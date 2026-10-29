import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DMConnector } from "../src/connectors/dm/index.js";

// Explicit local/CI opt-in: never downloads images or touches existing containers.
const image = process.env.DM_DOCKER_IMAGE;
if (!image)
  throw new Error("Set DM_DOCKER_IMAGE to an already available, licensed official DM8 image");
const folder = mkdtempSync(join(tmpdir(), "dbhub-dm-regression-"));
chmodSync(folder, 0o700);
const name = "dbhub-dm-regression-" + randomUUID();
const password = "Dbh_" + randomBytes(18).toString("hex");
let created = false;
let tls = false;
let interrupted = false;
const children = new Set<ChildProcess>();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--openssl-legacy-provider"].filter(Boolean).join(" "),
};
async function command(
  binary: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  inherit = false,
  timeout = 120000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...env, ...extra },
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "",
      errors = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (errors += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      children.delete(child);
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else
        reject(new Error(`${binary} failed (${code}): ${errors.replaceAll(password, "********")}`));
    });
  });
}
async function dsn(): Promise<string> {
  const port = (await command("docker", ["port", name, "5236"])).split(":").at(-1)!;
  const url = new URL(`dm://SYSDBA:${password}@127.0.0.1:${port}`);
  if (tls)
    for (const [key, value] of Object.entries({
      sslmode: "verify-full",
      sslrootcert: join(folder, "ca.pem"),
      sslcert: join(folder, "client.pem"),
      sslkey: join(folder, "client.key"),
    }))
      url.searchParams.set(key, value);
  return url.toString();
}
async function query(sql: string): Promise<void> {
  if (interrupted) throw new Error("DM regression interrupted");
  const connector = new DMConnector();
  try {
    await connector.connect(await dsn(), undefined, {
      connectionTimeoutSeconds: 3,
      queryTimeoutSeconds: 5,
    });
    await connector.executeSQL(sql, {});
  } finally {
    await connector.disconnect();
  }
}
async function ready(): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 40; i++) {
    if (interrupted) throw new Error("DM regression interrupted");
    try {
      await query("SELECT 1 FROM DUAL");
      return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw last;
}
async function test(
  files: string[],
  more: NodeJS.ProcessEnv = {},
  args: string[] = []
): Promise<void> {
  await command(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", "--project", "integration", ...files, ...args],
    { DM_TEST_DSN: await dsn(), ...more },
    true
  );
}
const suite = "src/connectors/__tests__/dm.integration.test.ts";
const tlsSuite = "src/connectors/__tests__/dm-tls.integration.test.ts";
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
    "dbhub.integration=dm-regression",
    "-p",
    "127.0.0.1::5236",
    "-e",
    "SYSDBA_PWD=" + password,
    "-e",
    "BUFFER=128",
    "-e",
    "PAGE_SIZE=16",
    "-e",
    "CASE_SENSITIVE=Y",
    image,
  ]);
  created = true;
  await ready();
  const modes = (process.env.DM_TEST_MODES ?? "0,1,2,3,4,5,6,7").split(",");
  if (modes.some((mode) => !/^[0-7]$/.test(mode)))
    throw new Error("DM_TEST_MODES must contain values 0..7");
  for (const mode of modes) {
    await query(`SP_SET_PARA_VALUE(2, 'COMPATIBLE_MODE', ${mode})`);
    await query(`SP_SET_PARA_VALUE(2, 'FLOAT_MODE', ${mode === "2" ? 1 : 0})`);
    await command("docker", ["restart", name]);
    await ready();
    await test([suite], { DM_EXPECT_MODE: mode });
  }
  await test(["src/connectors/__tests__/dm-pool.integration.test.ts"]);
  await test([tlsSuite], { DM_TLS_TEST_DSN: await dsn(), DM_PLAINTEXT_TEST_DSN: await dsn() }, [
    "-t",
    "does not silently downgrade",
  ]);
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
      "/CN=" + (subject === "server" ? "localhost" : "SYSDBA"),
    ]);
    const extension = join(folder, subject + ".ext");
    writeFileSync(
      extension,
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
      extension,
    ]);
    chmodSync(join(folder, subject + ".key"), 0o600);
  }
  await command("docker", ["exec", name, "mkdir", "-p", "/opt/dmdbms/bin/server_ssl"]);
  for (const [file, target] of [
    ["ca.pem", "ca-cert.pem"],
    ["server.pem", "server-cert.pem"],
    ["server.key", "server-key.pem"],
  ])
    await command("docker", [
      "cp",
      join(folder, file),
      name + ":/opt/dmdbms/bin/server_ssl/" + target,
    ]);
  await command("docker", [
    "exec",
    name,
    "chown",
    "-R",
    "dmdba:dinstall",
    "/opt/dmdbms/bin/server_ssl",
  ]);
  await query("SP_SET_PARA_VALUE(2, 'ENABLE_ENCRYPT', 1)");
  await command("docker", ["restart", name]);
  tls = true;
  await ready();
  await test([tlsSuite], {
    DM_TLS_TEST_DSN: await dsn(),
    DM_TLS_WRONG_CA: join(folder, "wrong-ca.pem"),
    DM_PLAINTEXT_TEST_DSN: "",
  });
  await test([suite, "src/connectors/__tests__/dm-pool.integration.test.ts"], {
    DM_EXPECT_MODE: modes.at(-1),
  });
  if (process.env.DM_TEST_BUILT === "1")
    await command(
      process.execPath,
      ["scripts/smoke-test-dm.mjs"],
      { DM_TEST_DSN: await dsn(), DM_EXPECT_MODE: modes.at(-1) },
      true
    );
  console.log("PASS DM regression:", image, "modes", modes.join(","), "plaintext, TLS, pool");
} finally {
  try {
    if (created) await command("docker", ["rm", "-f", "-v", name]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
