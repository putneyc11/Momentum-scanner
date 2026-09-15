# Bring your existing real research history

You do not have to wait for 60 new sessions if you already have suitable real records. This importer adds your existing observed sessions to the research library. It does not place trades, approve a strategy, change risk limits, or bypass the research evidence requirements.

The supplied code archive contains no usable real research dataset. This tool does not invent historical observations or backfill missing discovery records.

## What you need

Ask the person or system that recorded your trading data for:

1. Actual one-minute OHLCV bars, grouped by stock and exchange-session date.
2. The timestamp when the scanner first discovered that stock that day.
3. The ID of the discovery snapshot saved at that time. Keep the actual snapshot and original provider export for review.
4. Confirmation that the recorded observation window is complete, including its end. Missing bars during genuine halts are allowed; fabricated replacement candles are not.

Historical price bars alone cannot tell us when your scanner knew about a stock. Do not make up an opening-time discovery timestamp or rename demo data to `real`. If these records do not exist, this strict importer cannot turn a historical winners list into unbiased research evidence.

The importer checks the structure and timestamps, but **cannot independently verify provenance, market-calendar completeness, or whether a snapshot really existed**. Those remain the importing operator's responsibility. `sessionComplete: true` is an assertion, not proof supplied by the program.

## File format

Use a UTF-8 `.jsonl` file, no larger than 50 MiB. Each nonblank line must contain exactly one complete JSON object for one stock on one session date. Do not wrap the file in a JSON array. Do not include comments or credentials.

Each object has these fields:

| Field                | Required value                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `date`               | Actual `YYYY-MM-DD` session date in `America/New_York`, no later than today.                                           |
| `symbol`             | Uppercase US-equity ticker; letters/numbers, `.` and `-` accepted.                                                     |
| `source`             | `alpaca` for actual Alpaca observations, or `real` for actual observations from another retained source.               |
| `discoveredAt`       | Actual first admission timestamp from that session, as ISO 8601 with `Z` or a numeric UTC offset.                      |
| `universeSnapshotId` | Nonempty ID pointing to the retained contemporaneous universe/discovery snapshot.                                      |
| `sessionComplete`    | Literal `true`, only after verifying the observation window is complete.                                               |
| `previousClose`      | Optional positive number: the actual previous-session close known at the decision time. Needed for Gap-and-Go signals. |
| `bars`               | Between 25 and 960 actual one-minute bar objects, strictly chronological, with no duplicate timestamps.                |

Every bar contains exactly `timestamp`, `open`, `high`, `low`, `close`, and `volume`. Prices are positive finite numbers. The high must be at least the open, close, and low; the low must be no higher than them. Volume is a nonnegative integer share count. Timestamps must be aligned to the start of a minute, inside the same session's 04:00–20:00 Eastern window on a weekday, and already completed. Missing minutes are permitted; the simulator will not invent a fill after a missing next minute.

This illustrates the complete object shape. The capitalized strings are **placeholders**, so this example is intentionally rejected by the importer. Replace them with your actual records, include all actual bars, and put the finished object on one line:

```json
{
  "date": "ACTUAL_YYYY-MM-DD",
  "symbol": "ACTUAL_TICKER",
  "source": "ACTUAL_SOURCE_real_OR_alpaca",
  "discoveredAt": "ACTUAL_ISO_8601_ADMISSION_TIME",
  "universeSnapshotId": "ID_OF_YOUR_RETAINED_DISCOVERY_SNAPSHOT",
  "sessionComplete": true,
  "previousClose": "ACTUAL_POSITIVE_NUMBER_OR_OMIT_THIS_FIELD",
  "bars": [
    {
      "timestamp": "ACTUAL_ISO_8601_MINUTE_START",
      "open": "ACTUAL_NUMBER",
      "high": "ACTUAL_NUMBER",
      "low": "ACTUAL_NUMBER",
      "close": "ACTUAL_NUMBER",
      "volume": "ACTUAL_INTEGER"
    }
  ]
}
```

Prices and volume in your real file must be JSON numbers, without quotation marks. An exporter can produce each line with `JSON.stringify(record)`, followed by a newline. Do not copy the placeholder example as research data.

## Run it, step by step

1. Open a terminal in the `momentum-platform` folder.
2. Save the real file somewhere you can find it, for example `Documents/real-sessions.jsonl`.
3. Check it first. Replace the example path below with the full path to your actual file:

   ```bash
   npm run import:data -- --file /absolute/path/real-sessions.jsonl --validate-only
   ```

   This checks the whole file without opening or changing a database. Fix the reported line before continuing. A successful validation is not a verification of the underlying trading edge or provenance.

4. To import into your deployed system, run the command in the configured worker environment with its `DATABASE_URL` already set. The file must be available to that environment. Do not put API keys or database passwords in the file or command line.

   ```bash
   npm run import:data -- --file /absolute/path/real-sessions.jsonl
   ```

   The importer uses only the configured database. It does not call Alpaca or any trading endpoint. If no `DATABASE_URL` is configured, it writes only the local development store; stop the local development server before using that mode.

5. Open Research in the dashboard and run the research cycle. Imported data enters the same chronological splits, cost model, embargo, sample-size checks, and holdout policy as newly recorded data. It does not automatically authorize paper execution.

The production research loader currently considers the most recent **180 calendar days**. Older records can be archived in the database but are not included in that current research window. Multiple stocks on the same date still count as one session, not multiple independent days.

## Existing records and replacement

The default is to reject any existing date/symbol pair before changing data. Duplicate date/symbol objects inside a file are always rejected. The entire file is validated before any write, so a bad final line cannot leave the first lines imported.

If you deliberately need to correct existing records, first retain the original export and review the exact dates and stocks. Then add `--replace`:

```bash
npm run import:data -- --file /absolute/path/corrected-real-sessions.jsonl --replace
```

`--replace` replaces the complete matching stock/session record; it does not merge candles. Replacements are audited with record/session counts, dates, and a SHA-256 fingerprint. Do not use this flag to overwrite data just because you inspected a disappointing research result. Replacing data does not erase consumed-holdout history.

PostgreSQL imports and their audit entry commit together in one transaction. If an insert races another writer and conflicts without `--replace`, the whole import rolls back. Local development JSON persistence is single-process and cannot offer database transaction guarantees for a disk failure; production history belongs in PostgreSQL. The import command reports completion only after all writes succeed.
