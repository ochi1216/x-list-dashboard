import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { callGemini as sharedGemini, sanitize } from "./_gemini.ts";
import type { GeminiCtx } from "./_gemini.ts";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; SupabaseEdgeFunction/1.0)",
};

const SUMMARY_PROMPT = `#依頼内容：
あなたは、記事や動画の作者の意図を十分くみとって、わかりやすく内容を読者に伝えることを専門としている要約のプロフェッショナルライターです。

以下の指示にしたがって、文章を日本語で要約します。
それぞれの内容は、段階的にキャンバスではなくチャット上で日本語で説明して下さい。
高校生にでも理解できるように、専門的な用語は解説を入れるか、平易な言葉を併記するようにしてください。
下記内容以外の受け答えや、作業をスタートするにあたっての会話を出力する必要はありません。

#1 全体の内容を俯瞰した上で、この記事にふさわしいタイトルを記載して下さい。
#2 全体の内容を要約し、50文字以内で簡潔な「要旨」を記載してください。
#3  全体の内容を俯瞰した上で、300文字程度でこの記事関する結論をまとめてください。
#4 この記事にTagを付ける事を目的として記事の内容に関連するキーワードを３つ以上抽出して、箇条書きではなく、コンマで区切って","提示して下さい。
#5 最後に、記事の内容をマークアップ形式でまとめます。
   主なポイントの最適な分類を行ってください。
    主なポイントの各項目の見出しは、必ず『1. 』『2. 』のように数字とピリオドから始めてください。
　主なポイントは、箇条書きで３項目以上で構成して下さい。
    主なポイントの分類として必要な場合は、個数に上限は設定しません。
　例えば、今週のTOP10や、本日の20選など、具体的なトピックスの数が規定されている場合は、それらを省略することなく項目として扱ってください。
各ポイントは、そのタイトルとは別に、できるだけシンプルに要約するために100文字程度の箇条書きの文章で説明してください。
100文字程度の文章で説明するために、 出力前に必ず文章の文字数をカウントして100文字を超えている場合は、
100文字程度に収まるように推敲をくり返して下さい。必要に応じて箇条書きの文章をわけてもよいです。
#### 禁止事項
箇条書きの文字数カウントの結果を箇条書きの最後に記載することを禁止します。

#### 出力形式例
---
■ タイトル：[タイトル]
■ 要旨：[50文字以内の要旨の内容]
■ キーワード：[キーワード1, キーワード2, キーワード3,,,]
■ 結論：
[結論の内容]

■ 主なポイント：
[主なポイントの各項目の見出しは、必ず『1. 』『2. 』のように数字とピリオドから始めてください]
1. **[ポイント1のタイトル]**
   ・[ポイント1の説明文1]
   ・[ポイント1の説明文2]

2. **[ポイント2のタイトル]**
   ・[ポイント2の説明文1]
   ・[ポイント2の説明文2]

3. **[ポイント3のタイトル]**
   ・[ポイント3の説明文1]
   ・[ポイント3の説明文2]

■要約終了
---

#####ここからが、要約してほしい文章の内容`;

const LANGUAGE_PRIORITY = ["ja-jp", "en-us", "zh-cn", "zh-tw", "de-de", "es-mx", "ko-kr"];

async function callGemini(ctx: GeminiCtx, transcriptText: string): Promise<string> {
  const fullPrompt = `${SUMMARY_PROMPT}\n\n${transcriptText}`;
  const res = await sharedGemini(ctx, {
    purpose: "ti_lesson",
    parts: [{ text: fullPrompt }],
    maxOutputTokens: 4000,
  });
  if (!res.ok) throw new Error(`gemini ${res.kind}${res.status ? ` http ${res.status}` : ""}: ${res.error}`);
  return res.text;
}

// llm_usage への記録・RPC呼び出しのアダプタ(共通部品 GeminiDb)
function makeDb(supabase: ReturnType<typeof createClient>) {
  return {
    async rpc(name: string, args?: Record<string, unknown>) {
      const r = await supabase.rpc(name, args ?? {});
      return { data: r.data as unknown, error: r.error ? { message: r.error.message } : null };
    },
    async insertUsage(row: Record<string, unknown>) {
      const r = await supabase.from("llm_usage").insert(row).select("id").single();
      const id = r?.data?.id;
      return id == null ? null : Number(id);
    },
  };
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const geminiKey = Deno.env.get("GEMINI_API_KEY");

  let body: { series_link?: string; language?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body.series_link) {
    return new Response(
      JSON.stringify({ ok: false, error: "'series_link' is required in the request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
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

  const preferredLanguage = body.language ?? "ja-jp";
  const limit = body.limit ?? 10;

  const { data: lessons, error: lessonsError } = await supabase
    .from("ti_video_updates")
    .select("link, sequence")
    .eq("series_link", body.series_link)
    .eq("platform", "ti_precision_labs_lesson")
    .order("sequence", { ascending: true });

  if (lessonsError) {
    return new Response(JSON.stringify({ ok: false, error: lessonsError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!lessons || lessons.length === 0) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "No lessons found for this series_link. Run fetch-ti-precision-labs-lessons first.",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const ctx: GeminiCtx = {
    db: makeDb(supabase),
    apiKey: geminiKey,
    fn: "summarize-ti-lesson",
    grp: "ti",
    batchId: crypto.randomUUID(),
  };
  let processed = 0;
  let remaining = 0;
  const errors: Record<string, string> = {};

  for (const lesson of lessons) {
    const { data: transcriptRows, error: trError } = await supabase
      .from("ti_video_transcripts")
      .select("*")
      .eq("video_link", lesson.link);
    if (trError || !transcriptRows || transcriptRows.length === 0) {
      continue; // no transcript available for this lesson at all
    }

    // already summarized in the preferred (or any previously chosen) language? skip
    if (transcriptRows.some((r) => r.summary)) {
      continue;
    }

    // pick language: preferredLanguage if present, else first available in LANGUAGE_PRIORITY order
    let row = transcriptRows.find((r) => r.language === preferredLanguage);
    if (!row) {
      for (const lang of LANGUAGE_PRIORITY) {
        row = transcriptRows.find((r) => r.language === lang);
        if (row) break;
      }
    }
    if (!row) row = transcriptRows[0];

    if (processed >= limit) {
      remaining++;
      continue;
    }

    try {
      let content = row.content;
      if (!content) {
        const res = await fetch(row.transcript_url, { headers: FETCH_HEADERS });
        if (!res.ok) throw new Error(`transcript fetch http ${res.status}`);
        content = await res.text();
        await supabase
          .from("ti_video_transcripts")
          .update({ content, fetched_at: new Date().toISOString() })
          .eq("id", row.id);
      }

      const summary = await callGemini(ctx, content);
      await supabase
        .from("ti_video_transcripts")
        .update({ summary, summarized_at: new Date().toISOString() })
        .eq("id", row.id);
      processed++;
    } catch (err) {
      console.error(`summarize error for ${lesson.link}:`, sanitize(err, geminiKey));
      errors[lesson.link] = sanitize(err, geminiKey);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, series_link: body.series_link, processed, remaining, errors }),
    { headers: { "Content-Type": "application/json" } },
  );
});
