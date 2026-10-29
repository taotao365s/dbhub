import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import pg from "pg";
import { KingbaseConnector, KingbaseDSNParser } from "../src/connectors/kingbase/index.js";

// Uses only a new disposable container from an already available official image.
const image = process.env.KINGBASE_DOCKER_IMAGE;
const mode = process.env.KINGBASE_TEST_MODE ?? "oracle";
if (!image || !["oracle", "mysql"].includes(mode))
  throw new Error("Set KINGBASE_DOCKER_IMAGE and KINGBASE_TEST_MODE=oracle|mysql");
const folder = mkdtempSync(join(tmpdir(), "dbhub-kb-regression-"));
chmodSync(folder, 0o700);
const name = "dbhub-kb-regression-" + randomUUID();
const password = "Dbh_" + randomBytes(16).toString("hex");
const data = "/home/kingbase/userdata/data";
const ctl = "/home/kingbase/install/kingbase/bin/sys_ctl";
let created = false,
  tls = false,
  interrupted = false;
const children = new Set<ChildProcess>();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
async function command(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  inherit = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let out = "",
      error = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (error += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      children.delete(child);
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else
        reject(new Error(`${binary} failed (${code}): ${error.replaceAll(password, "********")}`));
    });
  });
}
async function dsn(): Promise<string> {
  const port = (await command("docker", ["port", name, "54321"])).split(":").at(-1);
  const url = new URL(`kingbase://system:${password}@127.0.0.1:${port}/test`);
  url.searchParams.set("sslmode", tls ? "verify-full" : "disable");
  if (tls)
    for (const [key, file] of Object.entries({
      sslrootcert: "ca.pem",
      sslcert: "client.pem",
      sslkey: "client.key",
    }))
      url.searchParams.set(key, join(folder, file));
  return url.toString();
}
async function ready(): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    if (interrupted) throw new Error("Kingbase regression interrupted");
    const client = new pg.Client(
      await new KingbaseDSNParser().parse(await dsn(), { connectionTimeoutSeconds: 2 })
    );
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch (error) {
      last = error;
    } finally {
      await client.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw last;
}
async function testEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    KINGBASE_TEST_DSN: mode === "oracle" ? await dsn() : "",
    KINGBASE_MYSQL_TEST_DSN: mode === "mysql" ? await dsn() : "",
    KINGBASE_TLS_TEST: tls ? "1" : "",
    KINGBASE_TLS_WRONG_CA: join(folder, "wrong-ca.pem"),
  };
}
async function suites(): Promise<void> {
  await command(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--project",
      "integration",
      "src/connectors/__tests__/kingbase.integration.test.ts",
      "src/connectors/__tests__/kingbase-pool.integration.test.ts",
      ...(tls ? ["src/connectors/__tests__/kingbase-tls.integration.test.ts"] : []),
    ],
    await testEnv(),
    true
  );
}
try {
  await command("docker", ["image", "inspect", image]);
  await command("docker", [
    "run",
    "--pull",
    "never",
    "-d",
    "--name",
    name,
    "--label",
    "dbhub.integration=kb-regression",
    "-p",
    "127.0.0.1::54321",
    "-e",
    "DB_USER=system",
    "-e",
    "DB_PASSWORD=" + password,
    "-e",
    "DB_MODE=" + mode,
    "-e",
    "ENABLE_CI=no",
    image,
  ]);
  created = true;
  await ready();
  await suites();
  // Keep the same connector alive across a real database restart.
  const recovering = new KingbaseConnector();
  try {
    await recovering.connect(
      await dsn(),
      "CREATE TABLE restart_marker(id int); INSERT INTO restart_marker VALUES(1)",
      { poolMaxConnections: 1, connectionTimeoutSeconds: 2 }
    );
    const before = (await recovering.executeSQL("SELECT pg_backend_pid() AS pid", {})).resultSets[0]
      .rows[0].pid;
    await command("docker", [
      "exec",
      "--user",
      "kingbase",
      name,
      ctl,
      "-D",
      data,
      "-m",
      "fast",
      "-l",
      data + "/logfile",
      "restart",
    ]);
    await ready();
    let recovered = false;
    for (let i = 0; i < 20; i++) {
      try {
        const after = (
          await recovering.executeSQL(
            "SELECT pg_backend_pid() AS pid, (SELECT COUNT(*) FROM restart_marker) AS n",
            {}
          )
        ).resultSets[0].rows[0];
        assert.notEqual(after.pid, before);
        assert.equal(Number(after.n), 1);
        recovered = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(
      recovered,
      "same connector must recover after database restart without replaying init_script"
    );
    console.log("PASS Kingbase", mode, "database restart and initialization persistence");
  } finally {
    await recovering.disconnect();
  }
  for (const ca of ["ca", "wrong-ca"])
    await command("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(folder, ca + ".key"),
      "-out",
      join(folder, ca + ".pem"),
      "-days",
      "2",
      "-subj",
      "/CN=DBHub-" + ca,
    ]);
  for (const subject of ["server", "client"]) {
    await command("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(folder, subject + ".key"),
      "-out",
      join(folder, subject + ".csr"),
      "-subj",
      "/CN=" + (subject === "server" ? "localhost" : "system"),
    ]);
    writeFileSync(
      join(folder, subject + ".ext"),
      subject === "server"
        ? "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"
        : "extendedKeyUsage=clientAuth\n"
    );
    await command("openssl", [
      "x509",
      "-req",
      "-in",
      join(folder, subject + ".csr"),
      "-CA",
      join(folder, "ca.pem"),
      "-CAkey",
      join(folder, "ca.key"),
      "-CAcreateserial",
      "-out",
      join(folder, subject + ".pem"),
      "-days",
      "2",
      "-extfile",
      join(folder, subject + ".ext"),
    ]);
    chmodSync(join(folder, subject + ".key"), 0o600);
  }
  for (const file of ["ca.pem", "server.pem", "server.key"])
    await command("docker", ["cp", join(folder, file), name + ":" + data + "/" + file]);
  await command("docker", [
    "exec",
    "--user",
    "root",
    name,
    "chown",
    "kingbase:kingbase",
    data + "/ca.pem",
    data + "/server.pem",
    data + "/server.key",
  ]);
  await command("docker", ["exec", name, "chmod", "600", data + "/server.key"]);
  const admin = new pg.Client(await new KingbaseDSNParser().parse(await dsn()));
  try {
    await admin.connect();
    for (const sql of [
      "ALTER SYSTEM SET ssl = on",
      "ALTER SYSTEM SET ssl_cert_file = 'server.pem'",
      "ALTER SYSTEM SET ssl_key_file = 'server.key'",
      "ALTER SYSTEM SET ssl_ca_file = 'ca.pem'",
    ])
      await admin.query(sql);
  } finally {
    await admin.end();
  }
  const hba = join(folder, "sys_hba.conf");
  writeFileSync(
    hba,
    "local all all trust\nhostssl all all 0.0.0.0/0 md5 clientcert=verify-full\nhostnossl all all 0.0.0.0/0 reject\n"
  );
  await command("docker", ["cp", hba, name + ":" + data + "/sys_hba.conf"]);
  await command("docker", [
    "exec",
    "--user",
    "root",
    name,
    "chown",
    "kingbase:kingbase",
    data + "/sys_hba.conf",
  ]);
  await command("docker", [
    "exec",
    "--user",
    "kingbase",
    name,
    ctl,
    "-D",
    data,
    "-m",
    "fast",
    "-l",
    data + "/logfile",
    "restart",
  ]);
  tls = true;
  await ready();
  await suites();
  if (process.env.KINGBASE_TEST_BUILT === "1")
    await command(process.execPath, ["scripts/smoke-test-kingbase.mjs"], await testEnv(), true);
  console.log("PASS Kingbase regression:", image, mode, "plaintext, mutual TLS, pool, restart");
} finally {
  try {
    if (created) await command("docker", ["rm", "-f", "-v", name]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
