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
(pinned to `1.0.52452`). It supports SQL execution, metadata discovery,
`explain_sql`, session/cache `health_check`, bounded connection pooling, and TLS.

```toml
[[sources]]
id = "dm"
dsn = "dm://app_user:password@localhost:5236?schema=APP"
connection_timeout = 10
query_timeout = 30
pool_max_connections = 4

[[tools]]
name = "execute_sql"
source = "dm"
readonly = true
max_rows = 100

[[tools]]
name = "search_objects"
source = "dm"

[[tools]]
name = "explain_sql"
source = "dm"

[[tools]]
name = "health_check"
source = "dm"
```

DM connects to an **instance**, so omit the database path. Select an exact,
case-sensitive schema using `?schema=APP`; without it the login's current schema
is used. Percent-encode credentials and schema names. Structured TOML parameters
use `type = "dm"`, `host`, `port` (default `5236`), `user`, and `password`;
omit `database`. A non-default schema can use DSN `schema=APP` or TOML
`search_path = "APP"` (one schema only; conflicting settings are rejected).
`timezone` accepts `Z` or a fixed offset from `-12:59` to `+14:00`, applied
on every checkout. It does not accept IANA zone names or `local`.
SDK password callbacks are resolved afresh for each physical connection with
a bounded deadline. Per-connection `charset` and `collation` remain rejected:
DM database character-set/collation semantics cannot safely inherit the
MySQL connection options.
Environment variables support `DB_TYPE=dm` without `DB_NAME`.

Build this checkout and run `node dist/index.js --config /path/to/dbhub.toml`.
The tested legacy 2024 image on Node.js 22 needs the process-specific
`NODE_OPTIONS=--openssl-legacy-provider` for login encryption. DBHub never
disables login encryption.

TLS uses DM's native protocol upgrade, with a minimum of TLS 1.2. Example for
a server configured with `ENABLE_ENCRYPT=1` (mutual TLS):

```toml
[[sources]]
id = "dm_tls"
dsn = "dm://app_user:password@db.example.com:5236?schema=APP"
sslmode = "verify-full"
sslrootcert = "/absolute/path/ca-cert.pem"
sslcert = "/absolute/path/client-cert.pem"
sslkey = "/absolute/path/client-key.pem"
pool_max_connections = 4
```

The same TLS fields can be placed in the DSN query string. Certificate files
are reloaded on each new physical connection, including `~/` paths. Existing
TLS sessions keep their negotiated identity until replaced. `verify-full`
validates the CA chain and hostname; `verify-ca` checks the chain only;
`require` encrypts without authenticating the server certificate.
Verified modes require `sslrootcert`. Client certificate/key must be supplied
together when the server requires them. `sslservername` is a DSN-only hostname
override, useful for a tunnel whose connection address differs from the
certificate name. TLS failures and plaintext downgrade are rejected **before
login**. The pinned driver's insecure TLS default is replaced per connection;
no global TLS or driver prototype is patched. SSL authentication-only mode
(`ENABLE_ENCRYPT=2`) and TLCP are not supported.

Each source has an independent pool (default maximum 4 connections, configurable
with `pool_max_connections`, range 1–1000). Acquisition, including queue wait, is
bounded by `connection_timeout`; at most 500 requests may wait. Successful
read-only sessions are rolled back and reused. Writable, failed and timed-out
sessions are discarded; this prevents write/session settings from leaking
to later calls. Disconnect rejects waiters and closes active/idle sockets.
Timeout cancellation uses a separate pool of at most one control connection
per source, beyond `pool_max_connections`, so a full query pool cannot deadlock
cancellation. Its connection, queue and command deadline is two seconds.
Session settings and temporary objects are not a cross-call contract;
`init_script` runs once, not on every pooled session.

Readonly SQL combines validation with server-side read-only transactions.
Successful writable DML batches commit; failed batches roll back. DDL follows
DM's implicit commits and cannot be made atomic by DBHub. Custom parameters
use `?`, consumed left-to-right across a batch. BIGINT, DECIMAL/NUMBER and
date/time values are strings, preserving precision; CLOBs are strings and
BLOBs are buffers. Catalog names retain exact case. Row caps fetch one extra
row to identify truncation.

`explain_sql` uses **EXPLAIN FOR** and returns structured plan rows. Only a
single read-only SELECT/WITH target is accepted; ANALYZE and named-plan forms
are rejected. Plan generation needs a normal transaction for its internal
plan data; DBHub rolls it back and never executes the target query.
`health_check` reports visible sessions, MAX_SESSIONS, and buffer hit/read
counters. Missing catalog privileges produce explicit notes per unavailable
section. Session durations are returned as null, not inferred from idle times.

`query_timeout` bounds the whole execution after connection setup, including
fetching and transaction completion. On expiry DBHub requests
`SP_CANCEL_SESSION_OPERATION` on the operation's own session through the control
connection, then destroys/discards the original socket. The original session
is held until the request finishes to prevent reuse of its ID by a later call.
Cleanup can add up to two seconds to the reported timeout. A timeout error
states whether cancellation was requested or unavailable (for example, missing
privileges or a network failure). No privileges are granted automatically.
Cancellation is best effort, not a promise that a preceding write failed to
commit or that the server stopped instantaneously; do not blindly retry writes.
The transport hooks and deferred per-column conversion depend on the pinned driver and are covered by real
integration tests.

Verified on macOS/OrbStack with these official images:

| Image | Server build reported by V$VERSION | Architecture |
| --- | --- | --- |
| `dm8_single:dm8_20241022_rev244896_x86_rh6_64` | `03134284294-20241009-244896-20119` | amd64, emulated |
| `dm8:dm8_20250924_rev288894_HWarm_kylin10_64` | `03134284368-20250821-288894-20149` | arm64, native |

Both builds support `COMPATIBLE_MODE` values 0–7: native (0), SQL92 (1),
Oracle (2, tested with FLOAT_MODE=1), SQL Server (3), MySQL (4), DM6 (5),
Teradata (6), and PostgreSQL (7). The matrix checks actual parameter values
after restarting each isolated instance and runs the same connector/tool suite.
Mode 5 means **DM8's DM6 compatibility setting**, not a tested DM6 server.
Other server builds, DM7, and newer mode values are not implied by this matrix.

The checked-in regression runner repeats the connector/tool and pool suites
on both builds, including minimally privileged users and explicit cancellation,
and verifies mutual TLS, certificate rotation, downgrade rejection and SSH
forwarding. Coverage is recorded by its test output rather than implying
support for untested server builds.

DBHub detects the active mode on connection using `SYS.V$DM_INI`. A restricted
account needs SELECT on that view, or an administrator-confirmed DSN
`compatible_mode=0..7`. Explicit mode is checked against the server whenever
the view is readable; mismatches are rejected. Without either, connection
fails with an actionable error rather than guessing a SQL dialect.
Low-privilege health checks return notes for inaccessible views.
Mode 4 enables backtick identifiers;
mode 3 enables bracket identifiers. All modes keep native DM `?` bindings.
DM's MySQL mode does not imply MySQL's `#` comments, and PostgreSQL mode does
not imply PostgreSQL's dollar-quoted strings. Tests cover common operations and
mode-aware identifiers/binding; this is not certification of every vendor SQL
feature or every DM parameter combination.

Real-instance tests create/remove unique schemas and a restricted test user.
Supply `DM_TEST_DSN` for a disposable instance with schema/user DDL and privilege
grant rights (the regression runner uses its own SYSDBA account); optionally use
`DM_EXPECT_MODE` to assert the active compatibility parameter:

```sh
NODE_OPTIONS=--openssl-legacy-provider pnpm exec vitest run --project integration src/connectors/__tests__/dm.integration.test.ts src/connectors/__tests__/dm-pool.integration.test.ts
NODE_OPTIONS=--openssl-legacy-provider node scripts/smoke-test-dm.mjs
```

TLS tests use `DM_TLS_TEST_DSN` (verify-full plus certificate paths),
`DM_TLS_WRONG_CA` (an unrelated CA certificate), and
`DM_PLAINTEXT_TEST_DSN` (a separate plaintext instance):

```sh
NODE_OPTIONS=--openssl-legacy-provider pnpm exec vitest run --project integration src/connectors/__tests__/dm-tls.integration.test.ts
```

To reproduce the full mode/TLS/SSH matrix on an already loaded official image:

```sh
DM_DOCKER_IMAGE=dm8:dm8_20250924_rev288894_HWarm_kylin10_64 \
NODE_OPTIONS=--openssl-legacy-provider \
pnpm exec tsx scripts/test-dm-regression.ts
```

The runner requires Docker, OpenSSL and installed dependencies. It creates only
uniquely named, labeled containers with loopback ports, random credentials and
short-lived test certificates, and removes them on completion/failure.
It never pulls or removes images. `DM_TEST_MODES=0,4` narrows the default 0–7
matrix; `DM_TEST_BUILT=1` also runs the built MCP smoke test (build first).

The CI workflow includes an opt-in DM job. Enable repository variable
`DM_REGRESSION_ENABLED=true` and provision a trusted self-hosted runner labeled
`dm8` with both listed images and the ability to run both architectures.
It runs for same-repository PRs and manual dispatch, never fork PRs. Without
that runner/variable, this job is disabled; ordinary integration runs still
skip externally configured DM suites if their DSNs are absent.

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

`init_script` executes once per explicit connection initialization, after the
server version and compatibility mode have been validated. It uses that mode's
SQL scanner and honors source-level readonly. A failed script fails connection
initialization and closes its pool; failed DML batches roll back. Scripts are
not replayed on each new physical connection or after automatic pool recovery.
Use `search_path` and other connection options for settings that must apply to
every pooled session. Initialization that commits data should be idempotent if
the application may explicitly reconnect.

TLS continues to use the `pg` driver. `sslmode=require`, `verify-ca`, and
`verify-full`, plus `sslrootcert`, `sslcert`, and `sslkey`, work in DSNs or TOML
source fields. Prefer `verify-full` with the expected CA and server hostname;
client certificates are required when the server enables mutual TLS. Certificate
files are reloaded for new physical connections. Real-instance tests cover both
V8R6C9B14 modes with mutual TLS, wrong CA/hostname, missing client certificate,
plaintext rejection, explicit require/verify-ca, and certificate rotation.

Pool recovery tests cover saturation/acquisition timeout, terminated idle and
active backends, TCP connection drops, and a database restart while retaining
the same connector. Fatal server responses discard the connection immediately,
even before the TCP close event arrives; failed statements are not retried.

To run real-instance tests, set `KINGBASE_TEST_DSN` (Oracle mode) and/or
`KINGBASE_MYSQL_TEST_DSN` (MySQL mode), then run:

```bash
pnpm exec vitest run --project integration src/connectors/__tests__/kingbase.integration.test.ts
pnpm run build:backend
node scripts/smoke-test-kingbase.mjs
```

The integration suite creates and drops a unique `dbhub_it_*` schema and needs
DDL permissions in a test database. It does not recreate or remove containers.
The MCP smoke test verifies session initialization, reads data, and checks that
a tool-level DDL request is rejected. Pool tests terminate only their own test
connections and require permission to do so. Modes without configured DSNs are
skipped. TLS tests additionally require `KINGBASE_TLS_TEST=1`, verify-full DSNs
with client certificates, a TLS-only mutual-authentication server, and
`KINGBASE_TLS_WRONG_CA` pointing to an unrelated CA. SSH is not covered by this
Kingbase-specific suite.

For the complete reproducible suite, use an already loaded, licensed image:

```sh
pnpm run build:backend
KINGBASE_DOCKER_IMAGE=kingbase_v008r006c009b0014_single_arm:v1 \
KINGBASE_TEST_MODE=oracle KINGBASE_TEST_BUILT=1 \
pnpm exec tsx scripts/test-kingbase-regression.ts
```

Repeat with `KINGBASE_TEST_MODE=mysql`. The runner creates a uniquely named,
loopback-only disposable container, generates temporary credentials and
certificates, runs plaintext and TLS suites plus restart/MCP checks, and cleans
up its container and files. It never pulls images or changes existing user
containers. Docker, OpenSSL and installed dependencies are required.

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
