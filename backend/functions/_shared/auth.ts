// パイプライン認証(契約: backend/docs/CONTRACT.md「認証」)。外部依存なし。
// ヘッダ x-pipeline-secret を Vault の秘密と定数時間比較する。

export type PipelineCaller = "cron" | "win" | "none";
export interface AuthDb {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}
export interface AuthOptions {
  db: AuthDb;
  mode: string; // "log" | "enforce"
  // 許可する呼び出し元。"none"(秘密なし)は mode=log のときだけ、allow に "none" を含む関数で許可される。
  allow: PipelineCaller[];
  fn?: string; // ops_event のメッセージ用
  now?: () => number;
}
export interface AuthResult {
  caller: PipelineCaller;
  ok: boolean;
  limited: boolean; // true = 秘密なしをlogモードで許可した(呼び出し側で limit<=60・post_url不可を適用する)
}

const SECRET_TTL_MS = 60_000;
const SECRET_NAMES = { cron: "xd_pipeline_secret_cron", win: "xd_pipeline_secret_win" } as const;
const secretCache = new Map<string, { at: number; value: string | null }>();

export function clearAuthCache(): void {
  secretCache.clear();
}

// 定数時間比較(長さが違っても全長を走査)。
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function getSecret(db: AuthDb, name: string, now: () => number): Promise<string | null> {
  const hit = secretCache.get(name);
  if (hit && now() - hit.at < SECRET_TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    const r = await db.rpc("get_secret", { p_name: name });
    if (!r.error && typeof r.data === "string" && r.data.length > 0) value = r.data;
    else if (r.error) return null; // 取得失敗はキャッシュしない
  } catch {
    return null;
  }
  secretCache.set(name, { at: now(), value });
  return value;
}

export async function checkPipelineAuth(
  req: { headers: { get(name: string): string | null } },
  opts: AuthOptions,
): Promise<AuthResult> {
  const now = opts.now ?? (() => Date.now());
  const presented = req.headers.get("x-pipeline-secret") ?? "";
  const [cronSecret, winSecret] = await Promise.all([
    getSecret(opts.db, SECRET_NAMES.cron, now),
    getSecret(opts.db, SECRET_NAMES.win, now),
  ]);
  // 短絡せず両方を比較する。未設定の秘密・空ヘッダは一致させない。
  const isCron = cronSecret !== null && presented.length > 0 && timingSafeEqual(presented, cronSecret);
  const isWin = winSecret !== null && presented.length > 0 && timingSafeEqual(presented, winSecret);

  let caller: PipelineCaller = "none";
  if (isCron) caller = "cron";
  else if (isWin) caller = "win";

  if (caller !== "none") {
    return { caller, ok: opts.allow.includes(caller), limited: false };
  }

  // 秘密なし/不一致
  if (opts.mode === "log" && opts.allow.includes("none")) {
    try {
      await opts.db.rpc("ops_event", {
        p_level: "warn",
        p_kind: "unauth_call",
        p_message: `${opts.fn ?? "function"} called without a valid pipeline secret (allowed: log mode)`,
        p_data: { fn: opts.fn ?? null, had_header: presented.length > 0 },
        p_dedupe_minutes: 360,
      });
    } catch {
      // 記録失敗で処理は止めない
    }
    return { caller: "none", ok: true, limited: true };
  }
  return { caller: "none", ok: false, limited: false };
}
