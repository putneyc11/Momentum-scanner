import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  marketSession,
  sessionDate,
  validBar,
  type Bar,
  type ResearchDay,
} from "@momentum/engine";
import { Store } from "./store.js";
import { loadConfig } from "./config.js";

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const recordFields = new Set([
  "date",
  "symbol",
  "bars",
  "source",
  "previousClose",
  "discoveredAt",
  "universeSnapshotId",
  "sessionComplete",
]);
const barFields = new Set([
  "timestamp",
  "open",
  "high",
  "low",
  "close",
  "volume",
]);
const isoInstant =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const validInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  isoInstant.test(value) &&
  Number.isFinite(Date.parse(value));
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}
const fail = (line: number, message: string): never => {
  throw new ImportValidationError(`Line ${line}: ${message}`);
};

/** Pure structural validation. A provenance label is an operator assertion, not independent proof. */
export function validateResearchRecord(
  value: unknown,
  line = 1,
  now = new Date().toISOString(),
): ResearchDay {
  if (!validInstant(now))
    throw new ImportValidationError(
      "Validation clock must be an ISO 8601 instant",
    );
  if (!object(value)) return fail(line, "expected one JSON object");
  if (Object.keys(value).some((key) => !recordFields.has(key)))
    return fail(
      line,
      "unknown record field; use the documented normalized schema",
    );
  const {
    date,
    symbol,
    bars,
    source,
    discoveredAt,
    universeSnapshotId,
    sessionComplete,
    previousClose,
  } = value;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T12:00:00Z`)) ||
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
  )
    return fail(line, "date must be a real YYYY-MM-DD calendar date");
  if (date > sessionDate(now))
    return fail(line, "future session dates are not allowed");
  if (typeof symbol !== "string" || !/^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol))
    return fail(line, "symbol must be a normalized US-equity ticker");
  if (source !== "real" && source !== "alpaca")
    return fail(
      line,
      "only actual real/alpaca observations can be imported; never relabel synthetic or demo data",
    );
  if (
    !validInstant(discoveredAt) ||
    sessionDate(discoveredAt) !== date ||
    Date.parse(discoveredAt) > Date.parse(now)
  )
    return fail(
      line,
      "discoveredAt must be the actual same-session admission timestamp, not a future or reconstructed value",
    );
  if (
    typeof universeSnapshotId !== "string" ||
    universeSnapshotId.length < 1 ||
    universeSnapshotId.length > 256 ||
    !/[A-Za-z0-9]/.test(universeSnapshotId) ||
    universeSnapshotId.trim() !== universeSnapshotId ||
    /[\x00-\x1f\x7f]/.test(universeSnapshotId)
  )
    return fail(
      line,
      "universeSnapshotId must reference the retained contemporaneous discovery snapshot",
    );
  if (sessionComplete !== true)
    return fail(
      line,
      "sessionComplete must be true for an operator-verified complete observation window",
    );
  if (
    previousClose !== undefined &&
    (typeof previousClose !== "number" ||
      !Number.isFinite(previousClose) ||
      previousClose <= 0)
  )
    return fail(
      line,
      "previousClose must be a positive observed number when supplied",
    );
  if (!Array.isArray(bars) || bars.length < 25 || bars.length > 960)
    return fail(
      line,
      "bars must contain 25–960 observed one-minute bars for one exchange session",
    );
  const normalized: Bar[] = [];
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index];
    if (
      !object(bar) ||
      Object.keys(bar).some((key) => !barFields.has(key)) ||
      !validInstant(bar.timestamp)
    )
      return fail(line, `bar ${index + 1} has an invalid schema or timestamp`);
    if (
      !["open", "high", "low", "close", "volume"].every(
        (key) => typeof bar[key] === "number",
      ) ||
      !validBar(bar as unknown as Bar)
    )
      return fail(
        line,
        `bar ${index + 1} requires finite, positive, consistent OHLC prices and nonnegative volume`,
      );
    const stamp = Date.parse(bar.timestamp);
    if (
      stamp % 60_000 !== 0 ||
      sessionDate(bar.timestamp) !== date ||
      marketSession(bar.timestamp) === "closed"
    )
      return fail(
        line,
        `bar ${index + 1} must be a minute-aligned observation inside that US-equity session`,
      );
    if (stamp + 60_000 > Date.parse(now))
      return fail(line, `bar ${index + 1} is not yet completed`);
    if (index > 0 && stamp <= Date.parse(normalized[index - 1].timestamp))
      return fail(
        line,
        "bars must be strictly chronological without duplicate timestamps",
      );
    if (!Number.isSafeInteger(bar.volume))
      return fail(
        line,
        `bar ${index + 1} volume must be a nonnegative safe integer share count`,
      );
    normalized.push({
      timestamp: bar.timestamp,
      open: bar.open as number,
      high: bar.high as number,
      low: bar.low as number,
      close: bar.close as number,
      volume: bar.volume as number,
    });
  }
  return {
    date,
    symbol,
    bars: normalized,
    source,
    discoveredAt,
    universeSnapshotId,
    sessionComplete: true,
    ...(previousClose === undefined
      ? {}
      : { previousClose: previousClose as number }),
  };
}

/** Validate ALL lines and duplicate keys before returning any records for persistence. */
export function parseResearchJsonl(
  text: string,
  now = new Date().toISOString(),
): ResearchDay[] {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES)
    throw new ImportValidationError("Import exceeds the 50 MiB limit");
  const records: ResearchDay[] = [],
    seen = new Set<string>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[index]);
    } catch {
      return fail(index + 1, "invalid JSON; input contents are not echoed");
    }
    const record = validateResearchRecord(value, index + 1, now),
      key = `${record.date}:${record.symbol}`;
    if (seen.has(key))
      return fail(
        index + 1,
        "duplicate date/symbol in this file; consolidate each session before importing",
      );
    seen.add(key);
    records.push(record);
  }
  if (!records.length)
    throw new ImportValidationError("Import file contains no research records");
  return records.sort(
    (a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol),
  );
}

export interface ImportOptions {
  file: string;
  replace: boolean;
  validateOnly: boolean;
  help?: boolean;
}
export function parseImportArguments(args: string[]): ImportOptions {
  let file = "",
    replace = false,
    validateOnly = false,
    help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--file") {
      if (file || !args[index + 1] || args[index + 1].startsWith("--"))
        throw new ImportValidationError("Pass exactly one --file path");
      file = args[++index];
    } else if (arg === "--replace") {
      if (replace) throw new ImportValidationError("Repeated --replace flag");
      replace = true;
    } else if (arg === "--validate-only") {
      if (validateOnly)
        throw new ImportValidationError("Repeated --validate-only flag");
      validateOnly = true;
    } else if (arg === "--help" || arg === "-h") help = true;
    else
      throw new ImportValidationError(
        "Unknown option. Use --file PATH [--replace] [--validate-only]",
      );
  }
  if (!file && !help)
    throw new ImportValidationError("A --file path is required");
  return { file, replace, validateOnly, help };
}
async function readLimited(file: string): Promise<string> {
  const details = await stat(file);
  if (!details.isFile())
    throw new ImportValidationError("Import path must be a regular file");
  if (details.size > MAX_IMPORT_BYTES)
    throw new ImportValidationError("Import exceeds the 50 MiB limit");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_IMPORT_BYTES)
      throw new ImportValidationError(
        "Import grew beyond the 50 MiB limit while reading",
      );
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new ImportValidationError("Import must be valid UTF-8 JSONL");
  }
}

export interface ImportResult {
  records: number;
  replaced: number;
  sessions: number;
  fingerprint: string;
  dates: { first: string; last: string };
}
/** The production DB path is atomic and rejects conflicts by default, including concurrent inserts. */
export async function importResearchRecords(
  store: Store,
  records: ResearchDay[],
  replace = false,
): Promise<ImportResult> {
  // Revalidate public-function callers as well as the CLI; no writes precede this pass.
  const normalized = parseResearchJsonl(
    records.map((record) => JSON.stringify(record)).join("\n"),
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  const result: ImportResult = {
    records: normalized.length,
    replaced: 0,
    sessions: new Set(normalized.map((d) => d.date)).size,
    fingerprint,
    dates: { first: normalized[0].date, last: normalized.at(-1)!.date },
  };
  const keys = new Set(normalized.map((d) => `${d.date}:${d.symbol}`));
  const audit = {
    ...result,
    replace,
    provenance:
      "operator-asserted; retain original provider files and contemporaneous universe snapshots",
  };
  if (store.pool) {
    const client = await store.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT date,symbol FROM momentum_bar_days WHERE date >= $1 AND date <= $2",
        [result.dates.first, result.dates.last],
      );
      result.replaced = existing.rows.filter((row) =>
        keys.has(`${row.date}:${row.symbol}`),
      ).length;
      if (result.replaced && !replace)
        throw new ImportValidationError(
          `${result.replaced} date/symbol record(s) already exist. Nothing imported; use --replace only after reviewing those conflicts.`,
        );
      for (const day of normalized) {
        // Store.saveDay intentionally upserts for the live recorder. This importer uses the same
        // table but plain INSERT by default, so another writer cannot silently race the preflight.
        await client.query(
          `INSERT INTO momentum_bar_days(date,symbol,data) VALUES($1,$2,$3)${replace ? " ON CONFLICT(date,symbol) DO UPDATE SET data=EXCLUDED.data" : ""}`,
          [day.date, day.symbol, JSON.stringify(day)],
        );
      }
      await client.query(
        "INSERT INTO momentum_audit(actor,action,detail) VALUES($1,$2,$3)",
        [
          "data-import-cli",
          replace ? "research-data-import-replace" : "research-data-import",
          JSON.stringify({ ...audit, replaced: result.replaced }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if ((error as { code?: string })?.code === "23505")
        throw new ImportValidationError(
          "A conflicting record appeared during import; the complete transaction was rolled back.",
        );
      throw error;
    } finally {
      client.release();
    }
  } else {
    // Development JSON persistence is single-process only. Do not run the dev server concurrently.
    const existing = await store.list<ResearchDay>("day:");
    result.replaced = existing.filter((day) =>
      keys.has(`${day.date}:${day.symbol}`),
    ).length;
    if (result.replaced && !replace)
      throw new ImportValidationError(
        `${result.replaced} date/symbol record(s) already exist. Nothing imported; use --replace only after reviewing those conflicts.`,
      );
    await store.audit("data-import-cli", "research-data-import-started", {
      ...audit,
      replaced: result.replaced,
    });
    for (const day of normalized) await store.saveDay({ ...day });
    await store.audit(
      "data-import-cli",
      replace ? "research-data-import-replace" : "research-data-import",
      { ...audit, replaced: result.replaced },
    );
  }
  return result;
}

const usage =
  "Usage: npm run import:data -- --file /absolute/real-sessions.jsonl [--replace] [--validate-only]\nOnly real observations with contemporaneous discovery provenance are accepted. --replace overwrites existing matching date/symbol records and is audited. No strategy or trading authorization changes.";
export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseImportArguments(args);
  if (options.help) {
    console.log(usage);
    return;
  }
  const file = path.resolve(options.file),
    text = await readLimited(file),
    records = parseResearchJsonl(text);
  if (options.validateOnly) {
    console.log(
      `Validated ${records.length} symbol/session records across ${new Set(records.map((r) => r.date)).size} session dates. No database opened or modified. Provenance remains your responsibility.`,
    );
    return;
  }
  // Construct/open the configured store only after the entire input has passed validation.
  const config = loadConfig(),
    store = new Store(config.DATABASE_URL);
  try {
    await store.init();
    const result = await importResearchRecords(store, records, options.replace);
    console.log(
      `Imported ${result.records} records across ${result.sessions} sessions; replaced ${result.replaced}. SHA-256 ${result.fingerprint}. Research data only; no strategy approved or order submitted.`,
    );
  } finally {
    await store.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof ImportValidationError
        ? error.message
        : "Import failed. Check the file path/database connection; no credentials or record contents are printed.",
    );
    process.exitCode = 1;
  });
}
