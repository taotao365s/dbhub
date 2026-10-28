import { destroyDMSession, type DMSession } from "./transport.js";

interface Waiter {
  resolve(connection: DMSession): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Bounded per-source pool. Read-only sessions are reusable after rollback.
 * Writes, errors and timeouts discard their session rather than leaking state.
 * A local pool permits per-session TLS hooks before login; dmdb's native pool
 * has no connection factory/reset hooks and cannot enforce this boundary.
 */
export class DMSessionPool {
  private readonly sessions = new Set<DMSession>();
  private readonly idle: DMSession[] = [];
  private readonly waiters: Waiter[] = [];
  private opening = 0;
  private closed = false;
  constructor(
    private readonly options: {
      max: number;
      waitMs: number;
      create(): Promise<DMSession>;
    }
  ) {}

  acquire(): Promise<DMSession> {
    if (this.closed) return Promise.reject(new Error("DM pool is closed"));
    if (this.waiters.length >= 500) return Promise.reject(new Error("DM connection queue is full"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("DM connection pool acquisition timed out"));
        }, this.options.waitMs),
      };
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.waiters.length) {
      let connection = this.idle.pop();
      while (connection && (connection.closed || connection.socket.destroyed)) {
        this.sessions.delete(connection);
        destroyDMSession(connection);
        connection = this.idle.pop();
      }
      if (connection) {
        const waiter = this.waiters.shift()!;
        clearTimeout(waiter.timer);
        waiter.resolve(connection);
      } else if (
        this.sessions.size + this.opening < this.options.max &&
        this.opening < this.waiters.length
      ) {
        this.opening++;
        void this.options
          .create()
          .then((created) => {
            if (this.closed) destroyDMSession(created);
            else {
              this.sessions.add(created);
              this.idle.push(created);
            }
          })
          .catch((error: Error) => {
            const waiter = this.waiters.shift();
            if (waiter) {
              clearTimeout(waiter.timer);
              waiter.reject(error);
            }
          })
          .finally(() => {
            this.opening--;
            this.pump();
          });
      } else break;
    }
  }

  release(connection: DMSession, reusable: boolean): void {
    if (!this.sessions.has(connection)) return;
    if (this.closed || !reusable || connection.closed || connection.socket.destroyed) {
      this.sessions.delete(connection);
      destroyDMSession(connection);
    } else {
      this.idle.push(connection);
    }
    this.pump();
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("DM pool is closed"));
    }
    for (const connection of this.sessions) destroyDMSession(connection);
    this.sessions.clear();
    this.idle.length = 0;
  }
}
