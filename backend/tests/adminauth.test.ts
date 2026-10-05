import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../functions/_shared/adminauth.ts";

const KEY = "k".repeat(64);
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

test("PBKDF2: 20万回・salt16バイト・検証は正誤を区別", async () => {
  const h = await A.hashPassphrase("correct horse battery");
  assert.equal(h.iterations, 200000);
  assert.equal(A.b64uToBytes(h.salt)!.length, 16);
  assert.equal(A.b64uToBytes(h.hash)!.length, 32);
  assert.equal(await A.verifyPassphrase("correct horse battery", h), true);
  assert.equal(await A.verifyPassphrase("correct horse batterY", h), false);
  assert.equal(await A.verifyPassphrase("", h), false);
  assert.equal(await A.verifyPassphrase(undefined, h), false);
  assert.equal(await A.verifyPassphrase("x", null), false);
  assert.equal(await A.verifyPassphrase("x", { salt: null, hash: null, iterations: null }), false);
});

test("PBKDF2: saltはランダム(同じ入力でも毎回違う)・固定saltなら決定的", async () => {
  const a = await A.hashPassphrase("same-passphrase-1", { iterations: 1000 });
  const b = await A.hashPassphrase("same-passphrase-1", { iterations: 1000 });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  const salt = new Uint8Array(16).fill(7);
  const c = await A.hashPassphrase("same-passphrase-1", { iterations: 1000, salt });
  const d = await A.hashPassphrase("same-passphrase-1", { iterations: 1000, salt });
  assert.equal(c.hash, d.hash);
});

test("パスフレーズ形式: 12字以上", () => {
  assert.equal(A.validatePassphraseShape("short"), "too_short");
  assert.equal(A.validatePassphraseShape("a".repeat(11)), "too_short");
  assert.equal(A.validatePassphraseShape("a".repeat(12)), "ok");
  assert.equal(A.validatePassphraseShape("あ".repeat(12)), "ok");
  assert.equal(A.validatePassphraseShape(123), "invalid");
});

test("定数時間比較", () => {
  assert.equal(A.constantTimeEqual("abc", "abc"), true);
  assert.equal(A.constantTimeEqual("abc", "abd"), false);
  assert.equal(A.constantTimeEqual("abc", "abcd"), false);
  assert.equal(A.constantTimeEqual("", ""), true);
});

test("setupコード: 大文字小文字・ハイフン有無を許容して正規化", () => {
  const want = "ABCDE-FGHJK-LMNPQ-RSTUV";
  assert.equal(A.normalizeSetupCode("ABCDE-FGHJK-LMNPQ-RSTUV"), want);
  assert.equal(A.normalizeSetupCode("abcde-fghjk-lmnpq-rstuv"), want);
  assert.equal(A.normalizeSetupCode("abcdefghjklmnpqrstuv"), want);
  assert.equal(A.normalizeSetupCode(" abcde fghjk lmnpq rstuv "), want);
  assert.equal(A.normalizeSetupCode("ABCDE-FGHJK-LMNPQ"), null);
  assert.equal(A.normalizeSetupCode("ABCDE-FGHJK-LMNPQ-RSTU!"), null);
  assert.equal(A.normalizeSetupCode(null), null);
});

test("setupコード: ハッシュはSQL側(digest(code,'sha256'))と同じ形(正規化後のSHA-256 hex)", async () => {
  const h = await A.hashSetupCode("abcde-fghjk-lmnpq-rstuv");
  assert.match(h!, /^[0-9a-f]{64}$/);
  assert.equal(h, await A.sha256Hex("ABCDE-FGHJK-LMNPQ-RSTUV"));
  assert.equal(await A.hashSetupCode("zzz"), null);
});

test("setupコード: 期限7日・一回限り・不一致", async () => {
  const code = "ABCDE-FGHJK-LMNPQ-RSTUV";
  const hash = await A.hashSetupCode(code);
  const exp = NOW + A.SETUP_CODE_TTL_MS;
  const st = { setup_done: false, setup_code_hash: hash, setup_code_expires_at: new Date(exp).toISOString() };
  assert.equal(await A.checkSetupCode(code, st, NOW), "ok");
  assert.equal(await A.checkSetupCode("abcdefghjklmnpqrstuv", st, NOW), "ok");
  assert.equal(await A.checkSetupCode(code, st, exp - 1), "ok");
  assert.equal(await A.checkSetupCode(code, st, exp), "expired");
  assert.equal(await A.checkSetupCode(code, st, exp + 86400000), "expired");
  assert.equal(await A.checkSetupCode("AAAAA-AAAAA-AAAAA-AAAAA", st, NOW), "invalid");
  assert.equal(await A.checkSetupCode("bad", st, NOW), "invalid");
  assert.equal(await A.checkSetupCode(code, { ...st, setup_done: true }, NOW), "done");
  assert.equal(await A.checkSetupCode(code, { ...st, setup_code_hash: null }, NOW), "not_issued");
});

test("トークン: 署名・検証・payload(iat/exp30日/kv)", async () => {
  const t = await A.signToken(KEY, 3, NOW);
  const payload = JSON.parse(new TextDecoder().decode(A.b64uToBytes(t.split(".")[0])!));
  assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "kv"]);
  assert.equal(payload.exp - payload.iat, 30 * 86400);
  assert.equal(payload.kv, 3);
  const v = await A.verifyToken(KEY, t, 3, NOW + 1000);
  assert.equal(v.ok, true);
});

test("トークン: 改ざん(payload/署名/別鍵)は拒否", async () => {
  const t = await A.signToken(KEY, 1, NOW);
  const [p, s] = t.split(".");
  const forged = { ...JSON.parse(new TextDecoder().decode(A.b64uToBytes(p)!)), exp: 9999999999 };
  const p2 = A.bytesToB64u(new TextEncoder().encode(JSON.stringify(forged)));
  assert.deepEqual(await A.verifyToken(KEY, `${p2}.${s}`, 1, NOW), { ok: false, reason: "signature" });
  const s2 = (s[0] === "A" ? "B" : "A") + s.slice(1);
  assert.equal((await A.verifyToken(KEY, `${p}.${s2}`, 1, NOW)).ok, false);
  assert.equal((await A.verifyToken("other-key-other-key", t, 1, NOW)).ok, false);
  for (const bad of ["", "abc", "a.b.c", "!!.!!", null, undefined, 5, "x".repeat(2000)]) {
    assert.equal((await A.verifyToken(KEY, bad, 1, NOW)).ok, false);
  }
});

test("トークン: 期限切れ・key_version不一致", async () => {
  const t = await A.signToken(KEY, 2, NOW);
  const exp = NOW + 30 * 86400 * 1000;
  assert.equal((await A.verifyToken(KEY, t, 2, exp - 1000)).ok, true);
  assert.deepEqual(await A.verifyToken(KEY, t, 2, exp), { ok: false, reason: "expired" });
  assert.deepEqual(await A.verifyToken(KEY, t, 3, NOW), { ok: false, reason: "key_version" });
});

test("トークン: 残り29日未満で更新を促す(発行直後は不要)", async () => {
  const t = await A.signToken(KEY, 1, NOW);
  const a = await A.verifyToken(KEY, t, 1, NOW + 3600 * 1000);
  assert.equal(a.ok && a.refresh, false);
  const b = await A.verifyToken(KEY, t, 1, NOW + 25 * 3600 * 1000); // 残り約29日-1時間未満
  assert.equal(b.ok && b.refresh, true);
});

test("待ち時間: 5回未満は0、5回以上で2^(n-5)分、上限15分", () => {
  assert.deepEqual([0, 1, 4].map(A.waitMinutesForFailures), [0, 0, 0]);
  assert.deepEqual([5, 6, 7, 8, 9, 10, 50].map(A.waitMinutesForFailures), [1, 2, 4, 8, 15, 15, 15]);
});

test("待ち時間: 残り秒数。経過後は0。成功でのリセットはDB側(failed_count=0)", () => {
  const last = NOW;
  assert.equal(A.retryAfterSeconds(4, last, NOW), 0);
  assert.equal(A.retryAfterSeconds(5, last, NOW), 60);
  assert.equal(A.retryAfterSeconds(5, new Date(last).toISOString(), NOW + 30000), 30);
  assert.equal(A.retryAfterSeconds(5, last, NOW + 60000), 0);
  assert.equal(A.retryAfterSeconds(7, last, NOW + 60000), 180);
  assert.equal(A.retryAfterSeconds(20, last, NOW), 900);
  assert.equal(A.retryAfterSeconds(5, null, NOW), 0);
  assert.equal(A.retryAfterSeconds(0, last, NOW), 0);
});
