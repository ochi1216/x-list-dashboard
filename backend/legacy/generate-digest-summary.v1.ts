import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const LAST_RUN_PROMPT = `あなたはXリストの更新ダイジェストを作る専門家です。以下は直近1回の取得で新しく登録された投稿の一覧です（@ハンドル名: テーマ）。

この一覧から、誰が何を投稿したかが一目でわかる短い見出しを3〜5個、箇条書き形式で作ってください。1件20〜35字程度で、要約文や解説ではなく機械的な見出しとして書いてください（「〜についての投稿」のような説明的な言い回しは避け、固有名詞や具体的な内容を含めてください）。

あわせて、この一覧の中で特に目新しい・注目すべきキーワードやトピック名を2〜4個、短い単語・フレーズで挙げてください（説明文にせず単語だけ）。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"highlights": [{"author_handle": "@xxx", "text": "..."}], "new_terms": ["...", "..."]}

投稿一覧:
`;

const H24_PROMPT = `あなたはXリストの更新ダイジェストを作る専門家です。以下は直近24時間に複数回に分けて取得された投稿の一覧です（@ハンドル名: テーマ）。

1回だけ登場した単発の話題ではなく、複数の投稿・複数のアカウントにまたがって繰り返し登場した話題や、勢いが増している話題を優先して、今日一日の傾向を2〜4文で総括してください（"summary"）。

さらに、その傾向を踏まえて、深掘りして調べる価値がありそうなキーワードやトピックを1つだけ具体的に提案してください（"advice"、1〜2文）。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"summary": "...", "advice": "..."}

投稿一覧:
`;

const D7_PROMPT = `あなたはシニアライフアドバイザーです。以下は直近7日間の、Xリストの投稿の取得件数と未読件数の日別データです（投稿の内容そのものは含まれていません）。

このデータから読み取れる、閲覧・未読の傾向（未読が溜まりやすい曜日、既読ペースの変化など）を1〜2文で述べてください（"trend"）。話題の中身には一切触れず、あくまで数字から読み取れる行動パターンだけを扱ってください。

さらに、その傾向を踏まえて、無理なく続けられる生活習慣としてのアドバイスを1つ、やさしい口調で提案してください（"advice"、1〜2文）。説教くさくならないようにしてください。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"trend": "...", "advice": "..."}

日別データ:
`;

const LAST_RUN_SCHEMA = {
  type: "OBJECT",
  properties: {
    highlights: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          author_handle: { type: "STRING" },
          text: { type: "STRING" },
        },
        required: ["author_handle", "text"],
      },
    },
    new_terms: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["highlights", "new_terms"],
};

const H24_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    advice: { type: "STRING" },
  },
  required: ["summary", "advice"],
};

const D7_SCHEMA = {
  type: "OBJECT",
  properties: {
    trend: { type: "STRING" },
    advice: { type: "STRING" },
  },
  required: ["trend", "advice"],
};

async function callGemini(
  apiKey: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
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

// JST暦日での日付/曜日ラベル。棒グラフの日別バケットをユーザーの体感時刻(JST)に揃えるため。
function jstDateStr(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
}
function jstWeekday(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(d);
}

function toLine(p: { author_handle: string; gist: string | null; content: string | null }): string {
  const text = p.gist ?? (p.content ?? "").slice(0, 80);
  return `@${p.author_handle}: ${text}`;
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const geminiKey = Deno.env.get("GEMINI_API_KEY");

  let body: { period_type?: string; list_name?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const periodType = body.period_type;
  if (periodType !== "last_run" && periodType !== "24h" && periodType !== "7d") {
    return new Response(
      JSON.stringify({ ok: false, error: "period_type must be one of last_run, 24h, 7d" }),
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

  const listName = body.list_name ?? "FollowList-AI";

  async function upsertDigest(pt: string, digestBody: unknown) {
    const { error } = await supabase
      .from("digest_summaries")
      .upsert(
        {
          list_name: listName,
          period_type: pt,
          body: digestBody,
          generated_at: new Date().toISOString(),
        },
        { onConflict: "list_name,period_type" },
      );
    if (error) throw new Error(`upsert failed: ${error.message}`);
  }

  try {
    if (periodType === "last_run") {
      const { data: runs, error: runErr } = await supabase
        .from("fetch_runs")
        .select("started_at, finished_at")
        .eq("list_name", listName)
        .order("finished_at", { ascending: false })
        .limit(1);
      if (runErr) throw new Error(runErr.message);
      if (!runs || runs.length === 0) {
        return new Response(
          JSON.stringify({ ok: true, skipped: true, reason: "no fetch_runs row" }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      const run = runs[0];
      const { data: posts, error: postsErr } = await supabase
        .from("x_posts")
        .select("author_handle, gist, content")
        .eq("list_name", listName)
        .gte("fetched_at", run.started_at)
        .lte("fetched_at", run.finished_at);
      if (postsErr) throw new Error(postsErr.message);

      if (!posts || posts.length === 0) {
        await upsertDigest("last_run", { highlights: [], new_terms: [], empty: true });
      } else {
        const lines = posts.map(toLine).join("\n");
        const result = await callGemini(geminiKey, LAST_RUN_PROMPT + lines, LAST_RUN_SCHEMA);
        await upsertDigest("last_run", result);
      }
    } else if (periodType === "24h") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: posts, error: postsErr } = await supabase
        .from("x_posts")
        .select("author_handle, gist, content")
        .eq("list_name", listName)
        .or(`posted_at.gte.${since},and(posted_at.is.null,fetched_at.gte.${since})`);
      if (postsErr) throw new Error(postsErr.message);

      if (!posts || posts.length === 0) {
        await upsertDigest("24h", { summary: "", advice: "", empty: true });
      } else {
        const lines = posts.map(toLine).join("\n");
        const result = await callGemini(geminiKey, H24_PROMPT + lines, H24_SCHEMA);
        await upsertDigest("24h", result);
      }
    } else {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: posts, error: postsErr } = await supabase
        .from("x_posts")
        .select("posted_at, fetched_at, is_read")
        .eq("list_name", listName)
        .or(`posted_at.gte.${since},and(posted_at.is.null,fetched_at.gte.${since})`);
      if (postsErr) throw new Error(postsErr.message);

      const now = new Date();
      const days: { date: string; weekday: string; total: number; unread: number }[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        days.push({ date: jstDateStr(d), weekday: jstWeekday(d), total: 0, unread: 0 });
      }
      const dayIndex = new Map(days.map((d, i) => [d.date, i]));
      for (const p of posts ?? []) {
        const ts = p.posted_at ?? p.fetched_at;
        if (!ts) continue;
        const idx = dayIndex.get(jstDateStr(new Date(ts)));
        if (idx === undefined) continue;
        days[idx].total++;
        if (!p.is_read) days[idx].unread++;
      }

      const hasData = days.some((d) => d.total > 0);
      if (!hasData) {
        await upsertDigest("7d", { daily: days, trend: "", advice: "", empty: true });
      } else {
        const result = await callGemini(
          geminiKey,
          D7_PROMPT + JSON.stringify(days.map(({ date, weekday, total, unread }) => ({ date, weekday, total, unread }))),
          D7_SCHEMA,
        );
        await upsertDigest("7d", { ...result, daily: days });
      }
    }
  } catch (err) {
    console.error(`generate-digest-summary error (${periodType}):`, err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ ok: true, period_type: periodType }), {
    headers: { "Content-Type": "application/json" },
  });
});
