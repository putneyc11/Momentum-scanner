import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type StoreEvent = { type: string; data: unknown };
/** PostgreSQL is the production source of truth. Local JSON is single-process development only. */
export class Store {
  readonly events = new EventEmitter();
  pool?: Pool;
  private cache: Record<string, unknown> = {};
  private queue = Promise.resolve();
  private listener?: PoolClient;
  private leader?: PoolClient;
  private closed = false;
  constructor(
    databaseUrl: string,
    private file = path.resolve("state/dev-state.json"),
  ) {
    if (databaseUrl)
      this.pool = new Pool({
        connectionString: databaseUrl,
        max: 8,
        connectionTimeoutMillis: 10000,
      });
    this.events.setMaxListeners(500);
  }
  async init() {
    if (this.pool) {
      await this.pool
        .query(`CREATE TABLE IF NOT EXISTS momentum_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE IF NOT EXISTS momentum_audit (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, action text NOT NULL, detail jsonb NOT NULL);
        CREATE TABLE IF NOT EXISTS momentum_bar_days (date text NOT NULL, symbol text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(date,symbol));
        CREATE TABLE IF NOT EXISTS momentum_order_intents (id text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`);
      await this.listen();
    } else {
      try {
        this.cache = JSON.parse(await readFile(this.file, "utf8"));
      } catch (e: any) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  private async listen() {
    if (!this.pool || this.closed) return;
    const client = await this.pool.connect();
    this.listener = client;
    client.on("notification", (n) => {
      if (n.payload)
        try {
          const value = JSON.parse(n.payload);
          for (const event of Array.isArray(value) ? value : [value])
            this.events.emit("event", event);
        } catch {}
    });
    client.on("error", () => {
      client.release(true);
      this.listener = undefined;
      if (!this.closed)
        setTimeout(() => this.listen().catch(() => {}), 3000).unref();
    });
    await client.query("LISTEN momentum_events");
  }
  async get<T>(key: string, fallback: T): Promise<T> {
    if (this.pool) {
      const r = await this.pool.query(
        "SELECT value FROM momentum_state WHERE key=$1",
        [key],
      );
      return r.rows[0]?.value ?? fallback;
    }
    return structuredClone((this.cache[key] ?? fallback) as T);
  }
  async put(key: string, value: unknown) {
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO momentum_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()",
        [key, JSON.stringify(value)],
      );
      return;
    }
    this.cache[key] = structuredClone(value);
    const snapshot = JSON.stringify(this.cache);
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file + ".tmp", snapshot, { mode: 0o600 });
      await rename(this.file + ".tmp", this.file);
    });
    await this.queue;
  }
  async insertOnce(key: string, value: unknown): Promise<boolean> {
    if (this.pool) {
      const r = await this.pool.query(
        "INSERT INTO momentum_state(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING key",
        [key, JSON.stringify(value)],
      );
      return r.rowCount === 1;
    }
    if (key in this.cache) return false;
    await this.put(key, value);
    return true;
  }
  async list<T>(prefix: string): Promise<T[]> {
    // Never silently truncate order ownership or performance history. API presentation may
    // paginate, but reconciliation and risk require every recorded intent.
    if (this.pool) {
      const r = await this.pool.query(
        "SELECT value FROM momentum_state WHERE starts_with(key,$1) ORDER BY updated_at DESC",
        [prefix],
      );
      return r.rows.map((r) => r.value);
    }
    return Object.entries(this.cache)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => structuredClone(v) as T)
      .reverse();
  }
  async publish(type: string, data: unknown) {
    const event = { type, data };
    const payload = JSON.stringify(event);
    if (this.pool) {
      if (Buffer.byteLength(payload) < 7800)
        await this.pool.query("SELECT pg_notify($1,$2)", [
          "momentum_events",
          payload,
        ]);
    } else this.events.emit("event", event);
  }
  async publishBatch(events: StoreEvent[]) {
    if (!this.pool) {
      for (const event of events) this.events.emit("event", event);
      return;
    }
    let chunk: StoreEvent[] = [];
    let size = 2;
    for (const event of events) {
      const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (size + bytes >= 7600 && chunk.length) {
        await this.pool.query("SELECT pg_notify($1,$2)", [
          "momentum_events",
          JSON.stringify(chunk),
        ]);
        chunk = [];
        size = 2;
      }
      chunk.push(event);
      size += bytes;
    }
    if (chunk.length)
      await this.pool.query("SELECT pg_notify($1,$2)", [
        "momentum_events",
        JSON.stringify(chunk),
      ]);
  }
  async audit(actor: string, action: string, detail: unknown) {
    if (this.pool)
      await this.pool.query(
        "INSERT INTO momentum_audit(actor,action,detail) VALUES($1,$2,$3)",
        [actor, action, JSON.stringify(detail)],
      );
    else {
      const items = await this.get<any[]>("audit", []);
      await this.put(
        "audit",
        [
          { at: new Date().toISOString(), actor, action, detail },
          ...items,
        ].slice(0, 500),
      );
    }
  }
  async auditLog(limit = 100): Promise<unknown[]> {
    if (this.pool) {
      const r = await this.pool.query(
        "SELECT at,actor,action,detail FROM momentum_audit ORDER BY id DESC LIMIT $1",
        [Math.min(500, Math.max(1, limit))],
      );
      return r.rows;
    }
    return (await this.get<unknown[]>("audit", [])).slice(0, limit);
  }
  async saveDay(day: { date: string; symbol: string; [k: string]: unknown }) {
    if (this.pool)
      await this.pool.query(
        "INSERT INTO momentum_bar_days(date,symbol,data) VALUES($1,$2,$3) ON CONFLICT(date,symbol) DO UPDATE SET data=$3",
        [day.date, day.symbol, JSON.stringify(day)],
      );
    else await this.put(`day:${day.date}:${day.symbol}`, day);
  }
  async days<T>(): Promise<T[]> {
    if (this.pool) {
      const r = await this.pool.query(
        "SELECT data FROM momentum_bar_days WHERE date >= $1 ORDER BY date,symbol",
        [new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)],
      );
      return r.rows.map((r) => r.data);
    }
    return this.list<T>("day:");
  }
  async acquireLeader(): Promise<boolean> {
    if (!this.pool) return true;
    const client = await this.pool.connect();
    const r = await client.query(
      "SELECT pg_try_advisory_lock(63742101) AS acquired",
    );
    if (!r.rows[0].acquired) {
      client.release();
      return false;
    }
    this.leader = client;
    // Loss of the lease must stop this worker before another one can place orders.
    client.on("error", () => {
      this.events.emit("lease-lost");
    });
    return true;
  }
  async close() {
    this.closed = true;
    this.listener?.release();
    this.leader?.release();
    await this.pool?.end();
  }
}
