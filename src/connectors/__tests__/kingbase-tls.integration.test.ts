import { describe, it, expect } from "vitest";
import pg from "pg";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KingbaseConnector, KingbaseDSNParser } from "../kingbase/index.js";

for (const [mode, dsn] of [
  ["oracle", process.env.KINGBASE_TEST_DSN],
  ["mysql", process.env.KINGBASE_MYSQL_TEST_DSN],
]) {
  describe.skipIf(!dsn || process.env.KINGBASE_TLS_TEST !== "1")(
    `Kingbase ${mode} verified TLS`,
    () => {
      async function query(value: string) {
        const connector = new KingbaseConnector();
        try {
          await connector.connect(value, undefined, { connectionTimeoutSeconds: 3 });
          return await connector.executeSQL(
            "SELECT ssl,version,client_dn FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
            {}
          );
        } finally {
          await connector.disconnect();
        }
      }
      it("negotiates TLS 1.2 or later and presents the client certificate", async () => {
        const row = (await query(dsn!)).resultSets[0].rows[0];
        expect(row.ssl).toBe(true);
        expect(["TLSv1.2", "TLSv1.3"]).toContain(row.version);
        expect(row.client_dn).toContain("CN=system");
      });
      it("rejects a wrong certificate hostname", async () => {
        const config = await new KingbaseDSNParser().parse(dsn!);
        config.ssl = { ...(config.ssl as object), servername: "wrong.dbhub.invalid" };
        const client = new pg.Client(config);
        try {
          await expect(client.connect()).rejects.toThrow(/hostname|altnames|cert/i);
        } finally {
          await client.end();
        }
      });
      it.skipIf(!process.env.KINGBASE_TLS_WRONG_CA)("rejects an unrelated CA", async () => {
        const url = new URL(dsn!);
        url.searchParams.set("sslrootcert", process.env.KINGBASE_TLS_WRONG_CA!);
        await expect(query(url.toString())).rejects.toThrow(/cert|verify|issuer|self.signed/i);
      });
      it("requires a client certificate when the server requires mutual TLS", async () => {
        const url = new URL(dsn!);
        url.searchParams.delete("sslcert");
        url.searchParams.delete("sslkey");
        await expect(query(url.toString())).rejects.toThrow(/cert|authentication|connection/i);
      });
      it("rejects plaintext on the TLS-only server", async () => {
        const url = new URL(dsn!);
        for (const key of ["sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
        url.searchParams.set("sslmode", "disable");
        await expect(query(url.toString())).rejects.toThrow(/SSL|encryption|hba|connection/i);
      });
      it("supports explicit require and verify-ca modes", async () => {
        for (const sslmode of ["require", "verify-ca"]) {
          const url = new URL(dsn!);
          url.searchParams.set("sslmode", sslmode);
          if (sslmode === "require") url.searchParams.delete("sslrootcert");
          expect((await query(url.toString())).resultSets[0].rows[0].ssl).toBe(true);
        }
      });
      it("reloads certificate files when a new physical connection is created", async () => {
        const folder = mkdtempSync(join(tmpdir(), "kb-rotation-"));
        const url = new URL(dsn!);
        const ca = url.searchParams.get("sslrootcert")!;
        const rotated = join(folder, "ca.pem");
        const connector = new KingbaseConnector();
        const admin = new pg.Client(await new KingbaseDSNParser().parse(dsn!));
        try {
          await admin.connect();
          copyFileSync(ca, rotated);
          url.searchParams.set("sslrootcert", rotated);
          await connector.connect(url.toString(), undefined, {
            poolMaxConnections: 1,
            connectionTimeoutSeconds: 3,
          });
          const backend = (await connector.executeSQL("SELECT pg_backend_pid() AS pid", {}))
            .resultSets[0].rows[0].pid;
          writeFileSync(rotated, "invalid certificate");
          await admin.query("SELECT pg_terminate_backend($1)", [backend]);
          await expect
            .poll(
              async () => {
                try {
                  await connector.executeSQL("SELECT 1", {});
                  return false;
                } catch {
                  return true;
                }
              },
              { timeout: 3000 }
            )
            .toBe(true);
          // Force a new handshake, not just the old backend's disconnect error.
          await expect(connector.executeSQL("SELECT 1", {})).rejects.toThrow(
            /cert|verify|issuer|self.signed/i
          );
          copyFileSync(ca, rotated);
          expect((await connector.executeSQL("SELECT 1 AS n", {})).resultSets[0].rows[0].n).toBe(1);
        } finally {
          await connector.disconnect();
          await admin.end();
          rmSync(folder, { recursive: true, force: true });
        }
      });
    }
  );
}
