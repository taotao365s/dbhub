import {
  openDMSession,
  destroyDMSession,
  readTLSFile,
  type DMSession,
  type DMTLSConfig,
} from "./transport.js";
import { DMSessionPool } from "./pool.js";
import { computeHitRatioPct } from "../health-check-utils.js";
import dm from "dmdb";
import {
  ConnectorRegistry,
  type Connector,
  type ConnectorType,
  type SQLDialect,
  type ConnectorConfig,
  type DSNParser,
  type ExecuteOptions,
  type SQLResult,
  type SQLResultSet,
  type TableColumn,
  type TableIndex,
  type StoredProcedure,
  type HealthCheckResult,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";
import { splitProceduralStatements } from "../../utils/procedural-sql.js";
import { stripCommentsAndStrings, blankCommentsAndStrings } from "../../utils/sql-parser.js";
import { isReadOnlySQL } from "../../utils/allowed-keywords.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { closeQuietly } from "../../utils/resource-cleanup.js";

interface DMConnectionConfig {
  connection: dm.ConnectionAttributes;
  schema?: string;
  tls: DMTLSConfig;
  poolMax: number;
}

export class DMDSNParser implements DSNParser {
  isValidDSN(dsn: string): boolean {
    return dsn.startsWith("dm://");
  }
  getSampleDSN(): string {
    return "dm://username:password@localhost:5236?schema=APP";
  }

  async parse(dsn: string, config?: ConnectorConfig): Promise<DMConnectionConfig> {
    if (!this.isValidDSN(dsn))
      throw new Error("Invalid DM DSN; expected dm://user:password@host:5236?schema=APP");
    const url = new SafeURL(dsn);
    if (!url.hostname || !url.username) throw new Error("DM DSN requires a host and user");
    if (url.pathname && url.pathname !== "/") {
      throw new Error(
        "DM addresses an instance, not a database path. Use ?schema=NAME to select a schema."
      );
    }
    let schema: string | undefined;
    const params: Record<string, string> = {};
    url.forEachSearchParam((value, key) => {
      if (
        !["schema", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslservername"].includes(key)
      ) {
        throw new Error(`Unsupported DM DSN option '${key}'`);
      }
      if (key in params) throw new Error(`Duplicate DM DSN option '${key}'`);
      params[key] = value;
    });
    if (params.schema !== undefined) {
      quoteIdentifier(params.schema, "dm");
      schema = params.schema;
    }
    const mode = params.sslmode ?? "disable";
    if (!["disable", "require", "verify-ca", "verify-full"].includes(mode))
      throw new Error("Invalid DM sslmode");
    if (!!params.sslcert !== !!params.sslkey)
      throw new Error("DM sslcert and sslkey must be supplied together");
    if (
      mode === "disable" &&
      ["sslrootcert", "sslcert", "sslkey", "sslservername"].some((key) => params[key])
    ) {
      throw new Error("DM TLS options require sslmode=require, verify-ca or verify-full");
    }
    if (mode.startsWith("verify") && !params.sslrootcert)
      throw new Error("DM verified TLS requires sslrootcert");
    const tls: DMTLSConfig = {
      mode: mode as DMTLSConfig["mode"],
      hostname: params.sslservername ?? url.hostname,
      ca: readTLSFile(params.sslrootcert),
      cert: readTLSFile(params.sslcert),
      key: readTLSFile(params.sslkey),
    };
    if (
      config?.password ||
      config?.searchPath ||
      config?.timezone ||
      config?.charset ||
      config?.collation
    ) {
      throw new Error(
        "DM does not support password callbacks, search_path, timezone, charset or collation options"
      );
    }
    const poolMax = config?.poolMaxConnections ?? 4;
    if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 1000)
      throw new Error("DM pool size must be between 1 and 1000");
    return {
      schema,
      tls,
      poolMax,
      connection: {
        connectString: `${url.hostname}:${url.port || 5236}`,
        user: url.username,
        password: url.password,
        connectTimeout: (config?.connectionTimeoutSeconds ?? 10) * 1000,
        // An execution deadline below owns cancellation and session disposal.
        socketTimeout: 0,
        sessionTimeout: config?.queryTimeoutSeconds ?? 0,
      },
    };
  }
}

/** DM8 native protocol with bounded, source-local session pooling. */
export class DMConnector implements Connector {
  id: ConnectorType = "dm";
  name = "DM8";
  dsnParser = new DMDSNParser();
  private sourceId = "default";
  private parsed?: DMConnectionConfig;
  private pool?: DMSessionPool;
  private defaultSchema = "";
  private readonly = false;
  private queryTimeoutMs = 0;
  private compatibilityMode = 0;
  getSQLDialect(): SQLDialect {
    return this.compatibilityMode === 4
      ? "dm-mysql"
      : this.compatibilityMode === 3
        ? "dm-sqlserver"
        : "dm";
  }

  getId(): string {
    return this.sourceId;
  }
  clone(): Connector {
    return new DMConnector();
  }
  async getDefaultSchema(): Promise<string> {
    return this.defaultSchema;
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    await this.disconnect();
    this.parsed = await this.dsnParser.parse(dsn, config);
    const parsed = this.parsed;
    this.pool = new DMSessionPool({
      max: parsed.poolMax,
      waitMs: parsed.connection.connectTimeout ?? 10000,
      create: () => openDMSession(parsed.connection, parsed.tls),
    });
    this.readonly = config?.readonly ?? false;
    this.queryTimeoutMs = (config?.queryTimeoutSeconds ?? 0) * 1000;
    try {
      const rows = await this.query<{ NAME: string }>(
        "SELECT SF_GET_SCHEMA_NAME_BY_ID(CURRENT_SCHID()) AS NAME FROM DUAL"
      );
      this.defaultSchema = rows[0].NAME;
      const mode = await this.query<{ MODE: number }>(
        "SELECT SF_GET_PARA_VALUE(2, 'COMPATIBLE_MODE') AS MODE FROM DUAL"
      );
      this.compatibilityMode = Number(mode[0].MODE);
      if (initScript) await this.executeSQL(initScript, {});
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.pool?.close();
    this.pool = undefined;
    this.parsed = undefined;
    this.defaultSchema = "";
    this.compatibilityMode = 0;
  }

  private async acquire(): Promise<DMSession> {
    const parsed = this.parsed,
      pool = this.pool;
    if (!parsed || !pool) throw new Error("Not connected to DM");
    try {
      const connection = await pool.acquire();
      try {
        if (parsed.schema) {
          await connection.execute(`SET SCHEMA ${quoteIdentifier(parsed.schema, "dm")}`);
          await connection.rollback();
        }
        return connection;
      } catch (error) {
        pool.release(connection, false);
        throw error;
      }
    } catch (error) {
      if ((error as { errCode?: number }).errCode === 6071 && /unsupported/i.test(String(error))) {
        throw new Error(
          "DM login encryption is unavailable in this Node/OpenSSL runtime. " +
            "For legacy DM8 images, start this process with NODE_OPTIONS=--openssl-legacy-provider. " +
            "Login encryption has not been disabled.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  private async query<T>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const result = await this.executeSQL(sql, { readonly: true }, parameters);
    return result.resultSets[0]?.rows ?? [];
  }

  async executeSQL(
    sql: string,
    options: ExecuteOptions,
    parameters: unknown[] = []
  ): Promise<SQLResult> {
    const dialect = this.getSQLDialect();
    const statements = splitProceduralStatements(sql, dialect).filter((statement) =>
      stripCommentsAndStrings(statement, dialect).trim()
    );
    const readonly = this.readonly || options.readonly;
    if (readonly && statements.some((statement) => !isReadOnlySQL(statement, dialect))) {
      throw new Error("Read-only mode: statement is not permitted");
    }
    for (let i = 0; i < statements.length; i++) {
      const clean = stripCommentsAndStrings(statements[i], dialect).trim();
      if (/^explain\b/i.test(clean)) {
        // Accept only one ordinary SELECT/WITH target, never ANALYZE or named plans.
        const target = statements[i].replace(
          /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*explain\s+(?:for\s+)?/i,
          ""
        );
        if (
          !/^(select|with)\b/i.test(stripCommentsAndStrings(target, dialect).trim()) ||
          !isReadOnlySQL(target, dialect)
        ) {
          throw new Error("DM EXPLAIN requires a read-only SELECT or WITH statement");
        }
        statements[i] = "EXPLAIN FOR " + target;
      }
    }
    const explaining = statements.some((statement) => statement.startsWith("EXPLAIN FOR "));
    if (explaining && statements.length !== 1)
      throw new Error("DM EXPLAIN must be a single statement");
    if (
      options.maxRows !== undefined &&
      (!Number.isSafeInteger(options.maxRows) || options.maxRows < 1)
    ) {
      throw new Error("maxRows must be a positive safe integer");
    }
    // Positional binds are consumed once across the entire batch.
    const counts = statements.map(
      (statement) => (blankCommentsAndStrings(statement, dialect).match(/\?/g) ?? []).length
    );
    if (counts.reduce((sum, count) => sum + count, 0) !== parameters.length) {
      throw new Error("DM parameter count does not match the number of ? placeholders");
    }
    const connection = await this.acquire();
    const pool = this.pool!;
    let succeeded = false;
    let aborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // dmdb has no public cancel API. With the pinned driver, destroying this
    // operation's private socket stops client waiting; server cleanup is asynchronous.
    // Never return the session to a pool or send ROLLBACK on the dead socket.
    const operation = async (): Promise<SQLResult> => {
      try {
        if (readonly && !explaining)
          await connection.execute("SET TRANSACTION READ ONLY", [], { autoCommit: false });
        const resultSets: SQLResultSet[] = [];
        let offset = 0;
        for (const [index, statement] of statements.entries()) {
          const fetchInfo: Record<string, { type: number }> = {};
          const result = await connection.execute(
            statement,
            parameters.slice(offset, offset + counts[index]),
            {
              autoCommit: false,
              outFormat: dm.OUT_FORMAT_OBJECT,
              extendedMetaData: true,
              resultSet: true,
              fetchInfo,
              ...(options.maxRows ? { maxRows: options.maxRows + 1 } : {}),
            }
          );
          // dmdb keeps fetchInfo by reference until resultSet.getRows(). Populate
          // it using actual execution metadata before converting any row values.
          // The integration suite guards this behavior of the pinned driver.
          for (const column of (result.metaData ?? []).flat()) {
            if (
              /^(BIGINT|DEC|DECIMAL|NUMBER|NUMERIC|DATE|TIME|TIMESTAMP|DATETIME|TEXT|CLOB)/i.test(
                column.dbTypeName ?? ""
              )
            ) {
              fetchInfo[column.name] = { type: dm.STRING };
            } else if (/^(BLOB|IMAGE)/i.test(column.dbTypeName ?? "")) {
              fetchInfo[column.name] = { type: dm.BUFFER };
            }
          }
          offset += counts[index];
          const rows: unknown[] = [];
          if (result.resultSet) {
            try {
              const cap = options.maxRows ? options.maxRows + 1 : Infinity;
              while (rows.length < cap) {
                const requested = Math.min(1000, cap - rows.length);
                const batch = await result.resultSet.getRows(requested);
                rows.push(...batch);
                if (batch.length < requested) break;
              }
            } finally {
              if (!aborted) await result.resultSet.close();
            }
          }
          const resultSet: SQLResultSet = {
            sql: statement,
            rows,
            rowCount: result.resultSet ? rows.length : (result.rowsAffected ?? 0),
          };
          SQLRowLimiter.flagTruncation(resultSet, options.maxRows, true);
          resultSets.push(resultSet);
        }
        if (readonly) await connection.rollback();
        else await connection.commit();
        succeeded = true;
        return { resultSets };
      } catch (error) {
        if (!aborted) await closeQuietly(() => connection.rollback());
        throw error;
      } finally {
        pool.release(connection, succeeded && !!readonly && !aborted);
      }
    };
    try {
      if (!this.queryTimeoutMs) return await operation();
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            aborted = true;
            destroyDMSession(connection);
            pool.release(connection, false);
            reject(
              Object.assign(new Error("DM query execution timed out; its session was closed"), {
                code: "QUERY_TIMEOUT",
              })
            );
          }, this.queryTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getHealthCheck(): Promise<HealthCheckResult> {
    const result: HealthCheckResult = {};
    const notes: string[] = [];
    try {
      const rows = await this.query<Record<string, unknown>>(`
        SELECT COUNT(*) AS TOTAL,
          SUM(CASE WHEN STATE='ACTIVE' THEN 1 ELSE 0 END) AS ACTIVE,
          SUM(CASE WHEN STATE<>'ACTIVE' AND TRX_ID=0 THEN 1 ELSE 0 END) AS IDLE,
          SUM(CASE WHEN STATE<>'ACTIVE' AND TRX_ID<>0 THEN 1 ELSE 0 END) AS IDLE_TRX
        FROM V$SESSIONS WHERE SESS_ID <> SESSID()`);
      const max = await this.query<{ PARA_VALUE: string }>(
        "SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME='MAX_SESSIONS'"
      );
      result.connections = {
        total: Number(rows[0].TOTAL),
        active: Number(rows[0].ACTIVE ?? 0),
        idle: Number(rows[0].IDLE ?? 0),
        idleInTransaction: Number(rows[0].IDLE_TRX ?? 0),
        maxConnections: max[0] ? Number(max[0].PARA_VALUE) : null,
        longestIdleInTransactionSeconds: null,
        longestActiveQuerySeconds: null,
      };
      notes.push(
        "DM session durations are unavailable; counts reflect the current user's catalog visibility."
      );
    } catch (error) {
      if (![-551, -550, -2106].includes((error as { errCode?: number }).errCode ?? 0)) throw error;
      notes.push("DM session metrics unavailable: grant access to V$SESSIONS and V$DM_INI.");
    }
    try {
      const rows = await this.query<{ LOGICAL: string; PHYSICAL: string }>(
        "SELECT SUM(N_LOGIC_READS) AS LOGICAL, SUM(N_PHY_READS) AS PHYSICAL FROM V$BUFFERPOOL"
      );
      // DM's RAT_HIT is logical / (logical + physical), not (logical - physical) / logical.
      const logical = Number(rows[0]?.LOGICAL ?? 0),
        physical = Number(rows[0]?.PHYSICAL ?? 0);
      result.bufferCache = {
        blocksHit: logical,
        blocksRead: physical,
        hitRatioPct: computeHitRatioPct(logical + physical, physical),
      };
    } catch (error) {
      if (![-551, -550, -2106].includes((error as { errCode?: number }).errCode ?? 0)) throw error;
      notes.push("DM buffer metrics unavailable: grant access to V$BUFFERPOOL.");
    }
    if (notes.length) result.notes = notes;
    return result;
  }

  async getSchemas(): Promise<string[]> {
    const rows = await this.query<{ NAME: string }>(
      "SELECT NAME FROM SYSOBJECTS WHERE TYPE$ = 'SCH' ORDER BY NAME"
    );
    return rows.map((row) => row.NAME);
  }

  async getTables(schema = this.defaultSchema): Promise<string[]> {
    return (
      await this.query<{ TABLE_NAME: string }>(
        "SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = ? ORDER BY TABLE_NAME",
        [schema]
      )
    ).map((row) => row.TABLE_NAME);
  }

  async getViews(schema = this.defaultSchema): Promise<string[]> {
    return (
      await this.query<{ VIEW_NAME: string }>(
        "SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = ? ORDER BY VIEW_NAME",
        [schema]
      )
    ).map((row) => row.VIEW_NAME);
  }

  async tableExists(tableName: string, schema = this.defaultSchema): Promise<boolean> {
    return (
      (
        await this.query("SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = ? AND TABLE_NAME = ?", [
          schema,
          tableName,
        ])
      ).length > 0
    );
  }

  async getTableSchema(tableName: string, schema = this.defaultSchema): Promise<TableColumn[]> {
    const rows = await this.query<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      DATA_PRECISION: number | null;
      DATA_SCALE: number | null;
      DATA_LENGTH: number;
      NULLABLE: string;
      DATA_DEFAULT: string | null;
      DESCRIPTION: string | null;
    }>(
      `
      SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_PRECISION, c.DATA_SCALE, c.DATA_LENGTH,
        c.NULLABLE, c.DATA_DEFAULT, cc.COMMENTS AS DESCRIPTION
      FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc
      ON cc.SCHEMA_NAME = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
      WHERE c.OWNER = ? AND c.TABLE_NAME = ? ORDER BY c.COLUMN_ID`,
      [schema, tableName]
    );
    return rows.map((row) => ({
      column_name: row.COLUMN_NAME,
      data_type:
        /^(DECIMAL|NUMBER|NUMERIC|DEC)$/.test(row.DATA_TYPE) && row.DATA_PRECISION
          ? `${row.DATA_TYPE}(${row.DATA_PRECISION},${row.DATA_SCALE ?? 0})`
          : /^(VARCHAR2?|CHAR|BINARY|VARBINARY)$/.test(row.DATA_TYPE)
            ? `${row.DATA_TYPE}(${row.DATA_LENGTH})`
            : row.DATA_TYPE,
      is_nullable: row.NULLABLE === "Y" ? "YES" : "NO",
      column_default: row.DATA_DEFAULT?.trim() || null,
      description: row.DESCRIPTION,
    }));
  }

  async getTableIndexes(tableName: string, schema = this.defaultSchema): Promise<TableIndex[]> {
    const rows = await this.query<{
      INDEX_NAME: string;
      UNIQUENESS: string;
      IS_PRIMARY: number;
      COLUMN_NAME: string;
    }>(
      `SELECT i.INDEX_NAME, i.UNIQUENESS, ic.COLUMN_NAME,
      CASE WHEN pk.CONSTRAINT_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY
      FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS ic
        ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
      LEFT JOIN ALL_CONSTRAINTS pk ON pk.OWNER = i.TABLE_OWNER AND pk.TABLE_NAME = i.TABLE_NAME
        AND pk.CONSTRAINT_TYPE = 'P' AND pk.INDEX_OWNER = i.OWNER AND pk.INDEX_NAME = i.INDEX_NAME
      WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ? ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION`,
      [schema, tableName]
    );
    const indexes = new Map<string, TableIndex>();
    for (const row of rows) {
      if (!indexes.has(row.INDEX_NAME))
        indexes.set(row.INDEX_NAME, {
          index_name: row.INDEX_NAME,
          column_names: [],
          is_unique: row.UNIQUENESS === "UNIQUE",
          is_primary: Number(row.IS_PRIMARY) === 1,
        });
      indexes.get(row.INDEX_NAME)!.column_names.push(row.COLUMN_NAME);
    }
    return [...indexes.values()];
  }

  async getTableRowCount(tableName: string, schema = this.defaultSchema): Promise<number | null> {
    const rows = await this.query<{ NUM_ROWS: string | null }>(
      "SELECT NUM_ROWS FROM ALL_TABLES WHERE OWNER = ? AND TABLE_NAME = ?",
      [schema, tableName]
    );
    return rows[0]?.NUM_ROWS == null ? null : Number(rows[0].NUM_ROWS);
  }

  async getTableComment(tableName: string, schema = this.defaultSchema): Promise<string | null> {
    const rows = await this.query<{ COMMENTS: string | null }>(
      "SELECT COMMENTS FROM ALL_TAB_COMMENTS WHERE OWNER = ? AND TABLE_NAME = ?",
      [schema, tableName]
    );
    return rows[0]?.COMMENTS ?? null;
  }

  async getStoredProcedures(
    schema = this.defaultSchema,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    const rows = await this.query<{ OBJECT_NAME: string }>(
      `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = ? AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION')
       ${routineType ? "AND OBJECT_TYPE = ?" : ""} ORDER BY OBJECT_NAME`,
      routineType ? [schema, routineType.toUpperCase()] : [schema]
    );
    return rows.map((row) => row.OBJECT_NAME);
  }

  async getStoredProcedureDetail(
    name: string,
    schema = this.defaultSchema
  ): Promise<StoredProcedure> {
    const objects = await this.query<{ OBJECT_TYPE: string }>(
      "SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = ? AND OBJECT_NAME = ? AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION')",
      [schema, name]
    );
    if (!objects.length) throw new Error(`Routine '${name}' not found in schema '${schema}'`);
    const args = await this.query<{
      ARGUMENT_NAME: string | null;
      POSITION: number;
      IN_OUT: string;
      DATA_TYPE: string;
    }>(
      "SELECT ARGUMENT_NAME, POSITION, IN_OUT, DATA_TYPE FROM ALL_ARGUMENTS WHERE OWNER = ? AND OBJECT_NAME = ? AND PACKAGE_NAME IS NULL AND DATA_LEVEL = 0 ORDER BY POSITION",
      [schema, name]
    );
    const source = await this.query<{ TEXT: string }>(
      "SELECT t.TXT AS TEXT FROM SYS.SYSTEXTS t JOIN ALL_OBJECTS o ON o.OBJECT_ID = t.ID WHERE o.OWNER = ? AND o.OBJECT_NAME = ? ORDER BY t.SEQNO",
      [schema, name]
    );
    return {
      procedure_name: name,
      procedure_type: objects[0].OBJECT_TYPE === "FUNCTION" ? "function" : "procedure",
      language: "DM SQL",
      parameter_list: args
        .filter((arg) => arg.ARGUMENT_NAME !== null)
        .map((arg) => `${arg.ARGUMENT_NAME} ${arg.IN_OUT} ${arg.DATA_TYPE}`)
        .join(", "),
      return_type: args.find((arg) => Number(arg.POSITION) === 0 && arg.ARGUMENT_NAME === null)
        ?.DATA_TYPE,
      definition: source.map((row) => row.TEXT).join(""),
    };
  }
}

ConnectorRegistry.register(new DMConnector());
