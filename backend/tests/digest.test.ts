import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays, buildCorpus, checkClaim, digestDay, digestDayStartMs, runToday, runWeek, validateTopics, weekStartOf,
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

interface Rec { upserts: DailyRow[]; weeks: WeekRow[]; events: { level: string; kind: string }[]; gens: GenReq[] }
function makeDeps(opts: {
  cards?: Card[]; prev?: DailyRow | null; gen: (r: GenReq, n: number) => GenRes; cfg?: Record<string, number>;
  daily?: DailyRow[]; week?: WeekRow | null; now?: number;
}): { deps: DigestDeps; rec: Rec } {
  const rec: Rec = { upserts: [], weeks: [], events: [], gens: [] };
  const deps: DigestDeps = {
    now: () => opts.now ?? NOW,
    gen: async (r) => { rec.gens.push(r); return opts.gen(r, rec.gens.length); },
    cfgNum: async (k, d) => opts.cfg?.[k] ?? d,
    loadCards: async () => opts.cards ?? [],
    getDaily: async () => opts.prev ?? null,
    listDaily: async () => opts.daily ?? [],
    upsertDaily: async (row) => { rec.upserts.push(row); },
    getWeek: async () => opts.week ?? null,
    upsertWeek: async (row) => { rec.weeks.push(row); },
    opsEvent: async (level, kind) => { rec.events.push({ level, kind }); },
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
test("Geminiエラー(ガード以外)は保存せずok:false・キーを含めない", async () => {
  const m = makeDeps({ cards: cards(5), gen: () => ({ ok: false, kind: "http", error: "http 500 key=AIzaSyABCDEFGHIJ" }) });
  const r = await runToday(m.deps);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("AIza"));
  assert.equal(m.rec.upserts.length, 0);
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
