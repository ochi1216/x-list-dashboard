import test from "node:test";
import assert from "node:assert/strict";
import { callGemini, isGoneResponse, resolveGeminiBase, sanitize } from "../functions/_shared/gemini.ts";
import type { GeminiCtx } from "../functions/_shared/gemini.ts";

const KEY = "AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE0123456789";

function makeState(over: Record<string, unknown> = {}) {
  return {
    current_model: "m1",
    candidates: ["m1", "m2"],
    gone_streak: 0,
    usd_jpy: 160,
    configs: {
      m1: { enabled: true, in_usd: 0.1, out_usd: 0.4, gen_config: { default: { temperature: 0.5, thinkingConfig: { thinkingBudget: 0 } }, summary: { seed: 7 } } },
      m2: { enabled: true, in_usd: 0.3, out_usd: 2.5, gen_config: {} },
    },
    ...over,
  };
}

interface Harness {
  ctx: GeminiCtx;
  rpcCalls: { name: string; args: unknown }[];
  usage: Record<string, unknown>[];
  fetches: { url: string; init: RequestInit; body: any }[];
  sleeps: number[];
  setState(s: unknown): void;
}

function harness(
  responses: Array<{ status: number; body: unknown } | Error>,
  opts: { guard?: unknown; gone?: unknown[]; state?: unknown } = {},
): Harness {
  let state: unknown = opts.state ?? makeState();
  const rpcCalls: Harness["rpcCalls"] = [];
  const usage: Record<string, unknown>[] = [];
  const fetches: Harness["fetches"] = [];
  const sleeps: number[] = [];
  const goneQueue = [...(opts.gone ?? [])];
  let i = 0;
  const db = {
    async rpc(name: string, args?: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === "get_model_state") return { data: state, error: null };
      if (name === "cost_guard") return { data: opts.guard ?? { allowed: true, level: "ok" }, error: null };
      if (name === "model_report_gone") return { data: goneQueue.shift() ?? { current_model: "m1", switched: false, streak: 1 }, error: null };
      return { data: null, error: null };
    },
    async insertUsage(row: Record<string, unknown>) {
      usage.push(row);
      return usage.length;
    },
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    fetches.push({ url, init, body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  }) as unknown as typeof fetch;
  let t = 1_000;
  const ctx: GeminiCtx = {
    db, apiKey: KEY, fn: "summarize-x-post", grp: "x", batchId: "b-1", fetchFn,
    now: () => (t += 10),
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { ctx, rpcCalls, usage, fetches, sleeps, setState: (s) => { state = s; } };
}

const okBody = (text: unknown, usage: unknown = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 300 }) => ({
  candidates: [{ content: { parts: Array.isArray(text) ? text : [{ text }] }, finishReason: "STOP" }],
  ...(usage ? { usageMetadata: usage } : {}),
});
const REQ = { purpose: "summary", parts: [{ text: "hi" }], maxOutputTokens: 600, postUrl: "https://x.com/a/1" };
const SCHEMA = { type: "OBJECT", properties: { gist: { type: "STRING" } } };

test("成功: キーはヘッダのみ・URLに無い・usage記録と費用計算・model_report_ok", async () => {
  const h = harness([{ status: 200, body: okBody('{"gist":"g"}') }]);
  const r = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.json, { gist: "g" });
  assert.equal(r.model, "m1");
  assert.equal(r.usageId, 1);
  // (1000*0.1 + (200+300)*0.4)/1e6
  assert.ok(Math.abs(r.usage.costUsd! - 0.0003) < 1e-12);
  assert.deepEqual([r.usage.prompt, r.usage.output, r.usage.thoughts], [1000, 200, 300]);
  const f = h.fetches[0];
  assert.ok(!f.url.includes(KEY) && !f.url.includes("key="));
  assert.equal(f.url, "https://generativelanguage.googleapis.com/v1beta/models/m1:generateContent");
  assert.equal((f.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
  assert.ok(!String(f.init.body).includes(KEY));
  // generationConfig: schema + maxOutputTokens + モデル設定(default + purpose)
  assert.deepEqual(f.body.generationConfig, {
    temperature: 0.5, thinkingConfig: { thinkingBudget: 0 }, seed: 7,
    responseMimeType: "application/json", responseSchema: SCHEMA, maxOutputTokens: 600,
  });
  const u = h.usage[0];
  assert.equal(u.status, "ok");
  assert.equal(u.attempt, 1);
  assert.equal(u.fn, "summarize-x-post");
  assert.equal(u.purpose, "summary");
  assert.equal(u.grp, "x");
  assert.equal(u.batch_id, "b-1");
  assert.equal(u.post_url, "https://x.com/a/1");
  assert.equal(u.http_status, 200);
  assert.equal(u.in_price, 0.1);
  assert.equal(u.out_price, 0.4);
  assert.ok(h.rpcCalls.some((c) => c.name === "model_report_ok" && (c.args as any).p_model === "m1"));
  const guard = h.rpcCalls.find((c) => c.name === "cost_guard")!;
  assert.deepEqual(guard.args, { p_purpose: "summary", p_grp: "x" });
});

test("schema無しならresponseMimeTypeを付けずjsonはnull", async () => {
  const h = harness([{ status: 200, body: okBody("plain text") }]);
  const r = await callGemini(h.ctx, { ...REQ, purpose: "other" });
  assert.equal(r.ok && r.json, null);
  assert.equal(r.ok && r.text, "plain text");
  assert.equal(h.fetches[0].body.generationConfig.responseMimeType, undefined);
});

test("temperature/seed: モデル設定(default・用途別)に有ればそれが正。リクエストの値はモデル設定に無いときの既定値", async () => {
  // m1: default.temperature=0.5, summary.seed=7 → リクエストの temperature:0 / seed:1 は使われない
  const h1 = harness([{ status: 200, body: okBody("x") }]);
  await callGemini(h1.ctx, { ...REQ, temperature: 0, seed: 1 });
  assert.equal(h1.fetches[0].body.generationConfig.temperature, 0.5);
  assert.equal(h1.fetches[0].body.generationConfig.seed, 7);
  // モデル設定に temperature/seed が無ければリクエストの値を使う
  const st = makeState();
  (st.configs as any).m1.gen_config = { default: { thinkingConfig: { thinkingBudget: 0 } } };
  const h2 = harness([{ status: 200, body: okBody("x") }], { state: st });
  await callGemini(h2.ctx, { ...REQ, temperature: 0.2, seed: 3 });
  assert.equal(h2.fetches[0].body.generationConfig.temperature, 0.2);
  assert.equal(h2.fetches[0].body.generationConfig.seed, 3);
  // 用途別の設定が default より優先(従来どおり)
  const st3 = makeState();
  (st3.configs as any).m1.gen_config = { default: { temperature: 0.9 }, score: { temperature: 0 } };
  const h3 = harness([{ status: 200, body: okBody("x") }], { state: st3 });
  await callGemini(h3.ctx, { ...REQ, purpose: "score", temperature: 0.7 });
  assert.equal(h3.fetches[0].body.generationConfig.temperature, 0);
});

test("maxOutputTokens が未指定・0以下・非数なら、Geminiを呼ぶ前に例外(guard等の結果にはしない)", async () => {
  for (const bad of [undefined, 0, -5, Number.NaN, "600"]) {
    const h = harness([{ status: 200, body: okBody("x") }]);
    await assert.rejects(() => callGemini(h.ctx, { ...REQ, maxOutputTokens: bad as never }), /maxOutputTokens/);
    assert.equal(h.fetches.length, 0);
    assert.equal(h.rpcCalls.length, 0);
    assert.equal(h.usage.length, 0);
  }
});

test("モデル状態・cost_guard の取得失敗は kind=guard / level=state_error(gone と混同しない)。fetchしない", async () => {
  const h1 = harness([{ status: 200, body: okBody("x") }], { state: { nonsense: true } });
  const r1 = await callGemini(h1.ctx, REQ);
  assert.deepEqual(r1.ok ? null : [r1.kind, r1.level], ["guard", "state_error"]);
  assert.equal(h1.fetches.length, 0);
  assert.ok(!h1.rpcCalls.some((c) => c.name === "model_report_gone"));
  // get_model_state が例外
  const h2 = harness([{ status: 200, body: okBody("x") }]);
  h2.ctx.db.rpc = async (name) => { if (name === "get_model_state") throw new Error("db down"); return { data: null, error: null }; };
  const r2 = await callGemini(h2.ctx, REQ);
  assert.deepEqual(r2.ok ? null : [r2.kind, r2.level], ["guard", "state_error"]);
  // cost_guard が取得できない
  const h3 = harness([{ status: 200, body: okBody("x") }]);
  const orig = h3.ctx.db.rpc.bind(h3.ctx.db);
  h3.ctx.db.rpc = async (name, args) => name === "cost_guard" ? { data: null, error: { message: "boom" } } : orig(name, args);
  const r3 = await callGemini(h3.ctx, REQ);
  assert.deepEqual(r3.ok ? null : [r3.kind, r3.level], ["guard", "state_error"]);
  assert.equal(h3.fetches.length, 0);
});

test("提供終了の判定: 404は常に。400/410は本文に model を含み提供終了を示すときだけ", async () => {
  assert.equal(isGoneResponse(404, ""), true);
  assert.equal(isGoneResponse(400, "models/x is no longer available"), true);
  assert.equal(isGoneResponse(410, "The model has been deprecated"), true);
  assert.equal(isGoneResponse(400, "Requested entity was not found"), false); // model の語が無い
  assert.equal(isGoneResponse(410, "resource deprecated"), false);
  assert.equal(isGoneResponse(400, "model parameter invalid"), false); // 提供終了の語が無い
  assert.equal(isGoneResponse(500, "model not found"), false);
  const h = harness([{ status: 400, body: { error: { message: "Requested entity was not found" } } }]);
  const r = await callGemini(h.ctx, REQ);
  assert.equal(!r.ok && r.kind, "http");
  assert.ok(!h.rpcCalls.some((c) => c.name === "model_report_gone"));
});

test("finishReason=MAX_TOKENS: 失敗(parse)にせず text を返し truncated=true。使用量は記録・model_report_ok", async () => {
  const body = { candidates: [{ content: { parts: [{ text: '{"gist":"途中で切' }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 600, thoughtsTokenCount: 0 } };
  const h = harness([{ status: 200, body }]);
  const r = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.truncated, true);
    assert.equal(r.text, '{"gist":"途中で切');
    assert.equal(r.json, null);
  }
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0].status, "ok");
  assert.ok(h.rpcCalls.some((c) => c.name === "model_report_ok"));
  // 通常終了(STOP)では truncated は付かない
  const h2 = harness([{ status: 200, body: okBody('{"gist":"g"}') }]);
  const r2 = await callGemini(h2.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r2.ok && r2.truncated, undefined);
  // schema無し(本文テキスト)でも truncated
  const h3 = harness([{ status: 200, body: { candidates: [{ content: { parts: [{ text: "長い要約の途中" }] }, finishReason: "MAX_TOKENS" }] } }]);
  const r3 = await callGemini(h3.ctx, REQ);
  assert.equal(r3.ok && r3.truncated, true);
});

test("再実行(再試行・提供終了後の新モデル再実行)は合計1回まで: 切替後の429は再試行しない", async () => {
  const h = harness(
    [{ status: 404, body: "models/m1 not found" }, { status: 429, body: "quota" }],
    { gone: [{ current_model: "m2", switched: true, streak: 3 }] },
  );
  const orig = h.ctx.db.rpc.bind(h.ctx.db);
  let gone = false;
  h.ctx.db.rpc = async (name, args) => {
    if (name === "model_report_gone") gone = true;
    if (name === "get_model_state" && gone) return { data: makeState({ current_model: "m2" }), error: null };
    return orig(name, args);
  };
  const r = await callGemini(h.ctx, REQ);
  assert.equal(h.fetches.length, 2);
  assert.equal(!r.ok && r.kind, "http");
  assert.deepEqual(h.sleeps, []);
});

test("思考part(thought:true)は除外し、残りのtextを全て結合する", async () => {
  const parts = [{ text: "考え中", thought: true }, { text: '{"gist":' }, { text: '"x"}' }];
  const h = harness([{ status: 200, body: okBody(parts) }]);
  const r = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.text, '{"gist":"x"}');
    assert.deepEqual(r.json, { gist: "x" });
  }
});

test("429は1.5秒後に1回だけ再試行し、別行(attempt=2)で記録する", async () => {
  const h = harness([
    { status: 429, body: { error: { message: "quota" } } },
    { status: 200, body: okBody('{"gist":"g"}') },
  ]);
  const r = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r.ok, true);
  assert.deepEqual(h.sleeps, [1500]);
  assert.equal(h.fetches.length, 2);
  assert.deepEqual(h.usage.map((u) => [u.attempt, u.status, u.http_status]), [[1, "error", 429], [2, "ok", 200]]);
});

test("429が続いても再試行は1回だけ(500/503も同様)", async () => {
  for (const st of [429, 500, 503]) {
    const h = harness([{ status: st, body: "boom" }]);
    const r = await callGemini(h.ctx, REQ);
    assert.equal(h.fetches.length, 2, `status ${st}`);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.kind, "http"); assert.equal(r.status, st); }
    assert.equal(h.usage.length, 2);
    assert.ok(!h.rpcCalls.some((c) => c.name === "model_report_ok"));
  }
});

test("400(通常エラー)は再試行もモデル切替もしない", async () => {
  const h = harness([{ status: 400, body: { error: { message: "API key not valid" } } }]);
  const r = await callGemini(h.ctx, REQ);
  assert.equal(h.fetches.length, 1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "http");
  assert.ok(!h.rpcCalls.some((c) => c.name === "model_report_gone"));
});

test("404×3でモデル切替: 3回目のmodel_report_goneがswitchedなら新モデルで同一要求を再実行", async () => {
  const notFound = { status: 404, body: { error: { message: "models/m1 is not found" } } };
  const h = harness(
    [notFound, notFound, notFound, { status: 200, body: okBody('{"gist":"g"}') }],
    { gone: [
      { current_model: "m1", switched: false, streak: 1 },
      { current_model: "m1", switched: false, streak: 2 },
      { current_model: "m2", switched: true, streak: 3 },
    ] },
  );
  const r1 = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  const r2 = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.deepEqual([r1.ok, r2.ok], [false, false]);
  if (!r1.ok) { assert.equal(r1.kind, "gone"); assert.equal(r1.status, 404); assert.equal(r1.model, "m1"); }
  assert.equal(h.fetches.length, 2);
  // 3回目: 切替後の状態に更新してから呼ぶ
  h.setState(makeState({ current_model: "m2" }));
  const r3 = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r3.ok, true);
  if (r3.ok) assert.equal(r3.model, "m2");
  assert.equal(h.fetches.length, 4);
  assert.ok(h.fetches[2].url.includes("/models/m1:"));
  assert.ok(h.fetches[3].url.includes("/models/m2:"));
  // 同一要求(contents・schema・maxOutputTokens)
  assert.deepEqual(h.fetches[3].body.contents, h.fetches[2].body.contents);
  assert.equal(h.fetches[3].body.generationConfig.maxOutputTokens, 600);
  assert.deepEqual(h.fetches[3].body.generationConfig.responseSchema, SCHEMA);
  // 新モデルの単価で記録(m2: 0.3/2.5)
  const last = h.usage[3];
  assert.equal(last.model, "m2");
  assert.equal(last.in_price, 0.3);
  assert.equal(last.attempt, 2);
  assert.equal(last.status, "ok");
  assert.equal(h.usage.filter((u) => u.status === "error").length, 3);
  assert.equal(h.rpcCalls.filter((c) => c.name === "model_report_gone").length, 3);
});

test("切替が同じ呼び出しの中で起きる場合: キャッシュを更新して新モデルで1回だけ再実行", async () => {
  const notFound = { status: 404, body: "not found" };
  const h = harness([notFound, { status: 200, body: okBody("ok") }], {
    gone: [{ current_model: "m2", switched: true, streak: 3 }],
  });
  // get_model_state は切替後に新モデルを返すよう差し替え
  const orig = h.ctx.db.rpc.bind(h.ctx.db);
  let gone = false;
  h.ctx.db.rpc = async (name, args) => {
    if (name === "model_report_gone") gone = true;
    if (name === "get_model_state" && gone) return { data: makeState({ current_model: "m2" }), error: null };
    return orig(name, args);
  };
  const r = await callGemini(h.ctx, REQ);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.model, "m2");
  assert.equal(h.fetches.length, 2);
  assert.ok(h.fetches[1].url.includes("/models/m2:"));
});

test("400/410で本文が提供終了を示す場合もgone扱い、示さなければhttp", async () => {
  const h = harness([{ status: 410, body: { error: { message: "This model has been deprecated" } } }]);
  const r = await callGemini(h.ctx, REQ);
  assert.equal(!r.ok && r.kind, "gone");
  assert.ok(h.rpcCalls.some((c) => c.name === "model_report_gone"));
});

test("cost_guard拒否は即guard。fetchせず、レベルを返す", async () => {
  const h = harness([{ status: 200, body: okBody("x") }], { guard: { allowed: false, level: "stop" } });
  const r = await callGemini(h.ctx, REQ);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.kind, "guard"); assert.equal(r.level, "stop"); }
  assert.equal(h.fetches.length, 0);
  assert.equal(h.usage.length, 0);
});

test("usage記録: 失敗(HTTPエラー)でもstatus=errorで1行、キー非露出・200字以内", async () => {
  const long = `bad request key=${KEY} ` + "x".repeat(500);
  const h = harness([{ status: 400, body: { error: { message: long } } }]);
  const r = await callGemini(h.ctx, REQ);
  assert.equal(h.usage.length, 1);
  const u = h.usage[0];
  assert.equal(u.status, "error");
  assert.equal(u.http_status, 400);
  assert.ok(String(u.error).length <= 200);
  assert.ok(!JSON.stringify(u).includes("AIza"));
  assert.ok(!JSON.stringify(r).includes("AIza"));
  assert.ok(!JSON.stringify(r).includes("key=" + KEY));
});

test("通信例外: kind=network、usageにerror行、例外文のキーは伏せる", async () => {
  const h = harness([new Error(`fetch failed https://x/?key=${KEY} and ${KEY}`)]);
  const r = await callGemini(h.ctx, REQ);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "network");
  assert.ok(!JSON.stringify(r).includes("AIza"));
  assert.equal(h.usage.length, 1);
  assert.equal(h.usage[0].status, "error");
  assert.equal(h.usage[0].http_status, null);
  assert.ok(!JSON.stringify(h.usage[0]).includes("AIza"));
  assert.equal(h.fetches.length, 1);
});

test("usageMetadata欠落: status=no_usage、トークン・費用はnull、結果は成功", async () => {
  const h = harness([{ status: 200, body: okBody('{"gist":"g"}', null) }]);
  const r = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.usage.costUsd, null);
  const u = h.usage[0];
  assert.equal(u.status, "no_usage");
  assert.equal(u.cost_usd, null);
  assert.equal(u.prompt_tokens, null);
});

test("単価未登録: status=unpriced、トークンは記録しcost_usdはnull", async () => {
  const st = makeState();
  (st.configs as any).m1.in_usd = null;
  (st.configs as any).m1.out_usd = null;
  const h = harness([{ status: 200, body: okBody("t") }], { state: st });
  const r = await callGemini(h.ctx, REQ);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.usage.costUsd, null);
  const u = h.usage[0];
  assert.equal(u.status, "unpriced");
  assert.equal(u.cost_usd, null);
  assert.equal(u.prompt_tokens, 1000);
});

test("thoughtsTokenCount欠落は0扱い", async () => {
  const h = harness([{ status: 200, body: okBody("t", { promptTokenCount: 10, candidatesTokenCount: 5 }) }]);
  const r = await callGemini(h.ctx, REQ);
  assert.equal(r.ok && r.usage.thoughts, 0);
  assert.equal(h.usage[0].thoughts_tokens, 0);
});

test("空応答はkind=empty(使用量は記録)、JSON不正はkind=parse", async () => {
  const h1 = harness([{ status: 200, body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "…", thought: true }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 0, thoughtsTokenCount: 600 } } }]);
  const r1 = await callGemini(h1.ctx, REQ);
  assert.equal(!r1.ok && r1.kind, "empty");
  assert.equal(h1.usage.length, 1);
  assert.equal(h1.usage[0].status, "ok");
  assert.ok(!h1.rpcCalls.some((c) => c.name === "model_report_ok"));
  const h2 = harness([{ status: 200, body: okBody("not json {") }]);
  const r2 = await callGemini(h2.ctx, { ...REQ, schema: SCHEMA });
  assert.equal(!r2.ok && r2.kind, "parse");
  assert.equal(h2.usage.length, 1);
});

test("コードフェンス付きJSONも受理", async () => {
  const h = harness([{ status: 200, body: okBody('```json\n{"gist":"g"}\n```') }]);
  const r = await callGemini(h.ctx, { ...REQ, schema: SCHEMA });
  assert.deepEqual(r.ok && r.json, { gist: "g" });
});

test("get_model_stateは30秒キャッシュ(同一db)", async () => {
  const h = harness([{ status: 200, body: okBody("a") }]);
  let t = 5_000;
  h.ctx.now = () => t;
  await callGemini(h.ctx, REQ);
  t += 29_000;
  await callGemini(h.ctx, REQ);
  assert.equal(h.rpcCalls.filter((c) => c.name === "get_model_state").length, 1);
  t += 2_000;
  await callGemini(h.ctx, REQ);
  assert.equal(h.rpcCalls.filter((c) => c.name === "get_model_state").length, 2);
});

test("insertUsageが例外でも呼び出し結果は返る(usageId=null)。失敗は console.error に残り、キーは載らない", async () => {
  const h = harness([{ status: 200, body: okBody("a") }]);
  h.ctx.db.insertUsage = async () => { throw new Error(`db down key=${KEY}`); };
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const r = await callGemini(h.ctx, REQ);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.usageId, null);
  } finally {
    console.error = orig;
  }
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("llm_usage insert failed"));
  assert.ok(!logs[0].includes("AIza") && !logs[0].includes(KEY));
  // idが返らない(null)場合も記録漏れとして残す
  const h2 = harness([{ status: 200, body: okBody("a") }]);
  h2.ctx.db.insertUsage = async () => null;
  const logs2: string[] = [];
  console.error = (...a: unknown[]) => { logs2.push(a.map(String).join(" ")); };
  try { await callGemini(h2.ctx, REQ); } finally { console.error = orig; }
  assert.equal(logs2.length, 1);
});

test("費用が算出できない行(単価なし・usageなし)は status=unpriced / no_usage のまま cost_usd=null", async () => {
  const st = makeState();
  (st.configs as any).m1.in_usd = null;
  const h = harness([{ status: 200, body: okBody("a") }, { status: 200, body: okBody("b", null) }], { state: st });
  await callGemini(h.ctx, REQ);
  await callGemini(h.ctx, REQ);
  assert.deepEqual(h.usage.map((u) => [u.status, u.cost_usd]), [["unpriced", null], ["no_usage", null]]);
});

test("sanitize: キー・key=・長さ・Error対応", () => {
  const s = sanitize(new Error(`failed https://a/b?key=${KEY}&x=1 token ${KEY}`), [KEY]);
  assert.ok(!s.includes("AIza"));
  assert.ok(!s.includes(KEY));
  assert.ok(s.includes("key=[redacted]"));
  assert.equal(sanitize("a".repeat(1000)).length, 200);
  assert.ok(!sanitize({ k: "AIzaSyABCDEFGHIJKL" }).includes("AIza"));
  assert.ok(!sanitize("x-goog-api-key: AIzaSyABCDEFGHIJKL").includes("AIza"));
});

test("resolveGeminiBase: 未設定・不正・外部httpは本番URL、loopback http と https は上書き", () => {
  const def = "https://generativelanguage.googleapis.com/v1beta/models";
  assert.equal(resolveGeminiBase(undefined), def);
  assert.equal(resolveGeminiBase(""), def);
  assert.equal(resolveGeminiBase("not a url"), def);
  assert.equal(resolveGeminiBase("http://evil.example.com"), def);
  assert.equal(resolveGeminiBase("http://127.0.0.1:8788"), "http://127.0.0.1:8788/v1beta/models");
  assert.equal(resolveGeminiBase("https://proxy.example.com/"), "https://proxy.example.com/v1beta/models");
});

test("callGemini: ctx.baseUrl があればそのURLへ(キーは常にヘッダ)", async () => {
  let seen = "";
  let hdr: Record<string, string> = {};
  const ctx = {
    db: {
      async rpc(name: string) {
        if (name === "get_model_state") return { data: { current_model: "m1", configs: {} }, error: null };
        if (name === "cost_guard") return { data: { allowed: true, level: "ok" }, error: null };
        return { data: null, error: null };
      },
      async insertUsage() { return 1; },
    },
    apiKey: KEY, fn: "t", grp: "x", batchId: "b", baseUrl: "http://127.0.0.1:1/v1beta/models",
    fetchFn: (async (url: string, init: RequestInit) => {
      seen = url;
      hdr = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} }), { status: 200 });
    }) as unknown as typeof fetch,
  } as GeminiCtx;
  const r = await callGemini(ctx, { purpose: "summary", parts: [{ text: "x" }], maxOutputTokens: 10 });
  assert.equal(r.ok, true);
  assert.equal(seen, "http://127.0.0.1:1/v1beta/models/m1:generateContent");
  assert.ok(!seen.includes("key="));
  assert.equal(hdr["x-goog-api-key"], KEY);
});
