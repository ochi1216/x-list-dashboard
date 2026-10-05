import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "GEMINI_API_KEY secret is not set on this Supabase project.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let body: { items?: { title: string; source: string }[] };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const items = body.items ?? [];
  if (items.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "body.items must be a non-empty array of {title, source}" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const results: Record<string, string[]> = {};
  const errors: Record<string, string> = {};

  for (const item of items) {
    try {
      const { bullets } = await callGemini(geminiKey, item.title, item.source);
      results[item.title] = bullets;
    } catch (err) {
      console.error(`summarize error for "${item.title}":`, err);
      errors[item.title] = String(err instanceof Error ? err.message : err);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, results, errors }),
    { headers: { "Content-Type": "application/json" } },
  );
});
