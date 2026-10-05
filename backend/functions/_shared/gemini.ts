// 共通Gemini呼び出し(契約: backend/docs/CONTRACT.md「共通Gemini呼び出し」)。
// 外部依存なし(jsr:/npm:/URL import 不可)。fetch / db / now / sleep は ctx で注入する。
// Node 22 の型剥がしでも動くよう、enum・namespace・parameter property は使わない。

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
export interface GeminiDb {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  insertUsage(row: Record<string, unknown>): Promise<number | null>; // llm_usageへINSERTしidを返す
}
export interface GeminiCtx {
  db: GeminiDb;
  apiKey: string;
  fn: string;
  grp: "x" | "ti";
  batchId: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number; // 1回のHTTP要求の上限(既定40秒。契約への追加・任意)
  baseUrl?: string; // Geminiの "<origin>/v1beta/models" 相当の上書き(結合試験用。未設定なら本番URL。契約への追加・任意)
}
export interface GeminiRequest {
  purpose: string;
  parts: GeminiPart[];
  schema?: Record<string, unknown>; // responseSchema(JSON応答時)
  maxOutputTokens: number; // 必須
  temperature?: number;
  seed?: number;
  postUrl?: string;
}
export type GeminiResult =
  | {
    ok: true;
    text: string;
    json: unknown | null;
    model: string;
    usageId: number | null;
    usage: { prompt: number; output: number; thoughts: number; costUsd: number | null };
    // finishReason が MAX_TOKENS で本文が途中で切れている。text は返すが、保存・採用してはならない(呼び出し側で判定)。
    // schema 有りで JSON として読めなければ json は null。
    truncated?: boolean;
  }
  | {
    ok: false;
    kind: "guard" | "gone" | "http" | "empty" | "parse" | "network" | "auth"; // auth: 認証系エラー(401/403、400のAPIキー不正・PERMISSION_DENIED等)。再試行しない
    error: string;
    status?: number;
    model?: string;
    level?: string; // guard のとき: cost_guard の level、または "state_error"(モデル状態・費用ガードの取得失敗。gone とは別物)
  };

const DEFAULT_ORIGIN = "https://generativelanguage.googleapis.com";
const BASE_URL = `${DEFAULT_ORIGIN}/v1beta/models`;
const STATE_TTL_MS = 30_000;
const RETRY_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 40_000;
const GONE_BODY_RE = /not found|no longer|deprecated|retired|decommission|discontinued/i;
const MODEL_WORD_RE = /model/i;
const AUTH_BODY_RE = /API key not valid|API_KEY_INVALID|API key expired|API_KEY_EXPIRED|PERMISSION_DENIED|UNAUTHENTICATED/i;

// 認証系エラー: HTTP 401/403、または400で本文がAPIキー不正・権限なしを示すもの。
// 鍵の誤設定・請求停止で全投稿が失敗するので、呼び出し側は試行回数に数えず、その実行を打ち切る。
export function isAuthResponse(status: number, bodyText: string): boolean {
  if (status === 401 || status === 403) return true;
  return status === 400 && AUTH_BODY_RE.test(bodyText);
}

// 認証エラーの通知(360分に1回に束ねる)。失敗しても処理は止めない。
export async function reportGeminiAuthError(db: GeminiDb, status?: number): Promise<void> {
  try {
    await db.rpc("ops_event", {
      p_level: "error", p_kind: "gemini_auth", p_message: "Gemini APIの認証エラー",
      p_data: { detail: `http ${status ?? "unknown"}` }, p_dedupe_minutes: 360,
    });
  } catch {
    // 通知の失敗で処理は止めない
  }
}

// 「提供終了」判定: 404 は常に。400/410 は本文が提供終了を示し、かつ本文に "model" を含むときだけ
// (認証・入力の不備など別原因の400/410でモデルを切り替えないため)。
export function isGoneResponse(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  return (status === 400 || status === 410) && MODEL_WORD_RE.test(bodyText) && GONE_BODY_RE.test(bodyText);
}

// 環境変数 GEMINI_BASE_URL(例 "http://127.0.0.1:8788")から v1beta/models のURLを作る。
// 未設定・不正なら本番URL。キーを平文で外部に送らないよう、http は loopback のみ許可する。
export function resolveGeminiBase(origin?: string | null): string {
  const raw = (origin ?? "").trim();
  if (!raw) return BASE_URL;
  try {
    const u = new URL(raw);
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) {
      return `${u.origin}/v1beta/models`;
    }
  } catch {
    // 不正なURL
  }
  return BASE_URL;
}

// ---------- sanitize ----------

// エラー文からAPIキーらしき文字列・key=パラメータを除き、先頭200字に丸める。
export function sanitize(input: unknown, secrets: string[] = []): string {
  let s: string;
  if (input instanceof Error) s = input.message;
  else if (typeof input === "string") s = input;
  else {
    try {
      s = JSON.stringify(input) ?? String(input);
    } catch {
      s = String(input);
    }
  }
  for (const sec of secrets) {
    if (sec && sec.length >= 8) s = s.split(sec).join("[redacted]");
  }
  s = s.replace(/AIza[0-9A-Za-z_\-]{6,}/g, "[redacted]");
  s = s.replace(/(x-goog-api-key["':=\s]+)[^\s"',&]+/gi, "$1[redacted]");
  s = s.replace(/([?&;\s"']|^)key=[^&\s"']+/gi, "$1key=[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

// ---------- model state cache(30秒) ----------

interface ModelCfg {
  gen_config?: Record<string, unknown> | null;
  enabled?: boolean;
  in_usd?: number | string | null;
  out_usd?: number | string | null;
}
interface ModelState {
  current_model: string;
  configs: Record<string, ModelCfg>;
}
const stateCache = new WeakMap<object, { at: number; state: ModelState }>();

function parseState(data: unknown): ModelState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const cur = d.current_model;
  if (typeof cur !== "string" || !cur) return null;
  const configs = (d.configs && typeof d.configs === "object" ? d.configs : {}) as Record<string, ModelCfg>;
  return { current_model: cur, configs };
}

async function getState(ctx: GeminiCtx, now: () => number, force = false): Promise<ModelState | null> {
  const hit = stateCache.get(ctx.db);
  if (!force && hit && now() - hit.at < STATE_TTL_MS) return hit.state;
  let r;
  try {
    r = await ctx.db.rpc("get_model_state");
  } catch {
    return null;
  }
  if (r.error) return null;
  const st = parseState(r.data);
  if (!st) return null;
  stateCache.set(ctx.db, { at: now(), state: st });
  return st;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function buildGenerationConfig(state: ModelState, model: string, req: GeminiRequest): Record<string, unknown> {
  const gc = state.configs[model]?.gen_config;
  const base = isPlainObject(gc) ? gc : {};
  const def = isPlainObject(base.default) ? base.default : {};
  const per = isPlainObject(base[req.purpose]) ? (base[req.purpose] as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...def, ...per };
  if (req.schema) {
    out.responseMimeType = "application/json";
    out.responseSchema = req.schema;
  }
  out.maxOutputTokens = req.maxOutputTokens;
  // モデル設定(gen_config の default / 用途別)に temperature・seed があればそれが正。
  // リクエストの値は、モデル設定に無いときの既定値としてだけ使う。
  if (req.temperature !== undefined && out.temperature === undefined) out.temperature = req.temperature;
  if (req.seed !== undefined && out.seed === undefined) out.seed = req.seed;
  return out;
}

function stripFences(t: string): string {
  const m = t.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : t;
}

function errorMessageFromBody(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText);
    const m = j?.error?.message;
    if (typeof m === "string" && m) return m;
  } catch {
    // 本文がJSONでない
  }
  return bodyText;
}

interface HttpOutcome {
  status: number | null; // null = 通信例外
  bodyText: string;
  json: unknown;
  netError?: string;
  latencyMs: number;
}

async function doFetch(
  ctx: GeminiCtx,
  now: () => number,
  model: string,
  body: string,
): Promise<HttpOutcome> {
  const fetchFn = ctx.fetchFn ?? fetch;
  const t0 = now();
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(`${ctx.baseUrl ?? BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": ctx.apiKey },
      body,
      signal: ac?.signal,
    });
    const bodyText = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = null;
    }
    return { status: res.status, bodyText, json, latencyMs: now() - t0 };
  } catch (e) {
    const aborted = ac?.signal.aborted === true;
    return {
      status: null,
      bodyText: "",
      json: null,
      netError: aborted ? "request timed out" : sanitize(e, [ctx.apiKey]),
      latencyMs: now() - t0,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeRpc(ctx: GeminiCtx, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const r = await ctx.db.rpc(name, args);
    return r.error ? null : r.data;
  } catch {
    return null;
  }
}

export async function callGemini(ctx: GeminiCtx, req: GeminiRequest): Promise<GeminiResult> {
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const secrets = [ctx.apiKey];

  if (!ctx.apiKey) return { ok: false, kind: "network", error: "api key is not set" };

  // maxOutputTokens は必須(契約・費用ガードの前提)。未指定・0以下はプログラミングエラーなので早期に例外にする
  // (実行時の結果として返すと、ガード停止などと混同され、静かに処理が止まる)。
  if (typeof req.maxOutputTokens !== "number" || !Number.isFinite(req.maxOutputTokens) || req.maxOutputTokens <= 0) {
    throw new Error(`callGemini: maxOutputTokens must be a positive number (purpose=${String(req?.purpose)})`);
  }

  // ① モデル状態(取得失敗は「提供終了」ではない。安全側に止める=guard/state_error)
  let state = await getState(ctx, now);
  if (!state) return { ok: false, kind: "guard", error: "model state unavailable", level: "state_error" };

  // ② 費用ガード(取得失敗は安全側=拒否)
  let guard: Record<string, unknown> | null = null;
  try {
    const g = await ctx.db.rpc("cost_guard", { p_purpose: req.purpose, p_grp: ctx.grp });
    if (!g.error && isPlainObject(g.data)) guard = g.data;
  } catch {
    guard = null;
  }
  if (!guard) return { ok: false, kind: "guard", error: "cost_guard unavailable", level: "state_error" };
  if (guard.allowed !== true) {
    return {
      ok: false,
      kind: "guard",
      error: `cost guard denied (level=${String(guard.level ?? "unknown")})`,
      level: typeof guard.level === "string" ? guard.level : undefined,
    };
  }

  let model = state.current_model;
  let attempt = 0;
  // 再実行(429等の再試行・提供終了後の新モデル再実行)は合計1回まで。
  // 1回の呼び出しの最悪時間を 要求timeout×2+待ち1.5秒 に抑え、関数全体の時間予算の計算を成り立たせる。
  let reruns = 0;

  for (;;) {
    attempt++;
    const cfg = state.configs[model] ?? {};
    const body = JSON.stringify({
      contents: [{ parts: req.parts }],
      generationConfig: buildGenerationConfig(state, model, req),
    });
    const out = await doFetch(ctx, now, model, body);

    const inPrice = num(cfg.in_usd);
    const outPrice = num(cfg.out_usd);
    const row: Record<string, unknown> = {
      batch_id: ctx.batchId,
      fn: ctx.fn,
      purpose: req.purpose,
      grp: ctx.grp,
      model,
      prompt_tokens: null,
      output_tokens: null,
      thoughts_tokens: null,
      cost_usd: null,
      in_price: inPrice,
      out_price: outPrice,
      status: "error",
      http_status: out.status,
      latency_ms: out.latencyMs,
      attempt,
      error: null,
      post_url: req.postUrl ?? null,
    };

    // ---- 通信例外 ----
    if (out.status === null) {
      const msg = out.netError ?? "network error";
      row.error = msg;
      await recordUsage(ctx, row);
      return { ok: false, kind: "network", error: msg, model };
    }

    // ---- HTTPエラー ----
    if (out.status < 200 || out.status >= 300) {
      const msg = sanitize(`http ${out.status}: ${errorMessageFromBody(out.bodyText)}`, secrets);
      row.error = msg;
      await recordUsage(ctx, row);

      // 認証系は再試行・モデル切替の対象外(別のモデルや再実行で直らない)
      if (isAuthResponse(out.status, out.bodyText)) {
        return { ok: false, kind: "auth", error: msg, status: out.status, model };
      }

      const gone = isGoneResponse(out.status, out.bodyText);
      if (gone) {
        const rep = await safeRpc(ctx, "model_report_gone", { p_model: model, p_reason: msg });
        const repObj = isPlainObject(rep) ? rep : {};
        const newModel = typeof repObj.current_model === "string" ? repObj.current_model : "";
        // 切替が起きた(または他の呼び出しが既に切替済み)なら、新モデルで同じ要求を1回だけ再実行
        if ((repObj.switched === true || repObj.stale === true) && newModel && newModel !== model && reruns < 1) {
          reruns++;
          const fresh = await getState(ctx, now, true);
          if (fresh) {
            state = fresh;
            model = newModel;
            continue;
          }
        }
        return { ok: false, kind: "gone", error: msg, status: out.status, model };
      }

      if ((out.status === 429 || out.status === 500 || out.status === 503) && reruns < 1) {
        reruns++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, kind: "http", error: msg, status: out.status, model };
    }

    // ---- 2xx ----
    const j = (isPlainObject(out.json) ? out.json : {}) as Record<string, unknown>;
    const um = isPlainObject(j.usageMetadata) ? j.usageMetadata : null;
    let prompt = 0, output = 0, thoughts = 0;
    let costUsd: number | null = null;
    if (!um) {
      row.status = "no_usage";
    } else {
      prompt = num(um.promptTokenCount) ?? 0;
      output = num(um.candidatesTokenCount) ?? 0;
      thoughts = num(um.thoughtsTokenCount) ?? 0;
      row.prompt_tokens = prompt;
      row.output_tokens = output;
      row.thoughts_tokens = thoughts;
      if (inPrice === null || outPrice === null) {
        row.status = "unpriced";
      } else {
        costUsd = (prompt * inPrice + (output + thoughts) * outPrice) / 1e6;
        row.cost_usd = costUsd;
        row.status = "ok";
      }
    }

    // 本文: 思考part(thought:true)を除く全textを結合
    const cand = Array.isArray(j.candidates) ? (j.candidates[0] as Record<string, unknown> | undefined) : undefined;
    const content = cand && isPlainObject(cand.content) ? cand.content : null;
    const partsArr = content && Array.isArray(content.parts) ? content.parts : [];
    let text = "";
    for (const p of partsArr) {
      if (isPlainObject(p) && p.thought !== true && typeof p.text === "string") text += p.text;
    }

    let result: GeminiResult;
    const fr = cand && typeof cand.finishReason === "string" ? cand.finishReason : "none";
    if (!text.trim()) {
      const pf = isPlainObject(j.promptFeedback) && typeof j.promptFeedback.blockReason === "string"
        ? ` blockReason=${j.promptFeedback.blockReason}`
        : "";
      const msg = sanitize(`empty response (finishReason=${fr}${pf})`, secrets);
      row.error = msg;
      result = { ok: false, kind: "empty", error: msg, status: out.status, model };
    } else {
      let parsed: unknown | null = null;
      let parseErr: string | null = null;
      if (req.schema) {
        try {
          parsed = JSON.parse(stripFences(text));
        } catch {
          parseErr = "response is not valid JSON";
        }
      }
      if (fr === "MAX_TOKENS") {
        // 出力が上限で途中切れ。失敗(parse)にはせず text を返し、truncated で知らせる
        // (呼び出し側が、途中で切れた本文を成功として保存しないために判定する)。
        row.error = "truncated (finishReason=MAX_TOKENS)";
        result = {
          ok: true, text, json: parseErr ? null : parsed, model, usageId: null,
          usage: { prompt, output, thoughts, costUsd }, truncated: true,
        };
      } else if (parseErr) {
        row.error = parseErr;
        result = { ok: false, kind: "parse", error: parseErr, status: out.status, model };
      } else {
        result = {
          ok: true,
          text,
          json: parsed,
          model,
          usageId: null,
          usage: { prompt, output, thoughts, costUsd },
        };
      }
    }

    const usageId = await recordUsage(ctx, row);
    if (result.ok) {
      result.usageId = usageId;
      await safeRpc(ctx, "model_report_ok", { p_model: model });
    }
    return result;
  }
}

// llm_usage への記録。失敗しても呼び出し結果は返すが、記録漏れ(=費用ガードの集計漏れ)に気づけるよう
// console.error に残す(キーは伏せる)。
async function recordUsage(ctx: GeminiCtx, row: Record<string, unknown>): Promise<number | null> {
  try {
    const id = await ctx.db.insertUsage(row);
    if (id === null || id === undefined) {
      console.error(`llm_usage insert returned no id (fn=${ctx.fn} purpose=${String(row.purpose)} model=${String(row.model)})`);
      return null;
    }
    return id;
  } catch (e) {
    console.error(`llm_usage insert failed (fn=${ctx.fn} purpose=${String(row.purpose)}): ${sanitize(e, [ctx.apiKey])}`);
    return null;
  }
}

// supabase-js のクライアント(service role)を GeminiDb に適合させる薄いアダプタ。
// client は { rpc, from } を持つ構造的型(import不要)。
export function makeGeminiDb(client: {
  // deno-lint-ignore no-explicit-any
  rpc: (name: string, args?: any) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
}): GeminiDb {
  return {
    async rpc(name, args) {
      const r = await client.rpc(name, args ?? {});
      return { data: r.data, error: r.error ? { message: r.error.message } : null };
    },
    async insertUsage(row) {
      const r = await client.from("llm_usage").insert(row).select("id").single();
      if (r?.error) throw new Error(`llm_usage insert: ${r.error.message ?? "error"}`);
      const id = r?.data?.id;
      return typeof id === "number" ? id : (id != null ? Number(id) : null);
    },
  };
}
