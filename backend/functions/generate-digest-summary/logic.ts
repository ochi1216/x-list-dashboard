// 旧3モード(last_run / 24h / 7d)のロジック。原本 legacy/generate-digest-summary.v1.ts と
// プロンプト・スキーマ・保存形式・応答は同一。Gemini呼び出しだけ注入された gen に差し替え。
// 共通部品のimportなし(index.ts から依存を注入)。

export const LAST_RUN_PROMPT = `あなたはXリストの更新ダイジェストを作る専門家です。以下は直近1回の取得で新しく登録された投稿の一覧です（@ハンドル名: テーマ）。

この一覧から、誰が何を投稿したかが一目でわかる短い見出しを3〜5個、箇条書き形式で作ってください。1件20〜35字程度で、要約文や解説ではなく機械的な見出しとして書いてください（「〜についての投稿」のような説明的な言い回しは避け、固有名詞や具体的な内容を含めてください）。

あわせて、この一覧の中で特に目新しい・注目すべきキーワードやトピック名を2〜4個、短い単語・フレーズで挙げてください（説明文にせず単語だけ）。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"highlights": [{"author_handle": "@xxx", "text": "..."}], "new_terms": ["...", "..."]}

投稿一覧:
`;

export const H24_PROMPT = `あなたはXリストの更新ダイジェストを作る専門家です。以下は直近24時間に複数回に分けて取得された投稿の一覧です（@ハンドル名: テーマ）。

1回だけ登場した単発の話題ではなく、複数の投稿・複数のアカウントにまたがって繰り返し登場した話題や、勢いが増している話題を優先して、今日一日の傾向を2〜4文で総括してください（"summary"）。

さらに、その傾向を踏まえて、深掘りして調べる価値がありそうなキーワードやトピックを1つだけ具体的に提案してください（"advice"、1〜2文）。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"summary": "...", "advice": "..."}

投稿一覧:
`;

export const D7_PROMPT = `あなたはシニアライフアドバイザーです。以下は直近7日間の、Xリストの投稿の取得件数と未読件数の日別データです（投稿の内容そのものは含まれていません）。

このデータから読み取れる、閲覧・未読の傾向（未読が溜まりやすい曜日、既読ペースの変化など）を1〜2文で述べてください（"trend"）。話題の中身には一切触れず、あくまで数字から読み取れる行動パターンだけを扱ってください。

さらに、その傾向を踏まえて、無理なく続けられる生活習慣としてのアドバイスを1つ、やさしい口調で提案してください（"advice"、1〜2文）。説教くさくならないようにしてください。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"trend": "...", "advice": "..."}

日別データ:
`;

export const LAST_RUN_SCHEMA = {
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

export const H24_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    advice: { type: "STRING" },
  },
  required: ["summary", "advice"],
};

export const D7_SCHEMA = {
  type: "OBJECT",
  properties: {
    trend: { type: "STRING" },
    advice: { type: "STRING" },
  },
  required: ["trend", "advice"],
};

// JST暦日での日付/曜日ラベル。棒グラフの日別バケットをユーザーの体感時刻(JST)に揃えるため。
export function jstDateStr(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
}
export function jstWeekday(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", weekday: "short" }).format(d);
}

export function toLine(p: { author_handle: string; gist: string | null; content: string | null }): string {
  const text = p.gist ?? (p.content ?? "").slice(0, 80);
  return `@${p.author_handle}: ${text}`;
}

export const LEGACY_PURPOSE: Record<string, string> = { last_run: "digest", "24h": "digest24", "7d": "digest7" };
export const LEGACY_MAX_TOKENS: Record<string, number> = { last_run: 2048, "24h": 1024, "7d": 1024 };

export type LegacyGen = (
  purpose: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxOutputTokens: number,
) => Promise<Record<string, unknown>>; // 失敗時は throw

// 旧版と同じ形のクエリ結果を返す依存(supabase-js由来)
export interface LegacyDeps {
  gen: LegacyGen;
  now: () => number;
  latestRun(listName: string): Promise<{ started_at: string; finished_at: string } | null>;
  postsInRun(listName: string, startedAt: string, finishedAt: string): Promise<{ author_handle: string; gist: string | null; content: string | null }[]>;
  posts24h(listName: string, sinceIso: string): Promise<{ author_handle: string; gist: string | null; content: string | null }[]>;
  posts7d(listName: string, sinceIso: string): Promise<{ posted_at: string | null; fetched_at: string | null; is_read: boolean }[]>;
  upsertDigest(listName: string, periodType: string, body: unknown): Promise<void>;
}

export type LegacyResult = { skipped: true; reason: string } | { skipped?: false };

export async function runLegacy(deps: LegacyDeps, periodType: "last_run" | "24h" | "7d", listName: string): Promise<LegacyResult> {
  const purpose = LEGACY_PURPOSE[periodType];
  const maxTok = LEGACY_MAX_TOKENS[periodType];
  if (periodType === "last_run") {
    const run = await deps.latestRun(listName);
    if (!run) return { skipped: true, reason: "no fetch_runs row" };
    const posts = await deps.postsInRun(listName, run.started_at, run.finished_at);
    if (!posts || posts.length === 0) {
      await deps.upsertDigest(listName, "last_run", { highlights: [], new_terms: [], empty: true });
    } else {
      const lines = posts.map(toLine).join("\n");
      const result = await deps.gen(purpose, LAST_RUN_PROMPT + lines, LAST_RUN_SCHEMA, maxTok);
      await deps.upsertDigest(listName, "last_run", result);
    }
  } else if (periodType === "24h") {
    const since = new Date(deps.now() - 24 * 60 * 60 * 1000).toISOString();
    const posts = await deps.posts24h(listName, since);
    if (!posts || posts.length === 0) {
      await deps.upsertDigest(listName, "24h", { summary: "", advice: "", empty: true });
    } else {
      const lines = posts.map(toLine).join("\n");
      const result = await deps.gen(purpose, H24_PROMPT + lines, H24_SCHEMA, maxTok);
      await deps.upsertDigest(listName, "24h", result);
    }
  } else {
    const since = new Date(deps.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const posts = await deps.posts7d(listName, since);
    const now = new Date(deps.now());
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
      await deps.upsertDigest(listName, "7d", { daily: days, trend: "", advice: "", empty: true });
    } else {
      const result = await deps.gen(
        purpose,
        D7_PROMPT + JSON.stringify(days.map(({ date, weekday, total, unread }) => ({ date, weekday, total, unread }))),
        D7_SCHEMA,
        maxTok,
      );
      await deps.upsertDigest(listName, "7d", { ...result, daily: days });
    }
  }
  return {};
}
