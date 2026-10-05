// SQL の digest_due() と Edge の runToday(digest.ts)が、同じ状態から同じ判定(生成する/しない)になることの確認。
// run.sh が一時DBで使う(本番には触れない)。使い方:
//   node parity.ts names        … シナリオ名を1行ずつ
//   node parity.ts sql <name>   … そのシナリオの状態をDBへ作って digest_due() を select するSQL
//   node parity.ts ts <name>    … 同じ状態を runToday へ与えた結果(true=生成する / false=見送る)
// 状態は「前回の試行(digest_last_attempt_at)」と「当日の digest_daily 行」の組。
// 区分確定(tier_batches)と新規 score>=3 の件数は常に十分に満たし、判定を2つの基準だけで決める。
import { digestDay, runToday } from "../../functions/_shared/digest.ts";
import type { Card, DailyRow } from "../../functions/_shared/digest.ts";

interface Scenario {
  name: string;
  attempt?: number | "bad"; // 前回の試行が何分前か("bad"=日付でない値)。省略=記録なし
  daily?: { status: "ok" | "empty" | "failed" | "paused"; hoursAgo: number }; // 当日の行。省略=行なし
}

export const SCENARIOS: Scenario[] = [
  { name: "none" },
  { name: "attempt_10m", attempt: 10 },
  { name: "attempt_29m", attempt: 29 },
  { name: "attempt_31m", attempt: 31 },
  { name: "attempt_40m", attempt: 40 },
  { name: "attempt_bad", attempt: "bad" },
  { name: "ok_1h", daily: { status: "ok", hoursAgo: 1 } },
  { name: "ok_5.9h", daily: { status: "ok", hoursAgo: 5.9 } },
  { name: "ok_6.1h", daily: { status: "ok", hoursAgo: 6.1 } },
  { name: "ok_7h", daily: { status: "ok", hoursAgo: 7 } },
  { name: "empty_2h", daily: { status: "empty", hoursAgo: 2 } },
  { name: "empty_7h", daily: { status: "empty", hoursAgo: 7 } },
  { name: "failed_6min", daily: { status: "failed", hoursAgo: 0.1 } },
  { name: "failed_7h", daily: { status: "failed", hoursAgo: 7 } },
  { name: "paused_6min", daily: { status: "paused", hoursAgo: 0.1 } },
  { name: "ok_7h_attempt_10m", daily: { status: "ok", hoursAgo: 7 }, attempt: 10 },
  { name: "ok_1h_attempt_40m", daily: { status: "ok", hoursAgo: 1 }, attempt: 40 },
  { name: "failed_6min_attempt_40m", daily: { status: "failed", hoursAgo: 0.1 }, attempt: 40 },
  { name: "failed_6min_attempt_10m", daily: { status: "failed", hoursAgo: 0.1 }, attempt: 10 },
  { name: "empty_2h_attempt_40m", daily: { status: "empty", hoursAgo: 2 }, attempt: 40 },
];

const find = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`unknown scenario: ${name}`);
  return s;
};
const isoUtc = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function sqlFor(s: Scenario): string {
  const lines = [
    `truncate public.x_posts, public.tier_batches, public.digest_daily restart identity;`,
    `delete from public.tuning_config where key = 'digest_last_attempt_at';`,
    `insert into public.tuning_config(key, value) values ('tier_scope_from', '"2026-10-01T00:00:00Z"'), ('digest_min_new_scored', '5'), ('digest_min_interval_hours', '6')`,
    `  on conflict (key) do update set value = excluded.value;`,
    `insert into public.x_posts(post_url, author_handle, content, fetched_at, posted_at, summary, score, score_state, scored_at, batch_key)`,
    `  select 'p' || i, 'a', 'x', now(), now(), 's', 4, 'scored', now(), 'pb' from generate_series(1, 5) i;`,
    `insert into public.tier_batches(batch_key, day_start, slot, first_at, last_at, n_posts, finalized_at) values ('pb', now(), 'am', now(), now(), 5, now());`,
  ];
  if (s.attempt !== undefined) {
    lines.push(s.attempt === "bad"
      ? `insert into public.tuning_config(key, value) values ('digest_last_attempt_at', '"not a date"') on conflict (key) do update set value = excluded.value;`
      : `insert into public.tuning_config(key, value) values ('digest_last_attempt_at', to_jsonb(to_char((now() - interval '${s.attempt} minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) on conflict (key) do update set value = excluded.value;`);
  }
  if (s.daily) {
    lines.push(`insert into public.digest_daily(day, generated_at, status) values ((public.jst_day2_start(now()) at time zone 'Asia/Tokyo')::date, now() - interval '${Math.round(s.daily.hoursAgo * 60)} minutes', '${s.daily.status}');`);
  }
  lines.push(`select public.digest_due();`);
  return lines.join("\n");
}

export async function tsDecision(s: Scenario): Promise<boolean> {
  const nowMs = Date.now();
  const day = digestDay(nowMs);
  const at = new Date(nowMs).toISOString();
  const cards: Card[] = Array.from({ length: 5 }, (_, i) => ({
    post_url: `p${i + 1}`, gist: "g", summary: "s", content: "x", score: 4, scored_at: at, fetched_at: at, image_urls: null,
  }));
  const prev: DailyRow | null = s.daily
    ? {
      day, generated_at: new Date(nowMs - Math.round(s.daily.hoursAgo * 60) * 60_000).toISOString(), model: "m", status: s.daily.status,
      topics: [], input_count: 5, dropped_ratio: 0, version: 1,
    }
    : null;
  const lastAttempt = s.attempt === undefined ? null : s.attempt === "bad" ? "not a date" : isoUtc(nowMs - s.attempt * 60_000);
  let generated = false;
  await runToday({
    now: () => nowMs,
    gen: async () => { generated = true; return { ok: true, text: '{"topics":[]}', json: { topics: [] }, model: "m" }; },
    cfgNum: async (k, d) => (k === "digest_min_new_scored" ? 5 : k === "digest_min_interval_hours" ? 6 : d),
    loadCards: async () => cards,
    getDaily: async () => prev,
    listDaily: async () => [],
    upsertDaily: async () => {},
    getWeek: async () => null,
    upsertWeek: async () => {},
    opsEvent: async () => {},
    touchAttempt: async () => {},
    getLastAttempt: async () => lastAttempt,
  });
  return generated;
}

const [cmd, name] = process.argv.slice(2);
if (cmd === "names") console.log(SCENARIOS.map((s) => s.name).join("\n"));
else if (cmd === "sql") console.log(sqlFor(find(name)));
else if (cmd === "ts") console.log(String(await tsDecision(find(name))));
