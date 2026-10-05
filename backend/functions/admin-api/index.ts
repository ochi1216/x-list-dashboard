// admin-api: 管理画面用API(setup/login/ラベル/区分変更/設定/レポート/費用/通知)
// デプロイ時は _shared/adminauth.ts を ./_adminauth.ts としてコピーする(backend/build.sh)。
// 分岐ロジックは ./logic.ts(外部依存なし・Nodeでテスト済み)。ここは supabase-js と Deno だけを扱う薄い層。
// 秘密(パスフレーズ・トークン・署名鍵・Vault値)と例外全文はログにもレスポンスにも出さない。
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as auth from "./_adminauth.ts";
import { handleAdmin } from "./logic.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-admin-token, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// deno-lint-ignore no-explicit-any
type Any = any;

function fail(): never {
  // 詳細(error.message)は意図的に捨てる: DBエラー文に値が混ざり得るため
  throw new Error("db");
}

const db = {
  async rpc(name: string, args?: Record<string, unknown>) {
    const { data, error } = await supabase.rpc(name, args ?? {});
    return { data: data as unknown, error: error ? { message: "rpc_error" } : null };
  },
  async getAuth() {
    const { data, error } = await supabase.from("admin_auth").select("*").eq("id", 1).maybeSingle();
    if (error) fail();
    return (data as Any) ?? null;
  },
  async updateAuth(patch: Record<string, unknown>) {
    const { error } = await supabase.from("admin_auth").update(patch).eq("id", 1);
    if (error) fail();
  },
  async completeSetup(codeHash: string, patch: Record<string, unknown>) {
    const { data, error } = await supabase.from("admin_auth").update(patch).eq("id", 1).eq("setup_done", false)
      .eq("setup_code_hash", codeHash).select("id");
    if (error) fail();
    return (data ?? []).length > 0;
  },
  async claimOp(opId: string, kind: string) {
    const { data, error } = await supabase.from("admin_ops")
      .upsert({ op_id: opId, kind }, { onConflict: "op_id", ignoreDuplicates: true }).select("op_id");
    if (error) fail();
    if ((data ?? []).length > 0) return { inserted: true, result: null };
    const prev = await supabase.from("admin_ops").select("result").eq("op_id", opId).maybeSingle();
    return { inserted: false, result: (prev.data as Any)?.result ?? null };
  },
  async finishOp(opId: string, result: unknown) {
    await supabase.from("admin_ops").update({ result }).eq("op_id", opId);
  },
  async releaseOp(opId: string) {
    await supabase.from("admin_ops").delete().eq("op_id", opId);
  },
  async updatePost(postUrl: string, patch: Record<string, unknown>) {
    const { data, error } = await supabase.from("x_posts").update(patch).eq("post_url", postUrl).select("id");
    if (error) fail();
    return (data ?? []).length > 0;
  },
  async getConfigRows() {
    const { data, error } = await supabase.from("tuning_config").select("key,value");
    if (error) fail();
    return (data ?? []) as { key: string; value: unknown }[];
  },
  async getConfigValue(key: string) {
    const { data, error } = await supabase.from("tuning_config").select("value").eq("key", key).maybeSingle();
    if (error) fail();
    return (data as Any)?.value ?? null;
  },
  async setConfig(key: string, oldValue: unknown, newValue: unknown, source: string) {
    const up = await supabase.from("tuning_config")
      .upsert({ key, value: newValue, updated_at: new Date().toISOString(), updated_by: "admin" }, { onConflict: "key" });
    if (up.error) fail();
    const h = await supabase.from("tuning_config_history")
      .insert({ key, old_value: oldValue, new_value: newValue, source }).select("id").single();
    if (h.error) fail();
    return ((h.data as Any)?.id ?? null) as number | null;
  },
  async getHistory(id: number) {
    const { data, error } = await supabase.from("tuning_config_history").select("id,key,old_value,new_value")
      .eq("id", id).maybeSingle();
    if (error) fail();
    return (data as Any) ?? null;
  },
  async latestListNo() {
    const { data, error } = await supabase.from("score_labels").select("list_no").not("list_no", "is", null)
      .order("list_no", { ascending: false }).limit(1);
    if (error) fail();
    return (data ?? []).length ? ((data as Any)[0].list_no as number) : null;
  },
  async labelRows(listNo: number) {
    // 盲検: ai_*・author_handle・slot・inclusion_prob はそもそも取得しない
    const { data, error } = await supabase.from("score_labels")
      .select("id,content,summary,image_urls,label_score").eq("list_no", listNo).order("id").limit(500);
    if (error) fail();
    return (data ?? []) as Any[];
  },
  async labelSubmit(id: number, score: number, cls: string, nowIso: string) {
    const { data, error } = await supabase.from("score_labels")
      .update({ label_score: score, label_class: cls, labeled_at: nowIso }).eq("id", id).select("list_no");
    if (error) fail();
    if (!(data ?? []).length) return { found: false, list_no: null };
    return { found: true, list_no: ((data as Any)[0].list_no ?? null) as number | null };
  },
  async weekReport(weekStart: string | null) {
    let q = supabase.from("weekly_reports").select("week_start,body,text_ja");
    q = weekStart ? q.eq("week_start", weekStart) : q.order("week_start", { ascending: false }).limit(1);
    const { data, error } = await q;
    if (error) fail();
    return ((data ?? [])[0] as Any) ?? null;
  },
  async costMonthly(fromMonth: string) {
    const { data, error } = await supabase.from("llm_cost_monthly")
      .select("month,grp,purpose,model,calls,cost_usd,cost_jpy,finalized").gte("month", fromMonth).limit(5000);
    if (error) fail();
    return (data ?? []) as Any[];
  },
  async recentErrors(limit: number) {
    const { data, error } = await supabase.from("llm_usage").select("called_at,fn,purpose,model,http_status,status,error")
      .eq("status", "error").order("called_at", { ascending: false }).limit(limit);
    if (error) fail();
    return (data ?? []) as Any[];
  },
  async modelLastSwitchAt() {
    const { data } = await supabase.from("model_state").select("last_switch_at").eq("id", 1).maybeSingle();
    return ((data as Any)?.last_switch_at ?? null) as string | null;
  },
  async opsEvents(limit: number) {
    const { data, error } = await supabase.from("ops_events").select("id,at,level,kind,message,suppressed")
      .order("id", { ascending: false }).limit(limit);
    if (error) fail();
    return (data ?? []) as Any[];
  },
};

// 署名鍵(Vault)は60秒だけメモリにキャッシュ
let keyCache: { v: string; at: number } | null = null;
async function getTokenKey(): Promise<string | null> {
  const now = Date.now();
  if (keyCache && now - keyCache.at < 60_000) return keyCache.v;
  const { data, error } = await supabase.rpc("get_secret", { p_name: "xd_admin_token_key" });
  if (error || typeof data !== "string" || data.length < 16) return null;
  keyCache = { v: data, at: now };
  return data;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 64 * 1024) return json(413, { ok: false, error: "too_large" });
    body = JSON.parse(text);
  } catch (_e) {
    return json(400, { ok: false, error: "bad_request" });
  }

  const action = typeof (body as Any)?.action === "string" ? String((body as Any).action).slice(0, 40) : "?";
  try {
    const tokenKey = await getTokenKey();
    if (!tokenKey) return json(503, { ok: false, error: "server_not_ready" });
    const r = await handleAdmin({ db: db as Any, auth: auth as Any, tokenKey, now: () => Date.now() },
      req.headers.get("x-admin-token"), body);
    const extra: Record<string, string> = {};
    if (r.status === 429 && typeof r.body.retry_after === "number") extra["Retry-After"] = String(r.body.retry_after);
    return json(r.status, r.body, extra);
  } catch (e) {
    // 例外全文は出さない(種類だけ)
    console.error("admin-api error", action, e instanceof Error ? e.name : "unknown");
    return json(500, { ok: false, error: "server_error" });
  }
});
