#!/usr/bin/env bash
# 検査一式: build → deno check(全関数) → Nodeの単体テスト → Denoの結合試験。
# 前提: deno 2.x が PATH にあること(例 export PATH=/tmp/denoinst/node_modules/.bin:$PATH)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT/build.sh"
for d in "$ROOT"/dist/*/; do
  echo "deno check: $(basename "$d")"
  (cd "$d" && deno check index.ts)
done
node --test "$ROOT/tests/*.test.ts"
deno test -A --no-check "$ROOT/tests/deno/integration.test.ts"
