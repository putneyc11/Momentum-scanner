# Review of HYP-000

**Reviewer:** Codex, clean session, no build context
**Date:** YYYY-MM-DD

## Defects
1. **[FATAL|SERIOUS|MINOR]** — what is wrong, at `file:line`, and why it
   invalidates the result.

## Checks run
- [ ] `entryViable` identical in `lib/backtest.js` and the live loop (invariant #3)
- [ ] Validation leakage — how many candidates scored against the split
- [ ] Backfill survivorship — direction and rough size of the bias
- [ ] Lookahead — entry fill, stop/target ordering, whole-day fields at signal time
- [ ] Fill realism at these sizes on these names
- [ ] Split-half regime check
- [ ] Parameter count vs day count

## Verdict
KILL / SURVIVES-REVIEW
