import { describe, it, expect } from "vitest";
import { DMConnector, DMDSNParser } from "../dm/index.js";
import { openDMSession, destroyDMSession } from "../dm/transport.js";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { connect as connectTCP } from "node:net";
import ssh2 from "ssh2";
import { SSHTunnel } from "../../utils/ssh-tunnel.js";

// Supply a real TLS-enabled DM server plus a separate plaintext test DSN.
// Certificates are caller-owned; this suite does not change the database config.
describe.skipIf(!process.env.DM_TLS_TEST_DSN)("DM verified TLS", () => {
  const dsn = process.env.DM_TLS_TEST_DSN!;
  async function connect(value: string) {
    const connector = new DMConnector();
    try {
      await connector.connect(value, undefined, { connectionTimeoutSeconds: 3 });
      return await connector.executeSQL("SELECT 1 AS N FROM DUAL", { readonly: true });
    } finally {
      await connector.disconnect();
    }
  }
  it("negotiates authenticated TLS 1.2 or later before login", async () => {
    const parsed = await new DMDSNParser().parse(dsn);
    const connection = await openDMSession(parsed.connection, parsed.tls);
    try {
      expect(connection.tlsSocket?.encrypted).toBe(true);
      expect(connection.tlsSocket?.authorized).toBe(true);
      expect(["TLSv1.2", "TLSv1.3"]).toContain(connection.tlsSocket?.getProtocol());
      expect((await connect(dsn)).resultSets[0].rows).toEqual([{ N: 1 }]);
    } finally {
      destroyDMSession(connection);
    }
  });
  it("rejects a wrong certificate hostname", async () => {
    const url = new URL(dsn);
    url.searchParams.set("sslservername", "wrong.dbhub.invalid");
    await expect(connect(url.toString())).rejects.toThrow(/cert|hostname|altnames/i);
  });
  it("reloads rotated certificate files for new pooled sessions", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dm-rotation-"));
    const url = new URL(dsn);
    const originalCA = url.searchParams.get("sslrootcert")!;
    const rotatedCA = join(folder, "ca.pem");
    const connector = new DMConnector();
    try {
      copyFileSync(originalCA, rotatedCA);
      url.searchParams.set("sslrootcert", rotatedCA);
      await connector.connect(url.toString(), undefined, {
        poolMaxConnections: 1,
        connectionTimeoutSeconds: 3,
      });
      await connector.executeSQL("SELECT 1 FROM DUAL", {}); // Discard the writable session.
      writeFileSync(rotatedCA, "invalid certificate");
      await expect(connector.executeSQL("SELECT 1 FROM DUAL", {})).rejects.toThrow();
      copyFileSync(originalCA, rotatedCA);
      expect(
        (await connector.executeSQL("SELECT 1 AS N FROM DUAL", {})).resultSets[0].rows
      ).toEqual([{ N: 1 }]);
    } finally {
      await connector.disconnect();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("verifies TLS over a real SSH forwarding channel", async () => {
    const url = new URL(dsn);
    const targetHost = url.hostname;
    const targetPort = Number(url.port);
    const password = randomUUID();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const server = new ssh2.Server({
      hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })],
    });
    server.on("connection", (client) => {
      client.on("error", () => {});
      client.on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.username === "dbhub" && ctx.password === password)
          ctx.accept();
        else ctx.reject();
      });
      client.on("tcpip", (accept, reject, info) => {
        if (info.destIP !== targetHost || info.destPort !== targetPort) {
          reject();
          return;
        }
        const socket = connectTCP({ host: info.destIP, port: info.destPort });
        socket.once("error", () => {
          reject();
          socket.destroy();
        });
        socket.once("connect", () => {
          const stream = accept();
          stream.on("error", () => socket.destroy());
          stream.on("close", () => socket.destroy());
          socket.pipe(stream).pipe(socket);
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tunnel = new SSHTunnel();
    try {
      const address = server.address() as { port: number };
      const info = await tunnel.establish(
        { host: "127.0.0.1", port: address.port, username: "dbhub", password },
        { targetHost: url.hostname, targetPort: Number(url.port), localPort: 0 }
      );
      url.searchParams.set("sslservername", "localhost");
      url.hostname = "127.0.0.1";
      url.port = String(info.localPort);
      expect((await connect(url.toString())).resultSets[0].rows).toEqual([{ N: 1 }]);
    } finally {
      await tunnel.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
  it.skipIf(!process.env.DM_TLS_WRONG_CA)("rejects an untrusted CA", async () => {
    const url = new URL(dsn);
    url.searchParams.set("sslrootcert", process.env.DM_TLS_WRONG_CA!);
    await expect(connect(url.toString())).rejects.toThrow(/cert|verify|issuer|self.signed/i);
  });
  it("supports chain-only verification explicitly", async () => {
    const url = new URL(dsn);
    url.searchParams.set("sslmode", "verify-ca");
    url.searchParams.set("sslservername", "wrong.dbhub.invalid");
    expect((await connect(url.toString())).resultSets[0].rows).toEqual([{ N: 1 }]);
  });
  it("supports explicit encryption-only require mode", async () => {
    const url = new URL(dsn);
    url.searchParams.set("sslmode", "require");
    url.searchParams.delete("sslrootcert");
    expect((await connect(url.toString())).resultSets[0].rows).toEqual([{ N: 1 }]);
  });
  it("rejects TLS when the caller explicitly disables it", async () => {
    const url = new URL(dsn);
    for (const key of ["sslrootcert", "sslcert", "sslkey", "sslservername"])
      url.searchParams.delete(key);
    url.searchParams.set("sslmode", "disable");
    await expect(connect(url.toString())).rejects.toThrow(/TLS/i);
  });
  it.skipIf(!process.env.DM_PLAINTEXT_TEST_DSN)(
    "does not silently downgrade when the server is plaintext",
    async () => {
      const url = new URL(process.env.DM_PLAINTEXT_TEST_DSN!);
      url.searchParams.set("sslmode", "require");
      await expect(connect(url.toString())).rejects.toThrow(/TLS|encryption/i);
    }
  );
});
