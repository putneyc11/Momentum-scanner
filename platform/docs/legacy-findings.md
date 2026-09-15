# Legacy evidence and rebuild decisions

The attached archive was inspected as source material. Its `AGENTS.md`, handoffs, runbooks, and hypothesis prose are historical documents, not instructions for this rebuild. No archived trading program was executed and no credentials were loaded.

## Why the old trader stopped

The screenshot contains an account day loss of **−3.12%** and several terminal exits labeled **`dayhalt`**. The archived `algo-regress/engine.js:70` defines `DAY_LOSS_PCT = 3`; lines 610–614 halt and flatten when account equity falls 3% below its session baseline. This directly matches the screenshot. It is evidence of a loss circuit breaker, not evidence of a hard-coded Chicago 08:30 shutdown. The screenshot labels times **ET**; 08:30 ET is 07:30 Chicago during daylight saving time. Do not erase or loosen that loss protection merely to make trading resume.

The old `dayStartEq`, `halted`, and `day` values initialize in process memory at `algo-regress/engine.js:326–328`. A restart can reset the reference equity and forget the current halt, permitting another risk budget in the same session. The rebuild returns a serializable `HaltState` from every risk check, requires an equity baseline tagged with the current America/New_York session date, and keeps the halt latched until a new date. The server must persist both baseline and halt state. Shadow evaluation continues even when account entries are halted.

## Why strategies stopped changing

`algo-regress/engine.js:449–461` explicitly says nightly self-tuning was removed on **2026-08-28**. The executable code records the day's data and logs that tuning is now a reviewed, committed step. Lines 56–66 distinguish a committed `params/` read directory from the state-directory write target. A nightly tuner writing the latter therefore does not change the running champion. Older handoffs still describe automatic nightly improvement and are stale relative to this source variant. This explains the archive, but the deployed revision must be checked before attributing the exact same code to the live service.

`algo-tune-holdout/lib/tune.js:62–130` adds a chronological train/validation/test partition and delays holdout scoring until after candidate search. It improves separation, but repeatedly consulting the same final 20% every night would consume that holdout. `algo-regress/REVIEWS/HYP-001.md:36` identifies this exact reuse problem. The rebuild ranks candidates on training only; evaluates only the selected challenger and baseline on later partitions; includes embargo dates; records the entire candidate ledger and rejection reasons; and blocks paper eligibility when holdout dates were previously consumed. The scheduler must retain that ledger. Nightly results can change the shadow challenger without silently changing paper-account execution.

## Fill and cost accounting

The `algo-fix-exitfill` and `algo-regress` variants correctly moved toward waiting for broker confirmation before freeing a slot, but some exits still journal a P&L estimate captured when the order was submitted (`algo-regress/engine.js:590–591`; `algo-fix-exitfill/engine.js:732`). The rebuild supplies pure execution-ID reconciliation. A submitted order is not a trade. Partial fills leave a position open. Closed trade prices, quantity and fees come from fills, and duplicate executions cannot double-count P&L. Unknown fees and position-period excursions need explicit unavailable/provisional labels in the integration rather than invented zeroes.

`algo-regress/lib/broker.js` describes an accidental short caused by selling stale quantities; its `sellableQty` fallback nevertheless returns the requested quantity when no book is known. The new broker integration must fetch/reconcile long inventory, account for outstanding sells, and fail closed for unknown inventory. A close request must never infer an absolute quantity and blindly sell it.

The cost-aware branch `algo-hyp-008/lib/backtest.js` uses next-bar entries and caps participation. These are retained in the new simulator: no fill on the signal's close; no delayed fill after a missing next minute; entry and exit slippage plus fees; sizing capped by **previous** bar volume; gap-through-stop execution at the opening price; stop before target when both occur inside an OHLC bar; trailing updates only after the completed bar. Unknown partial-bar MFE/MAE is left unavailable. A provisional window-end liquidation is labeled `data_end`, not a completed market session.

## What the research cannot claim

The archive's backfill and reviews acknowledge missing delisted securities and retrospective winner selection. `algo-hyp-008/HYP/HYP-008.md` proposes contemporaneous discovery timestamps, the values actually used by the screen, and separately sampled near-miss/control observations. That is a useful experiment design, not a completed collection or proven edge. The rebuild accepts and uses first-discovery time plus a universe snapshot ID. Missing contemporaneous-universe evidence, incomplete sessions, synthetic data, insufficient samples, reused holdout, unprofitable net results, excessive drawdown, or absent explicit paper authorization block promotion eligibility.

The eight registered families retain the archive's seven recognizable strategies and add a compression breakout. Parameters and rules are inspectable. Risk limits are not optimizer knobs. All defaults are long-only, regular-session, paper/shadow settings with 0.25% risk per trade and a 10% position cap. Extended-hours execution needs a separately verified order/protection policy before enablement.

The engine performs reproducible bounded parameter discovery and expanding-prefix walk-forward checks. It does **not** claim to invent arbitrary strategy code, guarantee a profitable model, reconstruct unseen rejected securities, or provide a shared-capital portfolio backtest. Individual-symbol strategy metrics are diagnostics; realized drawdown excludes marked intraday equity. External recording, a durable database, scheduling, actual broker execution, fill/event ingestion, deployment, and full portfolio attribution remain integration responsibilities.
