import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const PROMPT = `あなたはニュース見出しを要約する専門家です。
見出し（と出典）だけが与えられます。本文は与えられていません。
見出しに書かれている情報の範囲内で言い換え・整理し、見出しに書かれていない事実（具体的な原因・数値・引用など）を創作しないでください。
日本語で3行の箇条書き要約を作成してください。各行は35字以内を目安にしてください。
必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"bullets": ["...", "...", "..."]}`;

async function callGemini(
  apiKey: string,
  title: string,
  source: string,
): Promise<{ bullets: string[] }> {
  const fullPrompt = `${PROMPT}\n\n出典: ${source}\n見出し: ${title}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              bullets: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["bullets"],
          },
        },
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`gemini api http ${res.status}: ${errText}`);
  }
  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      `unexpected gemini response shape (finishReason=${candidate?.finishReason}): ${
        JSON.stringify(json).slice(0, 500)
      }`,
    );
  }
  return JSON.parse(text);
}

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

  for (const article of articles) {
    try {
      const { bullets } = await callGemini(geminiKey, article.title, article.source ?? "");
      await supabase
        .from("news_articles")
        .update({ summary_bullets: bullets, summarized_at: new Date().toISOString() })
        .eq("link", article.link);
      processed++;
    } catch (err) {
      console.error(`summarize error for ${article.link}:`, err);
      errors[article.link] = String(err instanceof Error ? err.message : err);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, total: articles.length, errors }),
    { headers: { "Content-Type": "application/json" } },
  );
});
