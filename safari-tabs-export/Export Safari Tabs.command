#!/bin/zsh
# Double-clickable launcher for the Safari tab exporter.
# Put your API key in ~/.anthropic_key (just the key on one line) or export
# ANTHROPIC_API_KEY in your shell profile to enable AI descriptions.
cd "$(dirname "$0")"
if [[ -z "$ANTHROPIC_API_KEY" && -f "$HOME/.anthropic_key" ]]; then
  export ANTHROPIC_API_KEY="$(head -n1 "$HOME/.anthropic_key" | tr -d '[:space:]')"
fi
python3 export_safari_tabs.py "$@"
echo ""
read -sk 1 "?Press any key to close..."
