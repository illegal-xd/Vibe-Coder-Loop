#!/usr/bin/env bash
# serve_card.sh — start the unified local viewer on the usage view.
#
# Usage:
#   bash scripts/token-usage/serve_card.sh [--port 8788] [--host 127.0.0.1]
#                                          [--usage-dir ~/.config/opencode/token-usage]
#
# The archive defaults to ~/.config/opencode/token-usage (or
# VIBE_TOKEN_USAGE_HOME). The server reads the JSONL files on every API call,
# so the page always reflects the current log; no snapshot step is required.
# The same server also exposes the context timeline and the memory view.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NODE="${NODE:-node}"

if ! command -v "$NODE" >/dev/null 2>&1; then
  printf 'ERROR node not found; the local viewer requires Node.js 18+ (memory view: 22.5+)\n' >&2
  exit 2
fi

exec "$NODE" "$ROOT/tools/viewer/server.mjs" --open usage "$@"
