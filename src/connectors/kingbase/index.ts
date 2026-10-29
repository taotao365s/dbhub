import type pg from "pg";
import { PostgresConnector, PostgresDSNParser } from "../postgres/index.js";
import {
  ConnectorRegistry,
  type Connector,
  type ConnectorConfig,
  type ConnectorType,
  type DSNParser,
  type SQLDialect,
  type StoredProcedure,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";

export class KingbaseDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<pg.PoolConfig> {
    if (!this.isValidDSN(dsn)) {
      throw new Error(
        `Invalid KingbaseES DSN: ${obfuscateDSNPassword(dsn)}. Expected: ${this.getSampleDSN()}`
      );
    }
    const url = new SafeURL(dsn);
    const parsed = await new PostgresDSNParser().parse(
      dsn.replace(/^kingbase:/, "postgres:"),
      config
    );
    // Preserve the vendor's default instead of inheriting PostgreSQL's 5432.
    parsed.port = url.port ? Number(url.port) : 54321;
    return parsed;
  }

  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("kingbase://");
  }

  getSampleDSN(): string {
    return "kingbase://user:password@localhost:54321/test";
  }
}

/**
 * KingbaseES V8R6 (Oracle and MySQL modes), using its PostgreSQL wire protocol.
 * Keep engine identity and SQL scanning separate from the shared pg transport.
 */
export class KingbaseConnector extends PostgresConnector {
  override id: ConnectorType = "kingbase";
  override name = "KingbaseES";
  override dsnParser = new KingbaseDSNParser();

  private compatibilityMode: "oracle" | "mysql" = "oracle";

  override getSQLDialect(): SQLDialect {
    return this.compatibilityMode === "mysql" ? "kingbase-mysql" : "kingbase";
  }

  override clone(): Connector {
    return new KingbaseConnector();
  }

  override async connect(
    dsn: string,
    initScript?: string,
    config?: ConnectorConfig
  ): Promise<void> {
    await this.disconnect();
    this.compatibilityMode = "oracle";
    // Initialization belongs here, after the server's SQL dialect is known.
    await super.connect(dsn, undefined, config);
    try {
      const version = await this.executeSQL("SELECT version() AS version", {});
      const mode = await this.executeSQL("SHOW database_mode", {});
      if (
        !/^KingbaseES V008R006/.test(version.resultSets[0].rows[0].version) ||
        !["oracle", "mysql"].includes(mode.resultSets[0].rows[0].database_mode)
      ) {
        throw new Error(
          "The KingbaseES connector currently supports V8R6 in Oracle or MySQL compatibility mode only"
        );
      }
      this.compatibilityMode = mode.resultSets[0].rows[0].database_mode;
      if (initScript?.trim()) await this.executeSQL(initScript, { readonly: config?.readonly });
      const schema = await this.executeSQL("SELECT current_schema() AS schema", {});
      this.defaultSchema = schema.resultSets[0].rows[0].schema ?? "public";
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async getDefaultSchema(): Promise<string> {
    return this.defaultSchema;
  }

  override async getTables(schema?: string): Promise<string[]> {
    // MySQL-mode information_schema.table_type is an enum without FOREIGN.
    // The compatibility catalogs cover base, partitioned, and foreign tables.
    const result = await this.executeSQL(
      `
      SELECT c.relname AS table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f')
      ORDER BY c.relname
    `,
      { readonly: true },
      [schema ?? this.defaultSchema]
    );
    return result.resultSets[0].rows.map((row) => row.table_name);
  }

  override async getStoredProcedureDetail(name: string, schema?: string): Promise<StoredProcedure> {
    const result = await this.executeSQL(
      `
      SELECT p.proname AS procedure_name,
        CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS procedure_type,
        l.lanname AS language,
        pg_get_function_arguments(p.oid) AS parameter_list,
        pg_get_function_result(p.oid) AS return_type,
        pg_get_functiondef(p.oid) AS definition
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind IN ('p', 'f')
      ORDER BY p.oid
    `,
      { readonly: true },
      [schema ?? this.defaultSchema, name]
    );
    const row = result.resultSets[0].rows[0];
    if (!row)
      throw new Error(`Routine '${name}' not found in schema '${schema ?? this.defaultSchema}'`);
    return {
      ...row,
      return_type: row.return_type === "void" ? undefined : row.return_type,
    } as StoredProcedure;
  }

  override async getSchemas(): Promise<string[]> {
    const systemSchemas = new Set([
      "sys",
      "sys_catalog",
      "sysaudit",
      "sysmac",
      "SYS_HM",
      "wmsys",
      "anon",
      "dbms_sql",
      "perf",
      "pg_bitmapindex",
      "src_restrict",
      "xlog_record_read",
    ]);
    return (await super.getSchemas()).filter(
      (schema) => !systemSchemas.has(schema) && !/^pg_(?:temp|toast)_/.test(schema)
    );
  }
}

ConnectorRegistry.register(new KingbaseConnector());
