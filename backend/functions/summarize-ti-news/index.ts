import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callGemini as sharedGemini, makeGeminiDb, resolveGeminiBase, sanitize } from "./_gemini.ts";
import { createBudget } from "./_util.ts";
import type { GeminiCtx } from "./_gemini.ts";

const PROMPT = `あなたはニュース見出しを要約する専門家です。
見出し（と出典）だけが与えられます。本文は与えられていません。
見出しに書かれている情報の範囲内で言い換え・整理し、見出しに書かれていない事実（具体的な原因・数値・引用など）を創作しないでください。
日本語で3行の箇条書き要約を作成してください。各行は35字以内を目安にしてください。
必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"bullets": ["...", "...", "..."]}`;

async function callGemini(
  ctx: GeminiCtx,
  title: string,
  source: string,
): Promise<{ bullets: string[] }> {
  const fullPrompt = `${PROMPT}\n\n出典: ${source}\n見出し: ${title}`;
  const res = await sharedGemini(ctx, {
    purpose: "ti_news",
    parts: [{ text: fullPrompt }],
    schema: {
      type: "OBJECT",
      properties: {
        bullets: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["bullets"],
    },
    maxOutputTokens: 600,
  });
  if (!res.ok) throw new Error(`gemini ${res.kind}${res.status ? ` http ${res.status}` : ""}: ${res.error}`);
  return (res.json ?? JSON.parse(res.text)) as { bullets: string[] };
}


const TIME_BUDGET_MS = 100_000; // Edge Functionの実行上限(約150秒)に収める。残りは次回の呼び出しで処理する

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const geminiKey = Deno.env.get("GEMINI_API_KEY");

  let body: { link?: string; links?: string[]; limit?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!geminiKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "GEMINI_API_KEY secret is not set on this Supabase project. Add it under Edge Functions > Secrets.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const limit = body.limit ?? 30;

  let query = supabase
    .from("news_articles")
    .select("link, title, source");
  if (body.link) {
    query = query.eq("link", body.link);
  } else if (body.links && body.links.length > 0) {
    // Only touch explicitly named rows (e.g. today's digest items) — never
    // silently sweep the historical backlog of un-summarized old articles.
    query = query.in("link", body.links).is("summary_bullets", null);
  } else {
    query = query.is("summary_bullets", null).order("fetched_at", { ascending: false }).limit(limit);
  }
  const { data: articles, error: fetchError } = await query;

  if (fetchError) {
    return new Response(JSON.stringify({ ok: false, error: fetchError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!articles || articles.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, processed: 0, message: "no pending articles" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  let processed = 0;
  const errors: Record<string, string> = {};
  const ctx: GeminiCtx = {
    db: makeGeminiDb(supabase),
    apiKey: geminiKey,
    baseUrl: resolveGeminiBase(Deno.env.get("GEMINI_BASE_URL")),
    timeoutMs: 20_000,
    fn: "summarize-ti-news",
    grp: "ti",
    batchId: crypto.randomUUID(),
  };

  const budget = createBudget(TIME_BUDGET_MS);
  let deferred = 0;
  for (const article of articles) {
    if (budget.expired()) {
      deferred++;
      continue;
    }
    try {
      const { bullets } = await callGemini(ctx, article.title, article.source ?? "");
      const { error: upErr } = await supabase
        .from("news_articles")
        .update({ summary_bullets: bullets, summarized_at: new Date().toISOString() })
        .eq("link", article.link);
      // 保存に失敗したのに成功扱いにすると、次回また同じ記事に費用を使ってしまう
      if (upErr) throw new Error(`update failed: ${upErr.message}`);
      processed++;
    } catch (err) {
      console.error(`summarize error for ${article.link}:`, sanitize(err, [geminiKey]));
      errors[article.link] = sanitize(err, [geminiKey]);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, total: articles.length, errors, ...(deferred > 0 ? { deferred } : {}) }),
    { headers: { "Content-Type": "application/json" } },
  );
});
