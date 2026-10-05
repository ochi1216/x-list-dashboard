#!/usr/bin/env bash
# 一時Postgres(16)を立てて 00_stub → migrations 001a〜006 → 試験SQL → 並行実行試験 を流し、最後に破棄する。
# 使い方: backend/tests/sql/run.sh   (rootで実行しても postgres ユーザーに切り替える。本番DBには一切触らない)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../../migrations"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"; PORT="${PGPORT_TEST:-54329}"
WORK="$(mktemp -d /tmp/xd_sqltest.XXXXXX)"; chmod 755 "$WORK"; chmod -R a+rX "$HERE" "$MIG"
RUN=""; if [ "$(id -u)" = 0 ]; then chown postgres "$WORK"; RUN="runuser -u postgres --"; fi
cleanup(){ $RUN "$BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
$RUN "$BIN/initdb" -D "$WORK/data" -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
$RUN "$BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
PSQL="$RUN $BIN/psql -h $WORK -p $PORT -X -q -v ON_ERROR_STOP=1 -d postgres"
$PSQL -f "$HERE/00_stub.sql"
for f in "$MIG"/20261005_00{1a,1b,1c,1d,1e,2a,2b,2c,3a,3b,3c,4,5,6}_*.sql; do
  echo "apply $(basename "$f")"; $PSQL -f "$f" >/dev/null
done
echo "== 006 を再適用(冪等性) =="; $PSQL -f "$MIG/20261005_006_review_fixes.sql" >/dev/null
echo "== 試験 =="; $PSQL -f "$HERE/10_tests.sql"
echo "== digest_due(SQL)と runToday(TS)の判定一致(同じ状態を両方へ与える) =="
PARITY_FAIL=0
for n in $(node "$HERE/parity.ts" names 2>/dev/null); do
  S=$(node "$HERE/parity.ts" sql "$n" 2>/dev/null | $PSQL -At -f - | tail -1)
  T=$(node "$HERE/parity.ts" ts "$n" 2>/dev/null)
  [ "$S" = t ] && S=true || S=false
  if [ "$S" = "$T" ]; then echo "  一致 $n: $S"; else echo "  不一致 $n: SQL=$S TS=$T"; PARITY_FAIL=1; fi
done
[ "$PARITY_FAIL" = 0 ] && echo "PASS digest_parity" || { echo "FAIL digest_parity"; exit 1; }
echo "== notify_ops 並行実行 =="
$PSQL -c "select public.set_secret('xd_ntfy_topic','t_test'); select public.ops_event('error','fetch_stale','x','{}',0);" >/dev/null
$PSQL -c "begin; select pg_advisory_xact_lock(hashtext('notify_ops')); select pg_sleep(4); commit;" >/dev/null &
sleep 1
R1=$($PSQL -At -c "select public.notify_ops()"); wait
R2=$($PSQL -At -c "select public.notify_ops()")
echo "ロック保持中=$R1(期待0) 解放後=$R2(期待1)"
[ "$R1" = 0 ] && [ "$R2" = 1 ] && echo "PASS notify_lock" || { echo "FAIL notify_lock"; exit 1; }
echo "ALL PASS"
