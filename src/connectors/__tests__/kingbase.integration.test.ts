import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { KingbaseConnector, KingbaseDSNParser } from "../kingbase/index.js";
import { ConnectorRegistry } from "../interface.js";
import { ConnectorManager } from "../manager.js";
import { loadTomlConfig, buildDSNFromSource } from "../../config/toml-loader.js";
import { initializeToolRegistry } from "../../tools/registry.js";
import { createExecuteSqlToolHandler } from "../../tools/execute-sql.js";
import { createSearchDatabaseObjectsToolHandler } from "../../tools/search-objects.js";
import { createExplainSqlToolHandler } from "../../tools/explain-sql.js";
import { createCustomToolHandler } from "../../tools/custom-tool-handler.js";
import { policyFromReadonly, sqlVerdict } from "../../utils/sql-access-policy.js";

// Opt in to an existing, licensed V8 instance. Never start/remove user containers.
// Each run owns only a unique schema, which is removed even when an assertion fails.
let sharedManager: ConnectorManager;
for (const [mode, dsn] of [
  ["oracle", process.env.KINGBASE_TEST_DSN],
  ["mysql", process.env.KINGBASE_MYSQL_TEST_DSN],
]) {
  describe.skipIf(!dsn)(`KingbaseES V8R6 ${mode}-mode integration`, () => {
    const schema = "dbhub_it_" + randomUUID().replace(/-/g, "");
    const table = `"${schema}"."MixedCase"`;
    const customStatement =
      mode === "mysql" ? "SELECT $1::integer AS `value; $99` # $88" : "SELECT $1::integer AS value";
    let folder: string;
    const previousArgv = process.argv;
    let admin: pg.Client;
    let connector: KingbaseConnector;
    let manager: ConnectorManager;
    let schemaCreated = false;
    const parse = (result: any) => JSON.parse(result.content[0].text);

    beforeAll(async () => {
      folder = mkdtempSync(join(tmpdir(), "dbhub-kingbase-"));
      const params = await new KingbaseDSNParser().parse(dsn!, { connectionTimeoutSeconds: 5 });
      admin = new pg.Client(params);
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await admin.query(
        `CREATE TABLE ${table} (id integer PRIMARY KEY, label varchar(100), amount numeric(30,9), happened_at timestamp(6), oracle_date date)`
      );
      await admin.query(`INSERT INTO ${table} (id, label, amount, happened_at, oracle_date)
      VALUES (1, 'first', 12345678901234567890.123456789, '2026-01-02 03:04:05.123456', '2026-01-02 03:04:05'), (2, 'second', NULL, NULL, NULL), (3, 'third', NULL, NULL, NULL)`);
      await admin.query(`CREATE INDEX it_label_idx ON ${table} (label)`);
      await admin.query(`COMMENT ON TABLE ${table} IS 'DBHub integration fixture'`);
      await admin.query(`COMMENT ON COLUMN ${table}.label IS 'Display label'`);
      await admin.query(`CREATE VIEW "${schema}".item_view AS SELECT id, label FROM ${table}`);
      await admin.query(
        `CREATE FUNCTION "${schema}".item_count(minimum integer) RETURNS integer LANGUAGE SQL AS $$ SELECT count(*)::integer FROM ${table} WHERE id >= minimum $$`
      );
      await admin.query(
        `CREATE FUNCTION "${schema}".write_item() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${table} (id, label) VALUES (99, 'hidden write'); RETURN 99; END; $$`
      );
      await admin.query(`ANALYZE ${table}`);

      // Exercise real TOML validation, Registry selection, clone(), and source IDs.
      const file = join(folder, "dbhub.toml");
      writeFileSync(
        file,
        `[[sources]]
id = "kingbase_it"
dsn = "${dsn!.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
search_path = "${schema},public"
init_script = ${JSON.stringify('CREATE TABLE "' + schema + '".init_from_toml(n int); INSERT INTO "' + schema + '".init_from_toml VALUES(1)')}
query_timeout = 1
pool_max_connections = 2

[[tools]]
name = "execute_sql"
source = "kingbase_it"
readonly = true
max_rows = 2

[[tools]]
name = "search_objects"
source = "kingbase_it"

[[tools]]
name = "explain_sql"
source = "kingbase_it"

[[tools]]
name = "lookup_literal"
description = "Check mode-aware parameter validation"
source = "kingbase_it"
statement = "${customStatement}"
readonly = true
parameters = [{ name = "id", type = "integer", description = "Value" }]
`,
        { mode: 0o600 }
      );
      process.argv = ["node", "test", "--config", file];
      const config = loadTomlConfig()!;
      expect(config.sources[0].type).toBe("kingbase");
      manager = sharedManager ??= new ConnectorManager();
      await manager.connectWithSources(config.sources);
      initializeToolRegistry(config);
      connector = ConnectorManager.getCurrentConnector("kingbase_it") as KingbaseConnector;
    }, 30_000);

    afterAll(async () => {
      try {
        await manager?.disconnect();
        if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        process.argv = previousArgv;
        if (folder) rmSync(folder, { recursive: true, force: true });
      }
    });

    it("runs init_script once using the detected compatibility mode", async () => {
      const initialized = new KingbaseConnector();
      const initTable = `"${schema}"."InitState"`;
      const column = mode === "mysql" ? "`value; $99`" : '"value; $99"';
      try {
        await initialized.connect(
          dsn!,
          `
          CREATE TABLE ${initTable} (id integer PRIMARY KEY, ${column} varchar(80));
          INSERT INTO ${initTable} VALUES (1, q'[initialized; once]');
        `,
          { poolMaxConnections: 2 }
        );
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            initialized.executeSQL(`SELECT COUNT(*) AS n FROM ${initTable}`, { readonly: true })
          )
        );
        for (const result of results) expect(Number(result.resultSets[0].rows[0].n)).toBe(1);
      } finally {
        await initialized.disconnect();
      }
    });

    it("rolls back failed initialization and closes the failed connection pool", async () => {
      const failed = new KingbaseConnector();
      try {
        await expect(
          failed.connect(
            dsn!,
            `
          INSERT INTO ${table}(id,label) VALUES(80,'init rollback');
          INSERT INTO ${table}(id,label) VALUES(1,'duplicate');
        `
          )
        ).rejects.toThrow();
        expect((await admin.query(`SELECT id FROM ${table} WHERE id=80`)).rows).toHaveLength(0);
        await expect(failed.executeSQL("SELECT 1", {})).rejects.toThrow("Not connected");
      } finally {
        await failed.disconnect();
      }
    });

    it("enforces source readonly during initialization", async () => {
      const readonly = new KingbaseConnector();
      try {
        await expect(
          readonly.connect(dsn!, `INSERT INTO ${table}(id,label) VALUES(81,'forbidden init')`, {
            readonly: true,
          })
        ).rejects.toThrow();
        expect((await admin.query(`SELECT id FROM ${table} WHERE id=81`)).rows).toHaveLength(0);
      } finally {
        await readonly.disconnect();
      }
    });

    it("keeps engine identity, default schema, and source identity", async () => {
      expect(connector.id).toBe("kingbase");
      expect((await admin.query(`SELECT n FROM "${schema}".init_from_toml`)).rows).toEqual([
        { n: 1 },
      ]);
      expect(connector.getSQLDialect()).toBe(mode === "mysql" ? "kingbase-mysql" : "kingbase");
      expect(connector.getId()).toBe("kingbase_it");
      expect(await connector.getDefaultSchema()).toBe(schema);
      expect(connector.clone()).toBeInstanceOf(KingbaseConnector);
      expect(ConnectorRegistry.getConnectorForDSN(dsn!)?.id).toBe("kingbase");
    });

    it("builds structured DSNs with the vendor default port", async () => {
      const built = buildDSNFromSource({
        id: "kb",
        type: "kingbase",
        host: "localhost",
        database: "test",
        user: "u",
        password: "p",
      });
      expect(built).toContain(":54321/test");
      const parsed = await new KingbaseDSNParser().parse("kingbase://u:p@localhost/test");
      expect(parsed.port).toBe(54321);
      expect(parsed.database).toBe("test");
    });

    it("discovers user schemas, tables, views and preserves catalog spelling", async () => {
      expect(await connector.getSchemas()).toContain(schema);
      expect(await connector.getSchemas()).not.toContain("sys_catalog");
      expect(await connector.getTables()).toContain("MixedCase");
      expect(await connector.getViews()).toContain("item_view");
      expect(await connector.tableExists("MixedCase")).toBe(true);
      expect(await connector.tableExists("missing_table")).toBe(false);
    });

    it("discovers columns, comments, indexes and estimated row counts", async () => {
      const columns = await connector.getTableSchema("MixedCase");
      expect(columns.map((c) => c.column_name)).toEqual([
        "id",
        "label",
        "amount",
        "happened_at",
        "oracle_date",
      ]);
      expect(columns.find((c) => c.column_name === "label")?.description).toBe("Display label");
      expect(await connector.getTableComment("MixedCase")).toBe("DBHub integration fixture");
      const indexes = await connector.getTableIndexes("MixedCase");
      expect(indexes.some((i) => i.is_primary && i.column_names.includes("id"))).toBe(true);
      expect(indexes.find((i) => i.index_name === "it_label_idx")?.column_names).toEqual(["label"]);
      expect(await connector.getTableRowCount("MixedCase")).toBe(3);
    });

    it("discovers functions and definitions", async () => {
      expect(await connector.getStoredProcedures(schema, "function")).toContain("item_count");
      const fn = await connector.getStoredProcedureDetail("item_count", schema);
      expect(fn.procedure_type).toBe("function");
      expect(fn.definition).toContain("MixedCase");
      expect(fn.parameter_list).toContain("minimum");
    });

    it("preserves numeric precision, timestamp microseconds and Oracle DATE time", async () => {
      const result = await connector.executeSQL(
        `SELECT amount, happened_at, oracle_date FROM ${table} WHERE id = $1`,
        { readonly: true },
        [1]
      );
      expect(result.resultSets[0].rows[0]).toEqual({
        amount: "12345678901234567890.123456789",
        happened_at: "2026-01-02 03:04:05.123456",
        oracle_date: mode === "oracle" ? "2026-01-02 03:04:05" : "2026-01-02",
      });
    });

    it("binds parameters without interpolating SQL", async () => {
      const value = "a'; DROP TABLE example; --";
      const result = await connector.executeSQL("SELECT $1::text AS label", { readonly: true }, [
        value,
      ]);
      expect(result.resultSets[0].rows).toEqual([{ label: value }]);
    });

    it("handles Oracle q literals and PostgreSQL dollar quotes together", async () => {
      const result = await connector.executeSQL(
        "SELECT q'[it's;fine $1]' AS q, $$hello;world$$ AS d; SELECT 2 AS n",
        { readonly: true, maxRows: 2 }
      );
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets[0].rows[0]).toEqual({ q: "it's;fine $1", d: "hello;world" });
      expect(result.resultSets[1].rows).toEqual([{ n: 2 }]);
    });

    it("preserves semicolons and quotes in PostgreSQL escape strings", async () => {
      const result = await connector.executeSQL(
        String.raw`SELECT E'it\'s;fine' AS value; SELECT 2 AS n`,
        { readonly: true, maxRows: 1 }
      );
      expect(result.resultSets).toHaveLength(2);
      expect(result.resultSets[0].rows).toEqual([{ value: "it's;fine" }]);
    });

    it("caps results and distinguishes exact limits from truncation", async () => {
      const result = await connector.executeSQL(`SELECT id FROM ${table} ORDER BY id`, {
        readonly: true,
        maxRows: 2,
      });
      expect(result.resultSets[0].rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.resultSets[0].truncated).toBe(true);
      const exact = await connector.executeSQL(`SELECT id FROM ${table} ORDER BY id LIMIT 2`, {
        readonly: true,
        maxRows: 2,
      });
      expect(exact.resultSets[0].rows).toHaveLength(2);
      expect(exact.resultSets[0].truncated).not.toBe(true);
    });

    it("caps comma-style pagination without changing offsets", async () => {
      const result = await connector.executeSQL(`SELECT id FROM ${table} ORDER BY id LIMIT 1,100`, {
        readonly: true,
        maxRows: 1,
      });
      expect(result.resultSets[0].rows).toEqual([{ id: 2 }]);
      expect(result.resultSets[0].truncated).toBe(true);
      const bound = await connector.executeSQL(
        `SELECT id FROM ${table} ORDER BY id LIMIT $1,$2`,
        { readonly: true, maxRows: 1 },
        [1, 100]
      );
      expect(bound.resultSets[0].rows).toEqual([{ id: 2 }]);
      expect(bound.resultSets[0].truncated).toBe(true);
    });

    it.skipIf(mode !== "mysql")(
      "handles MySQL backticks, hash comments and keyword-like identifiers",
      async () => {
        const handler = createExecuteSqlToolHandler("kingbase_it");
        const result = parse(
          await handler(
            { sql: "SELECT 1 AS `delete; $1` # comment; DROP TABLE ignored\n; SELECT 2 AS `n`" },
            null
          )
        );
        expect(result.success).toBe(true);
        expect(result.data.statements).toHaveLength(2);
        expect(result.data.statements[0].rows).toEqual([{ "delete; $1": 1 }]);
        const blocked = parse(
          await handler({ sql: "SELECT 1 INTO OUTFILE '/tmp/dbhub-should-not-write'" }, null)
        );
        expect(blocked.success).toBe(false);
        expect(
          sqlVerdict(
            policyFromReadonly(true),
            "SELECT load_file('/tmp/x')",
            connector.getSQLDialect()
          )
        ).toBe("deny");
      }
    );

    it("rejects direct and function-hidden writes in readonly transactions", async () => {
      await expect(
        connector.executeSQL(`INSERT INTO ${table} (id) VALUES (98)`, { readonly: true })
      ).rejects.toMatchObject({ code: "25006" });
      await expect(
        connector.executeSQL(`SELECT "${schema}".write_item()`, { readonly: true })
      ).rejects.toMatchObject({ code: "25006" });
      expect((await admin.query(`SELECT id FROM ${table} WHERE id IN (98,99)`)).rows).toEqual([]);
    });

    it("rolls back failed batches and can subsequently write on the same source", async () => {
      await expect(
        connector.executeSQL(
          `INSERT INTO ${table} (id) VALUES (10); SELECT nonexistent_column FROM ${table}`,
          {}
        )
      ).rejects.toThrow();
      expect((await admin.query(`SELECT id FROM ${table} WHERE id = 10`)).rows).toEqual([]);
      const result = await connector.executeSQL(
        `INSERT INTO ${table} (id) VALUES (11); DELETE FROM ${table} WHERE id = 11`,
        {}
      );
      expect(result.resultSets.map((r) => r.rowCount)).toEqual([1, 1]);
    });

    it("cancels long queries on the server and recovers the pool", async () => {
      await expect(
        connector.executeSQL("SELECT pg_sleep(10)", { readonly: true })
      ).rejects.toMatchObject({ code: "57014" });
      const active = await admin.query(
        "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query = 'SELECT pg_sleep(10)'"
      );
      expect(active.rows).toHaveLength(0);
      expect(
        (await connector.executeSQL("SELECT 1 AS n", { readonly: true })).resultSets[0].rows
      ).toEqual([{ n: 1 }]);
    }, 10_000);

    it("runs the real execute_sql handler with readonly and truncation policy", async () => {
      const handler = createExecuteSqlToolHandler("kingbase_it");
      const result = parse(await handler({ sql: `SELECT id FROM ${table} ORDER BY id` }, null));
      expect(result.success).toBe(true);
      expect(result.data.statements[0].rows).toHaveLength(2);
      expect(result.data.statements[0].truncated).toBe(true);
      const blocked = parse(await handler({ sql: `DELETE FROM ${table}` }, null));
      expect(blocked.success).toBe(false);
    });

    it("runs custom tools with $1 bindings and the Kingbase dialect", async () => {
      const handler = createCustomToolHandler({
        name: "lookup",
        description: "Lookup fixture",
        source: "kingbase_it",
        statement: `SELECT id, label FROM ${table} WHERE id = $1`,
        readonly: true,
        parameters: [{ name: "id", type: "integer", description: "Fixture ID", required: true }],
      });
      const result = parse(await handler({ id: 1 }, null));
      expect(result.success).toBe(true);
      expect(result.data.statements[0].rows).toEqual([{ id: 1, label: "first" }]);
    });

    it("validates custom parameters using the connected compatibility mode", async () => {
      const handler = createCustomToolHandler({
        name: "lookup_literal",
        description: "Mode-aware binding",
        source: "kingbase_it",
        statement: customStatement,
        readonly: true,
        parameters: [{ name: "id", type: "integer", description: "Value" }],
      });
      const result = parse(await handler({ id: 42 }, null));
      expect(result.success).toBe(true);
      expect(Object.values(result.data.statements[0].rows[0])).toEqual([42]);
    });

    it("runs search_objects and explain_sql handlers", async () => {
      const search = parse(
        await createSearchDatabaseObjectsToolHandler("kingbase_it")(
          {
            object_type: "table",
            schema,
            pattern: "MixedCase",
            detail_level: "full",
          },
          null
        )
      );
      expect(search.success).toBe(true);
      expect(JSON.stringify(search.data)).toContain("Display label");
      const explain = parse(
        await createExplainSqlToolHandler("kingbase_it")({ sql: `SELECT id FROM ${table}` }, null)
      );
      expect(explain.success).toBe(true);
      expect(JSON.stringify(explain.data)).toContain("Scan");
    });

    it("classifies escape hatches and hidden mutations using the Kingbase scanner", () => {
      for (const sql of [
        "SELECT sys_read_file('/tmp/x')",
        "SELECT pg_read_file('/tmp/x')",
        "SELECT utl_file.fopen('a','b','r')",
        "WITH x AS (DELETE FROM t RETURNING id) SELECT id FROM x",
      ]) {
        expect(sqlVerdict(policyFromReadonly(true), sql, connector.getSQLDialect())).toBe("deny");
      }
      expect(
        sqlVerdict(policyFromReadonly(true), "SELECT q'[it's; DELETE FROM t]' AS label", "kingbase")
      ).toBe("allow");
    });

    it("returns health metrics from the compatibility catalogs", async () => {
      const health = await connector.getHealthCheck();
      expect(health.connections?.total).toBeGreaterThan(0);
      expect(health.connections?.maxConnections).toBeGreaterThan(0);
    });
  });
}
