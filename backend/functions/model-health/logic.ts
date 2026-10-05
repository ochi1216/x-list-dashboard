// model-health のロジック(外部依存は deps で注入。共通部品のimportなし)。
// (1) モデル一覧での提供確認 (2) 現行・次候補へのprobe (3) rehearse(予行演習)

export const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const HTTP_TIMEOUT_MS = 40_000; // 1回のHTTP要求の上限(無いと応答しない相手で関数全体の150秒上限まで固まる)
export const AUTH_BODY_RE = /API key not valid|API_KEY_INVALID|API key expired|API_KEY_EXPIRED|PERMISSION_DENIED|UNAUTHENTICATED|FAILED_PRECONDITION/i; // _shared/gemini.ts の isAuthResponse と同じ基準
export const GONE_BODY_RE = /not found|no longer|deprecated|retired|decommission|discontinued/i;
export const REHEARSE_MIN_POSTS = 20; // 予行演習の最小件数(commit の根拠になる標本の大きさ)
export const COMMIT_MIN_RATE = 0.9;
export const SUMMARY_MAX_OUTPUT_TOKENS = 600; // 本番の要約(summarize-x-post の本文のみ)と同じ値。違うと本番で途切れるモデルを通してしまう
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,80}$/;

export type Rpc = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

export interface PostRow { content: string | null; summary?: string | null; image_urls?: string[] | null }

// 本番の採点(_shared/scoring.ts の buildScorePrompt / SCORE_SCHEMA / parseScoreResult)を注入する。
// 共通部品を import しない(Nodeの単体テストでも動かす)ため、index.ts が渡す。
export interface ScoringDeps {
  buildPrompt: (profileText: string, post: PostRow) => string;
  schema: Record<string, unknown>;
  parse: (json: unknown) => unknown | null; // 有効な採点なら非null
  maxOutputTokens: number; // 本番の採点と同じ値
}

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
  scoring?: ScoringDeps; // rehearse(本番の採点プロンプトで試す)に必要
  loadProfile?: () => Promise<string>; // 関心プロファイル本文(DBのみに在る。rehearse に必要)
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

// 認証系: 401/403、または400で本文がAPIキー不正・権限なし・FAILED_PRECONDITION(課金・地域・設定不備)。_shared/gemini.ts の isAuthResponse と同じ。
export function isAuth(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true;
  return status === 400 && AUTH_BODY_RE.test(body);
}

// 404 は常に。400/410 は本文が提供終了を示し、かつ本文に "model" を含むときだけ(別原因の400で切り替えない)。
export function isGone(status: number, body: string): boolean {
  if (status === 404) return true;
  return (status === 400 || status === 410) && /model/i.test(body) && GONE_BODY_RE.test(body);
}

// kill_switch の確認(cost_guard 側は変えず、関数側で見る)。取得に失敗したら止める側(unknown)。
export async function killSwitchState(deps: HealthDeps): Promise<"on" | "off" | "unknown"> {
  try {
    const r = await deps.rpc("cfg", { p_key: "kill_switch", p_default: false });
    if (r.error) return "unknown";
    return r.data === true || r.data === "true" ? "on" : "off";
  } catch {
    return "unknown";
  }
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
  auth?: boolean; // 認証系エラー(鍵の誤設定・請求停止)。gone とは別物(モデル切替の根拠にしない)
  text: string;
  json: unknown | null;
  thought_part: boolean;
  truncated?: boolean; // finishReason=MAX_TOKENS(出力が上限で途切れた)
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

// llm_usage の記録が連続3回以上失敗したら ops_event('error','usage_log_failed')(費用ガードが盲目になるため)。実行(deps)ごとに数える。
const usageFails = new WeakMap<object, { n: number; alerted: boolean }>();
function usageLogOk(deps: HealthDeps): void {
  const st = usageFails.get(deps);
  if (st) st.n = 0;
}
async function usageLogFailed(deps: HealthDeps): Promise<void> {
  const st = usageFails.get(deps) ?? { n: 0, alerted: false };
  usageFails.set(deps, st);
  st.n++;
  if (st.n < 3 || st.alerted) return;
  st.alerted = true;
  await opsEvent(deps, "error", "usage_log_failed", "llm_usageの記録に失敗が続いています(費用ガードが集計できません)", { detail: `x${st.n} model-health` }, 360);
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
      const auth = isAuth(res.status, raw);
      out = { ...empty, ok: false, http_status: res.status, auth, gone: !auth && isGone(res.status, raw), latency_ms: latency, error: sanitize(`http ${res.status}: ${raw}`, deps.apiKey) };
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
        truncated: j?.candidates?.[0]?.finishReason === "MAX_TOKENS",
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
    const usageId = await deps.insertUsage({
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
    if (usageId == null) await usageLogFailed(deps); else usageLogOk(deps);
  } catch (e) {
    // 記録失敗で処理は止めないが、記録漏れに気づけるよう残す(キーは伏せる)
    console.error(`llm_usage insert failed (model-health ${o.purpose}): ${sanitize(e, deps.apiKey)}`);
    await usageLogFailed(deps);
  }
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
  skipped?: string; // "guard" | "kill_switch" | "config_unavailable" | "auth"
  http_status?: number;
  gone?: boolean;
  auth?: boolean;
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
    model, role, ok: r.ok && jsonOk, http_status: r.http_status, gone: r.gone === true, auth: r.auth === true, json_ok: jsonOk,
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

// 認証エラー(鍵の誤設定・請求停止)の通知。共通のGemini呼び出し(_shared/gemini.ts reportGeminiAuthError)と同じ kind・文言・360分。
async function reportAuth(deps: HealthDeps, status: number | undefined, where: string): Promise<void> {
  await opsEvent(deps, "error", "gemini_auth", "Gemini APIの認証エラー", { detail: `http ${status ?? "unknown"}`, where }, 360);
}

// 現行・次候補の probe。kill_switch 中(または設定が読めない)は Gemini を呼ばない。
async function runProbes(
  deps: HealthDeps, state: ModelStateData, current: string, next: string | null, currentListed: boolean | null,
): Promise<{ probes: ProbeResult[]; reported: unknown }> {
  const probes: ProbeResult[] = [];
  let reported: unknown = null;
  const ks = await killSwitchState(deps);
  if (ks !== "off") {
    const skipped = ks === "on" ? "kill_switch" : "config_unavailable";
    probes.push({ model: current, role: "current", ok: false, skipped });
    if (next) probes.push({ model: next, role: "next", ok: false, skipped });
    return { probes, reported };
  }
  const cur = await probeModel(deps, state, current, "current");
  probes.push(cur);
  if (cur.auth) {
    // 認証エラー: 鍵・請求の問題なのでモデルの goneやprobe失敗とは別扱い。次候補は同じ鍵で必ず同じ結果なので呼ばない。
    await reportAuth(deps, cur.http_status, "probe");
    if (next) probes.push({ model: next, role: "next", ok: false, skipped: "auth" });
    return { probes, reported };
  }
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
  if (next) {
    const nx = await probeModel(deps, state, next, "next");
    probes.push(nx);
    if (nx.auth) await reportAuth(deps, nx.http_status, "probe");
  }
  return { probes, reported };
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

  const { probes, reported } = await runProbes(deps, state, current, next, currentListed);

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
export function summaryValid(j: unknown): boolean {
  const o = j as { gist?: unknown; summary?: unknown } | null;
  return !!o && typeof o.gist === "string" && o.gist.length > 0 && typeof o.summary === "string" && o.summary.length > 0;
}
// 用途別の gen_config(default に用途別を重ねる。callGemini と同じ解決)。
export function purposeGenConfig(state: ModelStateData, model: string, purpose: string): Record<string, unknown> {
  const gc = state.configs?.[model]?.gen_config;
  const o = gc && typeof gc === "object" ? gc as Record<string, unknown> : {};
  const def = o.default && typeof o.default === "object" ? o.default as Record<string, unknown> : {};
  const per = o[purpose] && typeof o[purpose] === "object" ? o[purpose] as Record<string, unknown> : {};
  return { ...def, ...per };
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

export async function exploreThinking(
  deps: HealthDeps, state: ModelStateData, model: string, base: Record<string, unknown>, deadline = Infinity,
) {
  const rows: ExploreRow[] = [];
  let guard = false;
  let auth: number | null = null; // 認証エラーのHTTPステータス(401/403/400)。出たら以降は呼ばない
  for (const cfg of THINKING_CANDIDATES) {
    if (deps.now() >= deadline) break; // 時間予算切れ(未探索分は結果に出ない→commitはブロックされる)
    const extra = { ...base };
    delete extra.thinkingConfig;
    if (cfg) extra.thinkingConfig = cfg;
    const r = await genCall(deps, {
      model, purpose: "probe", prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 512, extraConfig: extra, state,
    });
    if (r.guard) { guard = true; break; }
    if (r.auth) { auth = r.http_status ?? 0; break; }
    rows.push({
      config: cfg, ok: r.ok && probeValid(r.json) && !r.thought_part, http_status: r.http_status,
      thoughts: r.usage.thoughts, thought_part: r.thought_part, error: r.ok ? undefined : r.error,
    });
  }
  // 通ったもののうち思考トークンが最少のもの(同数なら探索順=指定なしが優先)
  let chosen: ExploreRow | null = null;
  for (const r of rows) if (r.ok && (chosen === null || r.thoughts < chosen.thoughts)) chosen = r;
  return { rows, chosen, guard, auth };
}

export interface RehearseOpts { model: string; n: number; commit: boolean }

export async function runRehearse(deps: HealthDeps, o: RehearseOpts): Promise<Record<string, unknown>> {
  if (!MODEL_NAME_RE.test(o.model ?? "")) return { ok: false, error: "model is invalid" };
  // 標本が小さいと成功率(90%)が意味を持たない。20件未満の予行演習は受け付けない。
  if (!(typeof o.n === "number" && Number.isFinite(o.n)) || Math.floor(o.n) < REHEARSE_MIN_POSTS) {
    return { ok: false, error: `n must be at least ${REHEARSE_MIN_POSTS}` };
  }
  const n = Math.min(50, Math.floor(o.n));
  // kill_switch 中は Gemini を呼ばない(cost_guard の probe 用途は止まらないため、関数側で見る)
  const ks = await killSwitchState(deps);
  if (ks !== "off") return { ok: false, error: ks === "on" ? "kill_switch is on" : "kill_switch state unavailable" };
  // 本番の採点プロンプトで試すので、採点の部品と関心プロファイルが要る
  if (!deps.scoring || !deps.loadProfile) return { ok: false, error: "scoring is not configured" };
  const scoring = deps.scoring;
  let profileText = "";
  try { profileText = (await deps.loadProfile()).trim(); } catch (e) { return { ok: false, error: `profile unavailable: ${sanitize(e, deps.apiKey)}` }; }
  if (!profileText) return { ok: false, error: "interest_profile is not set" };
  const st = await deps.rpc("get_model_state", {});
  const state = st.error ? null : parseState(st.data);
  if (!state) return { ok: false, error: `get_model_state failed: ${st.error ? sanitize(st.error.message) : "bad shape"}` };
  const model = o.model;
  const stateOk: ModelStateData = state; // worker内(関数宣言)では絞り込みが効かないため確定した値を持つ
  const deadline = deps.now() + (deps.timeBudgetMs ?? 100_000);

  const base = defaultGenConfig(state, model);
  const ex = await exploreThinking(deps, state, model, base, deadline);
  const chosenCfg = ex.chosen ? ex.chosen.config : null;
  // 用途ごと(要約・採点)の実際の設定(default+用途別)に、探索で選んだ思考指定を重ねる
  const extraFor = (purpose: string): Record<string, unknown> => {
    const e = purposeGenConfig(state, model, purpose);
    delete e.thinkingConfig;
    if (chosenCfg) e.thinkingConfig = chosenCfg;
    if (purpose === "score" && e.temperature === undefined) e.temperature = 0; // 本番の採点と同じ(温度0)
    return e;
  };
  const extraSummary = extraFor("summary");
  const extraScore = extraFor("score");

  const posts = (await deps.loadRecentPosts(n)).filter((p) => (p.content ?? "").trim().length > 0);

  type Task = { kind: "summary" | "score"; post: PostRow };
  const tasks: Task[] = [];
  for (const p of posts) {
    tasks.push({ kind: "summary", post: p }, { kind: "score", post: p });
  }
  const stat = {
    calls: 0, json_ok: 0, summary_calls: 0, summary_ok: 0, score_calls: 0, score_ok: 0,
    thought_part_calls: 0, thoughts_total: 0, thoughts_max: 0, calls_with_thoughts: 0,
    prompt_total: 0, output_total: 0, http_errors: 0,
  };
  const errors: string[] = [];
  let guard = ex.guard;
  let authStatus: number | null = ex.auth; // 認証エラー: 以降の呼び出しを止める(鍵・請求の問題で全件同じ結果になる)
  let skipped = 0;
  let idx = 0;
  async function worker() {
    for (;;) {
      if (guard || authStatus !== null || deps.now() >= deadline) return;
      const t = tasks[idx++];
      if (!t) return;
      const isSum = t.kind === "summary";
      const r = await genCall(deps, {
        model, purpose: "probe",
        // 採点は本番と同じプロンプト・スキーマ・出力上限(scoring.ts)。要約は従来の予行演習用プロンプト。
        prompt: isSum ? `${SUMMARY_PROMPT}\n\n本文:\n${t.post.content!.slice(0, 3000)}` : scoring.buildPrompt(profileText, t.post),
        schema: isSum ? SUMMARY_SCHEMA : scoring.schema,
        maxOutputTokens: isSum ? SUMMARY_MAX_OUTPUT_TOKENS : scoring.maxOutputTokens,
        extraConfig: isSum ? extraSummary : extraScore, state: stateOk,
      });
      if (r.guard) { guard = true; return; }
      if (r.auth) { authStatus ??= r.http_status ?? 0; return; }
      stat.calls++;
      // 出力が上限で途切れた(truncated)ものは成功に数えない
      const valid = r.ok && !r.truncated && (isSum ? summaryValid(r.json) : scoring.parse(r.json) !== null);
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
  if (authStatus !== null) await reportAuth(deps, authStatus || undefined, "rehearse");

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
    auth_stopped: authStatus !== null,
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
    if (authStatus !== null) reasons.push("gemini auth error");
    if (stat.calls === 0) reasons.push("no calls");
    if (skipped > 0) reasons.push("incomplete");
    if (posts.length < REHEARSE_MIN_POSTS) reasons.push(`fewer than ${REHEARSE_MIN_POSTS} posts`);
    if (rate < COMMIT_MIN_RATE) reasons.push("json success rate below 0.9");
    if (leak) reasons.push("thought parts leaked");
    // 単価が llm_prices に無いモデルは費用が計算できない(費用ガードが効かない)ので有効化しない
    const price = state.configs?.[model];
    const priced = price?.in_usd != null && price?.out_usd != null && Number.isFinite(Number(price.in_usd)) && Number.isFinite(Number(price.out_usd));
    if (!priced) reasons.push("no price in llm_prices");
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
