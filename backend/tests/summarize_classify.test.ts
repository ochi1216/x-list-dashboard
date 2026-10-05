import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildFullPrompt, checkUnauthRestrictions, classifyContent, fetchImageAsInlineData, IMAGE_PROMPT, isPermanentFailure,
  needsImageAnalysis, resolveLimit, RESPONSE_SCHEMA, SHORT_EN_PROMPT, summarizeOne, SUMMARY_PROMPT, toSmallVariant,
} from "../functions/summarize-x-post/logic.ts";
import { newBatchId, runPool, createBudget, clampInt } from "../functions/_shared/util.ts";

const legacy = readFileSync(new URL("../legacy/summarize-x-post.v7.ts", import.meta.url), "utf8");

test("classifyContent: 原本と同じ分類", () => {
  assert.equal(classifyContent(""), "empty");
  assert.equal(classifyContent("   \n "), "empty");
  assert.equal(classifyContent(null as unknown as string), "empty");
  assert.equal(classifyContent("今日はいい天気ですね"), "short_ja");
  assert.equal(classifyContent("あ".repeat(40)), "short_ja");
  assert.equal(classifyContent("あ".repeat(41)), "long");
  assert.equal(classifyContent("Just shipped a new feature today!"), "short_en");
  assert.equal(classifyContent("a".repeat(150)), "short_en");
  assert.equal(classifyContent("a".repeat(151)), "long");
  assert.equal(classifyContent("漢字投稿記事"), "long"); // かな無し・ASCII少 → long
  assert.equal(classifyContent("12345 67890"), "long"); // 数字だけ(英字比率0)
  assert.equal(classifyContent("https://t.co/abc OpenAI"), "short_en");
});

test("needsImageAnalysis: 画像ありかつ本文が長文でない場合のみ", () => {
  assert.equal(needsImageAnalysis("long", true), false);
  assert.equal(needsImageAnalysis("empty", true), true);
  assert.equal(needsImageAnalysis("short_ja", true), true);
  assert.equal(needsImageAnalysis("short_en", true), true);
  assert.equal(needsImageAnalysis("short_en", false), false);
});

test("toSmallVariant: twimg.comだけname=smallにする", () => {
  assert.equal(toSmallVariant("https://pbs.twimg.com/media/abc?format=jpg&name=large"), "https://pbs.twimg.com/media/abc?format=jpg&name=small");
  assert.equal(toSmallVariant("https://pbs.twimg.com/media/abc.jpg"), "https://pbs.twimg.com/media/abc.jpg?name=small");
  assert.equal(toSmallVariant("https://example.com/a.jpg?name=large"), "https://example.com/a.jpg?name=large");
  assert.equal(toSmallVariant("not a url"), "not a url");
});

test("プロンプト・スキーマ・分類関数は原本(legacy v7)と一字一句同じ", () => {
  const grab = (name: string) => {
    const m = legacy.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
    assert.ok(m, name);
    return m![1];
  };
  assert.equal(SUMMARY_PROMPT, grab("SUMMARY_PROMPT"));
  assert.equal(SHORT_EN_PROMPT, grab("SHORT_EN_PROMPT"));
  assert.equal(IMAGE_PROMPT, grab("IMAGE_PROMPT"));
  assert.deepEqual(RESPONSE_SCHEMA, { type: "OBJECT", properties: { gist: { type: "STRING" }, summary: { type: "STRING" } }, required: ["gist", "summary"] });
  // 関数本体のテキストが原本と一致する
  for (const fnName of ["classifyContent", "needsImageAnalysis", "toSmallVariant"]) {
    const re = new RegExp("function " + fnName + "\\([\\s\\S]*?\\n}\\n");
    const a = legacy.match(re)![0];
    const logic = readFileSync(new URL("../functions/summarize-x-post/logic.ts", import.meta.url), "utf8");
    const b = logic.match(re)![0];
    assert.equal(b, a, fnName);
  }
  // プロンプト組み立て
  assert.equal(
    buildFullPrompt("P", "@h", "名前", ""),
    "P\n\n投稿者: 名前 (@h)\n本文:\n(本文なし。画像のみの投稿)",
  );
  assert.equal(buildFullPrompt("P", "@h", "名前", "本文"), "P\n\n投稿者: 名前 (@h)\n本文:\n本文");
});

const post = (o: Record<string, unknown> = {}) => ({ post_url: "https://x.com/a/1", author_handle: "@a", author_name: "A", content: "", image_urls: [], ...o });
function fakeGen(json: unknown = { gist: "G", summary: "S" }) {
  const calls: { parts: any[]; maxOutputTokens: number }[] = [];
  return { calls, gen: async (parts: any[], opts: { maxOutputTokens: number }) => { calls.push({ parts, maxOutputTokens: opts.maxOutputTokens }); return { ok: true as const, json }; } };
}

test("summarizeOne: short_ja(画像なし)はGeminiを呼ばず原文を採用(60字で切る)", async () => {
  const g = fakeGen();
  const r = await summarizeOne(post({ content: "短い日本語の投稿です" }), { gen: g.gen });
  assert.deepEqual(r, { ok: true, gist: "短い日本語の投稿です", summary: "短い日本語の投稿です", usedGemini: false });
  assert.equal(g.calls.length, 0);
});

test("summarizeOne: 長文はSUMMARY_PROMPT・600トークン、short_enはSHORT_EN_PROMPT", async () => {
  const g = fakeGen();
  const r = await summarizeOne(post({ content: "あ".repeat(100) }), { gen: g.gen });
  assert.deepEqual(r, { ok: true, gist: "G", summary: "S", usedGemini: true });
  assert.equal(g.calls[0].maxOutputTokens, 600);
  assert.ok(g.calls[0].parts[0].text.startsWith(SUMMARY_PROMPT));
  await summarizeOne(post({ content: "Hello world" }), { gen: g.gen });
  assert.ok(g.calls[1].parts[0].text.startsWith(SHORT_EN_PROMPT));
});

test("summarizeOne: 画像あり(本文短)は画像を取得してIMAGE_PROMPT・1000トークン、最大4枚", async () => {
  const g = fakeGen();
  const fetched: string[] = [];
  const r = await summarizeOne(
    post({ content: "見て", image_urls: ["u1", "u2", "u3", "u4", "u5"] }),
    { gen: g.gen, fetchImage: async (u) => { fetched.push(u); return { mimeType: "image/jpeg", data: "QQ==" }; } },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(fetched, ["u1", "u2", "u3", "u4"]);
  assert.equal(g.calls[0].maxOutputTokens, 1000);
  assert.ok(g.calls[0].parts[0].text.startsWith(IMAGE_PROMPT));
  assert.equal(g.calls[0].parts.length, 5);
  assert.deepEqual(g.calls[0].parts[1], { inlineData: { mimeType: "image/jpeg", data: "QQ==" } });
});

test("summarizeOne: 画像が全部取得失敗なら short_ja は原文、それ以外は本文のみ要約", async () => {
  const g = fakeGen();
  const none = async () => null;
  const a = await summarizeOne(post({ content: "短い", image_urls: ["u"] }), { gen: g.gen, fetchImage: none });
  assert.equal(a.ok && a.usedGemini, false);
  const b = await summarizeOne(post({ content: "", image_urls: ["u"] }), { gen: g.gen, fetchImage: none });
  assert.equal(b.ok && b.usedGemini, true);
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].maxOutputTokens, 600);
  assert.ok(g.calls[0].parts[0].text.includes("(本文なし。画像のみの投稿)"));
});

test("summarizeOne: 長文は画像があっても画像を取得しない", async () => {
  const g = fakeGen();
  let n = 0;
  await summarizeOne(post({ content: "あ".repeat(80), image_urls: ["u"] }), { gen: g.gen, fetchImage: async () => { n++; return null; } });
  assert.equal(n, 0);
});

test("summarizeOne: 失敗・不正な形はok:false(書き込みしない)", async () => {
  const bad = await summarizeOne(post({ content: "あ".repeat(80) }), { gen: async () => ({ ok: false as const, error: "boom", kind: "http" }) });
  assert.deepEqual(bad, { ok: false, error: "boom", kind: "http" });
  const shape = await summarizeOne(post({ content: "あ".repeat(80) }), fakeGenDeps({ gist: "x" }));
  assert.equal(shape.ok, false);
});
function fakeGenDeps(json: unknown) { return { gen: fakeGen(json).gen }; }

test("fetchImageAsInlineData: 画像のみ受理し縮小URLで取得", async () => {
  let url = "";
  const mkFetch = (ct: string, ok = true) => (async (u: string) => { url = u; return { ok, headers: { get: () => ct }, arrayBuffer: async () => new Uint8Array([65, 66, 67]).buffer }; }) as unknown as typeof fetch;
  const r = await fetchImageAsInlineData("https://pbs.twimg.com/media/x?name=large", mkFetch("image/png; charset=x"));
  assert.deepEqual(r, { mimeType: "image/png", data: "QUJD" });
  assert.ok(url.includes("name=small"));
  assert.equal(await fetchImageAsInlineData("https://a/b", mkFetch("text/html")), null);
  assert.equal(await fetchImageAsInlineData("https://a/b", mkFetch("image/png", false)), null);
});

test("resolveLimit(既定20・上限60)と未認証の制限", () => {
  assert.equal(resolveLimit(undefined), 20);
  assert.equal(resolveLimit(5), 5);
  assert.equal(resolveLimit(500), 60);
  assert.equal(resolveLimit(0), 1);
  assert.equal(resolveLimit("abc"), 20);
  assert.equal(resolveLimit("30"), 30);
  assert.equal(checkUnauthRestrictions(true, { post_url: "https://x.com/a/1" }) !== null, true);
  assert.equal(checkUnauthRestrictions(true, {}), null);
  assert.equal(checkUnauthRestrictions(false, { post_url: "https://x.com/a/1" }), null);
});

test("runPool: 並列上限・時間予算で未着手を残す・例外を隔離", async () => {
  let active = 0, peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const r = await runPool(items, 4, async (i) => {
    active++; peak = Math.max(peak, active);
    await new Promise((res) => setTimeout(res, 5));
    active--;
    if (i === 3) throw new Error("x");
    return i * 2;
  });
  assert.equal(peak, 4);
  assert.equal(r.started, 10);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.results[2], { status: "ok", value: 4 });
  assert.equal(r.results[3].status, "error");

  // 締切: 時刻を進めて3件目以降は開始しない
  let t = 0;
  const r2 = await runPool([1, 2, 3, 4, 5], 1, async () => { t += 40; return 1; }, 100, () => t);
  assert.equal(r2.started, 3);
  assert.equal(r2.skipped, 2);
  assert.equal(r2.results[4].status, "skipped");

  assert.deepEqual((await runPool([], 4, async () => 1)).results, []);
});

test("newBatchId / createBudget / clampInt", () => {
  const id = newBatchId("summarize-x-post", () => Date.UTC(2026, 9, 5, 14, 30, 12, 345), () => "abc123");
  assert.equal(id, "summarize-x-post-20261005T143012Z-abc123");
  assert.notEqual(newBatchId("f"), newBatchId("f"));
  let t = 1000;
  const b = createBudget(100_000, () => t);
  assert.equal(b.deadline, 101_000);
  assert.equal(b.expired(), false);
  t = 101_000;
  assert.equal(b.expired(), true);
  assert.equal(b.remaining(), 0);
  assert.equal(clampInt("7", 1, 1, 5), 5);
  assert.equal(clampInt(undefined, 3, 1, 5), 3);
});

test("isPermanentFailure: 数えるのは Gemini の4xx(429以外)・parse・empty だけ", () => {
  // 数える
  for (const status of [400, 401, 403, 422]) assert.equal(isPermanentFailure({ kind: "http", status }), true, `http ${status}`);
  assert.equal(isPermanentFailure({ kind: "parse" }), true);
  assert.equal(isPermanentFailure({ kind: "empty" }), true);
  // 数えない: 429・5xx・通信・提供終了・費用ガード/状態取得失敗・不明
  for (const status of [429, 500, 502, 503, 504]) assert.equal(isPermanentFailure({ kind: "http", status }), false, `http ${status}`);
  assert.equal(isPermanentFailure({ kind: "http" }), false);
  assert.equal(isPermanentFailure({ kind: "network" }), false);
  assert.equal(isPermanentFailure({ kind: "gone", status: 404 }), false);
  assert.equal(isPermanentFailure({ kind: "guard" }), false);
  assert.equal(isPermanentFailure({}), false);
});

test("summarizeOne: Gemini失敗の kind/status が結果に引き継がれる(試行回数の判定に使う)", async () => {
  const r = await summarizeOne(post({ content: "あ".repeat(80) }), { gen: async () => ({ ok: false as const, error: "bad", kind: "http", status: 400 }) });
  assert.deepEqual(r, { ok: false, error: "bad", kind: "http", status: 400 });
  assert.equal(r.ok === false && isPermanentFailure(r), true);
  const r2 = await summarizeOne(post({ content: "あ".repeat(80) }), { gen: async () => ({ ok: false as const, error: "quota", kind: "http", status: 429 }) });
  assert.equal(r2.ok === false && isPermanentFailure(r2), false);
  const shape = await summarizeOne(post({ content: "あ".repeat(80) }), fakeGenDeps({ gist: "x" }));
  assert.equal(shape.ok === false && isPermanentFailure(shape), true); // 形が不正=parse
});
