import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUMMARY_PROMPT = `あなたはX(Twitter)の投稿を要約する専門家です。次の投稿を読んで、日本語で以下の2つを作成してください。

1. gist: 「結局何の話か」が一目でわかるテーマ一言（15〜30字程度）。投稿者の相槌・感想コメントではなく、引用元記事や話題の主旨を掴んでください（例:「これは有料でUdemyで出すやつでしょ」ではなく「Google Workspace時短術の記事に『有料級』との反応」）。
2. summary: 2〜3文の「要するに」説明。本文を読まなくても要点がわかる文章。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "...", "summary": "..."}`;

// 短い英語投稿向け: 要約(意訳・言い換え・説明の追加)ではなく直訳のみを行う。
// 短い投稿を長く水増しして翻訳することを防ぐための専用プロンプト。
const SHORT_EN_PROMPT = `あなたはX(Twitter)の短い英語投稿を日本語に翻訳する専門家です。次の投稿を、説明や背景を付け足さずに直訳してください。意訳・要約・解釈の追加はせず、原文の情報量をそのまま保った自然な日本語にしてください。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "直訳した日本語。30字程度に収まればそのまま、長ければ末尾を自然に短縮したもの", "summary": "直訳した日本語の全文"}`;

// 本文と添付画像を両方踏まえて要約するプロンプト。
// 本文が短い/ない場合は画像から読み取れる情報を中心にするよう指示する。
const IMAGE_PROMPT = `あなたはX(Twitter)の投稿を要約する専門家です。次の投稿本文と添付画像を踏まえて、日本語で以下の2つを作成してください。本文が短い、または本文だけでは話の内容がわからない場合は、画像から読み取れる情報(写真の被写体、スクリーンショットの文面、グラフの傾向など)を中心にまとめてください。

1. gist: 「結局何の話か」が一目でわかるテーマ一言（15〜30字程度）。
2. summary: 2〜3文の「要するに」説明。画像を見なくても要点がわかる文章にしてください。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "...", "summary": "..."}`;

// 投稿本文を4種類に分類する。
// - empty: 本文なし
// - short_ja: 短い日本語投稿。画像がなければそれ自体が一目で読める分量なのでGeminiには渡さず原文をそのまま採用(コストゼロ)。
// - short_en: 短い英語投稿。直訳のみ行う。
// - long: 上記以外(長文・記事引用・スレッド等)。従来通りgist+summary要約を行う。
function classifyContent(content: string): "empty" | "short_ja" | "short_en" | "long" {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return "empty";
  const hasKana = /[぀-ヿ]/.test(trimmed); // ひらがな/カタカナを含む＝日本語主体とみなす
  const noWhitespace = trimmed.replace(/\s/g, "");
  const asciiLetters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const isMostlyAscii = noWhitespace.length > 0 && asciiLetters / noWhitespace.length > 0.6;

  if (hasKana && trimmed.length <= 40) return "short_ja";
  if (!hasKana && isMostlyAscii && trimmed.length <= 150) return "short_en";
  return "long";
}

// 画像解析は、画像があって、かつ本文だけでは情報が不十分(empty/short_ja/short_en)な場合のみ行う。
// 本文が長い(long)場合は本文だけで要約が完結するので画像解析はスキップしてトークンを節約。
function needsImageAnalysis(kind: string, hasImages: boolean): boolean {
  return hasImages && kind !== "long";
}

// Xの画像CDN URLは`name=`パラメータでサイズを指定できる。
// トークン消費を押さえるため、解析には小さい縮小版(small)だけを取得する(元画像は保存しない)。
// X以外のホストには適用しない(クエリパラメータの仕様が違い、不正なリクエストになりうるため)。
function toSmallVariant(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("twimg.com")) return url;
    u.searchParams.set("name", "small");
    return u.toString();
  } catch {
    return url;
  }
}

async function fetchImageAsInlineData(
  url: string,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(toSmallVariant(url));
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < buf.length; i += chunkSize) {
      binary += String.fromCharCode(...buf.subarray(i, i + chunkSize));
    }
    return { mimeType: contentType, data: btoa(binary) };
  } catch (err) {
    console.error(`image fetch failed for ${url}:`, err);
    return null;
  }
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    gist: { type: "STRING" },
    summary: { type: "STRING" },
  },
  required: ["gist", "summary"],
};

async function callGemini(
  apiKey: string,
  promptTemplate: string,
  authorHandle: string,
  authorName: string,
  content: string,
  images: { mimeType: string; data: string }[] = [],
): Promise<{ gist: string; summary: string }> {
  const fullPrompt = `${promptTemplate}\n\n投稿者: ${authorName} (${authorHandle})\n本文:\n${content || "(本文なし。画像のみの投稿)"}`;
  const parts: unknown[] = [{ text: fullPrompt }];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
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

  let body: { post_url?: string; limit?: number };
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

  const limit = body.limit ?? 20;

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
    return new Response(JSON.stringify({ ok: false, error: fetchError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!posts || posts.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, processed: 0, message: "no pending posts" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  let processed = 0;
  const errors: Record<string, string> = {};

  for (const post of posts) {
    try {
      const content = post.content ?? "";
      const kind = classifyContent(content);
      const imageUrls = (Array.isArray(post.image_urls) ? post.image_urls : []).slice(0, 4);
      const hasImages = imageUrls.length > 0;
      let gist: string;
      let summary: string;

      if (needsImageAnalysis(kind, hasImages)) {
        const fetched = (await Promise.all(imageUrls.map(fetchImageAsInlineData)))
          .filter((img): img is { mimeType: string; data: string } => img !== null);
        if (fetched.length > 0) {
          const result = await callGemini(
            geminiKey,
            IMAGE_PROMPT,
            post.author_handle,
            post.author_name ?? "",
            content,
            fetched,
          );
          gist = result.gist;
          summary = result.summary;
        } else if (kind === "short_ja") {
          const text = content.trim();
          gist = text.length > 60 ? text.slice(0, 60) : text;
          summary = text;
        } else {
          const promptTemplate = kind === "short_en" ? SHORT_EN_PROMPT : SUMMARY_PROMPT;
          const result = await callGemini(geminiKey, promptTemplate, post.author_handle, post.author_name ?? "", content);
          gist = result.gist;
          summary = result.summary;
        }
      } else if (kind === "short_ja") {
        const text = content.trim();
        gist = text.length > 60 ? text.slice(0, 60) : text;
        summary = text;
      } else {
        const promptTemplate = kind === "short_en" ? SHORT_EN_PROMPT : SUMMARY_PROMPT;
        const result = await callGemini(geminiKey, promptTemplate, post.author_handle, post.author_name ?? "", content);
        gist = result.gist;
        summary = result.summary;
      }

      await supabase
        .from("x_posts")
        .update({ gist, summary, summarized_at: new Date().toISOString() })
        .eq("post_url", post.post_url);
      processed++;
    } catch (err) {
      console.error(`summarize error for ${post.post_url}:`, err);
      errors[post.post_url] = String(err instanceof Error ? err.message : err);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, total: posts.length, errors }),
    { headers: { "Content-Type": "application/json" } },
  );
});
