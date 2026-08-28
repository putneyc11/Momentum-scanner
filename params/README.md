# params/

**What the live trader trades.** In git, so a tuned champion reaches production
the same way any other change does: committed, reviewed against a regress
table and a frozen holdout, merged by a human.

Empty means every pod runs its `DEFAULTS` from `lib/strategy.js` and
`lib/strategies.js`. That is a valid and deliberate state, not a missing file.

`engine.js tune` does **not** write here. It writes to `state/params/`, which
is gitignored and which production never reads. Promotion is a deliberate copy:

```bash
node engine.js tune --iters 200 --seed 11      # writes state/params/
node engine.js regress --base <ref>            # what did it cost?
cp state/params/redgreen.json params/          # promote, on purpose
git add params/redgreen.json && git commit
```

An agent can tune all night without any of it reaching the account.
