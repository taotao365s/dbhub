// Read-only verification against a real DM8 instance through the built MCP server.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const dsn = process.env.DM_TEST_DSN;
if (!dsn) throw new Error("Set DM_TEST_DSN to a DM8 test instance");
const folder = mkdtempSync(join(tmpdir(), "dbhub-dm-mcp-"));
const config = join(folder, "dbhub.toml");
writeFileSync(
  config,
  `[[sources]]
id = "default"
dsn = ${JSON.stringify(dsn)}
query_timeout = 5
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
[[tools]]
name = "lookup_literal"
source = "default"
description = "Verify native parameter binding"
statement = "SELECT CAST(? AS INT) AS N FROM DUAL"
readonly = true
parameters = [{name = "value", type = "integer", description = "Value"}]
`,
  { mode: 0o600 }
);
const client = new Client({ name: "dm-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js"), "--transport", "stdio", "--config", config],
  // The SDK does not forward NODE_OPTIONS by default.
  env: { ...process.env },
  stderr: "pipe",
});
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
};
try {
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some((t) => t.name === "execute_sql"));
  const version = await call("execute_sql", { sql: "SELECT * FROM V$VERSION" });
  assert.equal(version.success, true, version.error);
  assert.ok(JSON.stringify(version).includes("V8"));
  const exact = await call("execute_sql", {
    sql: "SELECT CAST(9223372036854775807 AS BIGINT) AS B, CAST(12345678901234567890.123456789 AS DECIMAL(30,9)) AS D, q'[it's;?ok]' AS V FROM DUAL",
  });
  assert.equal(exact.success, true, exact.error);
  assert.deepEqual(exact.data.statements[0].rows[0], {
    B: "9223372036854775807",
    D: "12345678901234567890.123456789",
    V: "it's;?ok",
  });
  const capped = await call("execute_sql", {
    sql: "SELECT 1 AS N FROM DUAL UNION ALL SELECT 2 FROM DUAL UNION ALL SELECT 3 FROM DUAL",
  });
  assert.equal(capped.data.statements[0].rows.length, 2);
  assert.equal(capped.data.statements[0].truncated, true);
  const blocked = await call("execute_sql", { sql: "CREATE TABLE DBHUB_FORBIDDEN (ID INT)" });
  assert.equal(blocked.code, "READONLY_VIOLATION");
  const custom = await call("lookup_literal", { value: 42 });
  assert.equal(custom.success, true, custom.error);
  assert.equal(custom.data.statements[0].rows[0].N, 42);
  const schemas = await call("search_objects", { object_type: "schema", detail_level: "names" });
  assert.equal(schemas.success, true, schemas.error);
  const explain = await call("explain_sql", { sql: "SELECT 1 FROM DUAL" });
  assert.equal(explain.success, false);
  assert.ok(JSON.stringify(explain).includes("not supported"));
  console.log(
    "PASS DM8 built MCP: startup, discovery, bindings, precision, row cap, readonly, explicit EXPLAIN limitation"
  );
} finally {
  await client.close();
  rmSync(folder, { recursive: true, force: true });
}
