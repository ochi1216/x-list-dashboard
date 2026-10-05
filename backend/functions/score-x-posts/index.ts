import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// デプロイ時は backend/build.sh が _shared/*.ts を _<名前>.ts としてこのフォルダへコピーする
import { callGemini, makeGeminiDb, resolveGeminiBase } from "./_gemini.ts";
import { checkPipelineAuth } from "./_auth.ts";
import {
  buildSpeechPrompt, checkSpeechNumbers, classifyForScoring, dupKey, normalizeBody,
  parseSpeechResult, PROMPT_VERSION, scoreWithLlm, SPEECH_SCHEMA,
} from "./_scoring.ts";
import {
  type Cfg, failureClass, failureUpdate, hasEarlierDuplicate, mapPool, parseCfg, ruleFields,
  sanitize, speechDecision, speechSaveFields, targetFrom, wantRescore,
} from "./logic.ts";

const FN = "score-x-posts";
const CONCURRENCY = 4;
// 時間予算(実行上限は約150秒)。予算は「新しい処理を始めてよい期限」で、着手済みの呼び出しは完了を待つ。
// 1回の callGemini の最悪は 20秒(要求) + 1.5秒(待ち) + 20秒(再実行は合計1回まで) = 41.5秒。
// 採点は再採点(最大2回)の前にも期限を確かめるので、期限直前に着手した投稿の最悪は
// 80 + 41.5 = 121.5秒。読み下しも同じ期限で着手を止めるので 80 + 41.5 = 121.5秒。
// 区分確定(finalize_tiers)など DB 処理を数秒見込んでも 150秒を超えない。
const SCORE_BUDGET_MS = 80_000;
const SPEECH_BUDGET_MS = 80_000;
const GEMINI_TIMEOUT_MS = 20_000;
const BATCH_LIMIT = 200;
const CFG_KEYS = [
  "score_enabled", "tier_assign_enabled", "kill_switch", "backfill_enabled", "tier_scope_from", "score_backfill_from",
  "listen_threshold", "cap_opinion", "speech_enabled", "speech_max_per_run", "interest_profile",
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req: Request) => {
  // supabase-js のselect型推論は動的な列指定と相性が悪いので any 扱い(実行時の挙動は同じ)
  // deno-lint-ignore no-explicit-any
  const supabase: any = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const db = makeGeminiDb(supabase); // insert 失敗は callGemini が console.error に残す(キー伏せ)

  // 認証: cron専用・必須(modeに関わらず)
  const auth = await checkPipelineAuth(req, { db, mode: "enforce", allow: ["cron"] });
  if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);

  // X系は専用キー(GEMINI_API_KEY_X)があればそれを使う(summarize-x-post と同じ)
  const apiKey = Deno.env.get("GEMINI_API_KEY_X") || Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ ok: false, error: "no_api_key" }, 500);

  const batchId = crypto.randomUUID();
  const startedAt = Date.now();
  const scoreDeadline = startedAt + SCORE_BUDGET_MS;
  const speechDeadline = startedAt + SPEECH_BUDGET_MS;

  let locked = false;
  try {
    const lk = await db.rpc("lock_acquire", { p_name: FN, p_seconds: 170, p_owner: batchId });
    if (lk.error) return json({ ok: false, error: "lock_error" }, 500);
    locked = lk.data === true;
    if (!locked) return json({ ok: true, skipped: "locked" });

    const { data: cfgRows, error: cfgError } = await supabase.from("tuning_config").select("key,value").in("key", CFG_KEYS);
    // 設定が読めないまま既定値(kill_switch=false 等)で動くと、止めたはずの処理が走る。何もせず終える。
    if (cfgError) return json({ ok: false, error: "config_unavailable" }, 500);
    const cfg: Cfg = parseCfg((cfgRows ?? []) as { key: string; value: unknown }[]);
    if (cfg.killSwitch) return json({ ok: true, skipped: "kill_switch" });

    const gem = {
      db, apiKey, fn: FN, grp: "x" as const, batchId, timeoutMs: GEMINI_TIMEOUT_MS,
      baseUrl: resolveGeminiBase(Deno.env.get("GEMINI_BASE_URL")),
    };
    const call = (r: Parameters<typeof callGemini>[1]) => callGemini(gem, r);

    const counts = { scored: 0, rule: 0, skipped: 0, failed: 0, speech: 0 };
    const from = targetFrom(cfg);
    const baseQuery = (head: boolean) => {
      let q = supabase.from("x_posts")
        .select(head ? "id" : "id,post_url,author_handle,content,summary,image_urls,posted_at,fetched_at,score_attempts,dup_key",
          head ? { count: "exact", head: true } : undefined)
        .not("summary", "is", null).is("score_state", null).lt("score_attempts", 3)
        .gte("fetched_at", from!);
      return q;
    };

    if (!cfg.scoreEnabled) {
      // 採点と読み下しは飛ばす。区分確定は tier_assign_enabled なら実行する(下)
    } else if (!cfg.profileText) {
      await db.rpc("ops_event", {
        p_level: "warn", p_kind: "score_no_profile", p_message: "関心プロファイルが未設定のため採点をスキップ",
        p_data: {}, p_dedupe_minutes: 360,
      });
    } else if (from) {
      const modelState = (await db.rpc("get_model_state")).data as
        { configs?: Record<string, { gen_config?: unknown }> } | null;
      const genOf = (model: string) => modelState?.configs?.[model]?.gen_config;

      const { data: targets } = await baseQuery(false)
        .order("fetched_at", { ascending: false }).limit(BATCH_LIMIT);
      type Post = {
        id: number; post_url: string; author_handle: string | null; content: string | null; summary: string | null;
        image_urls: string[] | null; posted_at: string | null; fetched_at: string | null;
        score_attempts: number | null; dup_key: string | null;
      };
      const posts = (targets ?? []) as Post[];

      // 1) dup_key を先に全件保存(新しい順に処理しても先行投稿を参照できるように)
      const keys = new Map<number, string | null>();
      await mapPool(posts, CONCURRENCY, async (p) => {
        const k = normalizeBody(p.content) ? await dupKey(p.author_handle, p.content) : null;
        keys.set(p.id, k);
        if (k !== p.dup_key) {
          await supabase.from("x_posts").update({ dup_key: k }).eq("id", p.id);
          p.dup_key = k;
        }
      }, () => Date.now() > scoreDeadline);

      const findDup = async (p: Post): Promise<boolean> => {
        const k = keys.get(p.id);
        if (!k) return false;
        const mine = p.posted_at ?? p.fetched_at;
        if (!mine) return false;
        const lo = new Date(Date.parse(mine) - 14 * 86_400_000).toISOString();
        const [a, b] = await Promise.all([
          supabase.from("x_posts").select("post_url,posted_at").eq("dup_key", k)
            .neq("post_url", p.post_url).gte("posted_at", lo).lte("posted_at", mine).limit(20),
          supabase.from("post_scores").select("post_url,posted_at").eq("dup_key", k)
            .neq("post_url", p.post_url).gte("posted_at", lo).lte("posted_at", mine).limit(20),
        ]);
        const cands = [...((a.data ?? []) as []), ...((b.data ?? []) as [])];
        return hasEarlierDuplicate(p, cands);
      };

      let stop = false;
      let transportFails = 0;
      const nowIso = () => new Date().toISOString();

      await mapPool(posts, CONCURRENCY, async (p) => {
        try {
          const dup = await findDup(p);
          const cls = classifyForScoring(p, dup);
          if (cls === "duplicate_check" || cls === "none") {
            const f = ruleFields(cls === "none" ? "none" : "duplicate");
            const { error } = await supabase.from("x_posts").update({
              ...f, interest: null, scored_at: nowIso(), profile_version: cfg.profileVersion,
            }).eq("id", p.id);
            if (error) counts.failed++; else counts.rule++;
            return;
          }
          if (cls === "skipped_short") {
            const { error } = await supabase.from("x_posts").update({ score_state: "skipped" }).eq("id", p.id);
            if (error) counts.failed++; else counts.skipped++;
            return;
          }

          const out = await scoreWithLlm({
            call: (r) => call(r),
            profileText: cfg.profileText,
            capOpinion: cfg.capOpinion,
            wantRescore: (model, score) => wantRescore(genOf(model), score, cfg.listenThreshold),
            threshold: cfg.listenThreshold,
            timeUp: () => Date.now() > scoreDeadline,
          }, p);

          if (!out.ok) {
            const fc = failureClass(out.failKind);
            if (fc === "guard") { stop = true; return; }
            counts.failed++;
            if (fc === "transport") {
              if (++transportFails >= 4) stop = true;
            }
            await supabase.from("x_posts").update(failureUpdate(p.score_attempts ?? 0)).eq("id", p.id);
            return;
          }
          transportFails = 0;
          if (out.guardStopped) stop = true; // 再採点が費用ガードで止まった: 以後の着手をやめる(この投稿は T-1 で確定済み)

          await supabase.from("score_runs").insert(out.runs.map((r) => ({
            post_url: p.post_url, purpose: r.purpose, attempt: r.attempt, model: r.model,
            profile_version: cfg.profileVersion, prompt_version: PROMPT_VERSION, score_raw: r.score_raw,
            kind: r.kind, interest: r.interest, reason: r.reason, evidence: r.evidence, usage_id: r.usage_id,
          })));
          const { error } = await supabase.from("x_posts").update({
            score: out.score, score_raw: out.raw, score_kind: out.kind, score_reason: out.reason,
            cap_reason: out.capReason, interest: out.interest, score_state: "scored",
            scored_model: out.model, scored_at: nowIso(), profile_version: cfg.profileVersion,
            score_attempts: (p.score_attempts ?? 0) + 1,
          }).eq("id", p.id);
          if (error) counts.failed++; else counts.scored++;
        } catch (_e) {
          counts.failed++;
        }
      }, () => stop || Date.now() > scoreDeadline);

      if (stop && transportFails >= 4) {
        await db.rpc("ops_event", {
          p_level: "warn", p_kind: "score_stalled", p_message: "採点の通信失敗が続いたため中断",
          p_data: {}, p_dedupe_minutes: 60,
        });
      }
    }

    // 区分確定(score_enabled=false でも、tier_assign_enabled=true なら実行する)
    let tiers: unknown = null;
    if (cfg.tierAssignEnabled) {
      try {
        const r = await db.rpc("finalize_tiers", { p_force: false });
        tiers = r.error ? { error: sanitize(r.error.message) } : r.data;
      } catch (e) {
        tiers = { error: sanitize((e as Error).message) };
      }
    }

    // 読み下し(聴く確定済みで未生成のもの)
    if (cfg.scoreEnabled && cfg.speechEnabled && cfg.speechMaxPerRun > 0 && Date.now() < speechDeadline) {
      const { data: sp } = await supabase.from("x_posts")
        .select("id,post_url,content,summary,image_urls")
        .eq("listen_tier", "listen").is("speech_body", null).is("speech_at", null).eq("is_read", false)
        .order("score", { ascending: false }).limit(cfg.speechMaxPerRun);
      let speechStop = false;
      await mapPool((sp ?? []) as { id: number; post_url: string; content: string | null; summary: string | null; image_urls: string[] | null }[],
        CONCURRENCY, async (p) => {
          try {
            const r = await call({
              purpose: "speech", parts: [{ text: buildSpeechPrompt(p) }], schema: SPEECH_SCHEMA,
              maxOutputTokens: 600, temperature: 0.2, postUrl: p.post_url,
            });
            const s = r.ok && !r.truncated ? parseSpeechResult(r.json) : null;
            const numbersOk = !!s && checkSpeechNumbers(s.title + " " + s.body, [p.content ?? "", p.summary ?? ""]);
            const decision = speechDecision(r, !!s, numbersOk);
            if (decision === "guard_stop") { speechStop = true; return; } // 費用ガード: 記録せず次のtickで再開
            const now = new Date().toISOString();
            if (decision === "record_failure") {
              // 失敗(通信・形式不正・数値不一致・parse失敗)は speech_at だけ記録して再試行しない(費用の無限消費を防ぐ)
              await supabase.from("x_posts").update({ speech_at: now, speech_model: r.ok ? r.model : (r.model ?? null) }).eq("id", p.id);
              return;
            }
            const { error } = await supabase.from("x_posts")
              .update(speechSaveFields(s!.title, s!.body, (r as { model: string }).model, now)).eq("id", p.id);
            if (!error) counts.speech++;
          } catch (_e) { /* 想定外の例外(DB等)は次のtickで再試行 */ }
        }, () => speechStop || Date.now() > speechDeadline);
    }

    let remaining: number | null = null;
    if (from) {
      const { count } = await baseQuery(true);
      remaining = count ?? null;
    }

    return json({ ok: true, ...counts, remaining, tiers, ...(cfg.scoreEnabled ? {} : { skipped: "score_disabled" }) });
  } catch (e) {
    return json({ ok: false, error: sanitize((e as Error)?.message) }, 500);
  } finally {
    if (locked) {
      try { await db.rpc("lock_release", { p_name: FN, p_owner: batchId }); } catch (_e) { /* noop */ }
    }
  }
});
