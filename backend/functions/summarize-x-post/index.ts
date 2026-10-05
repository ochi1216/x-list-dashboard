// summarize-x-post (verify_jwt=true で配備)。要約のみ(gist is null が未処理)。後続の採点はしない。
// 共通部品は build.sh が `_gemini.ts` 等としてこのフォルダへコピーする。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callGemini, makeGeminiDb, reportGeminiAuthError, resolveGeminiBase, sanitize } from "./_gemini.ts";
import { checkPipelineAuth } from "./_auth.ts";
import { createBudget, jsonResponse, newBatchId, runPool } from "./_util.ts";
import { checkUnauthRestrictions, isPermanentFailure, RESPONSE_SCHEMA, resolveLimit, summarizeOne } from "./logic.ts";

const FN = "summarize-x-post";
// 時間予算(実行上限は約150秒)。「新しい投稿に着手してよい期限」で、着手済みの処理は完了を待つ。
// 1投稿の最悪 = 画像取得10秒(並列) + callGemini 41.5秒(要求20秒 + 待ち1.5秒 + 再実行は合計1回まで20秒)
// = 51.5秒。期限直前に着手しても 80 + 51.5 = 131.5秒で、ロック解放・応答に十分な余裕がある(150秒以内)。
const TIME_BUDGET_MS = 80_000;
const GEMINI_TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
const LOCK_SECONDS = 170;
const MAX_ATTEMPTS = 3; // 恒久的な失敗(isPermanentFailure)を繰り返す投稿を5分ごとに再試行して費用を使い続けないための上限

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const geminiKey = Deno.env.get("GEMINI_API_KEY_X") || Deno.env.get("GEMINI_API_KEY");
  const db = makeGeminiDb(supabase);
  const geminiBase = resolveGeminiBase(Deno.env.get("GEMINI_BASE_URL"));

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
      .select("post_url, author_handle, author_name, content, image_urls, summary_attempts");
    if (body.post_url) {
      query = query.eq("post_url", body.post_url);
    } else {
      query = query.is("gist", null).lt("summary_attempts", MAX_ATTEMPTS).limit(limit);
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
    let authStop = false;
    const errors: Record<string, string> = {};

    const { results, skipped } = await runPool(posts, CONCURRENCY, async (post) => {
      if (guardStop || authStop) return "skipped" as const;
      const countPermanentFailure = async () => {
        if (body.post_url) return; // 手動指定は試行回数に数えない
        await supabase.from("x_posts")
          .update({ summary_attempts: ((post as { summary_attempts?: number }).summary_attempts ?? 0) + 1 })
          .eq("post_url", post.post_url);
      };
      const outcome = await summarizeOne(post, {
        gen: async (parts, opts) => {
          const r = await callGemini(
            { db, apiKey: geminiKey, fn: FN, grp: "x", batchId, baseUrl: geminiBase, timeoutMs: GEMINI_TIMEOUT_MS },
            {
              purpose: "summary",
              parts,
              schema: RESPONSE_SCHEMA,
              maxOutputTokens: opts.maxOutputTokens,
              postUrl: post.post_url,
            },
          );
          if (r.ok && r.truncated) return { ok: false as const, error: "summary output truncated (MAX_TOKENS)", kind: "parse" };
          if (r.ok) return { ok: true as const, json: r.json };
          if (r.kind === "guard") guardStop = true; // 費用ガード・状態取得失敗: 全体を止める(試行回数は数えない)
          if (r.kind === "auth") { // 認証エラー: 鍵の誤設定・請求停止。全体を止める(試行回数は数えない)
            authStop = true;
            await reportGeminiAuthError(db, r.status);
          }
          return { ok: false as const, error: r.error, kind: r.kind, status: r.status };
        },
      });
      if (!outcome.ok) {
        errors[post.post_url] = sanitize(outcome.error, [geminiKey]);
        if (isPermanentFailure(outcome)) await countPermanentFailure();
        return "failed" as const;
      }
      const { error: upErr } = await supabase
        .from("x_posts")
        .update({ gist: outcome.gist, summary: outcome.summary, summarized_at: new Date().toISOString() })
        .eq("post_url", post.post_url);
      if (upErr) {
        // 保存の失敗は一時的なものとして試行回数に数えない
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
        .is("gist", null)
        .lt("summary_attempts", MAX_ATTEMPTS);
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
      ...(authStop ? { stopped: "gemini_auth" } : {}),
    });
  } catch (err) {
    console.error("summarize-x-post failed:", sanitize(err, [geminiKey]));
    return jsonResponse({ ok: false, error: sanitize(err, [geminiKey]) }, 500);
  } finally {
    await db.rpc("lock_release", { p_name: FN, p_owner: batchId }).catch(() => {});
  }
});
