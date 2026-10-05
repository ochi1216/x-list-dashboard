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
  }
  | {
    ok: false;
    kind: "guard" | "gone" | "http" | "empty" | "parse" | "network";
    error: string;
    status?: number;
    model?: string;
    level?: string;
  };

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const STATE_TTL_MS = 30_000;
const RETRY_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 40_000;
const GONE_BODY_RE = /not found|no longer|deprecated|retired|decommission|discontinued/i;

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
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.seed !== undefined) out.seed = req.seed;
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
    const res = await fetchFn(`${BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
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

  // ① モデル状態
  let state = await getState(ctx, now);
  if (!state) return { ok: false, kind: "gone", error: "model state unavailable" };

  // ② 費用ガード(取得失敗は安全側=拒否)
  let guard: Record<string, unknown> | null = null;
  try {
    const g = await ctx.db.rpc("cost_guard", { p_purpose: req.purpose, p_grp: ctx.grp });
    if (!g.error && isPlainObject(g.data)) guard = g.data;
  } catch {
    guard = null;
  }
  if (!guard) return { ok: false, kind: "guard", error: "cost_guard unavailable", level: "unknown" };
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
  let retried = false;
  let switched = false;

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

      const gone = out.status === 404 ||
        ((out.status === 400 || out.status === 410) && GONE_BODY_RE.test(out.bodyText));
      if (gone) {
        const rep = await safeRpc(ctx, "model_report_gone", { p_model: model, p_reason: msg });
        const repObj = isPlainObject(rep) ? rep : {};
        const newModel = typeof repObj.current_model === "string" ? repObj.current_model : "";
        // 切替が起きた(または他の呼び出しが既に切替済み)なら、新モデルで同じ要求を1回だけ再実行
        if ((repObj.switched === true || repObj.stale === true) && newModel && newModel !== model && !switched) {
          switched = true;
          const fresh = await getState(ctx, now, true);
          if (fresh) {
            state = fresh;
            model = newModel;
            continue;
          }
        }
        return { ok: false, kind: "gone", error: msg, status: out.status, model };
      }

      if ((out.status === 429 || out.status === 500 || out.status === 503) && !retried) {
        retried = true;
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
    if (!text.trim()) {
      const fr = cand && typeof cand.finishReason === "string" ? cand.finishReason : "none";
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
      if (parseErr) {
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

async function recordUsage(ctx: GeminiCtx, row: Record<string, unknown>): Promise<number | null> {
  try {
    return await ctx.db.insertUsage(row);
  } catch {
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
      const id = r?.data?.id;
      return typeof id === "number" ? id : (id != null ? Number(id) : null);
    },
  };
}
