// Run after build:backend. DSNs point to existing licensed V8 instances;
// this smoke test performs only reads through the built MCP stdio server.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const sources = [
  ["oracle", process.env.KINGBASE_TEST_DSN],
  ["mysql", process.env.KINGBASE_MYSQL_TEST_DSN],
].filter(([, dsn]) => dsn);
if (!sources.length) throw new Error("Set KINGBASE_TEST_DSN and/or KINGBASE_MYSQL_TEST_DSN");

for (const [mode, dsn] of sources) {
  const folder = mkdtempSync(join(tmpdir(), "dbhub-kingbase-mcp-"));
  const config = join(folder, "dbhub.toml");
  writeFileSync(
    config,
    `[[sources]]
id = "default"
dsn = "${dsn.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
init_script = "SET application_name = 'dbhub_init_smoke'"
[[tools]]
name = "execute_sql"
source = "default"
readonly = true
max_rows = 2
[[tools]]
name = "search_objects"
source = "default"
[[tools]]
name = "explain_sql"
source = "default"
`,
    { mode: 0o600 }
  );
  const client = new Client({ name: "kingbase-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js"), "--transport", "stdio", "--config", config],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "execute_sql"));
    const initialized = await call("execute_sql", {
      sql: "SELECT current_setting('application_name') AS name",
    });
    assert.equal(initialized.data.statements[0].rows[0].name, "dbhub_init_smoke");
    const actual = await call("execute_sql", { sql: "SHOW database_mode" });
    assert.equal(actual.data.statements[0].rows[0].database_mode, mode);
    const query =
      mode === "mysql"
        ? "SELECT q'[it's;ok]' AS `label;name`, $tag$a;b$tag$ AS d # trailing comment"
        : "SELECT q'[it's;ok]' AS label, $tag$a;b$tag$ AS d";
    const result = await call("execute_sql", { sql: query });
    assert.equal(result.success, true, result.error);
    assert.equal(result.data.statements[0].rows[0].d, "a;b");
    const capped = await call("execute_sql", {
      sql: "SELECT generate_series AS n FROM generate_series(1,10) LIMIT 1,9",
    });
    assert.equal(capped.data.statements[0].rows.length, 2);
    assert.equal(capped.data.statements[0].truncated, true);
    const blocked = await call("execute_sql", { sql: "CREATE TABLE dbhub_forbidden (id integer)" });
    assert.equal(blocked.success, false);
    assert.equal(blocked.code, "READONLY_VIOLATION");
    const explain = await call("explain_sql", { sql: "SELECT 1" });
    assert.equal(explain.success, true, explain.error);
    const schemas = await call("search_objects", { object_type: "schema", detail_level: "names" });
    assert.equal(schemas.success, true, schemas.error);
    assert.ok(!stderr.includes("Skipping KingbaseES"));
    console.log(
      `PASS KingbaseES V8 ${mode}: built MCP startup, tools/list, query, pagination, readonly, explain, discovery`
    );
  } finally {
    await client.close();
    rmSync(folder, { recursive: true, force: true });
  }
}
