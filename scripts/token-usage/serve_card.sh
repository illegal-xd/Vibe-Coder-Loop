#!/usr/bin/env bash
# serve_card.sh — start the token-usage card on a local Node HTTP server.
#
# Usage:
#   bash scripts/token-usage/serve_card.sh [--port 8787] [--host 127.0.0.1]
#                                          [--data-dir ~/.config/opencode/token-usage]
#
# The archive defaults to ~/.config/opencode/token-usage (or
# VIBE_TOKEN_USAGE_HOME). The server reads the JSONL files on every API call,
# so the page always reflects the current log; no snapshot step is required.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NODE="${NODE:-node}"

if ! command -v "$NODE" >/dev/null 2>&1; then
  printf 'ERROR node not found; the token-usage card server requires Node.js 18+\n' >&2
  exit 2
fi

exec "$NODE" "$ROOT/tools/token-usage-card/server.mjs" "$@"
