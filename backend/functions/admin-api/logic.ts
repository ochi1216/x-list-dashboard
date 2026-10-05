// admin-api の分岐ロジック(外部依存なし。DBと認証部品は引数で注入 → Node で単体テスト可能)
// index.ts だけが supabase-js / Deno を使う。ここでは import を一切使わない。
// 秘密(パスフレーズ・トークン・署名鍵・Vault値)と例外全文はレスポンスにもログにも出さない。

// ---- 注入される型 ---------------------------------------------------------------
export interface AuthRow {
  salt: string | null;
  hash: string | null;
  iterations: number | null;
  key_version: number;
  failed_count: number;
  last_failed_at: string | null;
  setup_done: boolean;
  setup_code_hash: string | null;
  setup_code_expires_at: string | null;
}

export interface AuthLib {
  hashPassphrase(pass: string): Promise<{ salt: string; hash: string; iterations: number }>;
  verifyPassphrase(pass: unknown, stored: unknown): Promise<boolean>;
  validatePassphraseShape(pass: unknown): string;
  hashSetupCode(input: unknown): Promise<string | null>;
  checkSetupCode(
    input: unknown,
    state: { setup_done: boolean; setup_code_hash?: string | null; setup_code_expires_at?: string | number | null },
    nowMs: number,
  ): Promise<string>;
  signToken(secret: string, keyVersion: number, nowMs: number): Promise<string>;
  verifyToken(
    secret: string,
    token: unknown,
    keyVersion: number,
    nowMs: number,
  ): Promise<{ ok: boolean; refresh?: boolean; reason?: string }>;
  retryAfterSeconds(failedCount: number, lastFailedAt: string | number | null | undefined, nowMs: number): number;
}

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface LabelRow {
  id: number;
  content: string | null;
  summary: string | null;
  image_urls: unknown;
  label_score: number | null;
  // 実装側(DB層)が余計な列(ai_*等)を混ぜても、logic側で必ず落とす
  [k: string]: unknown;
}

export interface MonthRow {
  month: string; // YYYY-MM-DD(JSTの月初)
  grp: string;
  purpose: string;
  model: string;
  calls: number;
  cost_usd: number;
  cost_jpy: number;
  finalized: boolean;
}

export interface AdminDb {
  rpc(name: string, args?: Record<string, unknown>): Promise<RpcResult>;
  getAuth(): Promise<AuthRow | null>;
  updateAuth(patch: Record<string, unknown>): Promise<void>;
  /** setup_done=false かつ setup_code_hash=codeHash の行だけを更新(一回限りを原子的に保証)。更新できたら true */
  completeSetup(codeHash: string, patch: Record<string, unknown>): Promise<boolean>;
  claimOp(opId: string, kind: string): Promise<{ inserted: boolean; result: unknown }>;
  finishOp(opId: string, result: unknown): Promise<void>;
  releaseOp(opId: string): Promise<void>;
  updatePost(postUrl: string, patch: Record<string, unknown>): Promise<boolean>;
  getConfigRows(): Promise<{ key: string; value: unknown }[]>;
  getConfigValue(key: string): Promise<unknown | null>;
  /** tuning_config を更新し、tuning_config_history に旧値・新値・source を記録。履歴idを返す */
  setConfig(key: string, oldValue: unknown, newValue: unknown, source: string): Promise<number | null>;
  getHistory(id: number): Promise<{ id: number; key: string; old_value: unknown; new_value: unknown } | null>;
  latestListNo(): Promise<number | null>;
  labelRows(listNo: number): Promise<LabelRow[]>;
  labelSubmit(id: number, score: number, cls: string, nowIso: string): Promise<{ found: boolean; list_no: number | null }>;
  weekReport(weekStart: string | null): Promise<{ week_start: string; body: unknown; text_ja: string | null } | null>;
  costMonthly(fromMonth: string): Promise<MonthRow[]>;
  recentErrors(limit: number): Promise<Record<string, unknown>[]>;
  modelLastSwitchAt(): Promise<string | null>;
  opsEvents(limit: number): Promise<Record<string, unknown>[]>;
}

export interface AdminDeps {
  db: AdminDb;
  auth: AuthLib;
  tokenKey: string;
  now: () => number;
}

export interface AdminResponse {
  status: number;
  body: Record<string, unknown>;
}

// ---- 設定の許可リストと値域 ---------------------------------------------------------
export interface ConfigSpec {
  kind: "int" | "num" | "bool" | "enum" | "iso";
  min?: number;
  max?: number;
  values?: string[];
  protected?: boolean; // パスフレーズ再入力が必要
}

export const CONFIG_SPECS: Record<string, ConfigSpec> = {
  usd_jpy: { kind: "num", min: 50, max: 500 },
  monthly_cap_jpy: { kind: "int", min: 100, max: 50000, protected: true },
  daily_cap_jpy: { kind: "int", min: 50, max: 5000, protected: true },
  hourly_call_cap: { kind: "int", min: 50, max: 5000, protected: true },
  ti_daily_call_cap: { kind: "int", min: 10, max: 5000, protected: true },
  cap_warn_ratio: { kind: "num", min: 0.3, max: 1, protected: true },
  cap_stop_extra_ratio: { kind: "num", min: 0.5, max: 3, protected: true },
  cap_stop_all_ratio: { kind: "num", min: 1, max: 5, protected: true },
  pipeline_auth_mode: { kind: "enum", values: ["log", "enforce"], protected: true },
  kill_switch: { kind: "bool", protected: true },
  auto_expire_enabled: { kind: "bool", protected: true },
  auto_expire_max_per_run: { kind: "int", min: 1, max: 2000 },
  score_enabled: { kind: "bool" },
  tier_assign_enabled: { kind: "bool" },
  cap_opinion: { kind: "bool" },
  backfill_enabled: { kind: "bool" },
  speech_enabled: { kind: "bool" },
  speech_max_per_run: { kind: "int", min: 1, max: 100 },
  listen_threshold: { kind: "int", min: 3, max: 5 },
  listen_quota_min: { kind: "int", min: 1, max: 60 },
  listen_chars_per_sec: { kind: "num", min: 3, max: 15 },
  listen_speed: { kind: "num", min: 0.5, max: 3 },
  listen_morning_share: { kind: "num", min: 0.1, max: 0.9 },
  batch_gap_minutes: { kind: "int", min: 10, max: 600 },
  batch_quiet_minutes: { kind: "int", min: 5, max: 120 },
  batch_confirm_hours: { kind: "int", min: 1, max: 24 },
  expire_listen_hours: { kind: "int", min: 1, max: 168 },
  expire_flow_hours: { kind: "int", min: 1, max: 336 },
  digest_min_interval_hours: { kind: "int", min: 1, max: 48 },
  digest_min_new_scored: { kind: "int", min: 1, max: 100 },
  tier_scope_from: { kind: "iso" },
  score_backfill_from: { kind: "iso" },
};

// config_get で読めるが config_set では変更できないキー(システム管理)
export const READONLY_CONFIG_KEYS = ["threshold_version"];

export function isAllowedConfigKey(key: unknown): key is string {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(CONFIG_SPECS, key);
}

export function isProtectedConfigKey(key: string): boolean {
  return CONFIG_SPECS[key]?.protected === true;
}

// 緊急停止がロックアウトに阻まれないよう、有効なトークンだけで通せる「安全側」の変更。
//  - kill_switch を true にする
//  - 上限(monthly_cap_jpy / daily_cap_jpy / hourly_call_cap / ti_daily_call_cap)を現在値より下げる
// これ以外(false にする・上げる・同値・旧値なし・他の保護キー)はパスフレーズ再入力が必要。
const LOWER_ONLY_KEYS = ["monthly_cap_jpy", "daily_cap_jpy", "hourly_call_cap", "ti_daily_call_cap"];
export function reauthNeeded(key: string, oldValue: unknown, newValue: unknown): boolean {
  if (!isProtectedConfigKey(key)) return false;
  if (key === "kill_switch") return newValue !== true;
  if (LOWER_ONLY_KEYS.includes(key)) {
    return !(typeof oldValue === "number" && typeof newValue === "number" && newValue < oldValue);
  }
  return true;
}

/** 値域検査。OK なら null、NG なら "invalid_value"。型は厳密(数値は数値、真偽は真偽、文字列は文字列)。 */
export function validateConfigValue(key: string, value: unknown): string | null {
  const s = CONFIG_SPECS[key];
  if (!s) return "key_not_allowed";
  switch (s.kind) {
    case "bool":
      return typeof value === "boolean" ? null : "invalid_value";
    case "enum":
      return typeof value === "string" && (s.values ?? []).includes(value) ? null : "invalid_value";
    case "int":
    case "num": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "invalid_value";
      if (s.kind === "int" && !Number.isInteger(value)) return "invalid_value";
      if (s.min !== undefined && value < s.min) return "invalid_value";
      if (s.max !== undefined && value > s.max) return "invalid_value";
      return null;
    }
    case "iso": {
      if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}/.test(value)) return "invalid_value";
      return Number.isFinite(Date.parse(value)) ? null : "invalid_value";
    }
  }
  return "invalid_value";
}

// ---- 小物 ---------------------------------------------------------------------
const PASSPHRASE_REAUTH_ERROR = "bad_passphrase";

function res(status: number, body: Record<string, unknown>): AdminResponse {
  return { status, body };
}
function ok(extra: Record<string, unknown> = {}): AdminResponse {
  return res(200, { ok: true, ...extra });
}
function err(status: number, code: string, extra: Record<string, unknown> = {}): AdminResponse {
  return res(status, { ok: false, error: code, ...extra });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d{1,15}$/.test(v)) return Number(v);
  return null;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** エラー文からキー・URL・長文を落として短くする(llm_usage.error の再掲用) */
export function scrubErrorText(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[key]")
    .replace(/key=[^&\s"']+/gi, "key=[x]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(n: number, d = 2): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

// ---- 盲検ラベル(AI点・投稿者名は絶対に返さない) ----------------------------------------
export function blindLabelItems(rows: LabelRow[]): { id: number; content: string | null; summary: string | null; image_urls: string[] }[] {
  const un = rows.filter((r) => r.label_score === null || r.label_score === undefined);
  // 並び(=抽出枠の順序)から枠が推測されないよう、idの決定的なハッシュ順にする
  un.sort((a, b) => ((Number(a.id) * 2654435761) % 4294967296) - ((Number(b.id) * 2654435761) % 4294967296));
  return un.map((r) => ({
    id: r.id,
    content: r.content ?? null,
    summary: r.summary ?? null,
    image_urls: Array.isArray(r.image_urls) ? (r.image_urls as unknown[]).filter((x) => typeof x === "string") as string[] : [],
  }));
}

// ---- 手動区分の更新内容 ----------------------------------------------------------------
export function tierPatch(how: "promote" | "demote", nowIso: string): Record<string, unknown> {
  if (how === "promote") {
    return {
      listen_tier: "listen",
      manual_action: "promote",
      manual_at: nowIso,
      tier_reason: "manual_promote",
      tier_assigned_at: nowIso,
    };
  }
  return {
    listen_tier: "hold",
    is_read: true,
    read_via: "user",
    read_at: nowIso,
    manual_action: "demote",
    manual_at: nowIso,
    tier_reason: "manual_demote",
    tier_assigned_at: nowIso,
  };
}

// ---- 費用集計(純粋) ---------------------------------------------------------------------
const JST_MS = 9 * 3600 * 1000;

export function jstMonthKey(nowMs: number, offsetMonths = 0): string {
  const d = new Date(nowMs + JST_MS);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export interface CostInputs {
  rows: MonthRow[];
  guard: unknown;
  modelState: unknown;
  lastSwitchAt: string | null;
  errors: Record<string, unknown>[];
}

export function buildCostSummary(inp: CostInputs, nowMs: number): Record<string, unknown> {
  const cur = jstMonthKey(nowMs, 0);
  const prev = jstMonthKey(nowMs, -1);
  const rows = inp.rows.map((r) => ({
    month: String(r.month).slice(0, 10),
    grp: r.grp,
    purpose: r.purpose,
    model: r.model,
    calls: num(r.calls),
    usd: num(r.cost_usd),
    jpy: num(r.cost_jpy),
    finalized: !!r.finalized,
  }));
  const sum = (list: typeof rows) => ({
    jpy: round(list.reduce((a, r) => a + r.jpy, 0), 1),
    usd: round(list.reduce((a, r) => a + r.usd, 0), 4),
    calls: list.reduce((a, r) => a + r.calls, 0),
  });
  const group = (list: typeof rows, keyOf: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { jpy: number; calls: number }>();
    for (const r of list) {
      const k = keyOf(r);
      const e = m.get(k) ?? { jpy: 0, calls: 0 };
      e.jpy += r.jpy;
      e.calls += r.calls;
      m.set(k, e);
    }
    return [...m.entries()].map(([k, v]) => ({ k, jpy: round(v.jpy, 1), calls: v.calls })).sort((a, b) => b.jpy - a.jpy);
  };

  const thisRows = rows.filter((r) => r.month === cur);
  const lastRows = rows.filter((r) => r.month === prev);
  const t = sum(thisRows);

  // 月末見込み = 今月の実績 ÷ 経過日数 × 月日数(経過日数は最低1日として月初の過大見積りを避ける)
  const jst = new Date(nowMs + JST_MS);
  const daysInMonth = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 0)).getUTCDate();
  const monthStartMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1);
  const elapsedDays = Math.max(1, (nowMs + JST_MS - monthStartMs) / 86400000);
  const forecast = round((t.jpy / elapsedDays) * daysInMonth, 0);

  const monthMap = new Map<string, { jpy: number; usd: number; finalized: boolean }>();
  for (const r of rows) {
    const e = monthMap.get(r.month) ?? { jpy: 0, usd: 0, finalized: true };
    e.jpy += r.jpy;
    e.usd += r.usd;
    e.finalized = e.finalized && r.finalized;
    monthMap.set(r.month, e);
  }
  const months = [...monthMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-13)
    .map(([m, v]) => ({ month: m.slice(0, 7), jpy: round(v.jpy, 1), usd: round(v.usd, 4), finalized: v.finalized }));

  const g = isObj(inp.guard) ? inp.guard : {};
  const ms = isObj(inp.modelState) ? inp.modelState : {};
  return {
    today_jpy: round(num(g.day_jpy), 1), // 直近24時間(X系)。cost_guard の day_jpy
    this_month: {
      ...t,
      forecast_jpy: forecast,
      by_model: group(thisRows, (r) => r.model).map((x) => ({ model: x.k, jpy: x.jpy, calls: x.calls })),
      by_purpose: group(thisRows, (r) => r.purpose).map((x) => ({ purpose: x.k, jpy: x.jpy, calls: x.calls })),
      by_grp: group(thisRows, (r) => r.grp).map((x) => ({ grp: x.k, jpy: x.jpy })),
    },
    last_month: lastRows.length ? sum(lastRows) : null,
    months,
    guard: inp.guard ?? null,
    model_state: {
      current_model: ms.current_model ?? null,
      candidates: Array.isArray(ms.candidates) ? ms.candidates : [],
      last_switch_at: inp.lastSwitchAt,
    },
    recent_errors: inp.errors.map((e) => ({
      at: e.called_at ?? e.at ?? null,
      fn: e.fn ?? null,
      purpose: e.purpose ?? null,
      model: e.model ?? null,
      status: e.http_status ?? e.status ?? null,
      error: scrubErrorText(e.error),
    })),
  };
}

// ---- 本体 -------------------------------------------------------------------------
interface Ctx {
  deps: AdminDeps;
  row: AuthRow;
  now: number;
}

async function recordFailure(ctx: Ctx): Promise<number> {
  const n = (ctx.row.failed_count || 0) + 1;
  await ctx.deps.db.updateAuth({ failed_count: n, last_failed_at: new Date(ctx.now).toISOString() });
  ctx.row.failed_count = n;
  ctx.row.last_failed_at = new Date(ctx.now).toISOString();
  return ctx.deps.auth.retryAfterSeconds(n, ctx.row.last_failed_at, ctx.now);
}

async function resetFailures(ctx: Ctx): Promise<void> {
  if ((ctx.row.failed_count || 0) > 0 || ctx.row.last_failed_at) {
    await ctx.deps.db.updateAuth({ failed_count: 0, last_failed_at: null });
    ctx.row.failed_count = 0;
    ctx.row.last_failed_at = null;
  }
}

function waitResponse(ctx: Ctx): AdminResponse | null {
  const left = ctx.deps.auth.retryAfterSeconds(ctx.row.failed_count || 0, ctx.row.last_failed_at, ctx.now);
  return left > 0 ? err(429, "rate_limited", { retry_after: left }) : null;
}

/** パスフレーズ再入力。成功なら null、失敗なら返すべき応答。待ち中は正解でも429。 */
async function reauth(ctx: Ctx, passphrase: unknown): Promise<AdminResponse | null> {
  const w = waitResponse(ctx);
  if (w) return w;
  if (typeof passphrase !== "string" || passphrase.length === 0) return err(400, "passphrase_required");
  const good = await ctx.deps.auth.verifyPassphrase(passphrase, ctx.row);
  if (!good) {
    const left = await recordFailure(ctx);
    return err(401, PASSPHRASE_REAUTH_ERROR, left > 0 ? { retry_after: left } : {});
  }
  await resetFailures(ctx);
  return null;
}

type Handler = (ctx: Ctx, req: Record<string, unknown>) => Promise<AdminResponse>;

async function withOp(
  ctx: Ctx,
  req: Record<string, unknown>,
  kind: string,
  run: () => Promise<AdminResponse>,
): Promise<AdminResponse> {
  const opId = str(req.op_id, 100);
  if (!opId) return err(400, "op_id_required");
  const c = await ctx.deps.db.claimOp(opId, kind);
  if (!c.inserted) {
    const prev = isObj(c.result) ? c.result : {};
    return ok({ duplicate: true, ...(prev.remaining !== undefined ? { remaining: prev.remaining } : {}) });
  }
  let r: AdminResponse;
  try {
    r = await run();
  } catch (e) {
    await ctx.deps.db.releaseOp(opId).catch(() => {});
    throw e;
  }
  if (r.body.ok === true) await ctx.deps.db.finishOp(opId, r.body).catch(() => {});
  else await ctx.deps.db.releaseOp(opId).catch(() => {});
  return r;
}

const HANDLERS: Record<string, Handler> = {
  async change_passphrase(ctx, req) {
    const bad = await reauth(ctx, req.old);
    if (bad) return bad;
    const shape = ctx.deps.auth.validatePassphraseShape(req.new);
    if (shape !== "ok") return err(400, shape === "too_short" ? "passphrase_too_short" : "invalid_passphrase");
    if (req.new === req.old) return err(400, "passphrase_unchanged");
    const h = await ctx.deps.auth.hashPassphrase(req.new as string);
    const kv = (ctx.row.key_version || 1) + 1; // 既存トークン(他端末)を失効させる
    await ctx.deps.db.updateAuth({
      salt: h.salt,
      hash: h.hash,
      iterations: h.iterations,
      key_version: kv,
      set_at: new Date(ctx.now).toISOString(),
    });
    ctx.row.key_version = kv;
    const token = await ctx.deps.auth.signToken(ctx.deps.tokenKey, kv, ctx.now);
    return ok({ token, key_version: kv });
  },

  async tier_set(ctx, req) {
    const postUrl = str(req.post_url, 2000);
    const how = req.how;
    if (!postUrl || !/^https?:\/\//.test(postUrl) || (how !== "promote" && how !== "demote")) return err(400, "bad_request");
    return await withOp(ctx, req, "tier_set", async () => {
      const found = await ctx.deps.db.updatePost(postUrl, tierPatch(how, new Date(ctx.now).toISOString()));
      return found ? ok() : err(404, "not_found");
    });
  },

  async label_create(ctx, req) {
    const n = req.n === undefined ? 20 : toInt(req.n);
    if (n === null || n < 1 || n > 60) return err(400, "bad_request");
    const r = await ctx.deps.db.rpc("create_label_list", { p_n: n });
    if (r.error) return err(500, "server_error");
    const d = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!isObj(d) || toInt(d.list_no) === null) return err(500, "server_error");
    return ok({ list_no: toInt(d.list_no), created: d.created ?? null });
  },

  async label_next(ctx, req) {
    let listNo: number | null;
    if (req.list_no === undefined || req.list_no === null) listNo = await ctx.deps.db.latestListNo();
    else {
      listNo = toInt(req.list_no);
      if (listNo === null) return err(400, "bad_request");
    }
    if (listNo === null) return ok({ list_no: null, items: [], remaining: 0, total: 0 });
    const rows = await ctx.deps.db.labelRows(listNo);
    const items = blindLabelItems(rows);
    return ok({ list_no: listNo, items, remaining: items.length, total: rows.length });
  },

  async label_submit(ctx, req) {
    const id = toInt(req.id);
    const score = toInt(req.score);
    const cls = req.cls;
    if (id === null || score === null || score < 1 || score > 5) return err(400, "bad_request");
    if (cls !== "announce" && cls !== "ref_only" && cls !== "opinion" && cls !== "other") return err(400, "bad_request");
    return await withOp(ctx, req, "label_submit", async () => {
      const r = await ctx.deps.db.labelSubmit(id, score, cls, new Date(ctx.now).toISOString());
      if (!r.found) return err(404, "not_found");
      let remaining = 0;
      if (r.list_no !== null) {
        remaining = (await ctx.deps.db.labelRows(r.list_no)).filter((x) => x.label_score === null || x.label_score === undefined).length;
      }
      return ok({ remaining });
    });
  },

  async week_report(ctx, req) {
    let ws: string | null = null;
    if (req.week_start !== undefined && req.week_start !== null) {
      if (typeof req.week_start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(req.week_start)) return err(400, "bad_request");
      ws = req.week_start;
    }
    const r = await ctx.deps.db.weekReport(ws);
    if (!r) return ok({ empty: true });
    return ok({ week_start: r.week_start, text_ja: r.text_ja ?? "", body: r.body ?? null });
  },

  async authors(ctx, req) {
    const w = req.weeks === undefined ? 4 : toInt(req.weeks);
    if (w === null || w < 1 || w > 52) return err(400, "bad_request");
    const r = await ctx.deps.db.rpc("author_scoreboard", { p_weeks: w });
    if (r.error) return err(500, "server_error");
    const list = Array.isArray(r.data) ? r.data : [];
    const rows = list.filter(isObj).map((x) => ({
      author_handle: x.author_handle ?? null,
      author_name: x.author_name ?? null,
      n: x.n ?? null,
      low_n: x.low_n ?? null,
      high_n: x.high_n ?? null,
      low_rate: x.low_rate ?? null,
      high_rate: x.high_rate ?? null,
      low_lo: x.low_lo ?? null,
      high_hi: x.high_hi ?? null,
      mean: x.mean ?? null,
      verdict: x.verdict ?? null,
    }));
    return ok({ rows });
  },

  async cost_summary(ctx) {
    const db = ctx.deps.db;
    // 当月の集計を最新化(失敗しても続行)
    await db.rpc("refresh_cost_monthly", { p_month: null, p_finalize: false }).catch(() => null);
    const from = jstMonthKey(ctx.now, -12);
    const [rows, guard, ms, lastSwitch, errors] = await Promise.all([
      db.costMonthly(from),
      db.rpc("cost_guard", { p_purpose: "summary", p_grp: "x" }),
      db.rpc("get_model_state"),
      db.modelLastSwitchAt(),
      db.recentErrors(10),
    ]);
    return ok(buildCostSummary({
      rows,
      guard: guard.error ? null : guard.data,
      modelState: ms.error ? null : ms.data,
      lastSwitchAt: lastSwitch,
      errors,
    }, ctx.now));
  },

  async config_get(ctx) {
    const rows = await ctx.deps.db.getConfigRows();
    const config: Record<string, unknown> = {};
    for (const r of rows) {
      if (isAllowedConfigKey(r.key) || READONLY_CONFIG_KEYS.includes(r.key)) config[r.key] = r.value;
    }
    const protectedKeys = Object.keys(CONFIG_SPECS).filter((k) => CONFIG_SPECS[k].protected);
    return ok({ config, protected: protectedKeys });
  },

  async config_set(ctx, req) {
    if (!isAllowedConfigKey(req.key)) return err(400, "key_not_allowed");
    const key = req.key;
    const bad = validateConfigValue(key, req.value);
    if (bad) return err(400, bad, { key });
    const old = await ctx.deps.db.getConfigValue(key);
    if (reauthNeeded(key, old, req.value)) {
      const r = await reauth(ctx, req.passphrase);
      if (r) return r;
    }
    if (old !== null && deepEqual(old, req.value)) return ok({ unchanged: true });
    const hid = await ctx.deps.db.setConfig(key, old, req.value, "admin");
    return ok({ history_id: hid });
  },

  async config_undo(ctx, req) {
    const hid = toInt(req.history_id);
    if (hid === null) return err(400, "bad_request");
    const h = await ctx.deps.db.getHistory(hid);
    if (!h) return err(404, "not_found");
    if (!isAllowedConfigKey(h.key)) return err(400, "key_not_allowed");
    if (h.old_value === null || h.old_value === undefined || validateConfigValue(h.key, h.old_value)) {
      return err(400, "cannot_undo");
    }
    const cur = await ctx.deps.db.getConfigValue(h.key);
    if (reauthNeeded(h.key, cur, h.old_value)) {
      const r = await reauth(ctx, req.passphrase);
      if (r) return r;
    }
    const newId = await ctx.deps.db.setConfig(h.key, cur, h.old_value, `undo:${hid}`);
    return ok({ history_id: newId, key: h.key, value: h.old_value });
  },

  async notify_info(ctx) {
    const [t, ev] = await Promise.all([ctx.deps.db.rpc("get_secret", { p_name: "xd_ntfy_topic" }), ctx.deps.db.opsEvents(20)]);
    const topic = !t.error && typeof t.data === "string" ? t.data : "";
    return ok({
      topic,
      configured: topic.trim() !== "",
      events: ev.map((e) => ({ at: e.at ?? null, level: e.level ?? null, kind: e.kind ?? null, message: e.message ?? null, suppressed: !!e.suppressed })),
    });
  },

  async notify_test(ctx) {
    const r = await ctx.deps.db.rpc("notify_test");
    if (r.error) return err(500, "server_error");
    if (r.data === null || r.data === undefined) return err(400, "not_configured");
    return ok();
  },

  async set_healthcheck(ctx, req) {
    const kind = req.kind;
    if (kind !== "daily" && kind !== "weekly") return err(400, "bad_request");
    if (typeof req.url !== "string" || req.url.length > 500) return err(400, "bad_request");
    const url = req.url.trim();
    if (url !== "") {
      let okUrl = false;
      try {
        okUrl = new URL(url).protocol === "https:";
      } catch (_e) {
        okUrl = false;
      }
      if (!okUrl) return err(400, "invalid_value", { key: "url" });
    }
    const bad = await reauth(ctx, req.passphrase);
    if (bad) return bad;
    const r = await ctx.deps.db.rpc("set_secret", { p_name: `xd_healthcheck_${kind}_url`, p_value: url });
    if (r.error) return err(500, "server_error");
    // URLそのものは記録しない
    await ctx.deps.db.rpc("ops_event", {
      p_level: "info",
      p_kind: "healthcheck_set",
      p_message: `healthcheck(${kind})のURLを${url === "" ? "削除" : "更新"}`,
      p_data: {},
      p_dedupe_minutes: 0,
    }).catch(() => null);
    return ok();
  },

  async profile_get(ctx) {
    const v = await ctx.deps.db.getConfigValue("interest_profile");
    const p = isObj(v) ? v : {};
    return ok({
      version: toInt(p.version) ?? 0,
      status: p.status === "approved" ? "approved" : "draft",
      text: typeof p.text === "string" ? p.text : "",
    });
  },

  async profile_set(ctx, req) {
    if (typeof req.text !== "string" || typeof req.approve !== "boolean") return err(400, "bad_request");
    const text = req.text.trim();
    const len = [...text].length;
    if (len === 0 || len > 600) return err(400, "invalid_value", { key: "text" });
    const bad = await reauth(ctx, req.passphrase);
    if (bad) return bad;
    const old = await ctx.deps.db.getConfigValue("interest_profile");
    const ov = isObj(old) ? (toInt(old.version) ?? 0) : 0;
    const value = { version: ov + 1, status: req.approve ? "approved" : "draft", text };
    await ctx.deps.db.setConfig("interest_profile", old, value, "admin");
    return ok({ version: value.version, status: value.status });
  },

  async ops_events(ctx, req) {
    const l = req.limit === undefined ? 50 : toInt(req.limit);
    if (l === null || l < 1) return err(400, "bad_request");
    const ev = await ctx.deps.db.opsEvents(Math.min(l, 200));
    return ok({
      events: ev.map((e) => ({
        id: e.id ?? null,
        at: e.at ?? null,
        level: e.level ?? null,
        kind: e.kind ?? null,
        message: e.message ?? null,
        suppressed: !!e.suppressed,
      })),
    });
  },
};

export const ACTIONS = ["setup", "login", "me", ...Object.keys(HANDLERS)];

export async function handleAdmin(deps: AdminDeps, token: string | null, raw: unknown): Promise<AdminResponse> {
  if (!isObj(raw) || typeof raw.action !== "string") return err(400, "bad_request");
  const action = raw.action;
  const now = deps.now();
  const row = await deps.db.getAuth();
  const ctx: Ctx | null = row ? { deps, row, now } : null;

  // ---- 認証前 ----
  if (action === "setup") {
    if (!ctx) return err(409, "setup_unavailable");
    const w = waitResponse(ctx);
    if (w) return w;
    if (ctx.row.setup_done) return err(409, "setup_done");
    const shape = deps.auth.validatePassphraseShape(raw.passphrase);
    if (shape !== "ok") return err(400, shape === "too_short" ? "passphrase_too_short" : "invalid_passphrase");
    const st = await deps.auth.checkSetupCode(raw.setup_code, ctx.row, now);
    if (st === "invalid" || st === "not_issued") {
      const left = await recordFailure(ctx);
      return err(401, "setup_code_invalid", left > 0 ? { retry_after: left } : {});
    }
    if (st === "expired") return err(400, "setup_code_expired");
    if (st === "done") return err(409, "setup_done");
    const codeHash = await deps.auth.hashSetupCode(raw.setup_code);
    if (!codeHash) return err(401, "setup_code_invalid");
    const h = await deps.auth.hashPassphrase(raw.passphrase as string);
    const done = await deps.db.completeSetup(codeHash, {
      salt: h.salt,
      hash: h.hash,
      iterations: h.iterations,
      setup_done: true,
      setup_code_hash: null,
      setup_code_expires_at: null,
      failed_count: 0,
      last_failed_at: null,
      set_at: new Date(now).toISOString(),
    });
    if (!done) return err(409, "setup_done");
    const t = await deps.auth.signToken(deps.tokenKey, ctx.row.key_version || 1, now);
    return ok({ token: t });
  }

  if (action === "login") {
    if (!ctx || !ctx.row.setup_done) return err(400, "setup_required");
    const w = waitResponse(ctx);
    if (w) return w;
    if (typeof raw.passphrase !== "string" || raw.passphrase.length === 0) return err(400, "passphrase_required");
    const good = await deps.auth.verifyPassphrase(raw.passphrase, ctx.row);
    if (!good) {
      const left = await recordFailure(ctx);
      return err(401, PASSPHRASE_REAUTH_ERROR, left > 0 ? { retry_after: left } : {});
    }
    await resetFailures(ctx);
    return ok({ token: await deps.auth.signToken(deps.tokenKey, ctx.row.key_version || 1, now) });
  }

  // ---- 以降は x-admin-token 必須(meだけは未認証でも setup_done を返す) ----
  let verified: { ok: boolean; refresh?: boolean } = { ok: false };
  if (ctx && ctx.row.setup_done && token) {
    verified = await deps.auth.verifyToken(deps.tokenKey, token, ctx.row.key_version || 1, now);
  }

  if (action === "me") {
    const setupDone = !!(ctx && ctx.row.setup_done);
    if (!verified.ok) return ok({ authed: false, setup_done: setupDone });
    const body: Record<string, unknown> = { authed: true, setup_done: true, key_version: ctx!.row.key_version };
    if (verified.refresh) body.token = await deps.auth.signToken(deps.tokenKey, ctx!.row.key_version, now);
    return ok(body);
  }

  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
  if (!handler) return err(400, "unknown_action");
  if (!ctx || !ctx.row.setup_done) return err(401, "setup_required");
  if (!verified.ok) return err(401, "invalid_token");

  const out = await handler(ctx, raw);
  // 使うたびに残り29日未満なら新トークンを返す(change_passphraseは自前で発行済み)
  if (out.body.ok === true && out.body.token === undefined && verified.refresh) {
    out.body.token = await deps.auth.signToken(deps.tokenKey, ctx.row.key_version || 1, now);
  }
  return out;
}
