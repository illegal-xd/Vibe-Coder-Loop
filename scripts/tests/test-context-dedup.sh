#!/usr/bin/env bash
# test-context-dedup.sh — OpenCode context deduplication gate
#
# Runs the host-neutral core tests and the OpenCode message-adapter tests
# with Node's built-in test runner. No npm install and no network access.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NODE="${NODE:-node}"

if ! command -v "$NODE" >/dev/null 2>&1; then
  printf 'SKIP  node not found; context-dedup JS tests require Node.js 18+\n' >&2
  exit 2
fi

cd "$ROOT" || exit 2
"$NODE" --test tests/context-dedup/*.test.mjs
