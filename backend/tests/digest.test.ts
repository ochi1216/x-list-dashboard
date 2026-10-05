import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, buildCorpus, checkClaim, digestDay, digestDayStartMs, parseKanjiNumeral, prevHeadlinesOf, runToday, runWeek,
  todayMaxTokens, validateTopics, weekStartOf,
} from "../functions/_shared/digest.ts";
import type { Card, DailyRow, DigestDeps, GenReq, GenRes, WeekRow } from "../functions/_shared/digest.ts";
import { jstDateStr, runLegacy, toLine } from "../functions/generate-digest-summary/logic.ts";

const NOW = Date.parse("2026-10-05T08:00:00Z"); // JST 10/05 17:00 (月曜)

function card(i: number, over: Partial<Card> = {}): Card {
  return {
    post_url: `https://x.com/u/status/${i}`,
    gist: `gist${i}`, summary: `summary${i}`,
    content: `OpenAIがGPT-5を発表。価格は1万2,000円で、10月5日に提供開始。シェアは35%。`,
    score: 4, scored_at: "2026-10-05T07:00:00Z", fetched_at: "2026-10-05T06:00:00Z", image_urls: null,
    ...over,
  };
}
function cards(n: number, over: Partial<Card> = {}): Card[] {
  return Array.from({ length: n }, (_, i) => card(i + 1, over));
}
function topic(urls: string[], over: Record<string, unknown> = {}) {
  return {
    headline: "OpenAIがGPT-5発表",
    summary: "OpenAIがGPT-5を発表した。価格は12000円。",
    new_facts: ["10/5に提供開始"],
    card_urls: urls,
    is_followup: false,
    ...over,
  };
}

interface Rec { upserts: DailyRow[]; weeks: WeekRow[]; events: { level: string; kind: string }[]; gens: GenReq[]; attempts: string[] }
function makeDeps(opts: {
  cards?: Card[]; prev?: DailyRow | null; gen: (r: GenReq, n: number) => GenRes; cfg?: Record<string, number>;
  daily?: DailyRow[]; week?: WeekRow | null; now?: number;
}): { deps: DigestDeps; rec: Rec } {
  const rec: Rec = { upserts: [], weeks: [], events: [], gens: [], attempts: [] };
  const deps: DigestDeps = {
    now: () => opts.now ?? NOW,
    gen: async (r) => { rec.gens.push(r); return opts.gen(r, rec.gens.length); },
    cfgNum: async (k, d) => opts.cfg?.[k] ?? d,
    loadCards: async () => opts.cards ?? [],
    getDaily: async () => opts.prev ?? null,
    listDaily: async (from, to) => (opts.daily ?? []).filter((r) => r.day >= from && r.day <= to),
    upsertDaily: async (row) => { rec.upserts.push(row); },
    getWeek: async () => opts.week ?? null,
    upsertWeek: async (row) => { rec.weeks.push(row); },
    opsEvent: async (level, kind) => { rec.events.push({ level, kind }); },
    touchAttempt: async (iso) => { rec.attempts.push(iso); },
  };
  return { deps, rec };
}
const ok = (j: unknown): GenRes => ({ ok: true, text: JSON.stringify(j), json: j, model: "gemini-test" });

// ---------- 日付 ----------
test("02:00 JST区切りの日・週", () => {
  assert.equal(digestDay(Date.parse("2026-10-05T16:59:00Z")), "2026-10-05"); // JST 10/06 01:59 → まだ10/05
  assert.equal(digestDay(Date.parse("2026-10-05T17:00:00Z")), "2026-10-06"); // JST 10/06 02:00
  assert.equal(new Date(digestDayStartMs("2026-10-05")).toISOString(), "2026-10-04T17:00:00.000Z");
  assert.equal(weekStartOf("2026-10-05"), "2026-10-05"); // 月曜
  assert.equal(weekStartOf("2026-10-11"), "2026-10-05"); // 日曜
  assert.equal(weekStartOf("2026-10-06"), "2026-10-05");
  assert.equal(addDays("2026-10-01", -6), "2026-09-25");
});

// ---------- 検査 ----------
test("数値: NFKC・カンマ・万億%の正規化", () => {
  const c = buildCorpus(["価格は12,000円、シェア35％、売上は3.5億円"]);
  assert.ok(checkClaim("価格は1.2万円", c).ok);
  assert.ok(checkClaim("価格は１２０００円", c).ok);
  assert.ok(checkClaim("シェアは35%", c).ok);
  assert.ok(checkClaim("売上は3.5億円", c).ok);
  assert.equal(checkClaim("価格は13,000円", c).ok, false);
  assert.equal(checkClaim("シェアは36%", c).ok, false);
});
test("英字・カタカナ固有名・日付", () => {
  const c = buildCorpus(["OpenAIがGPT‑5を発表。ジェミニ対抗。10月5日に提供開始"]);
  assert.ok(checkClaim("openai の GPT-5", c).ok);
  assert.equal(checkClaim("Anthropicが対抗", c).ok, false);
  assert.ok(checkClaim("ジェミニに対抗", c).ok);
  assert.equal(checkClaim("クロードに対抗", c).ok, false);
  assert.ok(checkClaim("ニュースとして発表", c).ok); // 一般語は対象外
  assert.ok(checkClaim("10/5に開始", c).ok);
  assert.equal(checkClaim("10月6日に開始", c).ok, false);
  assert.equal(checkClaim("2025年10月5日に開始", buildCorpus(["2026年10月5日"])).ok, false);
});
test("文単位の削除・画像あり投稿は要約も根拠にできる", () => {
  const cs = [card(1), card(2, { content: "画像のみ", image_urls: ["https://img/1.png"], gist: "Geminiの新機能", summary: "Geminiが7月に更新" })];
  const v = validateTopics([
    topic([cs[0].post_url], { summary: "OpenAIがGPT-5を発表した。価格は99円。", new_facts: ["シェアは35%", "シェアは50%"] }),
    topic([cs[1].post_url], { headline: "Gemini更新", summary: "Geminiが7月に更新。", new_facts: [] }),
    topic(["https://x.com/unknown"], {}),
  ], cs);
  assert.equal(v.topics.length, 2);
  assert.equal(v.topics[0].summary, "OpenAIがGPT-5を発表した。");
  assert.deepEqual(v.topics[0].new_facts, ["シェアは35%"]);
  assert.equal(v.topics[1].headline, "Gemini更新");
  // 総単位: (1+2+2) + (1+1+0) + (1+2+1)  / 削除: 1+1 + 0 + 4(カード無し話題)
  assert.equal(v.total, 5 + 2 + 4);
  assert.equal(v.dropped, 2 + 0 + 4);
});
test("画像なし投稿では要約だけに在る語は根拠にならない", () => {
  const cs = [card(1, { content: "本文のみ", summary: "Geminiが更新" })];
  const v = validateTopics([topic([cs[0].post_url], { headline: "本文のみ", summary: "Geminiが更新。", new_facts: [] })], cs);
  assert.equal(v.topics.length, 0);
});

// ---------- today ----------
test("条件: 新規score>=3が足りない/間隔未満ならskipped", async () => {
  const gen = () => ok({ topics: [topic(["https://x.com/u/status/1"])] });
  let r = await runToday(makeDeps({ cards: cards(4), gen }).deps);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "few_new");
  // 前回生成が2時間前(間隔6h未満)
  const prev: DailyRow = { day: "2026-10-05", generated_at: new Date(NOW - 2 * 3600e3).toISOString(), model: "m", status: "ok", topics: [], input_count: 5, dropped_ratio: 0, version: 1 };
  const fresh = cards(6, { scored_at: new Date(NOW - 3600e3).toISOString() });
  const m = makeDeps({ cards: fresh, prev, gen });
  r = await runToday(m.deps);
  assert.equal(r.reason, "interval");
  assert.equal(m.rec.gens.length, 0);
  // 前回が7時間前 かつ 前回以降の新規が5件以上 → 生成
  const prev2 = { ...prev, generated_at: new Date(NOW - 7 * 3600e3).toISOString() };
  const m2 = makeDeps({ cards: fresh, prev: prev2, gen });
  r = await runToday(m2.deps);
  assert.equal(r.status, "ok");
  // 前回以降の新規が4件のみ(残りは前回より前にscore済) → few_new
  const mixed = [...cards(4, { scored_at: new Date(NOW - 3600e3).toISOString() }), ...cards(5, { scored_at: new Date(NOW - 9 * 3600e3).toISOString() }).map((c, i) => ({ ...c, post_url: `https://x.com/o/${i}` }))];
  r = await runToday(makeDeps({ cards: mixed, prev: prev2, gen }).deps);
  assert.equal(r.reason, "few_new");
});
test("設定キーで閾値を変えられる・その日の初回は間隔を無視", async () => {
  const gen = () => ok({ topics: [topic(["https://x.com/u/status/1"])] });
  const r = await runToday(makeDeps({ cards: cards(2), gen, cfg: { digest_min_new_scored: 2 } }).deps);
  assert.equal(r.status, "ok");
});
test("生成→検査→保存(digest_daily の形)・score<3は入力しない", async () => {
  const cs = [...cards(5), card(9, { score: 2 })];
  const m = makeDeps({ cards: cs, gen: () => ok({ topics: [topic([cs[0].post_url, cs[1].post_url])] }) });
  const r = await runToday(m.deps);
  assert.equal(r.status, "ok");
  assert.equal(m.rec.upserts.length, 1);
  const row = m.rec.upserts[0];
  assert.equal(row.day, "2026-10-05");
  assert.equal(row.status, "ok");
  assert.equal(row.model, "gemini-test");
  assert.equal(row.input_count, 5);
  assert.equal(row.version, 1);
  assert.equal((row.topics as unknown[]).length, 1);
  assert.equal(m.rec.gens[0].purpose, "digest");
  assert.ok(!m.rec.gens[0].parts[0].text.includes("status/9")); // score2 のカードは入力外
  assert.ok(m.rec.gens[0].maxOutputTokens > 0);
});
test("削除率が20%超ならops_event warn", async () => {
  const cs = cards(5);
  const t = topic([cs[0].post_url], { summary: "価格は99円。シェアは1%。OpenAIが発表。", new_facts: ["売上は5兆円", "シェアは35%"] });
  const m = makeDeps({ cards: cs, gen: () => ok({ topics: [t] }) });
  const r = await runToday(m.deps);
  assert.equal(r.status, "ok");
  assert.ok((r.dropped_ratio ?? 0) > 0.2);
  assert.equal(m.rec.upserts[0].dropped_ratio, r.dropped_ratio);
  assert.ok(m.rec.events.some((e) => e.level === "warn" && e.kind === "digest_dropped"));
});
test("見出しが落ちたら1回だけ再生成し、直れば採用", async () => {
  const cs = cards(5);
  const bad = topic([cs[0].post_url], { headline: "Anthropicが発表" });
  const good = topic([cs[0].post_url]);
  const m = makeDeps({ cards: cs, gen: (_r, n) => ok({ topics: [n === 1 ? bad : good] }) });
  const r = await runToday(m.deps);
  assert.equal(m.rec.gens.length, 2);
  assert.equal(r.status, "ok");
  assert.equal((m.rec.upserts[0].topics as { headline: string }[])[0].headline, "OpenAIがGPT-5発表");
});
test("再生成しても見出しが駄目なら話題ごと破棄 → 全滅は failed(自由文に戻さない)", async () => {
  const cs = cards(5);
  const bad = topic([cs[0].post_url], { headline: "Anthropicが発表" });
  const m = makeDeps({ cards: cs, gen: () => ok({ topics: [bad] }) });
  const r = await runToday(m.deps);
  assert.equal(m.rec.gens.length, 2); // 1回だけ再生成
  assert.equal(r.status, "failed");
  assert.equal(r.message, "生成できません");
  assert.equal(m.rec.upserts[0].status, "failed");
  assert.deepEqual(m.rec.upserts[0].topics, []);
  assert.equal(m.rec.upserts[0].dropped_ratio, 1);
  assert.ok(m.rec.events.some((e) => e.kind === "digest_failed"));
});
test("一部の話題だけ破棄され残りは保存される", async () => {
  const cs = cards(5);
  const bad = topic([cs[0].post_url], { headline: "Anthropicが発表" });
  const good = topic([cs[1].post_url]);
  const m = makeDeps({ cards: cs, gen: () => ok({ topics: [bad, good] }) });
  const r = await runToday(m.deps);
  assert.equal(r.status, "ok");
  assert.equal(r.topics, 1);
});
test("費用ガード拒否 → paused を保存(既存の生成済み行は上書きしない)", async () => {
  const cs = cards(5);
  const guard = (): GenRes => ({ ok: false, kind: "guard", error: "cost guard denied" });
  let m = makeDeps({ cards: cs, gen: guard });
  let r = await runToday(m.deps);
  assert.equal(r.status, "paused");
  assert.equal(m.rec.upserts[0].status, "paused");
  const prev: DailyRow = { day: "2026-10-05", generated_at: new Date(NOW - 8 * 3600e3).toISOString(), model: "m", status: "ok", topics: [{ headline: "x" }], input_count: 5, dropped_ratio: 0, version: 1 };
  m = makeDeps({ cards: cards(6, { scored_at: new Date(NOW - 3600e3).toISOString() }), prev, gen: guard });
  r = await runToday(m.deps);
  assert.equal(r.status, "paused");
  assert.equal(m.rec.upserts.length, 0);
});
test("モデルが話題なしと返したら empty", async () => {
  const m = makeDeps({ cards: cards(5), gen: () => ok({ topics: [] }) });
  const r = await runToday(m.deps);
  assert.equal(r.status, "empty");
  assert.equal(m.rec.upserts[0].status, "empty");
});
test("Geminiエラー(ガード以外)は failed 行を保存して ok:false・キーを含めない・試行開始を記録", async () => {
  const m = makeDeps({ cards: cards(5), gen: () => ({ ok: false, kind: "http", error: "http 500 key=AIzaSyABCDEFGHIJ" }) });
  const r = await runToday(m.deps);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("AIza"));
  assert.equal(m.rec.attempts.length, 1);
  assert.equal(m.rec.attempts[0], new Date(NOW).toISOString());
  assert.equal(m.rec.upserts.length, 1);
  assert.equal(m.rec.upserts[0].status, "failed");
  assert.deepEqual(m.rec.upserts[0].topics, []);
  assert.ok(!JSON.stringify(m.rec.upserts).includes("AIza"));
  assert.ok(m.rec.events.some((e) => e.kind === "digest_failed"));
  assert.ok(!JSON.stringify(m.rec).includes("AIza"));
});
test("生成失敗(http/parse/JSON不正)でも当日に ok 行があれば上書きしない。試行は毎回記録", async () => {
  const prev: DailyRow = { day: "2026-10-05", generated_at: new Date(NOW - 8 * 3600e3).toISOString(), model: "m", status: "ok", topics: [{ headline: "正常" }], input_count: 5, dropped_ratio: 0, version: 1 };
  const fresh = cards(6, { scored_at: new Date(NOW - 3600e3).toISOString() });
  const fails: GenRes[] = [
    { ok: false, kind: "http", error: "http 503" },
    { ok: false, kind: "parse", error: "response is not valid JSON" }, // MAX_TOKENS切れの途中打ち切り
    { ok: false, kind: "empty", error: "empty response (finishReason=MAX_TOKENS)" },
    { ok: true, text: "not json", json: null, model: "gemini-test" }, // JSONとして読めない
    { ok: true, text: "{}", json: {}, model: "gemini-test" }, // topics が無い
  ];
  for (const f of fails) {
    const m = makeDeps({ cards: fresh, prev, gen: () => f });
    const r = await runToday(m.deps);
    assert.equal(r.status === "failed" || r.ok === false, true);
    assert.equal(m.rec.upserts.length, 0, JSON.stringify(f)); // ok行を壊さない
    assert.equal(m.rec.attempts.length, 1);
  }
  // 話題なし(empty)・全話題破棄(failed)・費用ガード(paused)でも ok 行は上書きしない
  for (const j of [{ topics: [] }, { topics: [topic([fresh[0].post_url], { headline: "Anthropicが発表" })] }]) {
    const m = makeDeps({ cards: fresh, prev, gen: () => ok(j) });
    await runToday(m.deps);
    assert.equal(m.rec.upserts.length, 0);
  }
  // ok行が無ければ failed を保存(JSON不正は empty 扱いにしない)
  const m2 = makeDeps({ cards: fresh, gen: () => ({ ok: true, text: "x", json: null, model: "gemini-test" }) });
  const r2 = await runToday(m2.deps);
  assert.equal(r2.status, "failed");
  assert.equal(m2.rec.upserts[0].status, "failed");
  // 新しい ok は ok 行を更新できる
  const m3 = makeDeps({ cards: fresh, prev, gen: () => ok({ topics: [topic([fresh[0].post_url])] }) });
  await runToday(m3.deps);
  assert.equal(m3.rec.upserts[0].status, "ok");
});
test("見出し再生成の試行ごとに digest_last_attempt_at を記録・失敗後の再実行は間隔でスキップ", async () => {
  const cs = cards(5);
  const bad = topic([cs[0].post_url], { headline: "Anthropicが発表" });
  const m = makeDeps({ cards: cs, gen: () => ok({ topics: [bad] }) });
  await runToday(m.deps);
  assert.equal(m.rec.gens.length, 2);
  assert.equal(m.rec.attempts.length, 2);
  // failed 行が保存されるので、同じ日の再実行は(前回生成から6時間以内は)呼び出さない
  const again = cards(6, { scored_at: new Date(NOW + 60e3).toISOString() });
  const m2 = makeDeps({ cards: again, prev: m.rec.upserts[0], gen: () => ok({ topics: [bad] }), now: NOW + 1800e3 });
  const r2 = await runToday(m2.deps);
  assert.equal(r2.reason, "interval");
  assert.equal(m2.rec.gens.length, 0);
  assert.equal(m2.rec.attempts.length, 0);
});
test("maxOutputTokens は入力カード数に応じて 1500+80×枚(上限6000)・入力は最大40枚", async () => {
  assert.equal(todayMaxTokens(0), 1500);
  assert.equal(todayMaxTokens(10), 2300);
  assert.equal(todayMaxTokens(40), 4700);
  assert.equal(todayMaxTokens(100), 6000);
  const gen = () => ok({ topics: [] });
  let m = makeDeps({ cards: cards(5), gen });
  await runToday(m.deps);
  assert.equal(m.rec.gens[0].maxOutputTokens, 1500 + 80 * 5);
  m = makeDeps({ cards: cards(60), gen });
  await runToday(m.deps);
  assert.equal(m.rec.gens[0].maxOutputTokens, 1500 + 80 * 40);
  assert.equal((m.rec.gens[0].parts[0].text.match(/^URL: /gm) ?? []).length, 40);
});

// ---------- 漢字の語・漢数字の裏取り ----------
const KCARD = card(1, { content: "OpenAIは新モデルGPT-5を公開した。価格は1万2000円。提供開始は10月5日で、国内の利用者向けに順次拡大する。" });
test("漢数字は算用数字へ正規化して比較(三千万円=3000万円・一万二千)", () => {
  assert.equal(parseKanjiNumeral("三千万"), 3e7);
  assert.equal(parseKanjiNumeral("一万二千"), 12000);
  assert.equal(parseKanjiNumeral("二〇二六"), 2026);
  assert.equal(parseKanjiNumeral("百万"), 1e6);
  assert.equal(parseKanjiNumeral("十五"), 15);
  assert.equal(parseKanjiNumeral("万一"), null);
  const c = buildCorpus(["寄付額は3,000万円、従業員は二千人、売上は五億円"]);
  assert.ok(checkClaim("三千万円を寄付", c).ok);
  assert.ok(checkClaim("3千万円を寄付", c).ok);
  assert.ok(checkClaim("従業員は2000人", c).ok);
  assert.ok(checkClaim("売上は5億円", c).ok);
  assert.equal(checkClaim("二千万円を寄付", c).ok, false);
  assert.equal(checkClaim("売上は六億円", c).ok, false);
  const c2 = buildCorpus(["価格は1万2,000円、予算は3億5千万円"]);
  assert.ok(checkClaim("価格は12000円", c2).ok); // 1万2000 = 12000
  assert.ok(checkClaim("価格は1万2千円", c2).ok);
  assert.ok(checkClaim("予算は三億五千万円", c2).ok);
  assert.ok(checkClaim("予算は3.5億円", c2).ok);
  assert.equal(checkClaim("価格は1万3000円", c2).ok, false);
  assert.ok(checkClaim("一部の人が数千万円と言う", buildCorpus(["x"])).ok); // 一部・概数(数千万円)は数として扱わない
  assert.ok(checkClaim("万一に備える", buildCorpus(["x"])).ok);
});
test("new_facts は厳格: 本文に無い社名・人名・金額・地名の漢字語は落ち、正当な言い換えは残る", () => {
  const cs = [KCARD];
  const v = validateTopics([topic([cs[0].post_url], {
    headline: "OpenAIが新モデル公開",
    summary: "OpenAIが新モデルGPT-5を公開した。",
    new_facts: [
      "日銀が利上げを決定",            // 本文に無い固有名(日銀)・事象
      "田中社長が三千万円を寄付",       // 人名・金額
      "価格は一万二千円",               // 正当: 本文の1万2000円(=12000)の漢数字表記
      "価格は一万三千円",               // 本文に無い金額
      "新モデルを国内の利用者向けに提供開始", // 正当な言い換え(語は本文由来・一般語)
      "提供開始は10月5日",              // 日付
      "東京で発表",                     // 本文に無い地名(東京)
    ],
  })], cs, []);
  const facts = v.topics[0].new_facts;
  assert.ok(facts.includes("新モデルを国内の利用者向けに提供開始"));
  assert.ok(facts.includes("提供開始は10月5日"));
  assert.ok(facts.includes("価格は一万二千円"));
  assert.ok(!facts.includes("価格は一万三千円"));
  assert.ok(!facts.includes("日銀が利上げを決定"));
  assert.ok(!facts.includes("田中社長が三千万円を寄付"));
  assert.ok(!facts.includes("東京で発表"));
});
test("headline/summary は『ストップ語外の漢字語3字以上』だけ検査(2字の一般名詞で全滅しない)", () => {
  const cs = [KCARD];
  // 3字以上の本文に無い漢字語(日本銀行・半導体大手) を含む見出し・文は落ちる
  const v1 = validateTopics([topic([cs[0].post_url], { headline: "日本銀行が新モデル公開", summary: "OpenAIが新モデルを公開した。", new_facts: [] })], cs, []);
  assert.equal(v1.topics.length, 0);
  assert.equal(v1.headlineFailed, 1);
  const v2 = validateTopics([topic([cs[0].post_url], {
    headline: "OpenAIが新モデル公開",
    summary: "OpenAIが新モデルを公開した。半導体大手との提携も発表した。",
    new_facts: [],
  })], cs, []);
  assert.equal(v2.topics[0].summary, "OpenAIが新モデルを公開した。");
  // 2字の言い換え(開発・研究・企業 など)や接頭辞つき(新製品・利用者・最新版)は残る
  const v3 = validateTopics([topic([cs[0].post_url], {
    headline: "OpenAIが新製品を発表",
    summary: "OpenAI社の最新版が利用者向けに公開された。",
    new_facts: [],
  })], cs, []);
  assert.equal(v3.topics.length, 1);
  assert.equal(v3.topics[0].summary, "OpenAI社の最新版が利用者向けに公開された。");
});
test("本文にある漢字語は分割(人工知能研究 = 本文の語の連結)でも通る", () => {
  const c = buildCorpus(["自動運転技術と画像認識の研究が進む"]);
  assert.ok(checkClaim("画像認識研究が進む", c, { kanjiMin: 2 }).ok);
  assert.equal(checkClaim("自動運転規制が進む", c, { kanjiMin: 2 }).ok, false);
  assert.ok(checkClaim("自動運転規制が進む", c).ok); // 既定では漢字語は検査しない(week等)
});

// ---------- is_followup ----------
test("is_followup: 前日の見出しが無ければ常に false、プロンプトにも前日の見出しを渡す", async () => {
  const cs = cards(5);
  const tp = topic([cs[0].post_url], { is_followup: true });
  // 前日データなし → true を false に矯正
  let m = makeDeps({ cards: cs, gen: () => ok({ topics: [tp] }) });
  await runToday(m.deps);
  assert.equal((m.rec.upserts[0].topics as { is_followup: boolean }[])[0].is_followup, false);
  assert.ok(m.rec.gens[0].parts[0].text.includes("前日の話題(見出し):\n(なし)"));
  // 前日(10-04)が ok で話題あり → 見出し一覧を渡し、true は保持
  const daily = [dailyRow("2026-10-03", "ok", "古い話題"), dailyRow("2026-10-04", "ok", "OpenAIがGPT-5を発表"), dailyRow("2026-10-04".replace("04", "02"), "failed")];
  m = makeDeps({ cards: cs, daily, gen: () => ok({ topics: [tp] }) });
  await runToday(m.deps);
  const text = m.rec.gens[0].parts[0].text;
  assert.ok(text.includes("- OpenAIがGPT-5を発表"));
  assert.ok(!text.includes("古い話題"));
  assert.ok(text.includes("同じ話題の続報の場合だけ true"));
  assert.equal((m.rec.upserts[0].topics as { is_followup: boolean }[])[0].is_followup, true);
  assert.deepEqual(prevHeadlinesOf(daily, "2026-10-05"), ["OpenAIがGPT-5を発表"]);
  assert.deepEqual(prevHeadlinesOf([dailyRow("2026-10-05", "ok")], "2026-10-05"), []); // 当日は含めない
  assert.deepEqual(prevHeadlinesOf([dailyRow("2026-10-04", "failed")], "2026-10-05"), []);
  // 前日の取得に失敗しても生成は続く(false)
  const m2 = makeDeps({ cards: cs, gen: () => ok({ topics: [tp] }) });
  m2.deps.listDaily = async () => { throw new Error("db"); };
  const r2 = await runToday(m2.deps);
  assert.equal(r2.status, "ok");
  assert.equal((m2.rec.upserts[0].topics as { is_followup: boolean }[])[0].is_followup, false);
});

// ---------- week ----------
function dailyRow(day: string, status = "ok", text = "OpenAIがGPT-5を発表"): DailyRow {
  return {
    day, generated_at: `${day}T10:00:00Z`, model: "m", status, input_count: 5, dropped_ratio: 0, version: 1,
    topics: status === "ok" ? [{ headline: text, summary: `${text}。価格は100ドル。`, new_facts: [], card_urls: ["u"], is_followup: false }] : [],
  };
}
test("week: 3日未満は生成せず accumulating", async () => {
  const m = makeDeps({ gen: () => ok({ themes: [] }), daily: [dailyRow("2026-10-03"), dailyRow("2026-10-04"), dailyRow("2026-10-02", "failed")] });
  const r = await runWeek(m.deps);
  assert.equal(r.status, "accumulating");
  assert.equal(r.days_covered, 2);
  assert.equal(m.rec.gens.length, 0);
  assert.equal(m.rec.weeks[0].status, "accumulating");
  assert.equal(m.rec.weeks[0].week_start, "2026-10-05");
});
test("week: 3日以上でテーマ生成・検査・day_refs絞り込み・生活助言なしの指示", async () => {
  const daily = [dailyRow("2026-10-02"), dailyRow("2026-10-03"), dailyRow("2026-10-04")];
  const m = makeDeps({
    daily,
    gen: () => ok({ themes: [
      { title: "GPT-5の話題", summary: "OpenAIがGPT-5を発表。価格は100ドル。", day_refs: ["2026-10-02", "2026-10-04", "2099-01-01"] },
      { title: "Anthropicの話題", summary: "Anthropicが何か。", day_refs: ["2026-10-03"] },
      { title: "参照なし", summary: "OpenAIが発表。", day_refs: ["2099-01-01"] },
    ] }),
  });
  const r = await runWeek(m.deps);
  assert.equal(r.status, "ok");
  assert.equal(r.days_covered, 3);
  assert.equal(r.themes, 1);
  const themes = m.rec.weeks[0].themes as { title: string; day_refs: string[] }[];
  assert.deepEqual(themes[0].day_refs, ["2026-10-02", "2026-10-04"]);
  assert.ok(m.rec.gens[0].parts[0].text.includes("助言"));
  assert.equal(m.rec.gens[0].purpose, "digest");
});
test("week: 費用ガード拒否は paused / 全滅は failed", async () => {
  const daily = [dailyRow("2026-10-02"), dailyRow("2026-10-03"), dailyRow("2026-10-04")];
  let m = makeDeps({ daily, gen: () => ({ ok: false, kind: "guard", error: "denied" }) });
  assert.equal((await runWeek(m.deps)).status, "paused");
  assert.equal(m.rec.weeks[0].status, "paused");
  m = makeDeps({ daily, gen: () => ok({ themes: [{ title: "Anthropic", summary: "Anthropic。", day_refs: ["2026-10-02"] }] }) });
  const r = await runWeek(m.deps);
  assert.equal(r.status, "failed");
  assert.equal(r.message, "生成できません");
});

test("week: 日次再生成。入力は直近7日(今日含む)の ok のみ・7日より前は含めない・week_start は現在の週の月曜", async () => {
  const daily = [
    dailyRow("2026-09-28"), // 7日より前(window=09-29..10-05)
    dailyRow("2026-09-30"), dailyRow("2026-10-01"), dailyRow("2026-10-02", "empty"), dailyRow("2026-10-05"),
  ];
  const m = makeDeps({ daily, gen: () => ok({ themes: [{ title: "GPT-5の話題", summary: "OpenAIがGPT-5を発表。", day_refs: ["2026-09-30", "2026-10-05"] }] }) });
  const r = await runWeek(m.deps);
  assert.equal(r.status, "ok");
  assert.equal(r.days_covered, 3);
  assert.equal(m.rec.weeks[0].week_start, "2026-10-05"); // 月曜
  assert.equal(m.rec.weeks[0].days_covered, 3);
  const prompt = m.rec.gens[0].parts[0].text;
  assert.ok(prompt.includes("## 2026-09-30") && prompt.includes("## 2026-10-05"));
  assert.ok(!prompt.includes("## 2026-09-28") && !prompt.includes("## 2026-10-02"));
  // 日曜(週の終わり)でも直近7日(月曜をまたぐ)を入力し、week_start はその週の月曜
  const sun = Date.parse("2026-10-11T08:00:00Z");
  const m2 = makeDeps({ now: sun, daily: [dailyRow("2026-10-05"), dailyRow("2026-10-07"), dailyRow("2026-10-09"), dailyRow("2026-10-04")], gen: () => ok({ themes: [] }) });
  const r2 = await runWeek(m2.deps);
  assert.equal(r2.week_start, "2026-10-05");
  assert.equal(r2.days_covered, 3); // 10-04 は 7日窓(10-05〜10-11)の外
});
test("week: 既に ok のテーマがあるとき、全滅(failed)で上書きしない・同日数の再実行は間隔でスキップ", async () => {
  const daily = [dailyRow("2026-10-02"), dailyRow("2026-10-03"), dailyRow("2026-10-04")];
  const prevOk: WeekRow = { week_start: "2026-10-05", generated_at: new Date(NOW - 8 * 3600e3).toISOString(), status: "ok", themes: [{ title: "x" }], days_covered: 3 };
  const bad = () => ok({ themes: [{ title: "Anthropic", summary: "Anthropic。", day_refs: ["2026-10-02"] }] });
  let m = makeDeps({ daily, week: prevOk, gen: bad });
  assert.equal((await runWeek(m.deps)).status, "failed");
  assert.equal(m.rec.weeks.length, 0);
  m = makeDeps({ daily, week: { ...prevOk, generated_at: new Date(NOW - 3600e3).toISOString() }, gen: bad });
  assert.equal((await runWeek(m.deps)).skipped, true);
  assert.equal(m.rec.gens.length, 0);
});

// ---------- 旧3モード ----------
test("legacy: last_run は旧形式で保存し purpose=digest", async () => {
  const calls: { purpose: string; prompt: string; max: number }[] = [];
  const saved: { pt: string; body: unknown }[] = [];
  const posts = [{ author_handle: "a", gist: "テーマ", content: "x" }, { author_handle: "b", gist: null, content: "あ".repeat(100) }];
  const deps = {
    now: () => NOW,
    gen: async (purpose: string, prompt: string, _s: Record<string, unknown>, max: number) => { calls.push({ purpose, prompt, max }); return { highlights: [], new_terms: ["t"] }; },
    latestRun: async () => ({ started_at: "a", finished_at: "b" }),
    postsInRun: async () => posts,
    posts24h: async () => posts,
    posts7d: async () => [],
    upsertDigest: async (_l: string, pt: string, body: unknown) => { saved.push({ pt, body }); },
  };
  await runLegacy(deps, "last_run", "L");
  assert.equal(calls[0].purpose, "digest");
  assert.ok(calls[0].prompt.endsWith(`@a: テーマ\n@b: ${"あ".repeat(80)}`));
  assert.deepEqual(saved[0], { pt: "last_run", body: { highlights: [], new_terms: ["t"] } });
  await runLegacy(deps, "24h", "L");
  assert.equal(calls[1].purpose, "digest24");
  await runLegacy(deps, "7d", "L"); // 7日データなし → Geminiを呼ばず empty
  assert.equal(calls.length, 2);
  const b = saved[2].body as { daily: unknown[]; empty: boolean; trend: string };
  assert.equal(saved[2].pt, "7d");
  assert.equal(b.empty, true);
  assert.equal(b.daily.length, 7);
  assert.equal(toLine({ author_handle: "z", gist: null, content: null }), "@z: ");
  assert.equal(jstDateStr(new Date("2026-10-05T16:00:00Z")), "2026-10-06");
});
test("legacy: 7d は daily を付けて保存し purpose=digest7、fetch_runs無しはskipped", async () => {
  const saved: { body: any }[] = [];
  const deps = {
    now: () => NOW,
    gen: async (purpose: string) => ({ trend: purpose, advice: "a" }),
    latestRun: async () => null,
    postsInRun: async () => [],
    posts24h: async () => [],
    posts7d: async () => [{ posted_at: "2026-10-05T01:00:00Z", fetched_at: null, is_read: false }],
    upsertDigest: async (_l: string, _p: string, body: unknown) => { saved.push({ body }); },
  };
  await runLegacy(deps, "7d", "L");
  assert.equal(saved[0].body.trend, "digest7");
  assert.equal(saved[0].body.daily[6].total, 1);
  assert.equal(saved[0].body.daily[6].unread, 1);
  const r = await runLegacy(deps, "last_run", "L");
  assert.deepEqual(r, { skipped: true, reason: "no fetch_runs row" });
});
