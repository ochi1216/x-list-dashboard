// summarize-x-post (verify_jwt=true で配備)。要約のみ(gist is null が未処理)。後続の採点はしない。
// 共通部品は build.sh が `_gemini.ts` 等としてこのフォルダへコピーする。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callGemini, makeGeminiDb, sanitize } from "./_gemini.ts";
import { checkPipelineAuth } from "./_auth.ts";
import { createBudget, jsonResponse, newBatchId, runPool } from "./_util.ts";
import { checkUnauthRestrictions, RESPONSE_SCHEMA, resolveLimit, summarizeOne } from "./logic.ts";

const FN = "summarize-x-post";
const TIME_BUDGET_MS = 100_000;
const CONCURRENCY = 4;
const LOCK_SECONDS = 170;

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const geminiKey = Deno.env.get("GEMINI_API_KEY_X") || Deno.env.get("GEMINI_API_KEY");
  const db = makeGeminiDb(supabase);

  let body: { post_url?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object") body = {};

  // ---- 認証(log: 秘密なしは制限付きで許可 / enforce: 401) ----
  const modeRes = await db.rpc("cfg", { p_key: "pipeline_auth_mode", p_default: "log" });
  const mode = !modeRes.error && modeRes.data === "log" ? "log" : "enforce"; // 取得失敗・不明な値は安全側
  const auth = await checkPipelineAuth(req, { db, mode, allow: ["cron", "win", "none"], fn: FN });
  if (!auth.ok) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  const restriction = checkUnauthRestrictions(auth.limited, body);
  if (restriction) return jsonResponse({ ok: false, error: restriction }, 403);

  if (!geminiKey) {
    return jsonResponse({
      ok: false,
      error: "GEMINI_API_KEY secret is not set on this Supabase project. Add it under Edge Functions > Secrets.",
    }, 500);
  }

  // ---- 二重実行防止 ----
  const batchId = newBatchId(FN);
  const lock = await db.rpc("lock_acquire", { p_name: FN, p_seconds: LOCK_SECONDS, p_owner: batchId });
  if (lock.error) return jsonResponse({ ok: false, error: "lock_error" }, 500);
  if (lock.data !== true) return jsonResponse({ ok: true, skipped: "busy" });

  try {
    const budget = createBudget(TIME_BUDGET_MS);
    const limit = resolveLimit(body.limit);

    let query = supabase
      .from("x_posts")
      .select("post_url, author_handle, author_name, content, image_urls");
    if (body.post_url) {
      query = query.eq("post_url", body.post_url);
    } else {
      query = query.is("gist", null).limit(limit);
    }
    const { data: posts, error: fetchError } = await query;

    if (fetchError) {
      return jsonResponse({ ok: false, error: sanitize(fetchError.message, [geminiKey]) }, 500);
    }
    if (!posts || posts.length === 0) {
      return jsonResponse({ ok: true, processed: 0, remaining: 0, message: "no pending posts" });
    }

    let processed = 0;
    let guardStop = false;
    const errors: Record<string, string> = {};

    const { results, skipped } = await runPool(posts, CONCURRENCY, async (post) => {
      if (guardStop) return "skipped" as const;
      const outcome = await summarizeOne(post, {
        gen: async (parts, opts) => {
          const r = await callGemini(
            { db, apiKey: geminiKey, fn: FN, grp: "x", batchId },
            {
              purpose: "summary",
              parts,
              schema: RESPONSE_SCHEMA,
              maxOutputTokens: opts.maxOutputTokens,
              postUrl: post.post_url,
            },
          );
          if (r.ok) return { ok: true as const, json: r.json };
          if (r.kind === "guard") guardStop = true;
          return { ok: false as const, error: r.error, kind: r.kind };
        },
      });
      if (!outcome.ok) {
        errors[post.post_url] = sanitize(outcome.error, [geminiKey]);
        return "failed" as const;
      }
      const { error: upErr } = await supabase
        .from("x_posts")
        .update({ gist: outcome.gist, summary: outcome.summary, summarized_at: new Date().toISOString() })
        .eq("post_url", post.post_url);
      if (upErr) {
        errors[post.post_url] = sanitize(upErr.message, [geminiKey]);
        return "failed" as const;
      }
      processed++;
      return "done" as const;
    }, budget.deadline);

    let unstarted = skipped;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "error") {
        errors[posts[i].post_url] = sanitize(r.error, [geminiKey]);
      } else if (r.status === "ok" && r.value === "skipped") {
        unstarted++;
      }
    }

    // 残り(まだ gist が無い件数)。取得に失敗したら未着手数で代用。
    let remaining = unstarted;
    if (!body.post_url) {
      const { count, error: cErr } = await supabase
        .from("x_posts")
        .select("post_url", { count: "exact", head: true })
        .is("gist", null);
      if (!cErr && typeof count === "number") remaining = count;
    }

    return jsonResponse({
      ok: true,
      processed,
      total: posts.length,
      errors,
      remaining,
      ...(unstarted > 0 ? { deferred: unstarted } : {}),
      ...(guardStop ? { stopped: "cost_guard" } : {}),
    });
  } catch (err) {
    console.error("summarize-x-post failed:", sanitize(err, [geminiKey]));
    return jsonResponse({ ok: false, error: sanitize(err, [geminiKey]) }, 500);
  } finally {
    await db.rpc("lock_release", { p_name: FN, p_owner: batchId }).catch(() => {});
  }
});
