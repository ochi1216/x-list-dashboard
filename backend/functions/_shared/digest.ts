// 今日の要点(today)・今週の流れ(week)の純粋ロジック。外部依存なし(Gemini呼び出し・DBは引数で注入)。
// 検査(数値・英字/カタカナ固有名・日付が引用カードの本文に在るか)もここに置く。

export const DIGEST_VERSION = 1;
export const MAX_TOPICS = 4;
export const MAX_CARDS = 40;
const HOUR_MS = 3600_000;

// ---------- 日付(02:00 JST区切り) ----------

// 02:00 JST区切りの「日」(YYYY-MM-DD)。JST=UTC+9、区切り2時間なので now+7h のUTC暦日。
export function digestDay(nowMs: number): string {
  return new Date(nowMs + 7 * HOUR_MS).toISOString().slice(0, 10);
}
// その日の開始(02:00 JST)の絶対時刻ms
export function digestDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - 7 * HOUR_MS;
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}
// 週の月曜(02:00 JST区切りの日付ベース)
export function weekStartOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0=日
  return addDays(day, -((dow + 6) % 7));
}

// ---------- エラー無害化 ----------
export function safeErr(e: unknown): string {
  let s = e instanceof Error ? e.message : String(e);
  s = s.replace(/AIza[0-9A-Za-z_\-]{6,}/g, "[redacted]").replace(/([?&;\s"']|^)key=[^&\s"']+/gi, "$1key=[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

// ---------- 正規化・トークン抽出 ----------

export function norm(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1") // 桁区切りカンマ(繰り返し適用)
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
}

const UNIT: Record<string, number> = { "千": 1e3, "万": 1e4, "億": 1e8, "兆": 1e12 };
const NUM_RE = /(\d+(?:\.\d+)?)\s*([千万億兆])?\s*(%|パーセント|percent)?/gi;

export interface NumTok { v: number; pct: boolean }
function numKey(v: number, pct: boolean): string {
  return `${Number(v.toPrecision(10))}|${pct ? 1 : 0}`;
}
export function extractNumbers(text: string): NumTok[] {
  const out: NumTok[] = [];
  const t = norm(text);
  for (const m of t.matchAll(NUM_RE)) {
    const base = parseFloat(m[1]);
    if (!Number.isFinite(base)) continue;
    out.push({ v: base * (m[2] ? UNIT[m[2]] : 1), pct: !!m[3] });
  }
  return out;
}

export interface DateTok { y?: number; m?: number; d?: number; kind: "ymd" | "md" | "m" | "d" }
// 日付表現を抽出し、抽出した部分を取り除いた残りも返す(残りは数値検査へ)
export function extractDates(text: string): { dates: DateTok[]; rest: string } {
  let t = norm(text);
  const dates: DateTok[] = [];
  const take = (re: RegExp, f: (m: RegExpMatchArray) => DateTok) => {
    t = t.replace(re, (...args) => {
      const m = args.slice(0, args.length - 2) as unknown as RegExpMatchArray;
      dates.push(f(m));
      return " ";
    });
  };
  take(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, (m) => ({ y: +m[1], m: +m[2], d: +m[3], kind: "ymd" }));
  take(/(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?!\d)/g, (m) => ({ y: +m[1], m: +m[2], d: +m[3], kind: "ymd" }));
  take(/(\d{1,2})月(\d{1,2})日/g, (m) => ({ m: +m[1], d: +m[2], kind: "md" }));
  take(/(?<![\d\/])(\d{1,2})\/(\d{1,2})(?![\d\/])/g, (m) => ({ m: +m[1], d: +m[2], kind: "md" }));
  take(/(\d{1,2})月/g, (m) => ({ m: +m[1], kind: "m" }));
  take(/(?<![\d.])(\d{1,2})日(?!間)/g, (m) => ({ d: +m[1], kind: "d" }));
  return { dates, rest: t };
}

const LATIN_RE = /[a-z][a-z0-9]*(?:[.\-'][a-z0-9]+)*/g;
const KATA_RE = /[ァ-ヶ][ァ-ヶー]+/g;
// 固有名ではない一般的なカタカナ語(これだけでは削除しない)
export const KATAKANA_STOP = new Set([
  "ニュース", "サービス", "ユーザー", "データ", "システム", "ツール", "アプリ", "ソフト", "ソフトウェア",
  "ネット", "インターネット", "コンテンツ", "テーマ", "トピック", "ポイント", "アカウント", "ポスト",
  "コメント", "メッセージ", "プロジェクト", "ビジネス", "マーケット", "トレンド", "リスク", "ルール",
  "モデル", "テスト", "サイト", "ページ", "リンク", "ファイル", "カード", "チーム", "メリット", "デメリット",
  "アップデート", "リリース", "スタート", "ケース", "タイプ", "レベル", "イメージ", "アイデア", "ヒント",
]);

export function extractLatin(text: string): string[] {
  return (norm(text).toLowerCase().match(LATIN_RE) ?? []).filter((w) => w.length >= 2);
}
export function extractKatakana(text: string): string[] {
  return (norm(text).match(KATA_RE) ?? []).filter((w) => w.length >= 2 && !KATAKANA_STOP.has(w));
}

// ---------- 検査 ----------

export interface Corpus {
  text: string; // norm済み・小文字
  nums: Set<string>;
  dates: DateTok[];
}
export function buildCorpus(texts: string[]): Corpus {
  const joined = texts.join("\n");
  const text = norm(joined).toLowerCase();
  const nums = new Set<string>();
  for (const n of extractNumbers(joined)) nums.add(numKey(n.v, n.pct));
  return { text, nums, dates: extractDates(joined).dates };
}

function dateOk(dt: DateTok, c: Corpus): boolean {
  if (dt.kind === "m") return c.text.includes(`${dt.m}月`);
  if (dt.kind === "d") return c.text.includes(`${dt.d}日`);
  return c.dates.some((cd) =>
    cd.m === dt.m && cd.d === dt.d && (dt.y === undefined || cd.y === undefined || cd.y === dt.y)
  );
}
function numOk(n: NumTok, c: Corpus): boolean {
  if (c.nums.has(numKey(n.v, n.pct))) return true;
  // 主張が%なしの数値で、本文に同値が%付きで在る場合は許容
  return !n.pct && c.nums.has(numKey(n.v, true));
}

// 文(見出し・要約の1文・new_fact)が本文コーパスで裏付けられるか。理由つきで返す。
export function checkClaim(claim: string, c: Corpus): { ok: boolean; reason?: string } {
  const { dates, rest } = extractDates(claim);
  for (const dt of dates) if (!dateOk(dt, c)) return { ok: false, reason: "date" };
  for (const n of extractNumbers(rest)) if (!numOk(n, c)) return { ok: false, reason: "number" };
  for (const w of extractLatin(rest)) if (!c.text.includes(w)) return { ok: false, reason: "latin" };
  for (const w of extractKatakana(rest)) if (!c.text.includes(w)) return { ok: false, reason: "katakana" };
  return { ok: true };
}

export function splitSentences(s: string): string[] {
  return (s ?? "").split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
}

// ---------- today ----------

export interface Card {
  post_url: string;
  gist: string | null;
  summary: string | null;
  content: string | null;
  score: number | null;
  scored_at: string | null;
  fetched_at: string | null;
  image_urls: string[] | null;
}
export interface Topic {
  headline: string;
  summary: string;
  new_facts: string[];
  card_urls: string[];
  is_followup: boolean;
}
export interface DailyRow {
  day: string;
  generated_at: string;
  model: string | null;
  status: string;
  topics: unknown;
  input_count: number;
  dropped_ratio: number;
  version: number;
}
export interface WeekRow {
  week_start: string;
  generated_at: string;
  status: string;
  themes: unknown;
  days_covered: number;
}

// 本文コーパス: 本文。画像あり投稿のみ要約・要旨も可(画像から読み取った情報は本文に無いため)。
export function cardCorpusTexts(c: Card): string[] {
  const t = [c.content ?? ""];
  if (c.image_urls && c.image_urls.length > 0) t.push(c.gist ?? "", c.summary ?? "");
  return t;
}

export const TODAY_SCHEMA = {
  type: "OBJECT",
  properties: {
    topics: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          headline: { type: "STRING" },
          summary: { type: "STRING" },
          new_facts: { type: "ARRAY", items: { type: "STRING" } },
          card_urls: { type: "ARRAY", items: { type: "STRING" } },
          is_followup: { type: "BOOLEAN" },
        },
        required: ["headline", "summary", "new_facts", "card_urls", "is_followup"],
      },
    },
  },
  required: ["topics"],
};

const TODAY_PROMPT = `あなたはXリストの「今日の要点」を作る編集者です。以下は今日の投稿のうち重要度の高いもの(カード)です。
カードに書かれている内容だけを根拠に、話題を最大4件にまとめてください。

ルール:
- headline: 20字以内の見出し。
- summary: 2文・120字以内。要するに何が起きたか。
- new_facts: その話題の新しい事実を短い1文ずつ(数値・固有名・日付はカード本文にあるものだけ)。
- card_urls: 根拠にしたカードのURL(下の「URL:」の値をそのまま写す)。1件以上。
- is_followup: 前日までの続報なら true、そうでなければ false。
- カードに書かれていない数値・固有名詞・日付・原因・評価を創作しないこと。推測や助言は書かない。
- 同じ話題のカードは1つにまとめる。

カード一覧:
`;

const RETRY_NOTE = `\n\n(注意)前回の出力は見出しにカード本文に無い数値・固有名・日付が含まれていました。見出しにはカード本文にある語だけを使ってください。`;

export function buildTodayPrompt(cards: Card[], retry = false): string {
  const lines = cards.map((c, i) => {
    const parts = [
      `[${i + 1}] score=${c.score ?? "-"}`,
      `URL: ${c.post_url}`,
      `要旨: ${c.gist ?? ""}`,
      `要約: ${c.summary ?? ""}`,
      `本文: ${(c.content ?? "").replace(/\s+/g, " ").slice(0, 1200)}`,
    ];
    return parts.join("\n");
  });
  return TODAY_PROMPT + lines.join("\n\n") + (retry ? RETRY_NOTE : "");
}

export function selectCards(cards: Card[]): Card[] {
  return cards
    .filter((c) => (c.score ?? 0) >= 3 && c.post_url)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.scored_at ?? "").localeCompare(a.scored_at ?? ""))
    .slice(0, MAX_CARDS);
}

export interface TodayValidation {
  topics: Topic[];
  total: number; // 検査単位の総数(見出し+要約文+new_facts)
  dropped: number; // 削除された単位の数(破棄された話題の分を含む)
  headlineFailed: number; // 見出しが落ちた話題の数(再生成の判断用)
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// 生成結果(未検査)を検査し、本文に無い文を削除する。
export function validateTopics(raw: unknown, cards: Card[]): TodayValidation {
  const byUrl = new Map(cards.map((c) => [c.post_url, c]));
  const list = Array.isArray(raw) ? (raw as unknown[]).slice(0, MAX_TOPICS) : [];
  const out: Topic[] = [];
  let total = 0, dropped = 0, headlineFailed = 0;
  for (const r of list) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const headline = asStr(o.headline).trim();
    const sentences = splitSentences(asStr(o.summary));
    const facts = (Array.isArray(o.new_facts) ? o.new_facts : []).map(asStr).map((s) => s.trim()).filter(Boolean);
    const urls = [...new Set((Array.isArray(o.card_urls) ? o.card_urls : []).map(asStr))].filter((u) => byUrl.has(u));
    const units = 1 + sentences.length + facts.length;
    total += units;
    if (!headline || urls.length === 0) {
      dropped += units;
      if (!headline) headlineFailed++;
      continue;
    }
    const corpus = buildCorpus(urls.flatMap((u) => cardCorpusTexts(byUrl.get(u)!)));
    if (!checkClaim(headline, corpus).ok) {
      dropped += units;
      headlineFailed++;
      continue;
    }
    const keptSent = sentences.filter((s) => checkClaim(s, corpus).ok);
    const keptFacts = facts.filter((s) => checkClaim(s, corpus).ok);
    dropped += (sentences.length - keptSent.length) + (facts.length - keptFacts.length);
    if (keptSent.length === 0) { // 要約が空になった話題は成立しない
      dropped += 1 + keptFacts.length;
      continue;
    }
    out.push({
      headline,
      summary: keptSent.slice(0, 2).join(""),
      new_facts: keptFacts,
      card_urls: urls,
      is_followup: o.is_followup === true,
    });
  }
  return { topics: out, total, dropped, headlineFailed };
}

// ---------- 注入する依存 ----------

export interface GenReq {
  purpose: string;
  parts: { text: string }[];
  schema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
}
export type GenRes =
  | { ok: true; text: string; json: unknown | null; model: string }
  | { ok: false; kind: string; error: string; status?: number; model?: string };

export interface DigestDeps {
  now: () => number;
  gen: (req: GenReq) => Promise<GenRes>;
  cfgNum: (key: string, def: number) => Promise<number>;
  loadCards: (startIso: string, endIso: string) => Promise<Card[]>;
  getDaily: (day: string) => Promise<DailyRow | null>;
  listDaily: (fromDay: string, toDay: string) => Promise<DailyRow[]>;
  upsertDaily: (row: DailyRow) => Promise<void>;
  getWeek: (weekStart: string) => Promise<WeekRow | null>;
  upsertWeek: (row: WeekRow) => Promise<void>;
  opsEvent: (level: "info" | "warn" | "error", kind: string, message: string, data: Record<string, unknown>, dedupeMinutes: number) => Promise<void>;
}

function genJson(r: GenRes & { ok: true }): unknown {
  if (r.json !== null && r.json !== undefined) return r.json;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

export const FAILED_MESSAGE = "生成できません";
export const DROP_WARN_RATIO = 0.2;

export interface TodayResult {
  ok: boolean;
  mode: "today";
  status?: "ok" | "empty" | "failed" | "paused";
  skipped?: boolean;
  reason?: string;
  day: string;
  topics?: number;
  input_count?: number;
  dropped_ratio?: number;
  message?: string;
  error?: string;
}

export async function runToday(deps: DigestDeps): Promise<TodayResult> {
  const nowMs = deps.now();
  const day = digestDay(nowMs);
  const startMs = digestDayStartMs(day);
  const [minNew, minHours] = await Promise.all([
    deps.cfgNum("digest_min_new_scored", 5),
    deps.cfgNum("digest_min_interval_hours", 6),
  ]);
  const all = await deps.loadCards(new Date(startMs).toISOString(), new Date(startMs + 86400_000).toISOString());
  const cards = selectCards(all);
  const prev = await deps.getDaily(day);

  // 前回生成(paused は生成していないので除く)
  const baseline = prev && prev.status !== "paused" && prev.generated_at ? Date.parse(prev.generated_at) : null;
  const eligible = all.filter((c) => (c.score ?? 0) >= 3);
  const newCount = baseline === null
    ? eligible.length
    : eligible.filter((c) => Date.parse(c.scored_at ?? c.fetched_at ?? "") > baseline).length;
  if (newCount < minNew) return { ok: true, mode: "today", skipped: true, reason: "few_new", day, input_count: cards.length };
  if (baseline !== null && nowMs - baseline < minHours * HOUR_MS) {
    return { ok: true, mode: "today", skipped: true, reason: "interval", day, input_count: cards.length };
  }

  const save = async (status: "ok" | "empty" | "failed" | "paused", topics: Topic[], model: string | null, ratio: number) => {
    // paused は生成していない。既に生成済みの行(ok/empty/failed)は上書きしない。
    if (status === "paused" && prev && prev.status !== "paused") return;
    await deps.upsertDaily({
      day,
      generated_at: new Date(deps.now()).toISOString(),
      model,
      status,
      topics,
      input_count: cards.length,
      dropped_ratio: ratio,
      version: DIGEST_VERSION,
    });
  };

  let model: string | null = null;
  const call = (retry: boolean) =>
    deps.gen({
      purpose: "digest",
      parts: [{ text: buildTodayPrompt(cards, retry) }],
      schema: TODAY_SCHEMA,
      maxOutputTokens: 3000,
      temperature: 0.2,
    });

  const g1 = await call(false);
  if (!g1.ok) {
    if (g1.kind === "guard") {
      await save("paused", [], null, 0);
      return { ok: true, mode: "today", status: "paused", day, input_count: cards.length };
    }
    return { ok: false, mode: "today", day, error: safeErr(g1.error) };
  }
  model = g1.model;
  const j1 = genJson(g1) as { topics?: unknown } | null;
  let v = validateTopics(j1?.topics, cards);

  // 見出しが落ちたら1回だけ再生成
  if (v.headlineFailed > 0) {
    const g2 = await call(true);
    if (g2.ok) {
      model = g2.model;
      const j2 = genJson(g2) as { topics?: unknown } | null;
      v = validateTopics(j2?.topics, cards);
    }
  }

  const ratio = v.total === 0 ? 0 : Math.round((v.dropped / v.total) * 10000) / 10000;
  if (ratio > DROP_WARN_RATIO) {
    await deps.opsEvent("warn", "digest_dropped", `今日の要点: 検査で${Math.round(ratio * 100)}%を削除`, { day, ratio, total: v.total, dropped: v.dropped }, 360);
  }
  if (v.topics.length === 0) {
    const emptyOut = v.total === 0; // モデルが話題なしと返した(検査で全滅したのではない)
    const status = emptyOut ? "empty" : "failed";
    await save(status, [], model, ratio);
    if (!emptyOut) {
      await deps.opsEvent("warn", "digest_failed", "今日の要点: 検査で全話題が破棄された", { day, ratio }, 360);
    }
    return { ok: true, mode: "today", status, day, topics: 0, input_count: cards.length, dropped_ratio: ratio, message: emptyOut ? undefined : FAILED_MESSAGE };
  }
  await save("ok", v.topics, model, ratio);
  return { ok: true, mode: "today", status: "ok", day, topics: v.topics.length, input_count: cards.length, dropped_ratio: ratio };
}

// ---------- week ----------

export interface Theme { title: string; summary: string; day_refs: string[] }

export const WEEK_SCHEMA = {
  type: "OBJECT",
  properties: {
    themes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          summary: { type: "STRING" },
          day_refs: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "summary", "day_refs"],
      },
    },
  },
  required: ["themes"],
};

const WEEK_PROMPT = `あなたはXリストの「今週の流れ」を作る編集者です。以下は直近の日ごとの「今日の要点」です。
日をまたいで繰り返し現れた話題・勢いが続いた話題を、2〜3個のテーマにまとめてください。

ルール:
- title: 20字以内。
- summary: 2文・120字以内。何がどう続いたか。
- day_refs: 根拠にした日付(下の日付をそのまま)。1つ以上。
- 日ごとの要点に書かれていない数値・固有名詞・日付を創作しないこと。
- 生活や行動についての助言・提案は書かない。話題の内容だけを書く。

日ごとの要点:
`;

export function topicsOf(row: DailyRow): Topic[] {
  return Array.isArray(row.topics) ? (row.topics as Topic[]).filter((t) => t && typeof t.headline === "string") : [];
}

export function buildWeekPrompt(days: { day: string; topics: Topic[] }[]): string {
  const blocks = days.map((d) =>
    `## ${d.day}\n` + d.topics.map((t) => `- ${t.headline}: ${t.summary}${t.new_facts.length ? ` (${t.new_facts.join(" / ")})` : ""}`).join("\n")
  );
  return WEEK_PROMPT + blocks.join("\n\n");
}

export interface WeekValidation { themes: Theme[]; total: number; dropped: number }
export function validateThemes(raw: unknown, days: { day: string; topics: Topic[] }[]): WeekValidation {
  const dayTexts = new Map(days.map((d) => [d.day, d.topics.flatMap((t) => [t.headline, t.summary, ...t.new_facts])]));
  const list = Array.isArray(raw) ? (raw as unknown[]).slice(0, 3) : [];
  const out: Theme[] = [];
  let total = 0, dropped = 0;
  for (const r of list) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const title = asStr(o.title).trim();
    const sentences = splitSentences(asStr(o.summary));
    const refs = [...new Set((Array.isArray(o.day_refs) ? o.day_refs : []).map(asStr))].filter((d) => dayTexts.has(d)).sort();
    const units = 1 + sentences.length;
    total += units;
    if (!title || refs.length === 0) { dropped += units; continue; }
    const corpus = buildCorpus(refs.flatMap((d) => dayTexts.get(d)!));
    if (!checkClaim(title, corpus).ok) { dropped += units; continue; }
    const kept = sentences.filter((s) => checkClaim(s, corpus).ok);
    dropped += sentences.length - kept.length;
    if (kept.length === 0) { dropped += 1; continue; }
    out.push({ title, summary: kept.slice(0, 2).join(""), day_refs: refs });
  }
  return { themes: out, total, dropped };
}

export interface WeekResult {
  ok: boolean;
  mode: "week";
  status?: "ok" | "accumulating" | "failed" | "paused";
  skipped?: boolean;
  reason?: string;
  week_start: string;
  days_covered?: number;
  themes?: number;
  dropped_ratio?: number;
  message?: string;
  error?: string;
}

export const WEEK_MIN_DAYS = 3;

export async function runWeek(deps: DigestDeps): Promise<WeekResult> {
  const nowMs = deps.now();
  const today = digestDay(nowMs);
  const weekStart = weekStartOf(today);
  const rows = await deps.listDaily(addDays(today, -6), today);
  const days = rows
    .filter((r) => r.status === "ok")
    .map((r) => ({ day: r.day, topics: topicsOf(r) }))
    .filter((d) => d.topics.length > 0)
    .sort((a, b) => a.day.localeCompare(b.day));
  const covered = days.length;
  const nowIso = () => new Date(deps.now()).toISOString();
  const prev = await deps.getWeek(weekStart);

  if (covered < WEEK_MIN_DAYS) {
    await deps.upsertWeek({ week_start: weekStart, generated_at: nowIso(), status: "accumulating", themes: [], days_covered: covered });
    return { ok: true, mode: "week", status: "accumulating", week_start: weekStart, days_covered: covered };
  }
  const minHours = await deps.cfgNum("digest_min_interval_hours", 6);
  if (prev && prev.status === "ok" && prev.days_covered === covered && prev.generated_at &&
      nowMs - Date.parse(prev.generated_at) < minHours * HOUR_MS) {
    return { ok: true, mode: "week", skipped: true, reason: "interval", week_start: weekStart, days_covered: covered };
  }

  const g = await deps.gen({
    purpose: "digest",
    parts: [{ text: buildWeekPrompt(days) }],
    schema: WEEK_SCHEMA,
    maxOutputTokens: 2000,
    temperature: 0.2,
  });
  if (!g.ok) {
    if (g.kind === "guard") {
      if (!prev || prev.status === "paused" || prev.status === "accumulating") {
        await deps.upsertWeek({ week_start: weekStart, generated_at: nowIso(), status: "paused", themes: [], days_covered: covered });
      }
      return { ok: true, mode: "week", status: "paused", week_start: weekStart, days_covered: covered };
    }
    return { ok: false, mode: "week", week_start: weekStart, days_covered: covered, error: safeErr(g.error) };
  }
  const j = genJson(g) as { themes?: unknown } | null;
  const v = validateThemes(j?.themes, days);
  const ratio = v.total === 0 ? 0 : Math.round((v.dropped / v.total) * 10000) / 10000;
  if (ratio > DROP_WARN_RATIO) {
    await deps.opsEvent("warn", "digest_week_dropped", `今週の流れ: 検査で${Math.round(ratio * 100)}%を削除`, { week_start: weekStart, ratio }, 360);
  }
  const status = v.themes.length > 0 ? "ok" : "failed";
  await deps.upsertWeek({ week_start: weekStart, generated_at: nowIso(), status, themes: v.themes, days_covered: covered });
  return {
    ok: true, mode: "week", status, week_start: weekStart, days_covered: covered, themes: v.themes.length, dropped_ratio: ratio,
    message: status === "failed" ? FAILED_MESSAGE : undefined,
  };
}
