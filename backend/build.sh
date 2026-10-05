#!/usr/bin/env bash
# Edge Function のデプロイ用ディレクトリを backend/dist/<関数>/ に作る。
#   - 関数フォルダ(functions/<関数>/)のファイルをそのままコピー
#   - index.ts 等が `./_<名前>.ts` を importしていれば、functions/_shared/<名前>.ts を `_<名前>.ts` としてコピー
#   - 相対importがすべて実在のファイルを指すか検査(指さなければ失敗)
#   - _shared に jsr:/npm:/URL import が混ざっていないか検査(契約: 共通部品は純粋なTS)
# 使い方: backend/build.sh [関数名 ...]   (省略時は全関数)
#   フォルダ未作成の関数は警告してスキップ。STRICT=1 ならエラー。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCS_DIR="$ROOT/functions"
SHARED_DIR="$FUNCS_DIR/_shared"
DIST_DIR="$ROOT/dist"

ALL_FUNCS=(summarize-x-post score-x-posts generate-digest-summary admin-api model-health summarize-ti-news summarize-ti-news-headline summarize-ti-lesson)
if [ "$#" -gt 0 ]; then FUNCS=("$@"); else FUNCS=("${ALL_FUNCS[@]}"); fi

errors=0
built=()
skipped=()

err() { echo "ERROR: $*" >&2; errors=$((errors + 1)); }

# _shared 自体の検査(外部import禁止)
if [ -d "$SHARED_DIR" ]; then
  for f in "$SHARED_DIR"/*.ts; do
    [ -e "$f" ] || continue
    if grep -nE "(from|import)[[:space:]]*[\"'](jsr:|npm:|https?:|node:)" "$f" >/dev/null; then
      err "$(basename "$f"): _shared に外部import(jsr:/npm:/URL/node:)があります"
    fi
  done
fi

# ファイル内の相対importパスを列挙
rel_imports() {
  grep -oE "(from|import)[[:space:]]*[\"']\.{1,2}/[^\"']+[\"']" "$1" 2>/dev/null \
    | sed -E "s/^(from|import)[[:space:]]*[\"']//; s/[\"']$//" || true
}

for fn in "${FUNCS[@]}"; do
  src="$FUNCS_DIR/$fn"
  out="$DIST_DIR/$fn"
  if [ ! -d "$src" ]; then
    if [ "${STRICT:-0}" = "1" ]; then err "$fn: functions/$fn がありません"; else echo "WARN: $fn: functions/$fn がありません(スキップ)" >&2; skipped+=("$fn"); fi
    continue
  fi
  if [ ! -f "$src/index.ts" ]; then
    err "$fn: index.ts がありません"
    continue
  fi

  rm -rf "$out"
  mkdir -p "$out"
  # 関数フォルダの中身(テスト用ファイルは除く)
  (cd "$src" && find . -type f ! -name '*.test.ts' -print0 | while IFS= read -r -d '' f; do
     mkdir -p "$out/$(dirname "$f")"; cp "$f" "$out/$f"
   done)

  # 共通部品のコピー(_<名前>.ts への import を検出。コピーした共通部品が更に import する場合も追う)
  changed=1
  while [ "$changed" = "1" ]; do
    changed=0
    while IFS= read -r -d '' f; do
      while IFS= read -r p; do
        [ -n "$p" ] || continue
        base="$(basename "$p")"
        # ./_name.ts 形式のみが共通部品
        if [[ "$p" =~ ^\./_([A-Za-z0-9_-]+)\.ts$ ]]; then
          name="${BASH_REMATCH[1]}"
          if [ -f "$out/$base" ]; then continue; fi
          if [ -f "$SHARED_DIR/$name.ts" ]; then
            cp "$SHARED_DIR/$name.ts" "$out/_$name.ts"
            changed=1
          fi
        fi
      done < <(rel_imports "$f")
    done < <(find "$out" -type f -name '*.ts' -print0)
  done

  # 検査: すべての相対importが実在ファイルを指す
  while IFS= read -r -d '' f; do
    d="$(dirname "$f")"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ ! -f "$d/$p" ]; then
        err "$fn: ${f#"$out"/} の import '$p' が存在しません"
      fi
    done < <(rel_imports "$f")
  done < <(find "$out" -type f -name '*.ts' -print0)

  built+=("$fn")
  echo "built: dist/$fn ($(find "$out" -type f | wc -l | tr -d ' ') files)"
done

echo "---"
echo "built: ${#built[@]}  skipped: ${#skipped[@]}  errors: $errors"
[ "$errors" -eq 0 ] || exit 1
