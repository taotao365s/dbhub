import { describe, it, expect } from "vitest";
import pg from "pg";
import { createServer, connect as connectTCP, type Socket } from "node:net";
import { KingbaseConnector, KingbaseDSNParser } from "../kingbase/index.js";

for (const [mode, dsn] of [
  ["oracle", process.env.KINGBASE_TEST_DSN],
  ["mysql", process.env.KINGBASE_MYSQL_TEST_DSN],
]) {
  describe.skipIf(!dsn)(`Kingbase ${mode} pool recovery`, () => {
    async function setup() {
      const admin = new pg.Client(await new KingbaseDSNParser().parse(dsn!));
      await admin.connect();
      const connector = new KingbaseConnector();
      try {
        await connector.connect(dsn!, undefined, {
          poolMaxConnections: 1,
          connectionTimeoutSeconds: 1,
        });
        return { admin, connector };
      } catch (error) {
        await admin.end();
        throw error;
      }
    }
    async function pid(connector: KingbaseConnector) {
      return (await connector.executeSQL("SELECT pg_backend_pid() AS pid", {})).resultSets[0]
        .rows[0].pid as number;
    }
    async function active(admin: pg.Client, backend: number) {
      await expect
        .poll(
          async () =>
            (await admin.query("SELECT state FROM pg_stat_activity WHERE pid=$1", [backend]))
              .rows[0]?.state,
          { timeout: 3000 }
        )
        .toBe("active");
    }
    it("bounds queued acquisition and recovers capacity after saturation", async () => {
      const { admin, connector } = await setup();
      try {
        const backend = await pid(connector);
        const holding = connector.executeSQL("SELECT pg_sleep(2)", {});
        await active(admin, backend);
        await expect(connector.executeSQL("SELECT 1", {})).rejects.toThrow(/timeout|timed out/i);
        await holding;
        expect(await pid(connector)).toBe(backend);
      } finally {
        await connector.disconnect();
        await admin.end();
      }
    }, 10000);
    it("replaces a terminated idle backend without terminating the process", async () => {
      const { admin, connector } = await setup();
      try {
        const backend = await pid(connector);
        await admin.query("SELECT pg_terminate_backend($1)", [backend]);
        await expect
          .poll(
            async () => {
              try {
                return await pid(connector);
              } catch {
                return backend;
              }
            },
            { timeout: 4000 }
          )
          .not.toBe(backend);
      } finally {
        await connector.disconnect();
        await admin.end();
      }
    });
    it("discards a backend terminated during an active query", async () => {
      const { admin, connector } = await setup();
      try {
        const backend = await pid(connector);
        const pending = connector.executeSQL("SELECT pg_sleep(30)", {});
        const rejected = expect(pending).rejects.toThrow();
        await active(admin, backend);
        await admin.query("SELECT pg_terminate_backend($1)", [backend]);
        await rejected;
        expect(await pid(connector)).not.toBe(backend);
      } finally {
        await connector.disconnect();
        await admin.end();
      }
    }, 10000);
    it("recovers from a real TCP connection drop", async () => {
      const url = new URL(dsn!);
      const targetHost = url.hostname,
        targetPort = Number(url.port) || 54321;
      const sockets = new Set<Socket>();
      const proxy = createServer((socket) => {
        const upstream = connectTCP({ host: targetHost, port: targetPort });
        for (const endpoint of [socket, upstream]) {
          sockets.add(endpoint);
          endpoint.on("error", () => {
            socket.destroy();
            upstream.destroy();
          });
          endpoint.on("close", () => {
            sockets.delete(endpoint);
            socket.destroy();
            upstream.destroy();
          });
        }
        socket.pipe(upstream).pipe(socket);
      });
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      const connector = new KingbaseConnector();
      try {
        url.hostname = "127.0.0.1";
        url.port = String((proxy.address() as { port: number }).port);
        await connector.connect(url.toString(), undefined, {
          poolMaxConnections: 1,
          connectionTimeoutSeconds: 2,
        });
        const backend = await pid(connector);
        for (const socket of sockets) socket.destroy();
        await expect
          .poll(
            async () => {
              try {
                return await pid(connector);
              } catch {
                return backend;
              }
            },
            { timeout: 4000 }
          )
          .not.toBe(backend);
      } finally {
        await connector.disconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });
  });
}
