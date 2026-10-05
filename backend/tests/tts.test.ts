// node --test backend/tests/tts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TTS = require("../../ui/tts.js");

// ---------- 偽の時計・synth ----------
function makeClock() {
  let t = 0;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeoutFn: (fn: () => void, ms: number) => { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
    clearTimeoutFn: (id: number) => { q.delete(id); },
    pending: () => q.size,
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let best: number | null = null;
        for (const [id, e] of q) if (e.at <= end && (best === null || e.at < q.get(best)!.at)) best = id;
        if (best === null) break;
        const e = q.get(best)!;
        q.delete(best);
        t = e.at;
        e.fn();
      }
      t = end;
    },
  };
}

function makeEnv(extra: Record<string, unknown> = {}) {
  const clock = makeClock();
  const log: string[] = [];
  const spoken: any[] = [];
  const synth = {
    cancel() { log.push("cancel"); },
    speak(u: any) { log.push("speak:" + u.text); spoken.push(u); },
  };
  class Utterance {
    text: string; lang = ""; rate = 1; voice: any = null;
    onstart: any = null; onend: any = null; onerror: any = null; onboundary: any = null;
    constructor(text: string) { this.text = text; }
  }
  const ev = { start: [] as number[], end: [] as number[], done: 0, stalls: [] as any[] };
  let rate = 1;
  const player = TTS.createPlayer({
    synth, Utterance, getVoice: () => ({ name: "V" }), getRate: () => rate, pauseMs: 400,
    onItemStart: (i: number) => ev.start.push(i),
    onItemEnd: (i: number) => ev.end.push(i),
    onDone: () => { ev.done++; },
    onStall: (s: any) => ev.stalls.push(s),
    setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now,
    ...extra,
  });
  return { clock, log, spoken, player, ev, setRate: (r: number) => { rate = r; } };
}
const last = (a: any[]) => a[a.length - 1];

// ---------- clean: 誤読パターン ----------
test("URL・絵文字・記号が出力に残らない", () => {
  const out = TTS.clean("見て👀🔥 https://t.co/AbC123 と http://example.com/a?b=1 www.foo.jp/x pic.twitter.com/zzz ★☆♪※ →【速報】 <b>AI</b>");
  assert.ok(!/https?:|t\.co|example|www|twitter|pic\./i.test(out), out);
  assert.ok(!/[👀🔥★☆♪※→<>\/]/u.test(out), out);
  assert.ok(out.includes("速報"));
  assert.ok(out.includes("エーアイ"));
});

test("絵文字のみ・URLのみは空文字", () => {
  assert.equal(TTS.clean("https://t.co/xx 🙂🙂"), "");
  assert.equal(TTS.clean(""), "");
  assert.equal(TTS.clean(null), "");
});

test("ハッシュタグ記号は除いて語は残す、cashtagの$も除く", () => {
  const out = TTS.clean("#半導体 #AI $NVDA");
  assert.ok(!/[#$＃]/.test(out), out);
  assert.ok(out.includes("半導体") && out.includes("エーアイ") && out.includes("NVDA"));
});

test("@handle: 英字は読める形に、数字のみは除去、対応表があればそれを使う", () => {
  const a = TTS.clean("@elon_musk が言った");
  assert.ok(a.startsWith("elon musk") && !a.includes("@") && !a.includes("_"), a);
  const b = TTS.clean("@12345 が言った");
  assert.ok(!b.includes("@") && !b.includes("12345"), b);
  assert.ok(TTS.clean("@OpenAI が発表").startsWith("オープンエーアイ"));
  assert.ok(TTS.clean("@abc123xyz hi", { handleNames: { abc123xyz: "田中さん" } }).startsWith("田中さん"));
  assert.ok(!TTS.clean("連絡は foo@example.com まで").includes("@"));
});

test("番号付きリストは「N件目」に。「いちドット」になる形が残らない", () => {
  const out = TTS.clean("1. 最初の話\n2) 次の話\n3. 三つ目");
  assert.ok(out.includes("1件目") && out.includes("2件目") && out.includes("3件目"), out);
  assert.ok(!/\d\s*[.)]/.test(out), out);
  assert.ok(!/ドット/.test(out));
  // speechTextの旧形式(「1. テーマ。本文」)
  const o2 = TTS.clean("1. 新GPUの話。本文です。");
  assert.ok(o2.startsWith("1件目、"), o2);
  // 小数は壊さない
  assert.ok(TTS.clean("1.5倍に増えた").startsWith("1.5倍"));
  assert.ok(TTS.clean("価格は3.5%上昇").includes("3.5パーセント"));
});

test("どんな入力でも小数点以外の「.」が残らない", () => {
  const out = TTS.clean("see e.g. Node.js v1.2 ver.2 Mr.Smith ... end. ok.\n3. foo 2. bar x.\n");
  const bad = out.match(/(^|\D)\.|\.(\D|$)/);
  assert.equal(bad, null, out);
  assert.ok(!/ドット/.test(out));
});

test("改行は句点になり、二重句点にならない", () => {
  assert.equal(TTS.clean("一行目\n二行目"), "一行目。二行目。");
  assert.equal(TTS.clean("一行目。\n\n二行目！"), "一行目。二行目！");
});

test("括弧内(全角・半角)は読み飛ばす", () => {
  assert.equal(TTS.clean("本日(月曜)の発表（詳細は後日）です"), "本日の発表です。");
  assert.equal(TTS.clean("A(B(C)D)E"), "AE。");
  assert.ok(!TTS.clean("開いたまま(おわり").includes("("));
});

// ---------- 数字・単位 ----------
test("通貨の読み下し", () => {
  assert.ok(TTS.clean("$300です").startsWith("300ドル"));
  assert.ok(TTS.clean("¥1,200です").startsWith("1200円"));
  assert.ok(TTS.clean("￥1,200で").startsWith("1200円"));
  assert.ok(TTS.clean("$1,234.5で").startsWith("1234.5ドル"));
  assert.ok(TTS.clean("$1.5Bの買収").startsWith("15億ドル"));
  assert.ok(TTS.clean("$300Kを調達").startsWith("30万ドル"));
  assert.ok(TTS.clean("$2 trillionだ").startsWith("2兆ドル"));
  assert.ok(TTS.clean("€50と£20").startsWith("50ユーロと20ポンド"));
  assert.ok(!/[$¥]/.test(TTS.clean("$300 ¥500 $")));
});

test("パーセント・日付・時刻", () => {
  assert.ok(TTS.clean("3.5%増").includes("3.5パーセント増"));
  assert.ok(TTS.clean("-5%減").includes("マイナス5パーセント"));
  assert.ok(TTS.clean("2026/10/9に発売").startsWith("10月9日に"));
  assert.ok(TTS.clean("2026-10-09に発売").startsWith("10月9日に"));
  assert.ok(TTS.clean("10/9に発売").startsWith("10月9日に"));
  assert.ok(TTS.clean("10/9から10/11まで").startsWith("10月9日から10月11日まで"));
  assert.ok(TTS.clean("10:30開始").startsWith("10時30分"));
  assert.ok(TTS.clean("9:00開始").startsWith("9時"));
  assert.ok(TTS.clean("2026年10月9日").startsWith("2026年10月9日"));
  assert.ok(TTS.clean("24/7対応").startsWith("24時間365日"));
});

test("単位の読み下し", () => {
  const cases: [string, string][] = [
    ["5GHz", "5ギガヘルツ"], ["2.4GHz帯", "2.4ギガヘルツ"], ["48V", "48ボルト"], ["2MW", "2メガワット"],
    ["1.5GW", "1.5ギガワット"], ["500kW", "500キロワット"], ["3nm", "3ナノメートル"], ["100W", "100ワット"],
    ["10A", "10アンペア"], ["5 GHz", "5ギガヘルツ"], ["80GB", "80ギガバイト"], ["1.2TB/s", "1.2テラバイト毎秒"],
    ["100Gbps", "100ギガビット毎秒"], ["25℃", "25度"], ["10x", "10倍"], ["5G", "5ジー"],
  ];
  for (const [src, want] of cases) assert.ok(TTS.clean(src + "です").includes(want), `${src} -> ${TTS.clean(src + "です")}`);
  // 型番は壊さない
  assert.ok(TTS.clean("A100とH100").includes("A100") && TTS.clean("A100とH100").includes("H100"));
  assert.ok(!TTS.clean("GPT-4Vは").includes("ボルト"));
});

test("範囲・マイナス・分数", () => {
  assert.ok(TTS.clean("5-10GHz").startsWith("5から10ギガヘルツ"));
  assert.ok(TTS.clean("5〜10分").startsWith("5から10分"));
  assert.ok(TTS.clean("気温-3度").includes("マイナス3度"));
  assert.ok(TTS.clean("3/40の確率").startsWith("40分の3"));
});

// ---------- 辞書 ----------
test("英略語・社名の辞書", () => {
  const cases: [string, string][] = [
    ["GPT", "ジーピーティー"], ["AI", "エーアイ"], ["LLM", "エルエルエム"], ["API", "エーピーアイ"], ["GaN", "ガン"],
    ["SiC", "シリコンカーバイド"], ["EMC", "イーエムシー"], ["CPU", "シーピーユー"], ["GPU", "ジーピーユー"],
    ["HBM", "エイチビーエム"], ["TSMC", "ティーエスエムシー"], ["NVIDIA", "エヌビディア"], ["OpenAI", "オープンエーアイ"],
    ["Claude", "クロード"], ["Gemini", "ジェミニ"], ["M&A", "エムアンドエー"],
  ];
  for (const [k, v] of cases) assert.equal(TTS.clean(`${k}の話`), `${v}の話。`, k);
});

test("辞書は単語境界で効く(語中・型番は置換しない)、複数形・小文字社名は効く", () => {
  assert.ok(!TTS.clean("PAIN と RAIN").includes("エーアイ"));
  assert.equal(TTS.clean("GPUsの話"), "ジーピーユーの話。");
  assert.ok(TTS.clean("nvidia と openai").includes("エヌビディア"));
  assert.ok(TTS.clean("ChatGPTは").startsWith("チャットジーピーティー"));
  assert.ok(TTS.clean("GPT-5が").startsWith("ジーピーティー 5"));
});

test("辞書の拡張: DICT直接 / extendDict / localStorage(xdash_tts_dict)", () => {
  TTS.DICT["Foobar"] = "フーバー";
  assert.ok(TTS.clean("Foobarだ").startsWith("フーバー"));
  TTS.extendDict({ Zork: "ゾーク" });
  assert.ok(TTS.clean("Zorkだ").startsWith("ゾーク"));
  (globalThis as any).localStorage = { getItem: (k: string) => (k === "xdash_tts_dict" ? JSON.stringify({ Quux: "クークス", AI: "アイ" }) : null) };
  try {
    assert.ok(TTS.clean("Quuxだ").startsWith("クークス"));
    assert.ok(TTS.clean("AIだ").startsWith("アイ"));
  } finally {
    delete (globalThis as any).localStorage;
  }
  assert.ok(TTS.clean("AIだ").startsWith("エーアイ"));
  // 壊れたlocalStorageでも落ちない
  (globalThis as any).localStorage = { getItem: () => "{broken" };
  try { assert.ok(TTS.clean("AIだ").startsWith("エーアイ")); } finally { delete (globalThis as any).localStorage; }
});

// ---------- split ----------
test("split: 文単位、長文は読点で再分割、必ずmaxLen以内", () => {
  assert.deepEqual(TTS.split("一つ目。二つ目！三つ目？\n四つ目"), ["一つ目。", "二つ目！", "三つ目？", "四つ目"]);
  const long = "りんごがあります、".repeat(30) + "。";
  const parts: string[] = TTS.split(long, 80);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 80, String(p.length));
  assert.equal(parts.join(""), long);
  // 読点の無い長文は強制分割
  const solid: string[] = TTS.split("あ".repeat(200), 80);
  assert.deepEqual(solid.map((x) => x.length), [80, 80, 40]);
  assert.deepEqual(TTS.split("", 80), []);
  assert.deepEqual(TTS.split("。。。"), []);
  for (const p of TTS.split("あ、".repeat(100), 10)) assert.ok(p.length <= 10);
});

// ---------- utterances ----------
test("utterances: speech_title/speech_bodyがあればそれを(cleanして)別発話に", () => {
  const u = TTS.utterances({
    speech_title: "OpenAIが新モデル https://t.co/x",
    speech_body: "性能は2倍になりました。価格は$300です。\n詳しくは後日。",
    gist: "使われない", summary: "使われない",
  });
  assert.deepEqual(u.map((x: any) => x.kind), ["title", "body", "body", "body"]);
  assert.ok(u[0].text.startsWith("オープンエーアイが新モデル") && !u[0].text.includes("t.co"));
  assert.ok(u[2].text.includes("300ドル"));
  assert.ok(!u.some((x: any) => x.text.includes("使われない")));
});

test("utterances: speech_*が無ければgist/summaryをclean+split", () => {
  const long = "GPUの需要は、" + "とても強く、".repeat(30) + "続いています。";
  const u = TTS.utterances({ gist: "1. 新GPUの話", summary: long + "次の文です。" });
  assert.equal(u[0].kind, "title");
  assert.ok(u[0].text.includes("新ジーピーユーの話"));
  const bodies = u.filter((x: any) => x.kind === "body");
  assert.ok(bodies.length >= 3);
  for (const b of bodies) assert.ok(b.text.length <= 80);
  assert.ok(bodies.some((b: any) => b.text.includes("ジーピーユー")));
});

test("utterances: 片方だけ・空・未採点", () => {
  assert.deepEqual(TTS.utterances({}), []);
  assert.deepEqual(TTS.utterances({ summary: "本文だけ。" }).map((x: any) => x.kind), ["body"]);
  assert.deepEqual(TTS.utterances({ gist: "見出しだけ" }).map((x: any) => x.kind), ["title"]);
  // speech_titleのみ → 本文はsummaryにフォールバック
  const u = TTS.utterances({ speech_title: "題", summary: "要約。" });
  assert.deepEqual(u.map((x: any) => x.kind), ["title", "body"]);
  // 全部URLだけなら発話ゼロ
  assert.deepEqual(TTS.utterances({ speech_title: "https://t.co/a", speech_body: "🙂" }), []);
});

// ---------- pickVoice ----------
test("pickVoice: ja-JPの高品質を優先、標準指定ならそれ以外、無ければnull", () => {
  const voices = [
    { name: "Samantha", lang: "en-US", voiceURI: "s" },
    { name: "Kyoko", lang: "ja-JP", voiceURI: "com.apple.voice.compact.ja-JP.Kyoko" },
    { name: "Kyoko (Enhanced)", lang: "ja-JP", voiceURI: "com.apple.voice.enhanced.ja-JP.Kyoko" },
    { name: "Otoya", lang: "ja_JP", voiceURI: "o" },
    { name: "Plain", lang: "ja-JP", voiceURI: "p", default: true },
  ];
  assert.equal(TTS.pickVoice(voices, "high").name, "Kyoko (Enhanced)");
  assert.equal(TTS.pickVoice(voices, "standard").name, "Plain");
  assert.equal(TTS.pickVoice([{ name: "Premium", lang: "ja-JP" }, { name: "Siri", lang: "ja-JP" }], "high").name, "Premium");
  assert.equal(TTS.pickVoice([voices[0]], "high"), null);
  assert.equal(TTS.pickVoice([], "high"), null);
  assert.equal(TTS.pickVoice(null, "high"), null);
  assert.equal(TTS.pickVoice([{ name: "Plain", lang: "ja-JP" }], "high").name, "Plain");
});

// ---------- player ----------
const ITEMS = [
  { kind: "title", text: "見出しです。" },
  { kind: "body", text: "一文目です。" },
  { kind: "body", text: "二文目です。" },
];

test("player: cancelの後100ms待ってからspeak、voice/rate/langが付く", () => {
  const e = makeEnv();
  e.setRate(1.2);
  e.player.play(ITEMS);
  assert.deepEqual(e.log, ["cancel"]);
  e.clock.advance(99);
  assert.equal(e.spoken.length, 0);
  e.clock.advance(1);
  assert.equal(e.spoken.length, 1);
  assert.equal(e.spoken[0].text, "見出しです。");
  assert.equal(e.spoken[0].lang, "ja-JP");
  assert.equal(e.spoken[0].rate, 1.2);
  assert.equal(e.spoken[0].voice.name, "V");
});

test("player: 順に再生し、title→bodyの間だけpauseMs(400)、最後にonDone", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onstart();
  assert.deepEqual(e.ev.start, [0]);
  e.spoken[0].onend();
  assert.deepEqual(e.ev.end, [0]);
  e.clock.advance(399 + 100);
  assert.equal(e.spoken.length, 1, "pause中は次を話さない");
  e.clock.advance(1);
  assert.equal(e.spoken.length, 2);
  e.spoken[1].onstart(); e.spoken[1].onend();
  e.clock.advance(100); // body→bodyはpauseなし(cancel待ちのみ)
  assert.equal(e.spoken.length, 3);
  e.spoken[2].onstart(); e.spoken[2].onend();
  assert.equal(e.ev.done, 1);
  assert.deepEqual(e.ev.start, [0, 1, 2]);
  assert.equal(e.player.state().status, "idle");
});

test("player: startIndexから再生、範囲外はonDone", () => {
  const e = makeEnv();
  e.player.play(ITEMS, 2);
  e.clock.advance(100);
  assert.equal(e.spoken[0].text, "二文目です。");
  const e2 = makeEnv();
  e2.player.play(ITEMS, 9);
  assert.equal(e2.ev.done, 1);
});

test("player: 3秒開始しなければ1回だけ再試行、それでもダメならonStall", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100);
  assert.equal(e.spoken.length, 1);
  e.clock.advance(2999);
  assert.equal(e.spoken.length, 1);
  e.clock.advance(1); // 開始タイムアウト → 再試行
  assert.equal(last(e.log), "cancel");
  assert.equal(e.ev.stalls.length, 0);
  e.clock.advance(100);
  assert.equal(e.spoken.length, 2);
  assert.equal(e.spoken[1].text, "見出しです。");
  e.clock.advance(3000); // 2回目も開始せず
  assert.equal(e.ev.stalls.length, 1);
  assert.deepEqual(e.ev.stalls[0], { reason: "no-start", index: 0 });
  assert.equal(e.player.state().status, "stalled");
  e.clock.advance(10000);
  assert.equal(e.spoken.length, 2, "再々試行しない");
  // 再試行の1回目の古いイベントは無視される
  e.spoken[0].onend();
  assert.deepEqual(e.ev.end, []);
});

test("player: 再試行で開始できれば通常どおり進む(onItemStartは1回)", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100 + 3000 + 100);
  e.spoken[1].onstart();
  assert.deepEqual(e.ev.start, [0]);
  e.spoken[1].onend();
  assert.deepEqual(e.ev.end, [0]);
  assert.equal(e.ev.stalls.length, 0);
});

test("player: onerror(canceled/interrupted)は無視、それ以外は1回再試行してからonStall", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onerror({ error: "interrupted" });
  e.spoken[0].onerror({ error: "canceled" });
  assert.equal(e.ev.stalls.length, 0);
  assert.equal(e.ev.end.length, 0);
  e.spoken[0].onerror({ error: "synthesis-failed" });
  e.clock.advance(100);
  assert.equal(e.spoken.length, 2);
  e.spoken[1].onerror({ error: "synthesis-failed" });
  assert.deepEqual(e.ev.stalls, [{ reason: "synthesis-failed", index: 0 }]);
  const e2 = makeEnv();
  e2.player.play(ITEMS);
  e2.clock.advance(100);
  e2.spoken[0].onerror({ error: "not-allowed" });
  assert.deepEqual(e2.ev.stalls, [{ reason: "not-allowed", index: 0 }]);
});

test("player: onendが来ない場合は想定時間(文字数/6.5/rate)の2倍で次へ強制移動", () => {
  const e = makeEnv();
  const text = "あ".repeat(65); // 想定10秒(rate1) → 20秒
  e.player.play([{ kind: "body", text }, { kind: "body", text: "次。" }]);
  e.clock.advance(100);
  e.spoken[0].onstart();
  e.clock.advance(19999);
  assert.equal(e.ev.end.length, 0);
  e.clock.advance(1);
  assert.deepEqual(e.ev.end, [0]);
  assert.equal(last(e.log.filter((x) => x === "cancel")), "cancel");
  e.clock.advance(100);
  assert.equal(e.spoken[1].text, "次。");
  // 強制移動後に遅れて届いた古いonendは無視
  e.spoken[0].onend();
  assert.deepEqual(e.ev.end, [0]);
  assert.equal(e.player.state().index, 1);
});

test("player: 強制移動の時間は速度に反比例する(rate 2 → 10秒)", () => {
  const e = makeEnv();
  e.setRate(2);
  e.player.play([{ kind: "body", text: "あ".repeat(65) }, { kind: "body", text: "次。" }]);
  e.clock.advance(100);
  e.spoken[0].onstart();
  e.clock.advance(9999);
  assert.equal(e.ev.end.length, 0);
  e.clock.advance(1);
  assert.deepEqual(e.ev.end, [0]);
});

test("player: onendの二重発火で二重に進まない", () => {
  const e = makeEnv({ pauseMs: 0 });
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onstart();
  e.spoken[0].onend();
  e.spoken[0].onend();
  e.spoken[0].onend();
  assert.deepEqual(e.ev.end, [0]);
  e.clock.advance(100);
  assert.equal(e.spoken.length, 2);
  assert.equal(e.player.state().index, 1);
  e.spoken[0].onerror({ error: "synthesis-failed" }); // 古い発話のエラーも無視
  e.clock.advance(5000);
  assert.equal(e.ev.stalls.length, 0);
});

test("player: onstartが来なくてもonendだけで進める(onItemStartも呼ぶ)", () => {
  const e = makeEnv({ pauseMs: 0 });
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onend();
  assert.deepEqual(e.ev.start, [0]);
  assert.deepEqual(e.ev.end, [0]);
});

test("player: setRateは今の文から新しい速度で再開(onItemStartは再発火しない)", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onstart();
  e.player.setRate(1.5);
  assert.equal(last(e.log), "cancel");
  e.clock.advance(100);
  assert.equal(e.spoken.length, 2);
  assert.equal(e.spoken[1].text, "見出しです。");
  assert.equal(e.spoken[1].rate, 1.5);
  e.spoken[0].onend(); // 古い発話は無視
  assert.equal(e.ev.end.length, 0);
  e.spoken[1].onstart();
  assert.deepEqual(e.ev.start, [0]);
  assert.equal(e.player.state().rate, 1.5);
  e.spoken[1].onend();
  assert.deepEqual(e.ev.end, [0]);
});

test("player: 一時停止→再開は今の文の頭から、停止中のsetRateは再生を始めない", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onstart();
  e.player.pause();
  assert.equal(e.player.state().status, "paused");
  e.clock.advance(60000);
  assert.equal(e.ev.end.length, 0, "強制移動タイマーも止まる");
  e.player.setRate(1.3);
  e.clock.advance(1000);
  assert.equal(e.spoken.length, 1);
  e.player.resume();
  e.clock.advance(100);
  assert.equal(e.spoken.length, 2);
  assert.equal(e.spoken[1].rate, 1.3);
  assert.equal(e.spoken[1].text, "見出しです。");
});

test("player: stopは以後のイベント・タイマーを無効化し、onStallは呼ばない", () => {
  const e = makeEnv();
  e.player.play(ITEMS);
  e.clock.advance(100);
  e.spoken[0].onstart();
  e.player.stop();
  assert.equal(e.player.state().status, "idle");
  e.spoken[0].onend();
  e.clock.advance(60000);
  assert.equal(e.spoken.length, 1);
  assert.deepEqual(e.ev.end, []);
  assert.equal(e.ev.done, 0);
  assert.equal(e.ev.stalls.length, 0);
  assert.equal(e.clock.pending(), 0);
});

test("player: stall後はresume()で同じ文から再開できる", () => {
  const e = makeEnv();
  e.player.play(ITEMS, 1);
  e.clock.advance(100 + 3000 + 100 + 3000);
  assert.equal(e.ev.stalls.length, 1);
  assert.equal(e.ev.stalls[0].index, 1);
  e.player.resume();
  e.clock.advance(100);
  assert.equal(last(e.spoken).text, "一文目です。");
  last(e.spoken).onstart();
  last(e.spoken).onend();
  assert.deepEqual(e.ev.end, [1]);
});

test("player: play()の呼び直しで前の再生のイベントは無視され、コールバック内の例外は再生を止めない", () => {
  const e = makeEnv({ onItemStart: () => { throw new Error("boom"); } });
  e.player.play(ITEMS);
  e.clock.advance(100);
  const old = e.spoken[0];
  e.player.play([{ kind: "body", text: "新しい。" }]);
  e.clock.advance(100);
  old.onstart(); old.onend();
  assert.equal(e.ev.end.length, 0);
  const cur = last(e.spoken);
  assert.equal(cur.text, "新しい。");
  cur.onstart(); cur.onend();
  assert.equal(e.ev.done, 1);
});

test("player: 文字列配列も受け付ける", () => {
  const e = makeEnv();
  e.player.play(["あ。", "", "い。"]);
  e.clock.advance(100);
  e.spoken[0].onstart(); e.spoken[0].onend();
  e.clock.advance(100);
  assert.equal(e.spoken[1].text, "い。");
  assert.equal(e.player.state().total, 2);
});
