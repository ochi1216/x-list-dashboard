// model-health のロジック(外部依存は deps で注入。共通部品のimportなし)。
// (1) モデル一覧での提供確認 (2) 現行・次候補へのprobe (3) rehearse(予行演習)

export const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const HTTP_TIMEOUT_MS = 40_000; // 1回のHTTP要求の上限(無いと応答しない相手で関数全体の150秒上限まで固まる)
export const GONE_BODY_RE = /not found|no longer|deprecated|retired|decommission|discontinued/i;
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,80}$/;

export type Rpc = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface PostRow { content: string | null; image_urls?: string[] | null }

export interface HealthDeps {
  rpc: Rpc;
  insertUsage: (row: Record<string, unknown>) => Promise<number | null>;
  fetchFn: typeof fetch;
  apiKey: string;
  now: () => number;
  batchId: string;
  saveHealth: (health: Record<string, unknown>, atIso: string) => Promise<void>;
  loadRecentPosts: (n: number) => Promise<PostRow[]>;
  commitConfig: (model: string, genConfig: Record<string, unknown>, atIso: string) => Promise<void>;
  timeBudgetMs?: number; // rehearse の打ち切り(既定100秒)
  baseUrl?: string; // 例 "https://generativelanguage.googleapis.com/v1beta"(未指定ならBASE。結合試験でモックへ向ける用)
}

export function sanitize(input: unknown, apiKey = ""): string {
  let s = input instanceof Error ? input.message : typeof input === "string" ? input : (() => {
    try { return JSON.stringify(input) ?? String(input); } catch { return String(input); }
  })();
  if (apiKey && apiKey.length >= 8) s = s.split(apiKey).join("[redacted]");
  s = s.replace(/AIza[0-9A-Za-z_\-]{6,}/g, "[redacted]");
  s = s.replace(/(x-goog-api-key["':=\s]+)[^\s"',&]+/gi, "$1[redacted]");
  s = s.replace(/([?&;\s"']|^)key=[^&\s"']+/gi, "$1key=[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

export function isGone(status: number, body: string): boolean {
  if (status === 404) return true;
  return (status === 400 || status === 410) && GONE_BODY_RE.test(body);
}

// ---------- モデル一覧 ----------

export interface ListResult { ok: boolean; names: string[]; error?: string }
export async function listModels(deps: HealthDeps): Promise<ListResult> {
  const names: string[] = [];
  let token = "";
  try {
    for (let page = 0; page < 10; page++) {
      const url = `${deps.baseUrl ?? BASE}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
      const res = await deps.fetchFn(url, { method: "GET", headers: { "x-goog-api-key": deps.apiKey }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, names, error: sanitize(`list http ${res.status}: ${t}`, deps.apiKey) };
      }
      const j = await res.json() as { models?: { name?: string }[]; nextPageToken?: string };
      for (const m of j.models ?? []) if (m.name) names.push(m.name.replace(/^models\//, ""));
      if (!j.nextPageToken) break;
      token = j.nextPageToken;
    }
    return { ok: true, names };
  } catch (e) {
    return { ok: false, names, error: sanitize(e, deps.apiKey) };
  }
}

// ---------- 1回のGemini呼び出し(probe用: 指定モデルへ直接。費用ガード・使用量記録つき) ----------

export interface ModelCfg { gen_config?: Record<string, unknown> | null; in_usd?: number | string | null; out_usd?: number | string | null; enabled?: boolean }
export interface ModelStateData { current_model: string; candidates: string[]; configs: Record<string, ModelCfg> }

export interface CallOut {
  ok: boolean; // HTTP成功かつ本文あり
  guard?: boolean;
  http_status?: number;
  gone?: boolean;
  text: string;
  json: unknown | null;
  thought_part: boolean;
  usage: { prompt: number; output: number; thoughts: number };
  latency_ms: number;
  error?: string;
}

export interface CallOpts {
  model: string;
  purpose: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  extraConfig?: Record<string, unknown>;
  state?: ModelStateData;
  postUrl?: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function genCall(deps: HealthDeps, o: CallOpts): Promise<CallOut> {
  const empty = { text: "", json: null, thought_part: false, usage: { prompt: 0, output: 0, thoughts: 0 }, latency_ms: 0 };
  const g = await deps.rpc("cost_guard", { p_purpose: "probe", p_grp: "x" });
  const allowed = !g.error && g.data && typeof g.data === "object" && (g.data as { allowed?: boolean }).allowed === true;
  if (!allowed) return { ok: false, guard: true, ...empty, error: g.error ? sanitize(g.error.message, deps.apiKey) : "cost guard denied" };

  const started = deps.now();
  const body = {
    contents: [{ parts: [{ text: o.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: o.schema,
      maxOutputTokens: o.maxOutputTokens,
      ...(o.extraConfig ?? {}),
    },
  };
  let out: CallOut;
  let status: number | undefined;
  try {
    const res = await deps.fetchFn(`${deps.baseUrl ?? BASE}/models/${o.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": deps.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    status = res.status;
    const raw = await res.text();
    const latency = deps.now() - started;
    if (!res.ok) {
      out = { ...empty, ok: false, http_status: res.status, gone: isGone(res.status, raw), latency_ms: latency, error: sanitize(`http ${res.status}: ${raw}`, deps.apiKey) };
    } else {
      let j: Record<string, any> = {};
      try { j = JSON.parse(raw); } catch { /* 空扱い */ }
      const parts: { text?: string; thought?: boolean }[] = j?.candidates?.[0]?.content?.parts ?? [];
      const thoughtPart = parts.some((p) => p.thought === true);
      const text = parts.filter((p) => p.thought !== true).map((p) => p.text ?? "").join("");
      let parsed: unknown | null = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      const um = j?.usageMetadata ?? {};
      out = {
        ok: text.length > 0,
        http_status: res.status,
        text,
        json: parsed,
        thought_part: thoughtPart,
        usage: { prompt: num(um.promptTokenCount), output: num(um.candidatesTokenCount), thoughts: num(um.thoughtsTokenCount) },
        latency_ms: latency,
        error: text.length > 0 ? undefined : `empty response (finishReason=${j?.candidates?.[0]?.finishReason ?? "?"})`,
      };
    }
  } catch (e) {
    out = { ...empty, ok: false, latency_ms: deps.now() - started, error: sanitize(e, deps.apiKey) };
  }

  // 使用量: 1呼び出し1行
  try {
    const cfg = o.state?.configs?.[o.model];
    const inP = cfg?.in_usd != null ? Number(cfg.in_usd) : null;
    const outP = cfg?.out_usd != null ? Number(cfg.out_usd) : null;
    const hasUsage = out.usage.prompt + out.usage.output + out.usage.thoughts > 0;
    const cost = inP != null && outP != null && hasUsage
      ? (out.usage.prompt * inP + (out.usage.output + out.usage.thoughts) * outP) / 1e6
      : null;
    await deps.insertUsage({
      called_at: new Date(deps.now()).toISOString(),
      batch_id: deps.batchId,
      fn: "model-health",
      purpose: o.purpose,
      grp: "x",
      model: o.model,
      prompt_tokens: hasUsage ? out.usage.prompt : null,
      output_tokens: hasUsage ? out.usage.output : null,
      thoughts_tokens: hasUsage ? out.usage.thoughts : null,
      cost_usd: cost,
      in_price: inP,
      out_price: outP,
      status: !out.ok ? "error" : !hasUsage ? "no_usage" : cost === null ? "unpriced" : "ok",
      http_status: status ?? null,
      latency_ms: out.latency_ms,
      attempt: 1,
      error: out.ok ? null : out.error ?? null,
      post_url: o.postUrl ?? null,
    });
  } catch { /* 記録失敗で処理は止めない */ }
  return out;
}

// ---------- probe ----------

export const PROBE_SCHEMA = {
  type: "OBJECT",
  properties: { ok: { type: "BOOLEAN" }, msg: { type: "STRING" } },
  required: ["ok", "msg"],
};
export const PROBE_PROMPT = `動作確認です。次のJSONだけを返してください(前置き不要)。msgには10字以内の短い日本語の挨拶を入れてください:
{"ok": true, "msg": "..."}`;

export function probeValid(j: unknown): boolean {
  const o = j as { ok?: unknown; msg?: unknown } | null;
  return !!o && typeof o === "object" && o.ok === true && typeof o.msg === "string" && o.msg.length > 0;
}

export function defaultGenConfig(state: ModelStateData, model: string): Record<string, unknown> {
  const gc = state.configs?.[model]?.gen_config;
  const d = gc && typeof gc === "object" ? (gc as Record<string, unknown>).default : null;
  return d && typeof d === "object" ? { ...(d as Record<string, unknown>) } : {};
}

export interface ProbeResult {
  model: string;
  role: "current" | "next";
  ok: boolean;
  skipped?: string;
  http_status?: number;
  gone?: boolean;
  json_ok?: boolean;
  thoughts?: number;
  latency_ms?: number;
  error?: string;
}

export async function probeModel(deps: HealthDeps, state: ModelStateData, model: string, role: "current" | "next"): Promise<ProbeResult> {
  const r = await genCall(deps, {
    model, purpose: "probe", prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 256,
    extraConfig: defaultGenConfig(state, model), state,
  });
  if (r.guard) return { model, role, ok: false, skipped: "guard", error: r.error };
  const jsonOk = probeValid(r.json);
  return {
    model, role, ok: r.ok && jsonOk, http_status: r.http_status, gone: r.gone === true, json_ok: jsonOk,
    thoughts: r.usage.thoughts, latency_ms: r.latency_ms, error: r.ok && jsonOk ? undefined : (r.error ?? "invalid json"),
  };
}

export function parseState(data: unknown): ModelStateData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.current_model !== "string" || !d.current_model) return null;
  return {
    current_model: d.current_model,
    candidates: Array.isArray(d.candidates) ? (d.candidates as unknown[]).filter((x): x is string => typeof x === "string") : [],
    configs: (d.configs && typeof d.configs === "object" ? d.configs : {}) as Record<string, ModelCfg>,
  };
}

async function opsEvent(deps: HealthDeps, level: string, kind: string, message: string, data: Record<string, unknown>, dedupe: number) {
  try {
    await deps.rpc("ops_event", { p_level: level, p_kind: kind, p_message: message, p_data: data, p_dedupe_minutes: dedupe });
  } catch { /* 記録失敗で処理は止めない */ }
}

// ---------- 日次ヘルスチェック ----------

export async function runHealth(deps: HealthDeps): Promise<Record<string, unknown>> {
  const st = await deps.rpc("get_model_state", {});
  const state = st.error ? null : parseState(st.data);
  if (!state) return { ok: false, error: `get_model_state failed: ${st.error ? sanitize(st.error.message) : "bad shape"}` };
  const current = state.current_model;
  const next = state.candidates.find((m) => m !== current) ?? null;

  const list = await listModels(deps);
  const listed = new Set(list.names);
  const currentListed = list.ok ? listed.has(current) : null; // null=不明
  const candidatesListed: Record<string, boolean | null> = {};
  for (const m of state.candidates) candidatesListed[m] = list.ok ? listed.has(m) : null;

  if (list.ok && !listed.has(current)) {
    await opsEvent(deps, "warn", "model_missing", `現行モデル ${current} がモデル一覧に有りません`, { model: current, candidates_listed: candidatesListed }, 1440);
  }

  const probes: ProbeResult[] = [];
  const cur = await probeModel(deps, state, current, "current");
  probes.push(cur);
  let reported: unknown = null;
  if (cur.skipped !== "guard") {
    if (cur.ok) {
      await deps.rpc("model_report_ok", { p_model: current });
    } else if (cur.gone) {
      if (currentListed === true) {
        cur.gone = false; // 一覧に在るのでgone扱いにしない
        await opsEvent(deps, "warn", "model_probe_failed", `現行モデル ${current} のprobeが404相当ですが一覧には在ります`, { model: current, http_status: cur.http_status }, 360);
      } else {
        const r = await deps.rpc("model_report_gone", { p_model: current, p_reason: `probe gone (http ${cur.http_status})` });
        reported = r.error ? { error: sanitize(r.error.message) } : r.data;
      }
    } else {
      await opsEvent(deps, "warn", "model_probe_failed", `現行モデル ${current} のprobeに失敗: ${cur.error ?? ""}`, { model: current, http_status: cur.http_status }, 360);
    }
  }
  if (next) probes.push(await probeModel(deps, state, next, "next"));

  const atIso = new Date(deps.now()).toISOString();
  const health = {
    at: atIso,
    current_model: current,
    list: { ok: list.ok, count: list.names.length, error: list.error ?? null, current_listed: currentListed, candidates_listed: candidatesListed },
    probes,
    reported_gone: reported,
  };
  await deps.saveHealth(health, atIso);
  return { ok: true, health };
}

// ---------- 予行演習(rehearse) ----------

export const SUMMARY_PROMPT = `あなたはX(Twitter)の投稿を要約する専門家です。次の投稿を読んで、日本語で以下の2つを作成してください。

1. gist: 「結局何の話か」が一目でわかるテーマ一言（15〜30字程度）。投稿者の相槌・感想コメントではなく、引用元記事や話題の主旨を掴んでください。
2. summary: 2〜3文の「要するに」説明。本文を読まなくても要点がわかる文章。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "...", "summary": "..."}`;
export const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: { gist: { type: "STRING" }, summary: { type: "STRING" } },
  required: ["gist", "summary"],
};
export const SCORE_PROMPT = `あなたはX(Twitter)の投稿の重要度を採点する評価者です。次の投稿を読み、AI・技術の情報収集の観点で「聴く価値」を1〜5の整数で採点してください(5=非常に有益、1=価値なし)。
kindは次のいずれか1つ: announce, ref_only, primary, news, numbers, howto, explain, opinion, none。
reasonは50字以内の理由。

必ず次のJSON形式のみで出力してください:
{"score": 3, "kind": "news", "reason": "..."}`;
export const SCORE_SCHEMA = {
  type: "OBJECT",
  properties: { score: { type: "INTEGER" }, kind: { type: "STRING" }, reason: { type: "STRING" } },
  required: ["score", "kind", "reason"],
};
export function summaryValid(j: unknown): boolean {
  const o = j as { gist?: unknown; summary?: unknown } | null;
  return !!o && typeof o.gist === "string" && o.gist.length > 0 && typeof o.summary === "string" && o.summary.length > 0;
}
export function scoreValid(j: unknown): boolean {
  const o = j as { score?: unknown; kind?: unknown; reason?: unknown } | null;
  return !!o && Number.isInteger(o.score) && (o.score as number) >= 1 && (o.score as number) <= 5 &&
    typeof o.kind === "string" && typeof o.reason === "string";
}

// 思考指定の探索候補(thinkingLevel系/thinkingBudget系)。null=指定なし。
export const THINKING_CANDIDATES: (Record<string, unknown> | null)[] = [
  null,
  { thinkingLevel: "minimal" },
  { thinkingLevel: "low" },
  { thinkingBudget: 0 },
  { thinkingBudget: 256 },
];

export interface ExploreRow { config: Record<string, unknown> | null; ok: boolean; http_status?: number; thoughts: number; thought_part: boolean; error?: string }

export async function exploreThinking(deps: HealthDeps, state: ModelStateData, model: string, base: Record<string, unknown>) {
  const rows: ExploreRow[] = [];
  let guard = false;
  for (const cfg of THINKING_CANDIDATES) {
    const extra = { ...base };
    delete extra.thinkingConfig;
    if (cfg) extra.thinkingConfig = cfg;
    const r = await genCall(deps, {
      model, purpose: "probe", prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 512, extraConfig: extra, state,
    });
    if (r.guard) { guard = true; break; }
    rows.push({
      config: cfg, ok: r.ok && probeValid(r.json) && !r.thought_part, http_status: r.http_status,
      thoughts: r.usage.thoughts, thought_part: r.thought_part, error: r.ok ? undefined : r.error,
    });
  }
  // 通ったもののうち思考トークンが最少のもの(同数なら探索順=指定なしが優先)
  let chosen: ExploreRow | null = null;
  for (const r of rows) if (r.ok && (chosen === null || r.thoughts < chosen.thoughts)) chosen = r;
  return { rows, chosen, guard };
}

export interface RehearseOpts { model: string; n: number; commit: boolean }

export async function runRehearse(deps: HealthDeps, o: RehearseOpts): Promise<Record<string, unknown>> {
  if (!MODEL_NAME_RE.test(o.model ?? "")) return { ok: false, error: "model is invalid" };
  const n = Math.min(50, Math.max(1, Math.floor(o.n) || 20));
  const st = await deps.rpc("get_model_state", {});
  const state = st.error ? null : parseState(st.data);
  if (!state) return { ok: false, error: `get_model_state failed: ${st.error ? sanitize(st.error.message) : "bad shape"}` };
  const model = o.model;
  const stateOk: ModelStateData = state; // worker内(関数宣言)では絞り込みが効かないため確定した値を持つ
  const deadline = deps.now() + (deps.timeBudgetMs ?? 100_000);

  const base = defaultGenConfig(state, model);
  const ex = await exploreThinking(deps, state, model, base);
  const chosenCfg = ex.chosen ? ex.chosen.config : null;
  const useExtra = { ...base };
  delete useExtra.thinkingConfig;
  if (chosenCfg) useExtra.thinkingConfig = chosenCfg;

  const posts = (await deps.loadRecentPosts(n)).filter((p) => (p.content ?? "").trim().length > 0);

  type Task = { kind: "summary" | "score"; content: string };
  const tasks: Task[] = [];
  for (const p of posts) {
    tasks.push({ kind: "summary", content: p.content as string }, { kind: "score", content: p.content as string });
  }
  const stat = {
    calls: 0, json_ok: 0, summary_calls: 0, summary_ok: 0, score_calls: 0, score_ok: 0,
    thought_part_calls: 0, thoughts_total: 0, thoughts_max: 0, calls_with_thoughts: 0,
    prompt_total: 0, output_total: 0, http_errors: 0,
  };
  const errors: string[] = [];
  let guard = ex.guard;
  let skipped = 0;
  let idx = 0;
  async function worker() {
    for (;;) {
      if (guard || deps.now() >= deadline) return;
      const t = tasks[idx++];
      if (!t) return;
      const isSum = t.kind === "summary";
      const r = await genCall(deps, {
        model, purpose: "probe",
        prompt: `${isSum ? SUMMARY_PROMPT : SCORE_PROMPT}\n\n本文:\n${t.content.slice(0, 3000)}`,
        schema: isSum ? SUMMARY_SCHEMA : SCORE_SCHEMA,
        maxOutputTokens: isSum ? 800 : 400,
        extraConfig: useExtra, state: stateOk,
      });
      if (r.guard) { guard = true; return; }
      stat.calls++;
      const valid = isSum ? summaryValid(r.json) : scoreValid(r.json);
      if (isSum) { stat.summary_calls++; if (valid) stat.summary_ok++; } else { stat.score_calls++; if (valid) stat.score_ok++; }
      if (valid) stat.json_ok++;
      if (r.thought_part) stat.thought_part_calls++;
      stat.thoughts_total += r.usage.thoughts;
      stat.thoughts_max = Math.max(stat.thoughts_max, r.usage.thoughts);
      if (r.usage.thoughts > 0) stat.calls_with_thoughts++;
      stat.prompt_total += r.usage.prompt;
      stat.output_total += r.usage.output;
      if (!r.ok || (r.http_status ?? 200) >= 400) stat.http_errors++;
      if (!valid && errors.length < 5) errors.push(r.error ?? "invalid json shape");
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  skipped = Math.max(0, tasks.length - stat.calls);

  const rate = stat.calls > 0 ? stat.json_ok / stat.calls : 0;
  const leak = stat.thought_part_calls > 0 || ex.rows.some((r) => r.thought_part);
  const result: Record<string, unknown> = {
    ok: true,
    action: "rehearse",
    model,
    n_posts: posts.length,
    calls: stat.calls,
    skipped,
    guard_stopped: guard,
    json_success_rate: Math.round(rate * 1000) / 1000,
    summary_success_rate: stat.summary_calls ? Math.round((stat.summary_ok / stat.summary_calls) * 1000) / 1000 : null,
    score_success_rate: stat.score_calls ? Math.round((stat.score_ok / stat.score_calls) * 1000) / 1000 : null,
    thought_part_leak: leak,
    thoughts_tokens: {
      total: stat.thoughts_total,
      avg: stat.calls ? Math.round((stat.thoughts_total / stat.calls) * 10) / 10 : 0,
      max: stat.thoughts_max,
      calls_with_thoughts: stat.calls_with_thoughts,
    },
    usage: { prompt: stat.prompt_total, output: stat.output_total },
    http_errors: stat.http_errors,
    thinking: { explored: ex.rows, chosen: chosenCfg, passed: ex.chosen !== null, needs_thinking_config: chosenCfg !== null },
    errors,
    committed: false,
  };

  if (o.commit) {
    const reasons: string[] = [];
    if (ex.chosen === null) reasons.push("no thinking config passed");
    if (guard) reasons.push("cost guard stopped");
    if (stat.calls === 0) reasons.push("no calls");
    if (skipped > 0) reasons.push("incomplete");
    if (rate < 0.9) reasons.push("json success rate below 0.9");
    if (leak) reasons.push("thought parts leaked");
    if (reasons.length > 0) {
      result.commit_blocked = reasons;
    } else {
      const existing = state.configs?.[model]?.gen_config;
      const gc: Record<string, unknown> = existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
      const def: Record<string, unknown> = gc.default && typeof gc.default === "object" ? { ...(gc.default as Record<string, unknown>) } : {};
      delete def.thinkingConfig;
      if (chosenCfg) def.thinkingConfig = chosenCfg;
      gc.default = def;
      await deps.commitConfig(model, gc, new Date(deps.now()).toISOString());
      result.committed = true;
      result.gen_config = gc;
    }
  }
  return result;
}
