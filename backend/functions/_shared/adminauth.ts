// 管理認証の純粋部品(Web Crypto のみ。外部依存なし。Node 22 / Deno 両対応)
// - パスフレーズ: PBKDF2-SHA256(20万回・salt 16バイト)
// - セットアップコード: XXXXX-XXXXX-XXXXX-XXXXX(7日有効・一回限り。DBにはSHA-256 hexのみ)
// - トークン: HMAC-SHA256署名(payload {iat,exp,kv})、30日・使うたびに延長
// - 失敗回数に応じた待ち時間
// 秘密(パスフレーズ・トークン・署名鍵)はログに出さない。例外メッセージにも値を含めない。

export const PBKDF2_ITERATIONS = 200000;
export const SALT_BYTES = 16;
export const HASH_BYTES = 32;
export const TOKEN_TTL_SEC = 30 * 24 * 3600;
export const TOKEN_REFRESH_BELOW_SEC = 29 * 24 * 3600;
export const SETUP_CODE_TTL_MS = 7 * 24 * 3600 * 1000;
export const MIN_PASSPHRASE_LEN = 12;
export const MAX_PASSPHRASE_LEN = 200;

const enc = new TextEncoder();

// ---- base64url ----------------------------------------------------------------
export function bytesToB64u(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uToBytes(str: string): Uint8Array | null {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) return null;
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_e) {
    return null;
  }
}

// ---- 定数時間比較 ---------------------------------------------------------------
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function constantTimeEqual(a: string, b: string): boolean {
  return constantTimeEqualBytes(enc.encode(String(a)), enc.encode(String(b)));
}

// ---- PBKDF2 ---------------------------------------------------------------------
async function pbkdf2(pass: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export interface PassphraseHash {
  salt: string; // base64url
  hash: string; // base64url
  iterations: number;
}

export function validatePassphraseShape(pass: unknown): "ok" | "too_short" | "too_long" | "invalid" {
  if (typeof pass !== "string") return "invalid";
  if ([...pass].length < MIN_PASSPHRASE_LEN) return "too_short";
  if (pass.length > MAX_PASSPHRASE_LEN) return "too_long";
  return "ok";
}

export async function hashPassphrase(
  pass: string,
  opts: { iterations?: number; salt?: Uint8Array } = {},
): Promise<PassphraseHash> {
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const h = await pbkdf2(pass, salt, iterations);
  return { salt: bytesToB64u(salt), hash: bytesToB64u(h), iterations };
}

export async function verifyPassphrase(
  pass: unknown,
  stored: { salt?: string | null; hash?: string | null; iterations?: number | null } | null | undefined,
): Promise<boolean> {
  if (typeof pass !== "string" || pass.length === 0 || pass.length > MAX_PASSPHRASE_LEN) return false;
  if (!stored || !stored.salt || !stored.hash || !stored.iterations) return false;
  const salt = b64uToBytes(stored.salt);
  const want = b64uToBytes(stored.hash);
  if (!salt || !want) return false;
  if (!Number.isInteger(stored.iterations) || stored.iterations < 1 || stored.iterations > 5_000_000) return false;
  const got = await pbkdf2(pass, salt, stored.iterations);
  return constantTimeEqualBytes(got, want);
}

// ---- セットアップコード ------------------------------------------------------------
/** 大文字小文字・ハイフン・空白の有無を許容して XXXXX-XXXXX-XXXXX-XXXXX に正規化。形式不正は null。 */
export function normalizeSetupCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.toUpperCase().replace(/[\s-]+/g, "");
  if (!/^[A-Z0-9]{20}$/.test(s)) return null;
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  let out = "";
  for (let i = 0; i < d.length; i++) out += d[i].toString(16).padStart(2, "0");
  return out;
}

export async function hashSetupCode(input: unknown): Promise<string | null> {
  const n = normalizeSetupCode(input);
  return n ? await sha256Hex(n) : null;
}

export type SetupCodeResult = "ok" | "invalid" | "expired" | "done" | "not_issued";

/** 状態: setup_done(済なら一回限りなので常に done)、保存ハッシュ、期限(ms または ISO文字列)。 */
export async function checkSetupCode(
  input: unknown,
  state: { setup_done: boolean; setup_code_hash?: string | null; setup_code_expires_at?: string | number | null },
  nowMs: number,
): Promise<SetupCodeResult> {
  if (state.setup_done) return "done";
  if (!state.setup_code_hash) return "not_issued";
  const h = await hashSetupCode(input);
  // 形式不正でも比較を行い、時間差を作らない
  const ok = constantTimeEqual(h ?? "x".repeat(64), state.setup_code_hash);
  if (!h || !ok) return "invalid";
  const exp = typeof state.setup_code_expires_at === "number"
    ? state.setup_code_expires_at
    : state.setup_code_expires_at ? Date.parse(state.setup_code_expires_at) : NaN;
  if (!Number.isFinite(exp) || nowMs >= exp) return "expired";
  return "ok";
}

// ---- トークン ---------------------------------------------------------------------
export interface TokenPayload {
  iat: number; // 秒
  exp: number; // 秒
  kv: number; // key_version
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signToken(secret: string, keyVersion: number, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const payload: TokenPayload = { iat, exp: iat + TOKEN_TTL_SEC, kv: keyVersion };
  const p = bytesToB64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(p)));
  return `${p}.${bytesToB64u(sig)}`;
}

export type TokenResult =
  | { ok: true; payload: TokenPayload; refresh: boolean }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "key_version" };

export async function verifyToken(
  secret: string,
  token: unknown,
  keyVersion: number,
  nowMs: number,
): Promise<TokenResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const sig = b64uToBytes(parts[1]);
  const body = b64uToBytes(parts[0]);
  if (!sig || !body) return { ok: false, reason: "malformed" };
  // crypto.subtle.verify は定数時間
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig as BufferSource, enc.encode(parts[0]));
  if (!valid) return { ok: false, reason: "signature" };
  let payload: TokenPayload;
  try {
    const o = JSON.parse(new TextDecoder().decode(body));
    if (!o || !Number.isFinite(o.iat) || !Number.isFinite(o.exp) || !Number.isFinite(o.kv)) {
      return { ok: false, reason: "malformed" };
    }
    payload = { iat: o.iat, exp: o.exp, kv: o.kv };
  } catch (_e) {
    return { ok: false, reason: "malformed" };
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= payload.exp) return { ok: false, reason: "expired" };
  if (payload.kv !== keyVersion) return { ok: false, reason: "key_version" };
  return { ok: true, payload, refresh: payload.exp - nowSec < TOKEN_REFRESH_BELOW_SEC };
}

// ---- 失敗カウントと待ち時間 ----------------------------------------------------------
/** 失敗が5回以上で 2^(n-5) 分、上限15分。 */
export function waitMinutesForFailures(failedCount: number): number {
  if (!Number.isFinite(failedCount) || failedCount < 5) return 0;
  return Math.min(15, Math.pow(2, Math.min(failedCount, 30) - 5));
}

/** 待たなければならない残り秒数(0なら試行可)。 */
export function retryAfterSeconds(
  failedCount: number,
  lastFailedAt: string | number | null | undefined,
  nowMs: number,
): number {
  const wait = waitMinutesForFailures(failedCount) * 60;
  if (wait <= 0 || lastFailedAt == null) return 0;
  const last = typeof lastFailedAt === "number" ? lastFailedAt : Date.parse(lastFailedAt);
  if (!Number.isFinite(last)) return 0;
  const left = Math.ceil((last + wait * 1000 - nowMs) / 1000);
  return left > 0 ? left : 0;
}
