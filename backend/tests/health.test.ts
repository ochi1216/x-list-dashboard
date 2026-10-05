import test from "node:test";
import assert from "node:assert/strict";
import { isGone, runHealth, runRehearse, sanitize } from "../functions/model-health/logic.ts";
import type { HealthDeps, PostRow } from "../functions/model-health/logic.ts";

const KEY = "AIzaSyTESTKEY1234567890";
const STATE = {
  current_model: "gemini-2.5-flash-lite",
  candidates: ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  configs: { "gemini-2.5-flash-lite": { gen_config: { default: {} }, enabled: true, in_usd: 0.1, out_usd: 0.4 } },
};

type Handler = (url: string, init: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

function setup(opts: {
  models?: string[] | "error"; generate?: Handler; guardAllowed?: boolean; posts?: PostRow[]; state?: unknown; timeBudgetMs?: number;
}) {
  const rec = {
    rpcs: [] as { name: string; args?: Record<string, unknown> }[],
    usage: [] as Record<string, unknown>[],
    fetches: [] as { url: string; init: RequestInit }[],
    health: null as null | Record<string, unknown>,
    commits: [] as { model: string; gc: Record<string, unknown> }[],
  };
  const deps: HealthDeps = {
    rpc: async (name, args) => {
      rec.rpcs.push({ name, args });
      if (name === "get_model_state") return { data: opts.state ?? STATE, error: null };
      if (name === "cost_guard") return { data: { allowed: opts.guardAllowed !== false, level: "ok" }, error: null };
      if (name === "model_report_gone") return { data: { current_model: STATE.current_model, switched: false, streak: 1 }, error: null };
      return { data: null, error: null };
    },
    insertUsage: async (row) => { rec.usage.push(row); return rec.usage.length; },
    fetchFn: (async (url: string, init: RequestInit) => {
      rec.fetches.push({ url, init });
      let r: { status: number; body: unknown };
      if (init.method === "GET") {
        r = opts.models === "error" ? { status: 500, body: `boom ${KEY}` } : { status: 200, body: { models: (opts.models ?? STATE.candidates).map((m) => ({ name: `models/${m}` })) } };
      } else {
        r = await (opts.generate ?? goodGen)(url, init);
      }
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch,
    apiKey: KEY,
    now: () => Date.parse("2026-10-05T00:00:00Z"),
    batchId: "b1",
    saveHealth: async (h) => { rec.health = h; },
    loadRecentPosts: async (n) => (opts.posts ?? []).slice(0, n),
    commitConfig: async (model, gc) => { rec.commits.push({ model, gc }); },
    timeBudgetMs: opts.timeBudgetMs,
  };
  return { deps, rec };
}

function geminiBody(json: unknown, extra: Record<string, unknown> = {}) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 0 },
    ...extra,
  };
}
// 要求内容に応じて正しいスキーマのJSONを返す
const goodGen: Handler = (_u, init) => {
  const b = JSON.parse(String(init.body));
  const props = Object.keys(b.generationConfig.responseSchema.properties);
  const j = props.includes("gist") ? { gist: "g", summary: "s" } : props.includes("score") ? { score: 3, kind: "news", reason: "r" } : { ok: true, msg: "やあ" };
  return { status: 200, body: geminiBody(j) };
};

test("isGone: 404 / 400・410+文言", () => {
  assert.ok(isGone(404, ""));
  assert.ok(isGone(400, "model is no longer available"));
  assert.ok(isGone(410, "retired"));
  assert.equal(isGone(400, "bad request"), false);
  assert.equal(isGone(500, "not found"), false);
});
test("sanitize はキーを含めない", () => {
  assert.ok(!sanitize(`x ${KEY} ?key=${KEY}`, KEY).includes("AIza"));
  assert.ok(sanitize("a".repeat(500)).length <= 200);
});

test("正常: 一覧に在り probe 成功 → health保存・report_ok・キーはヘッダ", async () => {
  const { deps, rec } = setup({});
  const r = await runHealth(deps) as any;
  assert.equal(r.ok, true);
  assert.ok(rec.health);
  assert.equal(r.health.list.current_listed, true);
  assert.equal(r.health.probes.length, 2);
  assert.ok(r.health.probes.every((p: any) => p.ok));
  assert.equal(r.health.probes[1].model, "gemini-3.5-flash-lite"); // 次候補
  assert.ok(rec.rpcs.some((c) => c.name === "model_report_ok"));
  assert.ok(!rec.rpcs.some((c) => c.name === "ops_event"));
  for (const f of rec.fetches) {
    assert.ok(!f.url.includes("key="));
    assert.equal((f.init.headers as Record<string, string>)["x-goog-api-key"], KEY);
  }
  assert.ok(rec.fetches[0].url.includes("pageSize=1000"));
  assert.ok(rec.usage.every((u) => u.purpose === "probe" && u.fn === "model-health"));
  assert.equal(rec.usage.length, 2);
});

test("現行が一覧に無い → ops_event warn model_missing", async () => {
  const { deps, rec } = setup({ models: ["gemini-3.5-flash-lite"] });
  const r = await runHealth(deps) as any;
  const ev = rec.rpcs.find((c) => c.name === "ops_event");
  assert.ok(ev);
  assert.equal(ev!.args!.p_level, "warn");
  assert.equal(ev!.args!.p_kind, "model_missing");
  assert.equal(r.health.list.current_listed, false);
  assert.equal(r.health.list.candidates_listed["gemini-3.5-flash-lite"], true);
});

test("一覧API失敗 → model_missingは出さない(不明扱い)・probeは続行", async () => {
  const { deps, rec } = setup({ models: "error" });
  const r = await runHealth(deps) as any;
  assert.equal(r.health.list.ok, false);
  assert.equal(r.health.list.current_listed, null);
  assert.ok(!JSON.stringify(r).includes("AIza"));
  assert.ok(!rec.rpcs.some((c) => c.args?.p_kind === "model_missing"));
  assert.equal(r.health.probes.length, 2);
});

test("probe失敗(500) → warn model_probe_failed・gone報告はしない", async () => {
  const { deps, rec } = setup({ generate: () => ({ status: 500, body: "internal" }) });
  const r = await runHealth(deps) as any;
  assert.equal(r.health.probes[0].ok, false);
  assert.ok(rec.rpcs.some((c) => c.args?.p_kind === "model_probe_failed" && c.args?.p_level === "warn"));
  assert.ok(!rec.rpcs.some((c) => c.name === "model_report_gone"));
  assert.ok(!rec.rpcs.some((c) => c.name === "model_report_ok"));
  assert.equal(rec.usage[0].status, "error");
});

test("probeが提供終了(404)かつ一覧に無い → model_report_gone", async () => {
  const { deps, rec } = setup({ models: ["gemini-3.5-flash-lite"], generate: (u) => u.includes("2.5-flash-lite") ? { status: 404, body: "models/x is not found" } : goodGen(u, { body: JSON.stringify({ generationConfig: { responseSchema: { properties: { ok: 1 } } } }) } as RequestInit) });
  const r = await runHealth(deps) as any;
  const rep = rec.rpcs.find((c) => c.name === "model_report_gone");
  assert.ok(rep);
  assert.equal(rep!.args!.p_model, "gemini-2.5-flash-lite");
  assert.ok(r.health.reported_gone);
  assert.equal(r.health.probes[0].gone, true);
  assert.equal(r.health.probes[1].role, "next");
});

test("probeが404でも一覧に在ればgone扱いにしない", async () => {
  const { deps, rec } = setup({ generate: () => ({ status: 404, body: "not found" }) });
  const r = await runHealth(deps) as any;
  assert.ok(!rec.rpcs.some((c) => c.name === "model_report_gone"));
  assert.equal(r.health.probes[0].gone, false);
  assert.ok(rec.rpcs.some((c) => c.args?.p_kind === "model_probe_failed"));
});

test("費用ガード拒否 → probeしない(Gemini呼び出し0)", async () => {
  const { deps, rec } = setup({ guardAllowed: false });
  const r = await runHealth(deps) as any;
  assert.equal(r.health.probes[0].skipped, "guard");
  assert.ok(!rec.fetches.some((f) => f.init.method === "POST"));
  assert.ok(!rec.rpcs.some((c) => c.name === "model_report_gone"));
});

// ---------- rehearse ----------
const POSTS: PostRow[] = Array.from({ length: 5 }, (_, i) => ({ content: `投稿${i}の本文です。` }));

test("rehearse: 集計(成功率・思考part・thoughts)と思考指定の探索。commitなしでは書かない", async () => {
  const seen: unknown[] = [];
  const gen: Handler = (u, init) => {
    const b = JSON.parse(String(init.body));
    seen.push(b.generationConfig.thinkingConfig);
    // thinkingLevel は未対応(400)、thinkingBudget:0 は通る、指定なしは思考トークンを使う
    const tc = b.generationConfig.thinkingConfig;
    if (tc && "thinkingLevel" in tc) return { status: 400, body: "Unknown name thinkingLevel" };
    const res = goodGen(u, init) as { status: number; body: any };
    res.body.usageMetadata.thoughtsTokenCount = tc ? 0 : 50;
    return res;
  };
  const { deps, rec } = setup({ generate: gen, posts: POSTS });
  const r = await runRehearse(deps, { model: "gemini-3.5-flash-lite", n: 3, commit: false }) as any;
  assert.equal(r.ok, true);
  assert.equal(r.n_posts, 3);
  assert.equal(r.calls, 6);
  assert.equal(r.json_success_rate, 1);
  assert.equal(r.thought_part_leak, false);
  assert.deepEqual(r.thinking.chosen, { thinkingBudget: 0 });
  assert.equal(r.thinking.needs_thinking_config, true);
  assert.equal(r.thoughts_tokens.total, 0);
  assert.equal(r.thinking.explored.find((e: any) => e.config?.thinkingLevel === "minimal").ok, false);
  assert.equal(r.committed, false);
  assert.equal(rec.commits.length, 0);
  assert.ok(rec.fetches.filter((f) => f.init.method === "POST").every((f) => f.url.includes("gemini-3.5-flash-lite:generateContent")));
});

test("rehearse: commit:true かつ合格のときだけ gen_config を書く", async () => {
  const { deps, rec } = setup({ posts: POSTS });
  const r = await runRehearse(deps, { model: "gemini-3.5-flash-lite", n: 2, commit: true }) as any;
  assert.equal(r.committed, true);
  assert.equal(rec.commits.length, 1);
  assert.equal(rec.commits[0].model, "gemini-3.5-flash-lite");
  assert.deepEqual(rec.commits[0].gc, { default: {} }); // 指定なしで通ったので思考指定は不要
});

test("rehearse: 思考partの混入・JSON不成立なら commit しない", async () => {
  const leaky: Handler = (u, init) => {
    const res = goodGen(u, init) as { status: number; body: any };
    res.body.candidates[0].content.parts.unshift({ text: "考え中", thought: true });
    return res;
  };
  let s = setup({ generate: leaky, posts: POSTS });
  let r = await runRehearse(s.deps, { model: "gemini-3.5-flash-lite", n: 2, commit: true }) as any;
  assert.equal(r.thought_part_leak, true);
  assert.equal(r.committed, false);
  assert.equal(s.rec.commits.length, 0);

  const broken: Handler = (u, init) => {
    const b = JSON.parse(String(init.body));
    if (b.generationConfig.maxOutputTokens > 512) return { status: 200, body: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } };
    return goodGen(u, init);
  };
  s = setup({ generate: broken, posts: POSTS });
  r = await runRehearse(s.deps, { model: "gemini-3.5-flash-lite", n: 2, commit: true }) as any;
  assert.ok(r.json_success_rate < 0.9);
  assert.equal(r.committed, false);
  assert.ok(r.commit_blocked.length > 0);
  assert.equal(s.rec.commits.length, 0);
});

test("rehearse: 不正なモデル名は拒否・commitは意図しない書込をしない", async () => {
  const { deps, rec } = setup({ posts: POSTS });
  const r = await runRehearse(deps, { model: "../evil?x=1", n: 2, commit: true }) as any;
  assert.equal(r.ok, false);
  assert.equal(rec.fetches.length, 0);
  assert.equal(rec.commits.length, 0);
});
