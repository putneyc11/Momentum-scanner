#!/usr/bin/env bash
# ./scripts/new-hyp.sh 007  — branch, worktree, and a stub hypothesis file.
#
# One worktree per hypothesis, for two reasons. The obvious one: two agents
# editing the same tree corrupts both. The one that costs money: render.yaml
# has autoDeploy:true on claude/algo-paper-trader and SIGTERM flattens open
# positions, so a push to the deploy branch during 04:00-20:00 ET closes live
# trades. Agents never touch that branch. You merge, after hours, on purpose.
set -euo pipefail

N="${1:?usage: ./scripts/new-hyp.sh <number>   e.g. ./scripts/new-hyp.sh 007}"
ROOT="$(git rev-parse --show-toplevel)"
BRANCH="hyp/$N"
TREE="$(dirname "$ROOT")/algo-hyp-$N"

[ -e "$TREE" ] && { echo "Worktree already exists: $TREE"; exit 1; }

git -C "$ROOT" worktree add -b "$BRANCH" "$TREE" HEAD
mkdir -p "$TREE/HYP" "$TREE/REVIEWS"
[ -f "$TREE/HYP/HYP-$N.md" ] || sed "s/HYP-000/HYP-$N/g" "$ROOT/HYP/TEMPLATE.md" > "$TREE/HYP/HYP-$N.md"

cat <<EOF

  Worktree  $TREE
  Branch    $BRANCH
  Stub      HYP/HYP-$N.md

  1. Paste Grok's hypothesis into HYP/HYP-$N.md
  2. cd $TREE  — give Claude the builder prompt from AGENTS.md
  3. Fresh Codex session, red-team prompt -> REVIEWS/HYP-$N.md
  4. Merge AFTER 20:00 ET, or:
       git worktree remove $TREE && git branch -D $BRANCH

EOF
