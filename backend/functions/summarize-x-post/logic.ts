// summarize-x-post の純粋ロジック(DenoとNodeの両方で動く。外部依存なし)。
// プロンプト・分類・画像取得・response schema は改修前原本(backend/legacy/summarize-x-post.v7.ts)から一字一句そのまま。

export const SUMMARY_PROMPT = `あなたはX(Twitter)の投稿を要約する専門家です。次の投稿を読んで、日本語で以下の2つを作成してください。

1. gist: 「結局何の話か」が一目でわかるテーマ一言（15〜30字程度）。投稿者の相槌・感想コメントではなく、引用元記事や話題の主旨を掴んでください（例:「これは有料でUdemyで出すやつでしょ」ではなく「Google Workspace時短術の記事に『有料級』との反応」）。
2. summary: 2〜3文の「要するに」説明。本文を読まなくても要点がわかる文章。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "...", "summary": "..."}`;

// 短い英語投稿向け: 要約(意訳・言い換え・説明の追加)ではなく直訳のみを行う。
// 短い投稿を長く水増しして翻訳することを防ぐための専用プロンプト。
export const SHORT_EN_PROMPT = `あなたはX(Twitter)の短い英語投稿を日本語に翻訳する専門家です。次の投稿を、説明や背景を付け足さずに直訳してください。意訳・要約・解釈の追加はせず、原文の情報量をそのまま保った自然な日本語にしてください。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "直訳した日本語。30字程度に収まればそのまま、長ければ末尾を自然に短縮したもの", "summary": "直訳した日本語の全文"}`;

// 本文と添付画像を両方踏まえて要約するプロンプト。
// 本文が短い/ない場合は画像から読み取れる情報を中心にするよう指示する。
export const IMAGE_PROMPT = `あなたはX(Twitter)の投稿を要約する専門家です。次の投稿本文と添付画像を踏まえて、日本語で以下の2つを作成してください。本文が短い、または本文だけでは話の内容がわからない場合は、画像から読み取れる情報(写真の被写体、スクリーンショットの文面、グラフの傾向など)を中心にまとめてください。

1. gist: 「結局何の話か」が一目でわかるテーマ一言（15〜30字程度）。
2. summary: 2〜3文の「要するに」説明。画像を見なくても要点がわかる文章にしてください。

必ず次のJSON形式のみで出力してください（前置きや説明文は不要）:
{"gist": "...", "summary": "..."}`;

// 投稿本文を4種類に分類する。
// - empty: 本文なし
// - short_ja: 短い日本語投稿。画像がなければそれ自体が一目で読める分量なのでGeminiには渡さず原文をそのまま採用(コストゼロ)。
// - short_en: 短い英語投稿。直訳のみ行う。
// - long: 上記以外(長文・記事引用・スレッド等)。従来通りgist+summary要約を行う。
export function classifyContent(content: string): "empty" | "short_ja" | "short_en" | "long" {
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
export function needsImageAnalysis(kind: string, hasImages: boolean): boolean {
  return hasImages && kind !== "long";
}

// Xの画像CDN URLは`name=`パラメータでサイズを指定できる。
// トークン消費を押さえるため、解析には小さい縮小版(small)だけを取得する(元画像は保存しない)。
// X以外のホストには適用しない(クエリパラメータの仕様が違い、不正なリクエストになりうるため)。
export function toSmallVariant(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("twimg.com")) return url;
    u.searchParams.set("name", "small");
    return u.toString();
  } catch {
    return url;
  }
}

const IMAGE_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function fetchImageAsInlineData(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    // 応答しない/巨大な画像で関数全体(実行上限約150秒・メモリ)を巻き込まない
    const res = await fetchFn(toSmallVariant(url), { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
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

export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    gist: { type: "STRING" },
    summary: { type: "STRING" },
  },
  required: ["gist", "summary"],
};

// ---- ここから下は改修で追加した部分(原本の判定の流れは保つ) ----

export const MAX_OUTPUT_TOKENS_TEXT = 600;
export const MAX_OUTPUT_TOKENS_IMAGE = 1000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 60;

// 原本の callGemini 内のプロンプト組み立てと同一。
export function buildFullPrompt(
  promptTemplate: string,
  authorHandle: string,
  authorName: string,
  content: string,
): string {
  return `${promptTemplate}\n\n投稿者: ${authorName} (${authorHandle})\n本文:\n${content || "(本文なし。画像のみの投稿)"}`;
}

export type InlineImage = { mimeType: string; data: string };
export type SummaryPart = { text: string } | { inlineData: InlineImage };
export type SummaryGen = (
  parts: SummaryPart[],
  opts: { maxOutputTokens: number },
) => Promise<{ ok: true; json: unknown } | { ok: false; error: string; kind?: string; status?: number }>;

export interface SummaryPost {
  post_url: string;
  author_handle: string;
  author_name?: string | null;
  content?: string | null;
  image_urls?: unknown;
}
export type SummarizeOutcome =
  | { ok: true; gist: string; summary: string; usedGemini: boolean }
  | { ok: false; error: string; kind?: string; status?: number };

// summary_attempts に数える「恒久的な失敗」か。
// 数える: Gemini の 4xx(429と認証系を除く=要求自体が通らない) / 応答が空 / JSONや形が不正(parse・empty)。
// 数えない: 認証系(auth: 鍵の誤設定・請求停止で全投稿が失敗するため。実行も打ち切る)・
//   通信失敗(network)・429/5xx・提供終了(gone)・モデル状態/費用ガードの取得失敗や拒否(guard)・
//   DB保存の失敗など、再試行すれば通る可能性があるもの(試行回数を消費して投稿が永久に未処理になるのを防ぐ)。
export function isPermanentFailure(f: { kind?: string; status?: number }): boolean {
  if (f.kind === "parse" || f.kind === "empty") return true;
  if (f.kind === "http") {
    const st = f.status;
    return typeof st === "number" && st >= 400 && st < 500 && st !== 429 && st !== 401 && st !== 403;
  }
  return false;
}

function readSummaryJson(json: unknown): { gist: string; summary: string } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.gist !== "string" || typeof o.summary !== "string") return null;
  return { gist: o.gist, summary: o.summary };
}

// 原本のループ本体(分岐の流れそのまま)。Gemini呼び出し・画像取得は注入する。
export async function summarizeOne(
  post: SummaryPost,
  deps: { gen: SummaryGen; fetchImage?: (url: string) => Promise<InlineImage | null> },
): Promise<SummarizeOutcome> {
  const fetchImage = deps.fetchImage ?? ((u: string) => fetchImageAsInlineData(u));
  const content = post.content ?? "";
  const kind = classifyContent(content);
  const imageUrls = (Array.isArray(post.image_urls) ? post.image_urls : []).slice(0, 4) as string[];
  const hasImages = imageUrls.length > 0;
  const authorName = post.author_name ?? "";

  const callModel = async (
    promptTemplate: string,
    images: InlineImage[],
  ): Promise<SummarizeOutcome> => {
    const parts: SummaryPart[] = [{ text: buildFullPrompt(promptTemplate, post.author_handle, authorName, content) }];
    for (const img of images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    const r = await deps.gen(parts, {
      maxOutputTokens: images.length > 0 ? MAX_OUTPUT_TOKENS_IMAGE : MAX_OUTPUT_TOKENS_TEXT,
    });
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind, ...(r.status !== undefined ? { status: r.status } : {}) };
    const s = readSummaryJson(r.json);
    if (!s) return { ok: false, error: "unexpected summary shape", kind: "parse" };
    return { ok: true, gist: s.gist, summary: s.summary, usedGemini: true };
  };

  const shortJa = (): SummarizeOutcome => {
    const text = content.trim();
    return { ok: true, gist: text.length > 60 ? text.slice(0, 60) : text, summary: text, usedGemini: false };
  };

  if (needsImageAnalysis(kind, hasImages)) {
    const fetched = (await Promise.all(imageUrls.map((u) => fetchImage(u))))
      .filter((img): img is InlineImage => img !== null);
    if (fetched.length > 0) return await callModel(IMAGE_PROMPT, fetched);
    if (kind === "short_ja") return shortJa();
    return await callModel(kind === "short_en" ? SHORT_EN_PROMPT : SUMMARY_PROMPT, []);
  }
  if (kind === "short_ja") return shortJa();
  return await callModel(kind === "short_en" ? SHORT_EN_PROMPT : SUMMARY_PROMPT, []);
}

// limit は既定20・上限60。post_url指定なら1件。
export function resolveLimit(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

// 認証判定の後に呼ぶ。秘密なし(log許可)の呼び出しは post_url 指定不可。
export function checkUnauthRestrictions(limited: boolean, body: { post_url?: unknown }): string | null {
  if (limited && body.post_url) return "post_url requires a pipeline secret";
  return null;
}
