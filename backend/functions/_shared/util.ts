// 共通ユーティリティ(並列プール・時間予算・batchId・JSON/CORS)。外部依存なし。

export type PoolResult<R> =
  | { status: "ok"; value: R }
  | { status: "error"; error: unknown }
  | { status: "skipped" }; // 時間予算切れ等で未着手

// items を最大 concurrency 並列で処理する。deadlineMs(絶対時刻 ms)を過ぎたら新しい要素は開始しない
// (実行中のものは完了を待つ)。fn の例外は結果に格納し、プール自体は止めない。
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  deadlineMs?: number,
  now: () => number = () => Date.now(),
): Promise<{ results: PoolResult<R>[]; started: number; skipped: number }> {
  const results: PoolResult<R>[] = items.map(() => ({ status: "skipped" } as PoolResult<R>));
  let next = 0;
  let started = 0;
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  async function worker() {
    for (;;) {
      if (deadlineMs !== undefined && now() >= deadlineMs) return;
      const i = next++;
      if (i >= items.length) return;
      started++;
      try {
        results[i] = { status: "ok", value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { status: "error", error };
      }
    }
  }
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : workers }, () => worker()));
  return { results, started, skipped: items.length - started };
}

export interface Budget {
  deadline: number; // 絶対時刻(ms)
  remaining(): number;
  expired(): boolean;
}
export function createBudget(totalMs: number, now: () => number = () => Date.now()): Budget {
  const deadline = now() + totalMs;
  return {
    deadline,
    remaining: () => Math.max(0, deadline - now()),
    expired: () => now() >= deadline,
  };
}

// 例: "summarize-x-post-20261005T143012Z-a1b2c3"
export function newBatchId(fn: string, now: () => number = () => Date.now(), rand?: () => string): string {
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const r = rand ? rand() : Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${fn}-${stamp}-${r}`;
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-token, x-pipeline-secret, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

// OPTIONS(プリフライト)なら応答を返す。そうでなければ null。
export function corsPreflight(req: { method: string }): Response | null {
  return req.method === "OPTIONS" ? new Response(null, { status: 204, headers: CORS_HEADERS }) : null;
}

export function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}
