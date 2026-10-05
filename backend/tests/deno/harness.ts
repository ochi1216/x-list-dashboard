// 結合試験の補助: 関数を `deno run -A dist/<関数>/index.ts` で起動し、HTTPで叩く。
import { MockGemini } from "./mock_gemini.ts";
import { MockSupabase } from "./mock_supabase.ts";

export const BACKEND = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

export async function build(): Promise<void> {
  const r = await new Deno.Command("bash", { args: [`${BACKEND}/build.sh`], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error("build.sh failed: " + new TextDecoder().decode(r.stderr));
}

function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

export interface RunningFn {
  name: string;
  url: string;
  logs: () => string;
  call: (body: unknown, headers?: Record<string, string>, method?: string) => Promise<{ status: number; json: any; text: string; headers: Headers }>;
  stop: () => Promise<void>;
}

export interface Env {
  supa: MockSupabase;
  gem: MockGemini;
}

// env を上書きしたいとき(例: GEMINI_API_KEY を外す)は extra に { GEMINI_API_KEY: null } のように渡す。
export async function startFn(e: Env, name: string, extra: Record<string, string | null> = {}): Promise<RunningFn> {
  const port = freePort();
  const env: Record<string, string> = {
    SUPABASE_URL: e.supa.url,
    SUPABASE_SERVICE_ROLE_KEY: e.supa.serviceKey,
    GEMINI_API_KEY: e.gem.apiKey,
    GEMINI_BASE_URL: e.gem.url,
    DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`,
    NO_COLOR: "1",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete env[k]; else env[k] = v;
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", `${BACKEND}/dist/${name}/index.ts`],
    env,
    clearEnv: false,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let buf = "";
  const dec = new TextDecoder();
  const drain = async (s: ReadableStream<Uint8Array>) => {
    try {
      for await (const c of s) buf += dec.decode(c);
    } catch { /* 終了 */ }
  };
  const d1 = drain(child.stdout);
  const d2 = drain(child.stderr);
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (buf.includes("Listening on")) break;
    if (Date.now() - t0 > 60_000) {
      child.kill();
      throw new Error(`${name} did not start:\n${buf}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    name,
    url,
    logs: () => buf,
    async call(body, headers = {}, method = "POST") {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", apikey: e.supa.serviceKey, ...headers },
        body: method === "GET" || method === "OPTIONS" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* 本文なし */ }
      return { status: res.status, json, text, headers: res.headers };
    },
    async stop() {
      try { child.kill("SIGTERM"); } catch { /* 済 */ }
      await child.status;
      await Promise.all([d1, d2]);
    },
  };
}

export async function withFn<T>(e: Env, name: string, extra: Record<string, string | null>, fn: (f: RunningFn) => Promise<T>): Promise<T> {
  const f = await startFn(e, name, extra);
  try {
    return await fn(f);
  } finally {
    await f.stop();
  }
}

export const CRON = { "x-pipeline-secret": "cron-secret-aaaaaaaaaaaa" };
export const WIN = { "x-pipeline-secret": "win-secret-bbbbbbbbbbbb" };

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assertion failed: " + msg);
}
export function eq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}
