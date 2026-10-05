#!/usr/bin/env bash
# index_beta.html の /*TTS:BEGIN*/ と /*TTS:END*/ の間へ ui/tts.js の中身を展開する(何度実行しても同じ結果)。
# 使い方: backend/ui_build.sh [--tts FILE] [--in FILE] [--out FILE]
#   既定: --tts ui/tts.js  --in index_beta.html  --out(省略時は --in を上書き)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tts="$root/ui/tts.js"; in="$root/index_beta.html"; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tts) tts="$2"; shift 2 ;;
    --in)  in="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || out="$in"
[ -f "$tts" ] || { echo "TTSファイルがありません: $tts" >&2; exit 1; }
[ -f "$in" ]  || { echo "入力HTMLがありません: $in" >&2; exit 1; }
python3 - "$tts" "$in" "$out" <<'PY'
import re, sys
tts_path, in_path, out_path = sys.argv[1:4]
tts = open(tts_path, encoding="utf-8").read().rstrip("\n")
html = open(in_path, encoding="utf-8").read()
if html.count("/*TTS:BEGIN*/") != 1 or html.count("/*TTS:END*/") != 1:
    sys.exit("マーカー /*TTS:BEGIN*/ と /*TTS:END*/ が1組ずつ必要です")
tts = tts.replace("</script", "<\\/script")  # scriptブロックを壊さない
pat = re.compile(r"/\*TTS:BEGIN\*/.*?/\*TTS:END\*/", re.S)
new = pat.sub(lambda m: "/*TTS:BEGIN*/\n" + tts + "\n/*TTS:END*/", html, count=1)
open(out_path, "w", encoding="utf-8").write(new)
print(f"✅ TTSを展開しました: {out_path} ({len(tts)}文字)")
PY
