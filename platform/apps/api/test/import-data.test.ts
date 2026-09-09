import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchDay } from "@momentum/engine";
import type { Store } from "../src/store.js";
import {
  importResearchRecords,
  MAX_IMPORT_BYTES,
  parseImportArguments,
  parseResearchJsonl,
  validateResearchRecord,
} from "../src/import-data.js";

const now = "2026-09-09T22:00:00Z";
/** Explicitly fabricated unit-test fixture. It never leaves an in-memory fake store. */
function fixture(symbol = "TEST", date = "2026-09-08"): ResearchDay {
  return {
    date,
    symbol,
    source: "real",
    previousClose: 10,
    discoveredAt: `${date}T13:30:00Z`,
    universeSnapshotId: "unit-test-fixture-only",
    sessionComplete: true,
    bars: Array.from({ length: 25 }, (_, index) => ({
      timestamp: new Date(
        Date.parse(`${date}T13:30:00Z`) + index * 60_000,
      ).toISOString(),
      open: 10,
      high: 10.2,
      low: 9.9,
      close: 10.1,
      volume: 1000,
    })),
  };
}
class FakeStore {
  data = new Map<string, ResearchDay>();
  saveDay = vi.fn(async (day: ResearchDay) => {
    this.data.set(`${day.date}:${day.symbol}`, structuredClone(day));
  });
  audit = vi.fn(async () => {});
  list = vi.fn(async () => [...this.data.values()]);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("historical research input validation", () => {
  it("preserves actual normalized fields and orders records without mutating their bars", () => {
    const first = fixture("AAA"),
      second = fixture("BBB"),
      original = structuredClone(first);
    const records = parseResearchJsonl(
      JSON.stringify(second) + "\r\n" + JSON.stringify(first) + "\n",
      now,
    );
    expect(records.map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
    expect(records[0]).toEqual(original);
    expect(first).toEqual(original);
  });
  it("requires real provenance fields without relabeling demo/synthetic observations", () => {
    for (const source of ["demo", "synthetic", "unknown"])
      expect(() =>
        validateResearchRecord({ ...fixture(), source }, 1, now),
      ).toThrow("only actual");
    expect(() =>
      validateResearchRecord({ ...fixture(), discoveredAt: undefined }, 1, now),
    ).toThrow("discoveredAt");
    expect(() =>
      validateResearchRecord({ ...fixture(), universeSnapshotId: "" }, 1, now),
    ).toThrow("universeSnapshotId");
    expect(() =>
      validateResearchRecord({ ...fixture(), sessionComplete: false }, 1, now),
    ).toThrow("sessionComplete");
    expect(() =>
      validateResearchRecord({ ...fixture(), previousClose: 0 }, 1, now),
    ).toThrow("previousClose");
  });
  it("rejects duplicate symbol/date records, future sessions and impossible calendar dates", () => {
    expect(() =>
      parseResearchJsonl(
        [fixture(), fixture()].map(JSON.stringify).join("\n"),
        now,
      ),
    ).toThrow("duplicate date/symbol");
    expect(() =>
      validateResearchRecord(fixture("TEST", "2026-09-10"), 1, now),
    ).toThrow("future session");
    expect(() =>
      validateResearchRecord({ ...fixture(), date: "2026-02-30" }, 1, now),
    ).toThrow("real YYYY-MM-DD");
  });
  it("rejects malformed OHLCV, unsorted/duplicate bars and future or cross-session observations", () => {
    const malformed = fixture();
    malformed.bars[3].high = 9;
    expect(() => validateResearchRecord(malformed, 1, now)).toThrow(
      "consistent OHLC",
    );
    const duplicate = fixture();
    duplicate.bars[3].timestamp = duplicate.bars[2].timestamp;
    expect(() => validateResearchRecord(duplicate, 1, now)).toThrow(
      "strictly chronological",
    );
    const cross = fixture();
    cross.bars[3].timestamp = "2026-09-07T13:33:00Z";
    expect(() => validateResearchRecord(cross, 1, now)).toThrow("inside that");
    const future = fixture("TEST", "2026-09-09");
    expect(() =>
      validateResearchRecord(future, 1, "2026-09-09T13:40:00Z"),
    ).toThrow("not yet completed");
    const infinite = fixture();
    infinite.bars[0].volume = Infinity;
    expect(() => validateResearchRecord(infinite, 1, now)).toThrow(
      "consistent OHLC",
    );
  });
  it("rejects unsupported fields and malformed JSON without echoing potentially private values", () => {
    expect(() =>
      validateResearchRecord({ ...fixture(), apiKey: "do-not-echo" }, 1, now),
    ).toThrow("unknown record field");
    try {
      parseResearchJsonl('{"secret":"do-not-echo" BROKEN}', now);
    } catch (error) {
      expect(String(error)).not.toContain("do-not-echo");
    }
    expect(() => parseResearchJsonl("", now)).toThrow("no research records");
    expect(() =>
      parseResearchJsonl(" ".repeat(MAX_IMPORT_BYTES + 1), now),
    ).toThrow("50 MiB");
  });
  it("requires explicit arguments for replacement and supports a zero-write validation pass", () => {
    expect(
      parseImportArguments([
        "--file",
        "/tmp/observed.jsonl",
        "--validate-only",
      ]),
    ).toMatchObject({
      file: "/tmp/observed.jsonl",
      replace: false,
      validateOnly: true,
    });
    expect(
      parseImportArguments(["--file", "/tmp/observed.jsonl", "--replace"])
        .replace,
    ).toBe(true);
    expect(() => parseImportArguments(["--file", "--replace"])).toThrow();
    expect(() =>
      parseImportArguments(["--file", "a", "--file", "b"]),
    ).toThrow();
    expect(() => parseImportArguments(["--unknown"])).toThrow("Unknown option");
  });
});
describe("preflight and persistence boundaries", () => {
  it("validates the complete batch before any persistence or audit write", async () => {
    const store = new FakeStore(),
      broken = fixture("BBB");
    broken.bars[20].low = 20;
    await expect(
      importResearchRecords(store as unknown as Store, [fixture(), broken]),
    ).rejects.toThrow("consistent OHLC");
    expect(store.list).not.toHaveBeenCalled();
    expect(store.saveDay).not.toHaveBeenCalled();
    expect(store.audit).not.toHaveBeenCalled();
  });
  it("rejects existing day conflicts without writes; replacement is explicit and audited", async () => {
    const store = new FakeStore();
    store.data.set("2026-09-08:TEST", fixture());
    await expect(
      importResearchRecords(store as unknown as Store, [fixture()]),
    ).rejects.toThrow("already exist");
    expect(store.saveDay).not.toHaveBeenCalled();
    expect(store.audit).not.toHaveBeenCalled();
    const result = await importResearchRecords(
      store as unknown as Store,
      [fixture()],
      true,
    );
    expect(result.replaced).toBe(1);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(store.saveDay).toHaveBeenCalledTimes(1);
    expect(store.audit).toHaveBeenLastCalledWith(
      "data-import-cli",
      "research-data-import-replace",
      expect.objectContaining({ replace: true, replaced: 1 }),
    );
  });
  it("rolls back the whole production batch if a concurrent duplicate appears", async () => {
    let inserts = 0;
    const client = {
      release: vi.fn(),
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith("SELECT")) return { rows: [] };
        if (sql.startsWith("INSERT INTO momentum_bar_days") && ++inserts === 2)
          throw Object.assign(new Error("duplicate"), { code: "23505" });
        return { rows: [] };
      }),
    };
    const store = {
      pool: { connect: vi.fn(async () => client) },
    } as unknown as Store;
    await expect(
      importResearchRecords(store, [fixture("AAA"), fixture("BBB")]),
    ).rejects.toThrow("complete transaction was rolled back");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(
      client.query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO momentum_audit"),
      ),
    ).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });
  it("commits data and its audit record together without any broker request", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No network expected"));
    const client = {
      release: vi.fn(),
      query: vi.fn(async () => ({ rows: [] })),
    };
    const store = {
      pool: { connect: vi.fn(async () => client) },
    } as unknown as Store;
    const result = await importResearchRecords(store, [fixture()]);
    expect(result.records).toBe(1);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(
      client.query.mock.calls.some((call: any) =>
        call[0].startsWith("INSERT INTO momentum_audit"),
      ),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
