import { describe, it, expect } from "vitest";
import { DMConnector, DMDSNParser } from "../dm/index.js";
import { openDMSession, destroyDMSession } from "../dm/transport.js";

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
