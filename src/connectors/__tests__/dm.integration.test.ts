import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DMConnector, DMDSNParser } from "../dm/index.js";
import { ConnectorManager } from "../manager.js";
import { buildDSNFromSource, loadTomlConfig } from "../../config/toml-loader.js";
import { initializeToolRegistry } from "../../tools/registry.js";
import { createExecuteSqlToolHandler } from "../../tools/execute-sql.js";
import { createSearchDatabaseObjectsToolHandler } from "../../tools/search-objects.js";
import { createCustomToolHandler } from "../../tools/custom-tool-handler.js";
import { createExplainSqlToolHandler } from "../../tools/explain-sql.js";
import { classifyConnectionError } from "../../utils/error-classifier.js";

// Opt-in real DM8. Only a unique test schema is created and removed.
describe.skipIf(!process.env.DM_TEST_DSN)("DM8 integration", () => {
  const dsn = process.env.DM_TEST_DSN!;
  const schema = "DBHUB_IT_" + randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
  const table = `"${schema}"."MixedCase"`;
  const admin = new DMConnector();
  let connector: DMConnector;
  let manager: ConnectorManager;
  let folder: string;
  let created = false;
  const previousArgv = process.argv;
  const parse = (result: any) => JSON.parse(result.content[0].text);

  beforeAll(async () => {
    await admin.connect(dsn, undefined, { connectionTimeoutSeconds: 5, queryTimeoutSeconds: 10 });
    await admin.executeSQL(`CREATE SCHEMA "${schema}"`, {});
    created = true;
    await admin.executeSQL(
      `
      CREATE TABLE ${table} (ID INT PRIMARY KEY, LABEL VARCHAR(100), AMOUNT DECIMAL(30,9), BIG BIGINT, TS TIMESTAMP(6), BODY CLOB, BIN BLOB);
      INSERT INTO ${table} VALUES (1, 'first', 12345678901234567890.123456789, 9223372036854775807, '2026-01-02 03:04:05.123456', 'text;value', HEXTORAW('00FF'));
      INSERT INTO ${table}(ID,LABEL) VALUES (2,'second');
      INSERT INTO ${table}(ID,LABEL) VALUES (3,'third');
      CREATE INDEX "${schema}"."LABEL_IDX" ON ${table}(LABEL);
      COMMENT ON TABLE ${table} IS 'DBHub integration fixture';
      COMMENT ON COLUMN ${table}.LABEL IS 'Display label';
      CREATE VIEW "${schema}"."ITEM_VIEW" AS SELECT ID, LABEL FROM ${table};
      CREATE FUNCTION "${schema}"."ITEM_COUNT"(MINIMUM INT) RETURN INT AS N INT; BEGIN SELECT COUNT(*) INTO N FROM ${table} WHERE ID >= MINIMUM; RETURN N; END;
      CREATE FUNCTION "${schema}"."WRITE_ITEM"() RETURN INT AS BEGIN INSERT INTO ${table}(ID) VALUES (99); RETURN 99; END;
    `,
      {}
    );
    const scoped = dsn + (dsn.includes("?") ? "&" : "?") + "schema=" + schema;
    folder = mkdtempSync(join(tmpdir(), "dbhub-dm-it-"));
    const file = join(folder, "dbhub.toml");
    writeFileSync(
      file,
      `[[sources]]
id = "dm_it"
dsn = ${JSON.stringify(scoped)}
query_timeout = 5
pool_max_connections = 2
[[tools]]
name = "execute_sql"
source = "dm_it"
readonly = true
max_rows = 2
[[tools]]
name = "search_objects"
source = "dm_it"
[[tools]]
name = "explain_sql"
source = "dm_it"
[[tools]]
name = "lookup_item"
description = "Find fixture"
source = "dm_it"
statement = "SELECT LABEL FROM \\"MixedCase\\" WHERE ID = ?"
readonly = true
parameters = [{ name = "id", type = "integer", description = "Item ID" }]
`,
      { mode: 0o600 }
    );
    process.argv = ["node", "test", "--config", file];
    const config = loadTomlConfig()!;
    expect(config.sources[0].type).toBe("dm");
    manager = new ConnectorManager();
    await manager.connectWithSources(config.sources);
    initializeToolRegistry(config);
    connector = ConnectorManager.getCurrentConnector("dm_it") as DMConnector;
  }, 60_000);

  afterAll(async () => {
    try {
      await manager?.disconnect();
      if (created) await admin.executeSQL(`DROP SCHEMA "${schema}" CASCADE`, {});
    } finally {
      await admin.disconnect();
      process.argv = previousArgv;
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  it("records the actual server version and compatibility mode", async () => {
    const mode = (
      await connector.executeSQL(
        "SELECT PARA_VALUE FROM V$DM_INI WHERE PARA_NAME='COMPATIBLE_MODE'",
        { readonly: true }
      )
    ).resultSets[0].rows[0].PARA_VALUE;
    if (process.env.DM_EXPECT_MODE !== undefined)
      expect(Number(mode)).toBe(Number(process.env.DM_EXPECT_MODE));
    const version = (await connector.executeSQL("SELECT BANNER FROM V$VERSION", { readonly: true }))
      .resultSets[0].rows;
    expect(JSON.stringify(version)).toContain("V8");
    console.info("DM verified mode:", mode, "version:", JSON.stringify(version));
  });

  it("scans the active mode's identifiers and custom parameters", async () => {
    const dialect = connector.getSQLDialect();
    const quoted =
      dialect === "dm-mysql"
        ? "`name;?value`"
        : dialect === "dm-sqlserver"
          ? "[name;?value]"
          : '"name;?value"';
    const sql = `SELECT CAST(? AS INT) AS ${quoted} FROM DUAL`;
    const result = await connector.executeSQL(sql, { readonly: true }, [7]);
    expect(result.resultSets[0].rows).toEqual([{ "name;?value": 7 }]);
    const handler = createCustomToolHandler({
      name: "mode_literal",
      source: "dm_it",
      description: "Mode-aware binding",
      statement: sql,
      readonly: true,
      parameters: [{ name: "n", type: "integer", description: "Value" }],
    });
    const custom = parse(await handler({ n: 8 }, {}));
    expect(custom.success).toBe(true);
    expect(custom.data.statements[0].rows).toEqual([{ "name;?value": 8 }]);
  });

  it("selects the configured schema and independent source identity", async () => {
    expect(await connector.getDefaultSchema()).toBe(schema);
    expect(connector.getId()).toBe("dm_it");
    expect(await admin.getDefaultSchema()).not.toBe(schema);
    expect(await connector.getSchemas()).toContain(schema);
  });
  it("discovers tables, views and exact case-sensitive identifiers", async () => {
    expect(await connector.getTables()).toContain("MixedCase");
    expect(await connector.getViews()).toContain("ITEM_VIEW");
    expect(await connector.tableExists("MixedCase")).toBe(true);
    expect(await connector.tableExists("mixedcase")).toBe(false);
  });
  it("returns column metadata, comments and indexes", async () => {
    expect(await connector.getTableSchema("MixedCase")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: "ID", is_nullable: "NO" }),
        expect.objectContaining({ column_name: "LABEL", description: "Display label" }),
        expect.objectContaining({ column_name: "AMOUNT", data_type: "DECIMAL(30,9)" }),
      ])
    );
    const indexes = await connector.getTableIndexes("MixedCase");
    expect(indexes.some((i) => i.is_primary && i.column_names.includes("ID"))).toBe(true);
    expect(
      indexes.some((i) => i.index_name === "LABEL_IDX" && i.column_names.includes("LABEL"))
    ).toBe(true);
    expect(await connector.getTableComment("MixedCase")).toBe("DBHub integration fixture");
    expect(await connector.getTableRowCount("MixedCase")).toBeNull();
  });
  it("discovers routine arguments and definition", async () => {
    expect(await connector.getStoredProcedures(undefined, "function")).toContain("ITEM_COUNT");
    expect(await connector.getStoredProcedures(undefined, "procedure")).not.toContain("ITEM_COUNT");
    const detail = await connector.getStoredProcedureDetail("ITEM_COUNT");
    expect(detail.procedure_type).toBe("function");
    expect(detail.parameter_list).toContain("MINIMUM");
    expect(detail.definition).toContain("COUNT");
    await expect(connector.getStoredProcedureDetail("MISSING")).rejects.toThrow("not found");
  });
  it("preserves decimal, bigint, microseconds and materializes LOBs", async () => {
    const row = (
      await connector.executeSQL('SELECT * FROM "MixedCase" WHERE ID = ?', { readonly: true }, [1])
    ).resultSets[0].rows[0];
    expect(row.AMOUNT).toBe("12345678901234567890.123456789");
    expect(row.BIG).toBe("9223372036854775807");
    expect(row.TS).toBe("2026-01-02 03:04:05.123456");
    expect(row.BODY).toBe("text;value");
    expect(Buffer.from(row.BIN)).toEqual(Buffer.from([0, 255]));
  });
  it("supports q literals and positional batches", async () => {
    const result = await connector.executeSQL(
      "SELECT q'[it's;?ok]' AS V FROM DUAL; SELECT ? AS N FROM DUAL; SELECT ? AS N FROM DUAL",
      { readonly: true },
      [7, 8]
    );
    expect(result.resultSets.map((s) => s.rows[0])).toEqual([
      { V: "it's;?ok" },
      { N: "7" },
      { N: "8" },
    ]);
    await expect(connector.executeSQL("SELECT ? FROM DUAL", {}, [])).rejects.toThrow(
      "parameter count"
    );
  });
  it("reports exact truncation without rewriting SQL", async () => {
    const capped = await connector.executeSQL('SELECT ID FROM "MixedCase" ORDER BY ID', {
      readonly: true,
      maxRows: 2,
    });
    expect(capped.resultSets[0]).toMatchObject({ rowCount: 2, truncated: true });
    const exact = await connector.executeSQL('SELECT ID FROM "MixedCase" WHERE ID < 3', {
      readonly: true,
      maxRows: 2,
    });
    expect(exact.resultSets[0].truncated).toBeUndefined();
  });
  it("rejects direct writes and hidden writes in read-only transactions", async () => {
    await expect(
      connector.executeSQL('DELETE FROM "MixedCase"', { readonly: true })
    ).rejects.toThrow("Read-only");
    await expect(
      connector.executeSQL("SELECT WRITE_ITEM() FROM DUAL", { readonly: true })
    ).rejects.toThrow();
    expect(
      (await connector.executeSQL('SELECT ID FROM "MixedCase" WHERE ID=99', {})).resultSets[0].rows
    ).toHaveLength(0);
  });
  it("commits writable batches and rolls back failed DML batches", async () => {
    await admin.executeSQL(
      `INSERT INTO ${table}(ID) VALUES (?); DELETE FROM ${table} WHERE ID = ?`,
      {},
      [44, 44]
    );
    await expect(
      admin.executeSQL(
        `INSERT INTO ${table}(ID) VALUES (45); INSERT INTO ${table}(ID) VALUES (1)`,
        {}
      )
    ).rejects.toThrow();
    expect(
      (await admin.executeSQL(`SELECT ID FROM ${table} WHERE ID IN (44,45)`, {})).resultSets[0].rows
    ).toHaveLength(0);
  });
  it("commits DML across sessions and fetches more than one result batch", async () => {
    await admin.executeSQL(`INSERT INTO ${table}(ID) VALUES (46)`, {});
    expect(
      (await connector.executeSQL('SELECT ID FROM "MixedCase" WHERE ID=46', { readonly: true }))
        .resultSets[0].rows
    ).toEqual([{ ID: 46 }]);
    await admin.executeSQL(`DELETE FROM ${table} WHERE ID=46`, {});
    const result = await connector.executeSQL(
      "SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 1005",
      { readonly: true }
    );
    expect(result.resultSets[0].rows).toHaveLength(1005);
  });

  it("enforces source-level readonly even if execution asks for writes", async () => {
    const ro = new DMConnector();
    try {
      await ro.connect(dsn, undefined, { readonly: true });
      await expect(ro.executeSQL(`INSERT INTO ${table}(ID) VALUES (50)`, {})).rejects.toThrow(
        "Read-only"
      );
    } finally {
      await ro.disconnect();
    }
  });
  it("provides actionable parser errors and structured connections", async () => {
    const parser = new DMDSNParser();
    const built = buildDSNFromSource({
      id: "test",
      type: "dm",
      host: "localhost",
      user: "u",
      password: "p@ss",
    });
    const parsed = await parser.parse(built);
    expect(parsed.connection.connectString).toBe("localhost:5236");
    expect(parsed.connection.password).toBe("p@ss");
    await expect(parser.parse("dm://u:p@localhost/database")).rejects.toThrow("schema");
    expect((await parser.parse("dm://u:p@localhost?sslmode=require")).tls.mode).toBe("require");
    await expect(parser.parse("dm://u:p@localhost?sslmode=verify-full")).rejects.toThrow(
      "sslrootcert"
    );
    await expect(parser.parse("dm://u:p@localhost?loginEncrypt=false")).rejects.toThrow(
      "Unsupported"
    );
  });
  it("classifies real authentication errors", async () => {
    const bad = new DMConnector();
    const parsed = new URL(dsn);
    parsed.password = "wrong-password";
    try {
      await bad.connect(parsed.toString(), undefined, { connectionTimeoutSeconds: 3 });
      throw new Error("Unexpected login");
    } catch (error) {
      expect(classifyConnectionError(error, "dm", "bad")?.code).toBe("AUTH_FAILED");
    } finally {
      await bad.disconnect();
    }
  });
  it("recovers with a fresh session after a query timeout", async () => {
    const timed = new DMConnector();
    try {
      await timed.connect(dsn, undefined, { queryTimeoutSeconds: 1, poolMaxConnections: 1 });
      const start = Date.now();
      await expect(
        timed.executeSQL(
          "SELECT /* DBHUB_TIMEOUT_PROBE */ COUNT(*) FROM SYSOBJECTS a, SYSOBJECTS b, SYSOBJECTS c WHERE MOD(a.ID+b.ID+c.ID,7)=0",
          { readonly: true }
        )
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(6000);
      expect((await timed.executeSQL("SELECT 1 AS N FROM DUAL", {})).resultSets[0].rows).toEqual([
        { N: 1 },
      ]);
      // Assert that closing the client also released the expensive server query.
      await expect
        .poll(
          async () => {
            const remaining = await admin.executeSQL(
              "SELECT SQL_TEXT FROM V$SESSIONS WHERE SQL_TEXT LIKE ?",
              { readonly: true },
              ["SELECT /* DBHUB_TIMEOUT_PROBE */ COUNT%"]
            );
            return remaining.resultSets[0].rows;
          },
          { timeout: 5000, interval: 100 }
        )
        .toHaveLength(0);
    } finally {
      await timed.disconnect();
    }
  }, 15_000);
  it("reuses read-only sessions, bounds concurrency and discards writable state", async () => {
    const pooled = new DMConnector();
    try {
      await pooled.connect(dsn, undefined, { poolMaxConnections: 1, queryTimeoutSeconds: 3 });
      const session = async () =>
        (await pooled.executeSQL("SELECT SESSID() AS ID FROM DUAL", { readonly: true }))
          .resultSets[0].rows[0].ID;
      const first = await session();
      expect(await session()).toBe(first);
      expect(new Set(await Promise.all(Array.from({ length: 12 }, session))).size).toBe(1);
      await pooled.executeSQL("SELECT 1 FROM DUAL", {});
      expect(await session()).not.toBe(first);
    } finally {
      await pooled.disconnect();
    }
  });

  it("returns actual session and buffer metrics", async () => {
    const health = await connector.getHealthCheck();
    expect(health.connections?.maxConnections).toBeGreaterThan(0);
    expect(health.connections?.total).toBeGreaterThanOrEqual(0);
    expect(health.bufferCache?.blocksHit).toBeGreaterThanOrEqual(0);
    expect(health.bufferCache?.hitRatioPct).toBeGreaterThanOrEqual(0);
    expect(health.bufferCache?.hitRatioPct).toBeLessThanOrEqual(100);
  });

  it("explains without running target functions and blocks ANALYZE", async () => {
    const result = await connector.executeSQL("EXPLAIN SELECT WRITE_ITEM() FROM DUAL", {
      readonly: true,
    });
    expect(result.resultSets[0].rows.length).toBeGreaterThan(0);
    expect(
      (await connector.executeSQL('SELECT ID FROM "MixedCase" WHERE ID=99', { readonly: true }))
        .resultSets[0].rows
    ).toHaveLength(0);
    await expect(connector.executeSQL("EXPLAIN ANALYZE SELECT 1 FROM DUAL", {})).rejects.toThrow(
      "EXPLAIN"
    );
  });

  it("executes real tool handlers including parameterized custom tools", async () => {
    const execute = parse(
      await createExecuteSqlToolHandler("dm_it")(
        { sql: 'SELECT ID FROM "MixedCase" ORDER BY ID' },
        {}
      )
    );
    expect(execute.success).toBe(true);
    expect(execute.data.statements[0].truncated).toBe(true);
    const search = parse(
      await createSearchDatabaseObjectsToolHandler("dm_it")(
        { object_type: "table", schema, detail_level: "full" },
        {}
      )
    );
    expect(search.success).toBe(true);
    const custom = parse(
      await createCustomToolHandler({
        name: "lookup_item",
        description: "Lookup",
        source: "dm_it",
        statement: 'SELECT LABEL FROM "MixedCase" WHERE ID = ?',
        readonly: true,
        parameters: [{ name: "id", type: "integer", description: "ID" }],
      })({ id: 1 }, {})
    );
    expect(custom.success).toBe(true);
    expect(JSON.stringify(custom)).toContain("first");
    const explain = parse(
      await createExplainSqlToolHandler("dm_it")({ sql: "SELECT 1 FROM DUAL" }, {})
    );
    expect(explain.success).toBe(true);
    expect(explain.data.rows.length).toBeGreaterThan(0);
    expect(explain.data.rows[0]).toHaveProperty("OPERATION");
  });
});
