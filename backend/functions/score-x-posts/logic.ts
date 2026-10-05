// score-x-posts の分岐ロジック(純粋関数。import なし)。

export const DUP_WINDOW_DAYS = 14;
export const DAY_MS = 86_400_000;
export const MAX_ATTEMPTS = 3;

export interface Cfg {
  scoreEnabled: boolean;
  tierAssignEnabled: boolean;
  killSwitch: boolean;
  backfillEnabled: boolean;
  tierScopeFrom: string | null;
  scoreBackfillFrom: string | null;
  listenThreshold: number;
  capOpinion: boolean;
  speechEnabled: boolean;
  speechMaxPerRun: number;
  profileText: string;
  profileVersion: number | null;
}

function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function num(v: unknown, d: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return d;
}
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

export function parseCfg(rows: { key: string; value: unknown }[]): Cfg {
  const m = new Map<string, unknown>();
  for (const r of rows ?? []) m.set(r.key, r.value);
  const prof = (m.get("interest_profile") ?? {}) as Record<string, unknown>;
  const text = typeof prof.text === "string" ? prof.text.trim() : "";
  return {
    scoreEnabled: bool(m.get("score_enabled"), true),
    tierAssignEnabled: bool(m.get("tier_assign_enabled"), true),
    killSwitch: bool(m.get("kill_switch"), false),
    backfillEnabled: bool(m.get("backfill_enabled"), false),
    tierScopeFrom: isoOrNull(m.get("tier_scope_from")),
    scoreBackfillFrom: isoOrNull(m.get("score_backfill_from")),
    listenThreshold: Math.round(num(m.get("listen_threshold"), 4)),
    capOpinion: bool(m.get("cap_opinion"), false),
    speechEnabled: bool(m.get("speech_enabled"), false),
    speechMaxPerRun: Math.max(0, Math.min(50, Math.round(num(m.get("speech_max_per_run"), 10)))),
    profileText: text,
    profileVersion: typeof prof.version === "number" ? prof.version : null,
  };
}

// 対象の下限(fetched_at >=)。無ければ null(=対象なし)
export function targetFrom(cfg: Cfg): string | null {
  return cfg.backfillEnabled ? cfg.scoreBackfillFrom : cfg.tierScopeFrom;
}

export interface DupSelf { post_url: string; posted_at?: string | null; fetched_at?: string | null }
export interface DupCand { post_url: string; posted_at?: string | null }

function ts(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// 自分より前(posted_at が小さい。同時刻は post_url 昇順で小さい)かつ14日以内の同一dup_key投稿があるか
export function hasEarlierDuplicate(self: DupSelf, cands: DupCand[], windowDays = DUP_WINDOW_DAYS): boolean {
  const mine = ts(self.posted_at) ?? ts(self.fetched_at);
  if (mine === null) return false;
  const from = mine - windowDays * DAY_MS;
  for (const c of cands) {
    if (c.post_url === self.post_url) continue;
    const t = ts(c.posted_at);
    if (t === null || t < from || t > mine) continue;
    if (t < mine || (t === mine && c.post_url < self.post_url)) return true;
  }
  return false;
}

export interface RuleFields {
  score: number;
  score_raw: null;
  score_kind: "duplicate" | "none";
  score_reason: string;
  cap_reason: string;
  score_state: "rule";
}

export function ruleFields(kind: "duplicate" | "none"): RuleFields {
  return {
    score: 1,
    score_raw: null,
    score_kind: kind,
    score_reason: kind === "duplicate" ? "重複投稿" : "本文・画像なし",
    cap_reason: kind,
    score_state: "rule",
  };
}

// 失敗時の更新(3回で failed)
export function failureUpdate(prevAttempts: number): { score_attempts: number; score_state: "failed" | null } {
  const n = (prevAttempts || 0) + 1;
  return { score_attempts: n, score_state: n >= MAX_ATTEMPTS ? "failed" : null };
}

// 失敗の扱い:
//   guard     = 費用ガードで全体停止(試行回数は増やさない)
//   auth      = 認証エラー(鍵の誤設定・請求停止)で全体停止(試行回数は増やさない)
//   transport = 通信系(network / 5xx / 429 / 提供終了など再試行で通りうるもの。試行回数は増やさない。連続すると中断)
//   content   = 応答不正(parse / empty / 429・認証系以外の4xx)。試行回数を増やし、3回で failed
export function failureClass(kind: string, status?: number): "guard" | "auth" | "transport" | "content" {
  if (kind === "guard") return "guard";
  if (kind === "auth") return "auth";
  if (kind === "parse" || kind === "empty") return "content";
  if (kind === "http" && typeof status === "number" && status >= 400 && status < 500 && status !== 429 && status !== 401 && status !== 403) {
    return "content";
  }
  return "transport";
}

// 再採点するか: モデル設定 gen_config.rescore===true かつ score∈{T-1,T}
export function wantRescore(genConfig: unknown, score: number, threshold: number): boolean {
  const g = genConfig as Record<string, unknown> | null | undefined;
  if (!g || g.rescore !== true) return false;
  return score === threshold - 1 || score === threshold;
}

export function sanitize(msg: unknown, max = 200): string {
  let s = String(msg ?? "");
  s = s.replace(/AIza[0-9A-Za-z_\-]{10,}/g, "[redacted]")
    .replace(/([?&]|\b)(key|api[_-]?key|token|secret)=[^\s&"']+/gi, "$1$2=[redacted]")
    .replace(/(Bearer|x-goog-api-key:?)\s+[^\s"']+/gi, "$1 [redacted]");
  return s.slice(0, max);
}

// 並列ワーカー。shouldStop() が true になったら新規着手しない。
export async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (true) {
      if (shouldStop()) return;
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

// 読み下しの結果の扱い: 保存 / 失敗を記録して再試行しない / 費用ガード・認証エラーで中断(何も記録しない)
export type SpeechDecision = "save" | "record_failure" | "guard_stop" | "auth_stop";
export function speechDecision(
  call: { ok: true } | { ok: false; kind: string },
  parsedOk: boolean,
  numbersOk: boolean,
): SpeechDecision {
  if (!call.ok) return call.kind === "guard" ? "guard_stop" : call.kind === "auth" ? "auth_stop" : "record_failure";
  return parsedOk && numbersOk ? "save" : "record_failure";
}

export interface SpeechRow { speech_title: string; speech_body: string; speech_model: string; speech_at: string }

export function speechSaveFields(title: string, body: string, model: string, nowIso: string): SpeechRow {
  return { speech_title: title, speech_body: body, speech_model: model, speech_at: nowIso };
}
