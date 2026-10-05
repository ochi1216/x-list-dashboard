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
    purpose: "ti_headline",
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
  // 出力が上限で途切れた要約は保存しない(次回の呼び出しでやり直す)
  if (res.truncated) throw new Error("gemini output truncated (MAX_TOKENS)");
  return (res.json ?? JSON.parse(res.text)) as { bullets: string[] };
}



const TIME_BUDGET_MS = 100_000; // Edge Functionの実行上限(約150秒)に収める。残りは次回の呼び出しで処理する

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
  const MAX_ITEMS = 100; // 追加: 1回の呼び出しで処理する上限(原本は無制限。超過分は応答の dropped で返す)
  const allItems = Array.isArray(body.items) ? body.items : [];
  const items = allItems.slice(0, MAX_ITEMS);
  const dropped = Math.max(0, allItems.length - MAX_ITEMS); // 上限超過分は処理しない。無通知で落とさず件数を返す
  if (items.length === 0) {
    return new Response(
      JSON.stringify({ ok: false, error: "body.items must be a non-empty array of {title, source}" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const ctx: GeminiCtx = {
    db: makeGeminiDb(createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)),
    apiKey: geminiKey,
    baseUrl: resolveGeminiBase(Deno.env.get("GEMINI_BASE_URL")),
    timeoutMs: 20_000,
    fn: "summarize-ti-news-headline",
    grp: "ti",
    batchId: crypto.randomUUID(),
  };
  const results: Record<string, string[]> = {};
  const errors: Record<string, string> = {};

  const budget = createBudget(TIME_BUDGET_MS);
  let deferred = 0;
  for (const item of items) {
    if (budget.expired()) {
      deferred++;
      continue;
    }
    try {
      const { bullets } = await callGemini(ctx, item.title, item.source);
      results[item.title] = bullets;
    } catch (err) {
      console.error(`summarize error for "${item.title}":`, sanitize(err, [geminiKey]));
      errors[item.title] = sanitize(err, [geminiKey]);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, results, errors, dropped, ...(deferred > 0 ? { deferred } : {}) }),
    { headers: { "Content-Type": "application/json" } },
  );
});
