import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callGemini, makeGeminiDb, resolveGeminiBase } from "./_gemini.ts";
import type { GeminiCtx } from "./_gemini.ts";
import { checkPipelineAuth } from "./_auth.ts";
import { runLegacy } from "./logic.ts";
import { runToday, runWeek, safeErr } from "./_digest.ts";
import type { Card, DailyRow, DigestDeps, WeekRow } from "./_digest.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  // X専用キーがあればそれを使う(TI系と費用・上限を分けるため)
  const geminiKey = Deno.env.get("GEMINI_API_KEY_X") || Deno.env.get("GEMINI_API_KEY");

  let body: { period_type?: string; list_name?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const periodType = body.period_type;
  const isNew = periodType === "today" || periodType === "week";
  if (periodType !== "last_run" && periodType !== "24h" && periodType !== "7d" && !isNew) {
    return json({ ok: false, error: "period_type must be one of last_run, 24h, 7d" }, 400);
  }

  // GeminiDb: contract の { rpc, insertUsage }
  const db = makeGeminiDb(supabase);

  // 新モード(today/week)はcron専用: mode に関わらず秘密必須
  if (isNew) {
    const auth = await checkPipelineAuth(req, { db, mode: "enforce", allow: ["cron"], fn: "generate-digest-summary" });
    if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);
  }

  // 旧3モード: log中は秘密なしでも可(ただし制限付き)、enforce なら秘密必須
  let legacyLimited = false;
  if (!isNew) {
    const modeRes = await db.rpc("cfg", { p_key: "pipeline_auth_mode", p_default: "log" });
    const mode = !modeRes.error && modeRes.data === "log" ? "log" : "enforce"; // 取得失敗・不明な値は安全側
    const auth = await checkPipelineAuth(req, { db, mode, allow: ["cron", "none"], fn: "generate-digest-summary" });
    if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);
    legacyLimited = auth.limited;
  }

  if (!geminiKey) {
    return json({
      ok: false,
      error: "GEMINI_API_KEY secret is not set on this Supabase project. Add it under Edge Functions > Secrets.",
    }, 500);
  }

  const batchId = crypto.randomUUID();
  const ctx: GeminiCtx = {
    db, apiKey: geminiKey, fn: "generate-digest-summary", grp: "x", batchId,
    baseUrl: resolveGeminiBase(Deno.env.get("GEMINI_BASE_URL")),
    timeoutMs: 30_000,
  };

  if (isNew) {
    // 同じモードの二重実行を防ぐ(同時に走ると同じ生成に二重で費用がかかる)。owner=batchId
    const lockName = `generate-digest-summary:${periodType}`;
    const lk = await db.rpc("lock_acquire", { p_name: lockName, p_seconds: 170, p_owner: batchId });
    if (lk.error) return json({ ok: false, error: "lock_error" }, 500);
    if (lk.data !== true) return json({ ok: true, skipped: true, reason: "busy" });
    try {
      const deps: DigestDeps = {
        now: () => Date.now(),
        gen: async (r) => {
          const res = await callGemini(ctx, r);
          if (res.ok) return { ok: true, text: res.text, json: res.json, model: res.model };
          return { ok: false, kind: res.kind, error: res.error, status: res.status, model: res.model };
        },
        cfgNum: async (key, def) => {
          const { data } = await db.rpc("cfg_num", { p_key: key, p_default: def });
          const n = Number(data);
          return Number.isFinite(n) ? n : def;
        },
        loadCards: async (startIso, endIso) => {
          const { data, error } = await supabase
            .from("x_posts")
            .select("post_url, gist, summary, content, score, scored_at, fetched_at, image_urls")
            .gte("score", 3)
            .gte("fetched_at", startIso)
            .lt("fetched_at", endIso)
            .order("score", { ascending: false })
            .limit(500);
          if (error) throw new Error(error.message);
          return (data ?? []) as Card[];
        },
        getDaily: async (day) => {
          const { data, error } = await supabase.from("digest_daily").select("*").eq("day", day).maybeSingle();
          if (error) throw new Error(error.message);
          return (data ?? null) as DailyRow | null;
        },
        listDaily: async (from, to) => {
          const { data, error } = await supabase.from("digest_daily").select("*").gte("day", from).lte("day", to);
          if (error) throw new Error(error.message);
          return (data ?? []) as DailyRow[];
        },
        upsertDaily: async (row) => {
          const { error } = await supabase.from("digest_daily").upsert(row, { onConflict: "day" });
          if (error) throw new Error(`upsert failed: ${error.message}`);
        },
        getWeek: async (ws) => {
          const { data, error } = await supabase.from("digest_week").select("*").eq("week_start", ws).maybeSingle();
          if (error) throw new Error(error.message);
          return (data ?? null) as WeekRow | null;
        },
        upsertWeek: async (row) => {
          const { error } = await supabase.from("digest_week").upsert(row, { onConflict: "week_start" });
          if (error) throw new Error(`upsert failed: ${error.message}`);
        },
        opsEvent: async (level, kind, message, data, dedupe) => {
          await db.rpc("ops_event", { p_level: level, p_kind: kind, p_message: message, p_data: data, p_dedupe_minutes: dedupe });
        },
        getLastAttempt: async () => {
          const { data, error } = await supabase.from("tuning_config").select("value").eq("key", "digest_last_attempt_at").maybeSingle();
          if (error) throw new Error(error.message);
          return typeof data?.value === "string" ? data.value : null;
        },
        touchAttempt: async (iso) => {
          const { error } = await supabase.from("tuning_config")
            .upsert({ key: "digest_last_attempt_at", value: iso, updated_at: iso }, { onConflict: "key" });
          if (error) throw new Error(`attempt record failed: ${error.message}`);
        },
      };
      const result = periodType === "today" ? await runToday(deps) : await runWeek(deps);
      return json(result, result.ok ? 200 : 500);
    } catch (err) {
      console.error(`generate-digest-summary error (${periodType}):`, safeErr(err));
      return json({ ok: false, error: safeErr(err) }, 500);
    } finally {
      try {
        await db.rpc("lock_release", { p_name: lockName, p_owner: batchId });
      } catch (_e) { /* 期限(170秒)で自然に解放される */ }
    }
  }

  // 秘密なし(log中)の旧モードは10分に1回だけ。ロックは解放しない(期限で自然に解放)。取れなければ何もしない。
  if (legacyLimited) {
    const lk = await db.rpc("lock_acquire", { p_name: `digest-legacy-${periodType}`, p_seconds: 600, p_owner: batchId });
    if (lk.error) return json({ ok: false, error: "lock_error" }, 500);
    if (lk.data !== true) return json({ ok: true, skipped: "busy" });
  }

  const listName = body.list_name ?? "FollowList-AI";

  try {
    const out = await runLegacy({
      now: () => Date.now(),
      gen: async (purpose, prompt, schema, maxOutputTokens) => {
        const res = await callGemini(ctx, { purpose, parts: [{ text: prompt }], schema, maxOutputTokens });
        if (!res.ok) throw new Error(`gemini ${res.kind}${res.status ? ` http ${res.status}` : ""}: ${res.error}`);
        const parsed = res.json ?? JSON.parse(res.text);
        return parsed as Record<string, unknown>;
      },
      latestRun: async (ln) => {
        const { data: runs, error } = await supabase
          .from("fetch_runs")
          .select("started_at, finished_at")
          .eq("list_name", ln)
          .order("finished_at", { ascending: false })
          .limit(1);
        if (error) throw new Error(error.message);
        return runs && runs.length > 0 ? runs[0] : null;
      },
      postsInRun: async (ln, startedAt, finishedAt) => {
        const { data, error } = await supabase
          .from("x_posts")
          .select("author_handle, gist, content")
          .eq("list_name", ln)
          .gte("fetched_at", startedAt)
          .lte("fetched_at", finishedAt);
        if (error) throw new Error(error.message);
        return data ?? [];
      },
      posts24h: async (ln, since) => {
        const { data, error } = await supabase
          .from("x_posts")
          .select("author_handle, gist, content")
          .eq("list_name", ln)
          .or(`posted_at.gte.${since},and(posted_at.is.null,fetched_at.gte.${since})`);
        if (error) throw new Error(error.message);
        return data ?? [];
      },
      posts7d: async (ln, since) => {
        const { data, error } = await supabase
          .from("x_posts")
          .select("posted_at, fetched_at, is_read")
          .eq("list_name", ln)
          .or(`posted_at.gte.${since},and(posted_at.is.null,fetched_at.gte.${since})`);
        if (error) throw new Error(error.message);
        return data ?? [];
      },
      upsertDigest: async (ln, pt, digestBody) => {
        const { error } = await supabase
          .from("digest_summaries")
          .upsert(
            { list_name: ln, period_type: pt, body: digestBody, generated_at: new Date().toISOString() },
            { onConflict: "list_name,period_type" },
          );
        if (error) throw new Error(`upsert failed: ${error.message}`);
      },
    }, periodType as "last_run" | "24h" | "7d", listName);
    if (out.skipped) return json({ ok: true, skipped: true, reason: out.reason });
  } catch (err) {
    console.error(`generate-digest-summary error (${periodType}):`, safeErr(err));
    return json({ ok: false, error: safeErr(err) }, 500);
  }

  return json({ ok: true, period_type: periodType });
});
