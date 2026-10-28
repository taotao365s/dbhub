> [!NOTE]  
> If you need an enterprise-level database MCP server with built-in guardrails like approval flow, access control, data masking, and audit logging beyond what DBHub offers, check out [Bytebase](https://www.bytebase.com/).

<p align="center">
 <a href="https://www.star-history.com/bytebase/dbhub">
  <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=bytebase/dbhub&type=trending&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=bytebase/dbhub&type=trending" />
   <img alt="GitHub Trending Repository of the Day" src="https://api.star-history.com/badge?repo=bytebase/dbhub&type=trending" />
  </picture>
 </a>
</p>

<p align="center">
<a href="https://dbhub.ai/" target="_blank">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-dark.svg" width="75%">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%">
  <img src="https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/logo/full-light.svg" width="75%" alt="DBHub Logo">
</picture>
</a>
</p>

```bash
            +------------------+    +--------------+    +------------------+
            |                  |    |              |    |                  |
            |  Claude Desktop  +--->+              +--->+    PostgreSQL    |
            |                  |    |              |    |                  |
            |  Claude Code     +--->+              +--->+    SQL Server    |
            |                  |    |              |    |                  |
            |  Cursor          +--->+    DBHub     +--->+    Oracle        |
            |                  |    |              |    |                  |
            |  VS Code         +--->+              +--->+    SQLite        |
            |                  |    |              |    |                  |
            |  Copilot CLI     +--->+              +--->+    MySQL         |
            |                  |    |              |    |                  |
            |                  |    |              +--->+    MariaDB       |
            |                  |    |              |    |                  |
            +------------------+    +--------------+    +------------------+
                 MCP Clients           MCP Server             Databases
```

DBHub is a minimal MCP server: token-efficient, zero-dependency, and just two tools by default with opt-in extras. This lightweight gateway allows MCP-compatible clients to connect to and explore different databases:

- **Minimal**: Zero dependency, token efficient with a minimal set of MCP tools to maximize context window
- **Multi-Database**: PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, KingbaseES, DM8, and SQLite through a single interface
- **Multi-Connection**: Connect to multiple databases simultaneously with TOML configuration
- **Guardrails**: Read-only mode, row limiting, and query timeout to prevent runaway operations
- **Secure Access**: SSH tunneling and SSL/TLS encryption

> DBHub is the official example in the [Claude Code docs](https://code.claude.com/docs/en/mcp#example-query-your-postgresql-database) for connecting to PostgreSQL via MCP.

## Token Efficiency

DBHub loads just 2 tools by default at **1.4k tokens** — 13-14x fewer than alternatives — keeping the context window open for your actual work.

| MCP Server | Default Config | Default Tools |
|------------|---------------|--------------|
| **DBHub** | **1.4k** | 2 (`execute_sql`, `search_objects`) |
| MCP Toolbox | 19.0k | 28 |
| Supabase MCP | 19.3k | all |

## Use Cases

- **Local Development**: Schema exploration, query validation, and data debugging with Claude Code, VS Code, Cursor, etc.
- **Non-Technical Access**: Expose curated, read-only views to non-technical staff via Claude Desktop, VS Code, Cursor, etc.
- **Multi-Database Consolidation**: Replace separate MCP servers for each database with a single DBHub process
- **Production Troubleshooting**: Read-only diagnostics with guardrails against runaway queries

## Supported Databases

PostgreSQL, MySQL, SQL Server, MariaDB, Oracle, KingbaseES, DM8, and SQLite.

### DM8

This checkout supports DM8 through the optional native-protocol `dmdb` driver
(pinned to `1.0.52452`). Tested with the official
`dm8_20241022_rev244896_x86_rh6_64` image on Apple Silicon via OrbStack's
`linux/amd64` emulation.

```toml
[[sources]]
id = "dm"
dsn = "dm://app_user:password@localhost:5236?schema=APP"
connection_timeout = 10
query_timeout = 30

[[tools]]
name = "execute_sql"
source = "dm"
readonly = true
max_rows = 100

[[tools]]
name = "search_objects"
source = "dm"
```

DM connects to an **instance**, so omit the database path. Select an exact,
case-sensitive schema using `?schema=APP`; without it the login's current schema
is used. Percent-encode credentials and schema names in DSNs. Structured TOML
parameters use `type = "dm"`, `host`, `port` (default `5236`), `user`, and
`password`; omit `database`. For a non-default schema use the DSN form.
Individual environment variables support `DB_TYPE=dm` without `DB_NAME`.

Build this checkout and run `node dist/index.js --config /path/to/dbhub.toml`.
On Node.js 22, the tested legacy image requires the legacy OpenSSL provider
for login encryption:

```sh
NODE_OPTIONS=--openssl-legacy-provider node dist/index.js --config /path/to/dbhub.toml
```

This is a process-specific runtime option; DBHub never disables login encryption.
Use a least-privilege database user. Readonly tools combine SQL validation with
a server-side read-only transaction. Each execution uses a fresh session, commits
successful writable DML batches, and rolls back failed DML batches. DDL follows
DM's implicit-commit behavior and is not an atomic batch. Session settings and
temporary objects do not persist between calls; `init_script` is a one-time
initialization, not a per-session hook.

Custom tool parameters use `?`, consumed left-to-right across a batch.
BIGINT, DECIMAL/NUMBER, and date/time values are returned as strings to preserve
precision; CLOBs are strings and BLOBs are buffers. Catalog names retain their
exact case. Table/view/column/index/comment and standalone routine discovery
are supported. Row caps fetch one extra row to report truncation accurately.

`query_timeout` bounds execution of the entire batch after connection setup,
including result fetching and transaction completion. On expiry, DBHub destroys
that operation's private socket; later calls use fresh sessions. Server cleanup is
asynchronous: the tested query disappeared several seconds after the client
deadline, so this is not a strict server-side execution deadline. This cancellation
and deferred per-column conversion depend on the pinned driver's behavior and
are covered by the real-instance tests. Timeout does not prove a preceding write
failed to commit, so do not blindly retry writes.

Current limitations: TLS, connection pooling, `health_check`, and `explain_sql`
are not implemented. The driver does not expose DM's printed EXPLAIN output;
DBHub reports an explicit unsupported error. Only `schema` and
`sslmode=disable` DSN options are accepted. Other DM versions and compatibility
settings have not been verified.

Real-instance integration tests create and remove a unique test schema:

```sh
# DM_TEST_DSN must identify a disposable test instance/user with schema DDL rights.
NODE_OPTIONS=--openssl-legacy-provider pnpm exec vitest run --project integration src/connectors/__tests__/dm.integration.test.ts
# After building: read-only checks through the built MCP stdio service.
NODE_OPTIONS=--openssl-legacy-provider node scripts/smoke-test-dm.mjs
```

### KingbaseES V8

This checkout supports KingbaseES V8R6 in **Oracle and MySQL compatibility modes**,
validated against **V008R006C009B0014 on ARM64**. It uses the existing `pg` driver
over the PostgreSQL wire protocol. Both modes use `kingbase://` (default port
54321) and **`$1, $2` parameter bindings**, including MySQL mode. The connector
detects `database_mode` on connection and selects the matching SQL scanner.
Other major versions and PG compatibility mode are not enabled by this adapter.

Example `dbhub.toml` (set `KINGBASE_DSN` in your environment):

```toml
[[sources]]
id = "kingbase"
dsn = "${KINGBASE_DSN}"
search_path = "public"
query_timeout = 30
pool_max_connections = 5

[[tools]]
name = "execute_sql"
source = "kingbase"
readonly = true
max_rows = 100

[[tools]]
name = "search_objects"
source = "kingbase"
```

Use a DSN such as `kingbase://user:password@localhost:54321/test`; percent-encode
special characters in credentials. Structured connection fields also accept
`type = "kingbase"`. Build this checkout and run
`node dist/index.js --transport stdio --config ./dbhub.toml`.
The published upstream package does not include this local change.

The adapter supports discovery, comments, indexes, routine definitions,
EXPLAIN, health metrics, readonly transactions and query timeouts. Oracle
`q'[...]'` and dollar-quoted strings are recognized in both modes; MySQL
mode additionally recognizes backticks and `#` comments. Comma-style
`LIMIT offset,count` preserves the offset when enforcing `max_rows`.
Date/time values are returned as server text; MySQL fractional timestamps
require an explicit precision such as `timestamp(6)`.

To run real-instance tests, set `KINGBASE_TEST_DSN` (Oracle mode) and/or
`KINGBASE_MYSQL_TEST_DSN` (MySQL mode), then run:

```bash
pnpm exec vitest run --project integration src/connectors/__tests__/kingbase.integration.test.ts
pnpm run build:backend
node scripts/smoke-test-kingbase.mjs
```

The integration suite creates and drops a unique `dbhub_it_*` schema and needs
DDL permissions in a test database. It does not recreate or remove containers.
The MCP smoke test only reads data and checks that a DDL request is rejected.
Modes without a configured DSN are skipped; TLS and SSH need separate
environment-specific validation.

## MCP Tools

DBHub implements MCP tools for database operations:

- **[execute_sql](https://dbhub.ai/tools/execute-sql)**: Execute SQL queries with transaction support and safety controls
- **[search_objects](https://dbhub.ai/tools/search-objects)**: Search and explore database schemas, tables, columns, indexes, and procedures with progressive disclosure
- **[explain_sql](https://dbhub.ai/tools/explain-sql)** (opt-in): Show a query's execution plan without running it
- **[health_check](https://dbhub.ai/tools/health-check)** (opt-in): Report connection pool state and buffer cache hit ratio
- **[Custom Tools](https://dbhub.ai/tools/custom-tools)**: Define reusable, parameterized SQL operations in your `dbhub.toml` configuration file

## Workbench

DBHub includes a [built-in web interface](https://dbhub.ai/workbench/overview) for interacting with your database tools. It provides a visual way to execute queries, run custom tools, and view request traces without requiring an MCP client.

![workbench](https://raw.githubusercontent.com/bytebase/dbhub/main/docs/images/workbench/workbench.webp)

## Installation

```bash
npx @bytebase/dbhub@latest --transport http --port 8080 --dsn "postgres://user:password@localhost:5432/dbname?sslmode=disable"
```

Also available as:

- [Docker image](https://dbhub.ai/installation#docker)
- [MCP Bundle](https://dbhub.ai/mcpb) (one-click install, read-only)
- [Claude Code plugin](https://dbhub.ai/claude-code-plugin)

See the [Installation Guide](https://dbhub.ai/installation) for all options, [Command-Line Options](https://dbhub.ai/config/command-line) for parameters, and [Multi-Database Configuration](https://dbhub.ai/config/toml) for connecting several databases at once.

## Development

Requires Node.js >= 22.5.0 (DBHub uses the built-in `node:sqlite` module).

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Build and run for production
pnpm build && pnpm start --transport stdio --dsn "postgres://user:password@localhost:5432/dbname"
```

See [Testing](.claude/skills/testing/SKILL.md) and [Debug](https://dbhub.ai/config/debug).

## Contributors

<a href="https://github.com/bytebase/dbhub/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=bytebase/dbhub" />
</a>

## Star History

<a href="https://www.star-history.com/?repos=bytebase%2Fdbhub&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=bytebase/dbhub&type=date&legend=top-left" />
 </picture>
</a>
