// 今日の要点(today)・今週の流れ(week)の純粋ロジック。外部依存なし(Gemini呼び出し・DBは引数で注入)。
// 検査(数値・漢数字・英字/カタカナ/漢字の固有名・日付が引用カードの本文に在るか)もここに置く。

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

const UNIT: Record<string, number> = { "百": 1e2, "千": 1e3, "万": 1e4, "億": 1e8, "兆": 1e12 };
// 算用数字+単位(千万・百万などの連なりは掛け合わせる: 3千万=3×1000×10000)
const NUM_RE = /(\d+(?:\.\d+)?)\s*([百千万億兆]+)?\s*(%|パーセント|percent)?/gi;

export interface NumTok { v: number; pct: boolean }
function numKey(v: number, pct: boolean): string {
  return `${Number(v.toPrecision(10))}|${pct ? 1 : 0}`;
}
function unitProduct(units: string | undefined): number {
  let p = 1;
  for (const ch of units ?? "") p *= UNIT[ch] ?? 1;
  return p;
}

// ---- 漢数字(三千万円・一万二千・二〇二六 など)を算用数字へ ----
const KNUM_DIGIT: Record<string, number> = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
const KNUM_SMALL: Record<string, number> = { "十": 10, "百": 100, "千": 1000 };
const KNUM_BIG: Record<string, number> = { "万": 1e4, "億": 1e8, "兆": 1e12 };
const KNUM_RE = /[〇零一二三四五六七八九十百千万億兆]{2,}/g;

// 漢数字の並び→数値。数として読めない並び(万一 など)は null。
export function parseKanjiNumeral(seq: string): number | null {
  const chars = [...seq];
  if (chars.every((ch) => ch in KNUM_DIGIT)) { // 位取り(二〇二六)
    return Number(chars.map((ch) => KNUM_DIGIT[ch]).join(""));
  }
  let total = 0, section = 0;
  let cur: number | null = null;
  for (const ch of chars) {
    if (ch in KNUM_DIGIT) {
      if (cur !== null) return null;
      cur = KNUM_DIGIT[ch];
    } else if (ch in KNUM_SMALL) {
      section += (cur ?? 1) * KNUM_SMALL[ch];
      cur = null;
    } else {
      section += cur ?? 0;
      if (section === 0) return null; // 万一 のように大きい単位から始まる並び
      total += section * KNUM_BIG[ch];
      section = 0;
      cur = null;
    }
  }
  return total + section + (cur ?? 0);
}

// 数値(算用数字+単位・漢数字)を抽出し、抽出した部分を取り除いた残りも返す。
// 「1万2000」のような万・億・兆の直後に続く小さい数は、足した値(12000)で数える。
//  merged=false(本文コーパス): 部分(10000, 2000)と合算(12000)をすべて数える
//  merged=true(主張): 合算だけを数える(本文が「12,000円」でも「1万2000円」でも通す)
export function numberTokens(text: string, merged = false): { toks: NumTok[]; rest: string } {
  const t0 = norm(text);
  interface Item { v: number; pct: boolean; big: number; start: number; end: number }
  const items: Item[] = [];
  for (const m of t0.matchAll(NUM_RE)) {
    const base = parseFloat(m[1]);
    if (!Number.isFinite(base)) continue;
    const units = m[2] ?? "";
    const lastUnit = units.length > 0 ? units[units.length - 1] : "";
    const start = m.index ?? 0;
    items.push({ v: base * unitProduct(units), pct: !!m[3], big: KNUM_BIG[lastUnit] ?? 0, start, end: start + m[0].length });
  }
  const toks: NumTok[] = [];
  for (let i = 0; i < items.length; i++) {
    let acc = items[i];
    while (acc.big > 0 && !acc.pct && i + 1 < items.length) {
      const nx = items[i + 1];
      if (!/^\s*$/.test(t0.slice(acc.end, nx.start)) || nx.v >= acc.big) break;
      if (!merged) toks.push({ v: acc.v, pct: false });
      acc = { v: acc.v + nx.v, pct: nx.pct, big: nx.big, start: acc.start, end: nx.end };
      i++;
    }
    toks.push({ v: acc.v, pct: acc.pct });
  }
  let t = t0.replace(NUM_RE, " ");
  t = t.replace(KNUM_RE, (...args) => {
    const m0 = args[0] as string;
    const off = args[args.length - 2] as number;
    const before = off > 0 ? (args[args.length - 1] as string)[off - 1] : "";
    if (before === "数" || before === "何" || before === "幾") return m0; // 概数(数千万円 など)は対象外
    const v = parseKanjiNumeral(m0);
    if (v === null) return m0;
    toks.push({ v, pct: false });
    return " ";
  });
  return { toks, rest: t };
}
export function extractNumbers(text: string): NumTok[] {
  return numberTokens(text).toks;
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

// ---- 漢字の語(固有名の幻覚検知) ----
const KANJI_RUN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF々]{2,}/g;
// 固有名ではない一般的な漢字語(これだけでは削除しない)
export const KANJI_STOP = new Set([
  "発表", "決定", "開始", "公開", "提供", "発売", "実施", "開催", "登場", "変更", "追加", "対応", "利用", "可能",
  "影響", "問題", "結果", "状況", "今後", "今回", "現在", "以上", "以下", "以降", "以前", "以内", "以外", "最新",
  "新規", "情報", "話題", "内容", "全体", "関連", "関係", "重要", "注目", "発生", "確認", "報告", "報道", "説明",
  "紹介", "解説", "投稿", "公式", "企業", "会社", "業界", "市場", "技術", "開発", "研究", "製品", "機能", "性能",
  "価格", "料金", "無料", "有料", "導入", "活用", "改善", "向上", "強化", "拡大", "増加", "減少", "上昇", "下落",
  "成長", "予定", "予想", "計画", "方針", "方法", "理由", "目的", "成功", "失敗", "参加", "協力", "提携", "買収",
  "合意", "契約", "展開", "運用", "管理", "調査", "分析", "評価", "比較", "検討", "検証", "実現", "実装", "搭載",
  "採用", "一般", "同時", "同様", "各社", "世界", "日本", "国内", "海外", "今日", "本日", "昨日", "明日", "今朝",
  "今夜", "午前", "午後", "週末", "年末", "年初", "月末", "月初", "今週", "来週", "先週", "今月", "来月", "先月",
  "今年", "昨年", "来年", "毎日", "毎週", "毎月", "毎年", "曜日", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜",
  "日曜", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日", "日曜日", "人工知能", "機械学習", "深層学習",
  "言語", "生成", "大規模", "自動", "画像", "動画", "音声", "検索", "推論", "学習", "精度", "速度", "無償", "公表",
  "判明", "見込", "検出", "実証", "試験", "運営", "提案", "支援", "構築", "設計", "更新", "改定", "改良", "修正",
  "削除", "廃止", "終了", "停止", "再開", "継続", "維持", "達成", "到達", "記録", "更改", "一部", "全員", "全社",
  "多数", "複数", "各種", "主要", "最大", "最小", "最高", "最低", "従来", "以後", "今季", "本年", "当面", "引き",
]);
// 漢字語の前後に付く1字(新製品・利用者・最新版 など)。語として単独では固有名にならない。
const KANJI_AFFIX = new Set([...("新旧全各本同今前後次最約他再未非無不超大小高低多少初計総諸両第主副元現的化性者型版側中内外間用員")]);

export function extractKanjiRuns(text: string, minLen: number): string[] {
  return (norm(text).match(KANJI_RUN_RE) ?? []).filter((w) => [...w].length >= minLen);
}

// 漢字の連なりが「ストップ語・本文に在る部分・接頭接尾の1字」だけで分割できれば根拠あり。
function kanjiRunOk(run: string, c: Corpus): boolean {
  const ch = [...run];
  const n = ch.length;
  const okAt: boolean[] = new Array(n + 1).fill(false);
  okAt[0] = true;
  for (let i = 0; i < n; i++) {
    if (!okAt[i]) continue;
    for (let j = i + 1; j <= n; j++) {
      const seg = ch.slice(i, j).join("");
      if (j - i === 1) {
        if (KANJI_AFFIX.has(seg)) okAt[j] = true;
      } else if (KANJI_STOP.has(seg) || c.text.includes(seg)) {
        okAt[j] = true;
      }
    }
  }
  return okAt[n];
}

export interface ClaimOpts {
  // 漢字語の検査対象とする最小字数(ストップ語・本文にある部分を除く)。0=検査しない。
  kanjiMin?: number;
}

// 文(見出し・要約の1文・new_fact)が本文コーパスで裏付けられるか。理由つきで返す。
export function checkClaim(claim: string, c: Corpus, opts: ClaimOpts = {}): { ok: boolean; reason?: string } {
  const { dates, rest } = extractDates(claim);
  for (const dt of dates) if (!dateOk(dt, c)) return { ok: false, reason: "date" };
  const nt = numberTokens(rest, true);
  for (const n of nt.toks) if (!numOk(n, c)) return { ok: false, reason: "number" };
  for (const w of extractLatin(rest)) if (!c.text.includes(w)) return { ok: false, reason: "latin" };
  for (const w of extractKatakana(rest)) if (!c.text.includes(w)) return { ok: false, reason: "katakana" };
  const kmin = opts.kanjiMin ?? 0;
  if (kmin > 0) {
    for (const w of extractKanjiRuns(nt.rest, kmin)) if (!kanjiRunOk(w, c)) return { ok: false, reason: "kanji" };
  }
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
- is_followup: 下の「前日の話題」にある見出しと同じ話題の続報の場合だけ true。それ以外、または「前日の話題」が無い場合は必ず false。
- カードに書かれていない数値・固有名詞・日付・原因・評価を創作しないこと。推測や助言は書かない。
- 同じ話題のカードは1つにまとめる。

前日の話題(見出し):
{PREV}

カード一覧:
`;

const RETRY_NOTE = `\n\n(注意)前回の出力は見出しにカード本文に無い数値・固有名(人名・社名・地名・漢字の名称)・日付が含まれていました。見出しにはカード本文にある語だけを使ってください。`;

export function buildTodayPrompt(cards: Card[], retry = false, prevHeadlines: string[] = []): string {
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
  const prev = prevHeadlines.length > 0 ? prevHeadlines.map((h) => `- ${h}`).join("\n") : "(なし)";
  return TODAY_PROMPT.replace("{PREV}", prev) + lines.join("\n\n") + (retry ? RETRY_NOTE : "");
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

// 漢字語の検査: new_facts は厳格(2字以上)、見出し・要約は誤検知で全滅しないよう3字以上だけ。
export const KANJI_MIN_FACT = 2;
export const KANJI_MIN_TEXT = 3;

// 生成結果(未検査)を検査し、本文に無い文を削除する。
// prevHeadlines: 前日(直近のdigest_daily)の見出し。空なら is_followup は常に false。
export function validateTopics(raw: unknown, cards: Card[], prevHeadlines: string[] = []): TodayValidation {
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
    if (!checkClaim(headline, corpus, { kanjiMin: KANJI_MIN_TEXT }).ok) {
      dropped += units;
      headlineFailed++;
      continue;
    }
    const keptSent = sentences.filter((s) => checkClaim(s, corpus, { kanjiMin: KANJI_MIN_TEXT }).ok);
    const keptFacts = facts.filter((s) => checkClaim(s, corpus, { kanjiMin: KANJI_MIN_FACT }).ok);
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
      is_followup: prevHeadlines.length > 0 && o.is_followup === true,
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
  // 生成の試行開始を記録する(tuning_config の digest_last_attempt_at に ISO文字列で upsert。SQL側 digest_due の30分バックオフ用)
  touchAttempt: (iso: string) => Promise<void>;
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

// 出力トークン上限: 入力カード数に応じて増やす(1500+80×カード数、上限6000)
export function todayMaxTokens(cardCount: number): number {
  return Math.min(6000, 1500 + 80 * cardCount);
}

// 前日(直近のdigest_daily。当日より前で status=ok かつ話題あり)の見出し一覧
export function prevHeadlinesOf(rows: DailyRow[], day: string): string[] {
  const prev = rows
    .filter((r) => r.day < day && r.status === "ok")
    .sort((a, b) => b.day.localeCompare(a.day))
    .find((r) => topicsOf(r).length > 0);
  return prev ? topicsOf(prev).map((t) => t.headline) : [];
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
    // 当日に ok の行が既にあれば、failed/empty/paused で上書きしない(正常な要点を壊さない)。
    if (status !== "ok" && prev && prev.status === "ok") return;
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

  // 前日の見出し(is_followup の根拠)。取れなくても生成は続ける(その場合 is_followup は常に false)。
  let prevHeadlines: string[] = [];
  try {
    prevHeadlines = prevHeadlinesOf(await deps.listDaily(addDays(day, -7), addDays(day, -1)), day);
  } catch {
    prevHeadlines = [];
  }

  let model: string | null = null;
  const call = async (retry: boolean) => {
    // 各試行の開始時に記録する(失敗しても再試行が暴走しないように、Gemini呼び出しの前に)
    await deps.touchAttempt(new Date(deps.now()).toISOString());
    return deps.gen({
      purpose: "digest",
      parts: [{ text: buildTodayPrompt(cards, retry, prevHeadlines) }],
      schema: TODAY_SCHEMA,
      maxOutputTokens: todayMaxTokens(cards.length),
      temperature: 0.2,
    });
  };
  const topicsArray = (g: GenRes & { ok: true }): unknown[] | null => {
    const j = genJson(g) as { topics?: unknown } | null;
    return j && Array.isArray(j.topics) ? j.topics : null;
  };
  // 生成失敗(ok行が無ければ failed 行を保存。ok行があれば残す)
  const failed = async (kind: string, m: string | null) => {
    await save("failed", [], m, 0);
    await deps.opsEvent("warn", "digest_failed", `今日の要点: 生成に失敗(${kind})`, { day, kind }, 360);
  };

  const g1 = await call(false);
  if (!g1.ok) {
    if (g1.kind === "guard") {
      await save("paused", [], null, 0);
      return { ok: true, mode: "today", status: "paused", day, input_count: cards.length };
    }
    await failed(g1.kind, g1.model ?? null);
    return { ok: false, mode: "today", day, error: safeErr(g1.error) };
  }
  model = g1.model;
  const t1 = topicsArray(g1);
  if (t1 === null) { // JSONとして読めない・topics が配列でない(空扱いにしない)
    await failed("parse", model);
    return { ok: true, mode: "today", status: "failed", day, input_count: cards.length, message: FAILED_MESSAGE };
  }
  let v = validateTopics(t1, cards, prevHeadlines);

  // 見出しが落ちたら1回だけ再生成
  if (v.headlineFailed > 0) {
    const g2 = await call(true);
    if (g2.ok) {
      const t2 = topicsArray(g2);
      if (t2 !== null) {
        model = g2.model;
        v = validateTopics(t2, cards, prevHeadlines);
      }
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

const WEEK_PROMPT = `あなたはXリストの「今週の流れ」を作る編集者です。以下は直近7日間の日ごとの「今日の要点」です。
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

// 「今週の流れ」= 日次(x_daily が毎日呼ぶ)で再生成するローリング7日の流れ。
//  - week_start(行のキー)は現在の週の月曜(JST 02:00区切り)。週が替わると新しい行になる。
//  - 入力は直近7日(今日を含む)の digest_daily のうち status=ok の日だけ。days_covered はその日数(0〜7)。
//  - days_covered < 3 は status='accumulating'(UIは「蓄積中 n/7」)。3以上でテーマ生成。
//  - 既に ok のテーマがあるとき、失敗・全滅(failed)で上書きしない。
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
  if (status === "ok" || !prev || prev.status !== "ok") {
    await deps.upsertWeek({ week_start: weekStart, generated_at: nowIso(), status, themes: v.themes, days_covered: covered });
  }
  return {
    ok: true, mode: "week", status, week_start: weekStart, days_covered: covered, themes: v.themes.length, dropped_ratio: ratio,
    message: status === "failed" ? FAILED_MESSAGE : undefined,
  };
}
