// Supabase REST / RPC の最小限のインメモリ・モック(結合試験用)。
// 対応: /rest/v1/<table> の GET/HEAD/POST(insert・upsert)/PATCH/DELETE と、PostgREST のフィルタ
//   eq neq gt gte lt lte is in not.<op> or=(...) 、order、limit、select(列の絞り込み)、
//   Prefer: count=exact / return=representation / resolution=ignore-duplicates|merge-duplicates、
//   Accept: application/vnd.pgrst.object+json(single)。
// /rest/v1/rpc/<fn> は契約(CONTRACT.md)のRPCのうち、各関数が呼ぶものをTSで再現する。
// 区分確定(finalize_tiers)・費用ガード(cost_guard)などの中身は本番SQLの簡易版(つながりの確認用)。

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

const SERIAL_TABLES = new Set([
  "llm_usage", "ops_events", "tuning_config_history", "score_runs", "x_posts", "news_articles", "score_labels",
  "ti_video_transcripts",
]);
const PKS: Record<string, string[]> = {
  tuning_config: ["key"], admin_ops: ["op_id"], admin_auth: ["id"], model_config: ["model"], model_state: ["id"],
  digest_daily: ["day"], digest_week: ["week_start"], digest_summaries: ["list_name", "period_type"],
};
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

export interface Req { method: string; path: string; query: string; body: unknown; status: number }

function cmp(a: unknown, b: string): number {
  const na = typeof a === "number" ? a : (typeof a === "string" && /^-?\d+(\.\d+)?$/.test(a) ? Number(a) : NaN);
  const nb = /^-?\d+(\.\d+)?$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const iso = /^\d{4}-\d{2}-\d{2}/;
  if (typeof a === "string" && iso.test(a) && iso.test(b)) return Date.parse(a) - Date.parse(b);
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function unq(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

function evalOp(val: unknown, op: string, arg: string): boolean {
  switch (op) {
    case "eq": return val !== null && val !== undefined && String(val) === arg;
    case "neq": return !(val !== null && val !== undefined && String(val) === arg);
    case "gt": return val != null && cmp(val, arg) > 0;
    case "gte": return val != null && cmp(val, arg) >= 0;
    case "lt": return val != null && cmp(val, arg) < 0;
    case "lte": return val != null && cmp(val, arg) <= 0;
    case "is": return arg === "null" ? val == null : arg === "true" ? val === true : arg === "false" ? val === false : false;
    case "in": {
      const list = splitTop(arg.replace(/^\(|\)$/g, "")).map(unq);
      return val != null && list.includes(String(val));
    }
    default: throw new Error(`mock: unsupported operator ${op}`);
  }
}

// "col.op.arg" / "not.col..." ではなく、cond = "col.op.arg" or "col.not.op.arg" or "and(...)"/"or(...)"
function evalCond(row: Row, cond: string): boolean {
  const m = cond.match(/^(and|or)\((.*)\)$/);
  if (m) {
    const parts = splitTop(m[2]).map((c) => evalCond(row, c));
    return m[1] === "and" ? parts.every(Boolean) : parts.some(Boolean);
  }
  const i = cond.indexOf(".");
  const col = cond.slice(0, i);
  let rest = cond.slice(i + 1);
  let neg = false;
  if (rest.startsWith("not.")) { neg = true; rest = rest.slice(4); }
  const j = rest.indexOf(".");
  const r = evalOp(row[col], rest.slice(0, j), rest.slice(j + 1));
  return neg ? !r : r;
}

export function matchFilters(row: Row, params: [string, string][]): boolean {
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    if (k === "or") {
      if (!evalCond(row, `or${v}`)) return false;
      continue;
    }
    if (k === "and") {
      if (!evalCond(row, `and${v}`)) return false;
      continue;
    }
    let op = v, neg = false;
    if (op.startsWith("not.")) { neg = true; op = op.slice(4); }
    const j = op.indexOf(".");
    const r = evalOp(row[k], op.slice(0, j), op.slice(j + 1));
    if (neg ? r : !r) return false;
  }
  return true;
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const keys = order.split(",").map((o) => {
    const [col, dir] = o.split(".");
    return { col, desc: dir === "desc" };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const x = a[col], y = b[col];
      if (x === y) continue;
      if (x == null) return desc ? -1 : 1; // PGの既定: NULLは最大扱い
      if (y == null) return desc ? 1 : -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : cmp(x, String(y));
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });
}

function project(row: Row, select: string | null): Row {
  if (!select || select === "*") return { ...row };
  const out: Row = {};
  for (const c of splitTop(select).map((s) => s.trim()).filter(Boolean)) {
    if (c === "*") Object.assign(out, row);
    else out[c] = row[c] ?? null;
  }
  return out;
}

const jstMonthStart = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

export class MockSupabase {
  tables: Record<string, Row[]> = {};
  secrets = new Map<string, string>();
  locks = new Map<string, { owner: string; until: number }>();
  serial: Record<string, number> = {};
  modelState = { current_model: "gemini-2.5-flash", candidates: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-flash"], gone_streak: 0 };
  requests: Req[] = [];
  rpcCalls: { name: string; args: Row }[] = [];
  serviceKey = "service-role-key-for-tests";
  server!: Deno.HttpServer;
  url = "";
  // テストからの故障注入: 次のN回のRPC名に対しエラーを返す
  failRpc = new Map<string, number>();

  async start(): Promise<void> {
    this.server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => this.handle(req));
    this.url = `http://127.0.0.1:${(this.server.addr as Deno.NetAddr).port}`;
  }
  async stop(): Promise<void> {
    await this.server.shutdown();
  }

  // ---- 状態の初期化 ----
  reset(): void {
    this.tables = {};
    this.secrets.clear();
    this.locks.clear();
    this.serial = {};
    this.requests = [];
    this.rpcCalls = [];
    this.failRpc.clear();
    this.modelState = { current_model: "gemini-2.5-flash", candidates: ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-flash"], gone_streak: 0 };
    const cfg: Record<string, unknown> = {
      usd_jpy: 150, monthly_cap_jpy: 4000, daily_cap_jpy: 400, hourly_call_cap: 600, ti_daily_call_cap: 500,
      cap_warn_ratio: 0.8, cap_stop_extra_ratio: 1.0, cap_stop_all_ratio: 1.3,
      pipeline_auth_mode: "log", kill_switch: false, score_enabled: true, tier_assign_enabled: true,
      listen_threshold: 4, speech_enabled: true, speech_max_per_run: 5, backfill_enabled: false, cap_opinion: false,
      tier_scope_from: "2026-01-01T00:00:00Z", digest_min_new_scored: 2, digest_min_interval_hours: 6,
      interest_profile: { version: 1, status: "approved", text: "W1: AI全般の新発表と実践" },
    };
    for (const [key, value] of Object.entries(cfg)) this.insert("tuning_config", { key, value, updated_at: new Date().toISOString() });
    this.secrets.set("xd_pipeline_secret_cron", "cron-secret-aaaaaaaaaaaa");
    this.secrets.set("xd_pipeline_secret_win", "win-secret-bbbbbbbbbbbb");
    this.secrets.set("xd_admin_token_key", "admin-token-signing-key-0123456789abcdef");
    this.secrets.set("xd_ntfy_topic", "xd-test-topic-123");
    for (const [m, enabled] of [["gemini-2.5-flash", true], ["gemini-3.5-flash", true], ["gemini-3.1-flash", false]] as const) {
      this.insert("model_config", { model: m, gen_config: { default: {} }, enabled, note: null, verified_at: null });
    }
    this.insert("llm_prices", { model: "gemini-2.5-flash", in_usd: 0.3, out_usd: 2.5 });
    this.insert("model_state", { id: 1, last_switch_at: null, last_health: null, last_health_at: null });
  }

  insert(table: string, row: Row): Row {
    const t = (this.tables[table] ??= []);
    const r: Row = { ...row };
    if (SERIAL_TABLES.has(table) && r.id === undefined) r.id = this.serial[table] = (this.serial[table] ?? 0) + 1;
    if (table === "llm_usage" && r.called_at === undefined) r.called_at = new Date().toISOString();
    if (table === "tuning_config_history" && r.at === undefined) r.at = new Date().toISOString();
    t.push(r);
    return r;
  }
  rows(table: string): Row[] {
    return this.tables[table] ??= [];
  }
  cfg(key: string, def: unknown = null): unknown {
    const r = this.rows("tuning_config").find((x) => x.key === key);
    return r ? r.value : def;
  }
  setCfg(key: string, value: unknown): void {
    const r = this.rows("tuning_config").find((x) => x.key === key);
    if (r) r.value = value; else this.insert("tuning_config", { key, value });
  }
  modelConfigs(): Row {
    const out: Row = {};
    for (const mc of this.rows("model_config")) {
      const p = this.rows("llm_prices").find((x) => x.model === mc.model);
      out[mc.model] = { gen_config: mc.gen_config, enabled: mc.enabled, in_usd: p?.in_usd ?? null, out_usd: p?.out_usd ?? null };
    }
    return out;
  }

  addPost(p: Row): Row {
    const n = (this.serial.x_posts ?? 0) + 1;
    return this.insert("x_posts", {
      list_name: "FollowList-AI", author_handle: `user${n}`, author_name: `User ${n}`, content: "", post_url: `https://x.com/user${n}/status/${1000 + n}`,
      posted_at: new Date().toISOString(), fetched_at: new Date().toISOString(), is_starred: false, is_read: false,
      summary: null, gist: null, summarized_at: null, tags: null, image_urls: [], score: null, score_state: null,
      score_attempts: 0, dup_key: null, listen_tier: null, speech_body: null, speech_at: null, manual_action: null, ...p,
    });
  }

  // ---- HTTP ----
  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const log: Req = { method: req.method, path: u.pathname, query: u.search, body: null, status: 0 };
    this.requests.push(log);
    const done = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      log.status = status;
      const h = new Headers({ "Content-Type": "application/json", ...headers });
      return new Response(body === undefined || req.method === "HEAD" ? null : JSON.stringify(body), { status, headers: h });
    };
    const key = req.headers.get("apikey") ?? "";
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (key !== this.serviceKey && bearer !== this.serviceKey) {
      return done(401, { message: "Invalid API key", code: "401" });
    }
    const m = u.pathname.match(/^\/rest\/v1\/(.+)$/);
    if (!m) return done(404, { message: "not found" });
    let body: unknown = null;
    if (req.method === "POST" || req.method === "PATCH") {
      const text = await req.text();
      body = text ? JSON.parse(text) : null;
      log.body = body;
    }
    const rest = m[1];
    try {
      if (rest.startsWith("rpc/")) {
        const name = rest.slice(4);
        const args = (body ?? {}) as Row;
        this.rpcCalls.push({ name, args });
        const left = this.failRpc.get(name) ?? 0;
        if (left > 0) {
          this.failRpc.set(name, left - 1);
          return done(500, { message: `injected failure for ${name}`, code: "XX000" });
        }
        const out = this.rpc(name, args);
        if (out === undefined) return done(404, { message: `Could not find the function public.${name}`, code: "PGRST202" });
        return done(200, out === undefined ? null : out);
      }
      return this.table(req, u, rest, body, done);
    } catch (e) {
      return done(400, { message: (e as Error).message, code: "MOCK" });
    }
  }

  private table(
    req: Request,
    u: URL,
    table: string,
    body: unknown,
    done: (s: number, b?: unknown, h?: Record<string, string>) => Response,
  ): Response {
    const params = [...u.searchParams.entries()] as [string, string][];
    const select = u.searchParams.get("select");
    const prefer = req.headers.get("prefer") ?? "";
    const wantRep = prefer.includes("return=representation");
    const single = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const t = this.rows(table);

    const reply = (rows: Row[], status: number, total?: number) => {
      const headers: Record<string, string> = {};
      if (prefer.includes("count=exact")) {
        const tot = total ?? rows.length;
        headers["Content-Range"] = rows.length > 0 ? `0-${rows.length - 1}/${tot}` : `*/${tot}`;
      }
      if (single) {
        if (rows.length !== 1) {
          return done(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows` });
        }
        return done(status, project(rows[0], select), headers);
      }
      return done(status, rows.map((r) => project(r, select)), headers);
    };

    if (req.method === "GET" || req.method === "HEAD") {
      let rows = t.filter((r) => matchFilters(r, params));
      const total = rows.length;
      rows = sortRows(rows, u.searchParams.get("order"));
      const off = Number(u.searchParams.get("offset") ?? 0);
      const lim = u.searchParams.get("limit");
      rows = rows.slice(off, lim ? off + Number(lim) : undefined);
      if (req.method === "HEAD") return reply([], 200, total);
      return reply(rows, 200, total);
    }
    if (req.method === "POST") {
      const list = (Array.isArray(body) ? body : [body]) as Row[];
      const onConflict = u.searchParams.get("on_conflict");
      const isUpsert = prefer.includes("resolution=");
      const ignore = prefer.includes("ignore-duplicates");
      const keys = onConflict ? onConflict.split(",") : PKS[table] ?? [];
      const out: Row[] = [];
      for (const r of list) {
        if (isUpsert && keys.length) {
          const ex = t.find((x) => keys.every((k) => x[k] === r[k]));
          if (ex) {
            if (!ignore) { Object.assign(ex, r); out.push(ex); }
            continue;
          }
        } else if (keys.length && PKS[table] && t.some((x) => PKS[table].every((k) => x[k] === r[k]))) {
          return done(409, { code: "23505", message: `duplicate key value violates unique constraint on ${table}` });
        }
        out.push(this.insert(table, r));
      }
      return wantRep ? reply(out, 201) : done(201);
    }
    if (req.method === "PATCH") {
      const hit = t.filter((r) => matchFilters(r, params));
      for (const r of hit) Object.assign(r, body as Row);
      return wantRep ? reply(hit, 200) : done(204);
    }
    if (req.method === "DELETE") {
      const hit = new Set(t.filter((r) => matchFilters(r, params)));
      this.tables[table] = t.filter((r) => !hit.has(r));
      return wantRep ? reply([...hit], 200) : done(204);
    }
    return done(405, { message: "method not allowed" });
  }

  // ---- RPC ----
  // 戻り値 undefined = 関数が無い(404)。void は null を返す。
  rpc(name: string, a: Row): unknown {
    const nowMs = Date.now();
    switch (name) {
      case "get_secret": {
        if (!String(a.p_name).startsWith("xd_")) throw new Error("name must start with xd_");
        return this.secrets.get(a.p_name) ?? null;
      }
      case "set_secret": {
        if (!String(a.p_name).startsWith("xd_")) throw new Error("name must start with xd_");
        this.secrets.set(a.p_name, String(a.p_value ?? ""));
        return null;
      }
      case "cfg": return this.cfg(a.p_key, a.p_default ?? null);
      case "cfg_num": {
        const n = Number(this.cfg(a.p_key, a.p_default));
        return Number.isFinite(n) ? n : a.p_default;
      }
      case "cfg_bool": return this.cfg(a.p_key, a.p_default) === true;
      case "get_model_state":
        return { ...this.modelState, configs: this.modelConfigs(), usd_jpy: Number(this.cfg("usd_jpy", 150)) };
      case "model_report_ok": {
        if (a.p_model === this.modelState.current_model) this.modelState.gone_streak = 0;
        return null;
      }
      case "model_report_gone": {
        const st = this.modelState;
        if (a.p_model !== st.current_model) return { current_model: st.current_model, switched: false, stale: true, streak: st.gone_streak };
        st.gone_streak++;
        if (st.gone_streak >= 3) {
          const next = st.candidates.find((c) => c !== st.current_model && this.modelConfigs()[c]?.enabled === true);
          if (next) {
            st.current_model = next;
            st.gone_streak = 0;
            const ms = this.rows("model_state").find((r) => r.id === 1);
            if (ms) ms.last_switch_at = new Date().toISOString();
            return { current_model: next, switched: true, streak: 0 };
          }
        }
        return { current_model: st.current_model, switched: false, streak: st.gone_streak };
      }
      case "model_set_current": {
        this.modelState.current_model = a.p_model;
        return null;
      }
      case "cost_guard": return this.costGuard(a.p_purpose, a.p_grp, nowMs);
      case "ops_event": {
        const dedupe = Number(a.p_dedupe_minutes ?? 0);
        const recent = this.rows("ops_events").find((e) =>
          e.kind === a.p_kind && dedupe > 0 && nowMs - Date.parse(e.at) < dedupe * 60_000
        );
        if (recent) { recent.suppressed_count = (recent.suppressed_count ?? 0) + 1; return null; }
        const r = this.insert("ops_events", { at: new Date(nowMs).toISOString(), level: a.p_level, kind: a.p_kind, message: a.p_message, data: a.p_data ?? {}, suppressed: false });
        return r.id;
      }
      case "lock_acquire": {
        const cur = this.locks.get(a.p_name);
        if (cur && cur.until > nowMs && cur.owner !== a.p_owner) return false;
        this.locks.set(a.p_name, { owner: a.p_owner, until: nowMs + Number(a.p_seconds) * 1000 });
        return true;
      }
      case "lock_release": {
        const cur = this.locks.get(a.p_name);
        if (cur && cur.owner === a.p_owner) this.locks.delete(a.p_name);
        return null;
      }
      case "finalize_tiers": return this.finalizeTiers(a.p_force === true);
      case "refresh_cost_monthly": return this.refreshCostMonthly(nowMs);
      case "notify_test": return this.secrets.get("xd_ntfy_topic") ? true : null;
      case "create_label_list": {
        const n = Number(a.p_n);
        const last = Math.max(0, ...this.rows("score_labels").map((r) => Number(r.list_no ?? 0)));
        const pool = this.rows("x_posts").filter((p) => p.summary).slice(0, n);
        pool.forEach((p, i) => this.insert("score_labels", {
          list_no: last + 1, slot: i % 3, post_url: p.post_url, author_handle: p.author_handle, content: p.content, summary: p.summary,
          image_urls: p.image_urls ?? [], inclusion_prob: 0.5, ai_score: p.score ?? 3, ai_kind: "news", ai_model: "gemini-2.5-flash",
          profile_version: 1, label_score: null, label_class: null, labeled_at: null,
        }));
        return [{ list_no: last + 1, created: pool.length }];
      }
      case "author_scoreboard": return [];
      default: return undefined;
    }
  }

  costGuard(purpose: string, grp: string, nowMs: number): Row {
    const usd = Number(this.cfg("usd_jpy", 150));
    const monthStart = jstMonthStart(nowMs);
    const usage = this.rows("llm_usage");
    const inMonth = usage.filter((u) => jstMonthStart(Date.parse(u.called_at ?? new Date(nowMs).toISOString())) === monthStart);
    const monthJpy = inMonth.reduce((s, u) => s + Number(u.cost_usd ?? 0), 0) * usd;
    const day = usage.filter((u) => u.grp === "x" && nowMs - Date.parse(u.called_at ?? new Date(nowMs).toISOString()) < 86400_000);
    const dayJpy = day.reduce((s, u) => s + Number(u.cost_usd ?? 0), 0) * usd;
    const calls1h = usage.filter((u) => nowMs - Date.parse(u.called_at ?? new Date(nowMs).toISOString()) < 3600_000).length;
    const cap = Number(this.cfg("monthly_cap_jpy", 4000));
    const dayCap = Number(this.cfg("daily_cap_jpy", 400));
    let level = "ok";
    if (monthJpy >= cap * Number(this.cfg("cap_warn_ratio", 0.8))) level = "warn";
    let allowed = true;
    if (this.cfg("kill_switch", false) === true) { allowed = false; level = "kill"; }
    else if (monthJpy >= cap * Number(this.cfg("cap_stop_extra_ratio", 1))) { allowed = false; level = "stop"; }
    else if (dayJpy >= dayCap) { allowed = false; level = "day_cap"; }
    else if (calls1h >= Number(this.cfg("hourly_call_cap", 600))) { allowed = false; level = "hourly_cap"; }
    else if (grp === "ti") {
      const ti = usage.filter((u) => u.grp === "ti" && nowMs - Date.parse(u.called_at ?? new Date(nowMs).toISOString()) < 86400_000).length;
      if (ti >= Number(this.cfg("ti_daily_call_cap", 500))) { allowed = false; level = "ti_cap"; }
    }
    return { allowed, level, month_jpy: monthJpy, day_jpy: dayJpy, cap_jpy: cap, calls_1h: calls1h };
  }

  finalizeTiers(force: boolean): Row {
    const thr = Number(this.cfg("listen_threshold", 4));
    const now = new Date().toISOString();
    let listen = 0, skim = 0, hold = 0;
    for (const p of this.rows("x_posts")) {
      if (p.listen_tier || p.score == null || (p.score_state !== "scored" && p.score_state !== "rule")) continue;
      const tier = p.score >= thr ? "listen" : p.score >= 3 ? "skim" : "hold";
      p.listen_tier = tier;
      p.tier_initial = tier;
      p.tier_reason = "score";
      p.tier_assigned_at = now;
      p.threshold_version = 1;
      if (tier === "listen") listen++; else if (tier === "skim") skim++; else hold++;
    }
    const n = listen + skim + hold;
    return { batches: n === 0 ? [] : [{ batch: "mock-batch-1", slot: "am", n, listen, skim, hold, alloc_sec: 0, used_sec: 0, forced: force }] };
  }

  refreshCostMonthly(nowMs: number): null {
    const usd = Number(this.cfg("usd_jpy", 150));
    const month = jstMonthStart(nowMs);
    const agg = new Map<string, Row>();
    for (const u of this.rows("llm_usage")) {
      if (jstMonthStart(Date.parse(u.called_at ?? new Date(nowMs).toISOString())) !== month) continue;
      const k = `${u.grp}|${u.purpose}|${u.model}`;
      const e = agg.get(k) ?? { month, grp: u.grp, purpose: u.purpose, model: u.model, calls: 0, cost_usd: 0, cost_jpy: 0, finalized: false };
      e.calls++;
      e.cost_usd += Number(u.cost_usd ?? 0);
      e.cost_jpy = e.cost_usd * usd;
      agg.set(k, e);
    }
    this.tables.llm_cost_monthly = [...(this.tables.llm_cost_monthly ?? []).filter((r) => r.month !== month), ...agg.values()];
    return null;
  }
}
