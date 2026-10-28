import { describe, it, expect } from "vitest";
import { DMDSNParser } from "../dm/index.js";
import { DMSessionPool } from "../dm/pool.js";
import { openDMSession, destroyDMSession } from "../dm/transport.js";

describe.skipIf(!process.env.DM_TEST_DSN)("DM pool lifecycle", () => {
  async function setup() {
    const parsed = await new DMDSNParser().parse(process.env.DM_TEST_DSN!);
    return new DMSessionPool({
      max: 1,
      waitMs: 1000,
      create: () => openDMSession(parsed.connection, parsed.tls),
    });
  }
  it("times out queued acquisition without leaking capacity", async () => {
    const pool = await setup();
    try {
      const first = await pool.acquire();
      await expect(pool.acquire()).rejects.toThrow("acquisition timed out");
      pool.release(first, true);
      const next = await pool.acquire();
      expect(next).toBe(first);
      pool.release(next, false);
      const fresh = await pool.acquire();
      expect(fresh).not.toBe(first);
      pool.release(fresh, true);
    } finally {
      pool.close();
    }
  });
  it("rejects waiting callers and destroys active sessions on disconnect", async () => {
    const pool = await setup();
    const first = await pool.acquire();
    const waiting = pool.acquire();
    const assertion = expect(waiting).rejects.toThrow("closed");
    pool.close();
    await assertion;
    expect(first.socket.destroyed).toBe(true);
    await expect(pool.acquire()).rejects.toThrow("closed");
  });
  it("replaces a dead idle socket", async () => {
    const pool = await setup();
    try {
      const first = await pool.acquire();
      pool.release(first, true);
      destroyDMSession(first);
      const next = await pool.acquire();
      expect(next).not.toBe(first);
      pool.release(next, true);
    } finally {
      pool.close();
    }
  });
  it("recovers capacity after the connection factory rejects", async () => {
    const parsed = await new DMDSNParser().parse(process.env.DM_TEST_DSN!);
    let attempt = 0;
    const pool = new DMSessionPool({
      max: 1,
      waitMs: 1000,
      create: async () => {
        if (++attempt === 1) throw new Error("factory failure");
        return openDMSession(parsed.connection, parsed.tls);
      },
    });
    try {
      await expect(pool.acquire()).rejects.toThrow("factory failure");
      const next = await pool.acquire();
      expect(next.closed).toBe(false);
      pool.release(next, true);
    } finally {
      pool.close();
    }
  });
});
