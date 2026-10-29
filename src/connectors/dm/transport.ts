import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIP, type Socket } from "node:net";
import { connect as connectTLS, type TLSSocket } from "node:tls";
import dm from "dmdb";

/** Narrow bridge to dmdb 1.0.52452; no process-wide driver or TLS monkey patches. */
export interface DMSession extends dm.Connection {
  socket: Socket;
  tlsSocket?: TLSSocket;
  sslEncrypt: number;
  closed: boolean;
  sessionID: bigint;
  access: { Zt: () => Promise<unknown> };
  once(event: string, listener: () => void): this;
  openConnection(group?: unknown): Promise<DMSession>;
  startTLS(encrypted: boolean): Promise<void>;
  doUnbinds(socket: Socket): void;
  doBinds(socket: Socket): Socket;
}

export interface DMTLSConfig {
  mode: "disable" | "require" | "verify-ca" | "verify-full";
  hostname: string;
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  paths?: { ca?: string; cert?: string; key?: string };
}

const require = createRequire(import.meta.url);
if (require("dmdb/package.json").version !== "1.0.52452") {
  throw new Error("DM transport requires the tested dmdb 1.0.52452 driver");
}
const { Connection } = require("dmdb/src/driver/connection.js") as {
  Connection: { newInstanceOfConnection(properties: unknown): DMSession };
};
const driver = dm as typeof dm & {
  parseConnectionAttr(options: dm.ConnectionAttributes): Promise<{ getAny(key: string): unknown }>;
};

export function readTLSFile(path: string | undefined): Buffer | undefined {
  return path
    ? readFileSync(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path)
    : undefined;
}

/** Enforce TLS before the login packet, including plaintext downgrade rejection. */
export async function openDMSession(
  options: dm.ConnectionAttributes,
  tls: DMTLSConfig
): Promise<DMSession> {
  // Each new physical connection observes rotated files; existing TLS sessions remain valid.
  if (tls.paths) {
    tls = {
      ...tls,
      ca: readTLSFile(tls.paths.ca),
      cert: readTLSFile(tls.paths.cert),
      key: readTLSFile(tls.paths.key),
    };
  }
  const properties = await driver.parseConnectionAttr(options);
  const connection = Connection.newInstanceOfConnection(properties);
  connection.startTLS = async (encrypted) => {
    if (!encrypted || tls.mode === "disable")
      throw new Error("DM TLS mode does not match server encryption");
    await new Promise<void>((resolve, reject) => {
      connection.doUnbinds(connection.socket);
      const secure = connectTLS({
        socket: connection.socket,
        servername: isIP(tls.hostname) ? undefined : tls.hostname,
        minVersion: "TLSv1.2",
        ca: tls.ca,
        cert: tls.cert,
        key: tls.key,
        rejectUnauthorized: tls.mode !== "require",
        // Node uses host for IP SAN validation when there is no SNI.
        host: tls.hostname,
        ...(tls.mode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
      });
      connection.tlsSocket = secure;
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
      connection.socket = connection.doBinds(secure);
    });
  };
  connection.once("connect", () => {
    const login = connection.access.Zt.bind(connection.access);
    connection.access.Zt = async () => {
      if (
        tls.mode !== "disable" &&
        (!connection.tlsSocket?.encrypted || connection.sslEncrypt !== 1)
      ) {
        throw new Error("DM server did not negotiate full TLS encryption; refusing login");
      }
      return login();
    };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection.openConnection(properties.getAny("epGroup")),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          destroyDMSession(connection);
          reject(new Error("DM connection/TLS handshake timed out"));
        }, options.connectTimeout ?? 10000);
      }),
    ]);
  } catch (error) {
    destroyDMSession(connection);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function destroyDMSession(connection: DMSession): void {
  connection.closed = true;
  connection.tlsSocket?.destroy();
  connection.socket?.destroy();
}
