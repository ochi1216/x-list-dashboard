import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../functions/_shared/adminauth.ts";
import * as L from "../functions/admin-api/logic.ts";

const KEY = "k".repeat(64);
const PASS = "my-long-passphrase-1";
let NOW = Date.UTC(2026, 9, 15, 3, 0, 0);

// テストでは反復を軽くする(本番は20万回。adminauth.test.ts で検証済み)
const auth = { ...A, hashPassphrase: (p: string) => A.hashPassphrase(p, { iterations: 1000 }) };

function fakeDb(init: Record<string, any> = {}) {
  const s: any = {
    auth: {
      salt: null, hash: null, iterations: null, key_version: 1, failed_count: 0, last_failed_at: null,
      setup_done: false, setup_code_hash: null, setup_code_expires_at: null,
      ...(init.auth ?? {}),
    },
    ops: new Map<string, any>(),
    config: new Map<string, unknown>(Object.entries(init.config ?? {})),
    history: [] as any[],
    posts: new Map<string, any>(init.posts ?? []),
    labels: init.labels ?? [],
    rpcs: [] as any[],
    rpcImpl: init.rpcImpl ?? {},
  };
  const db: any = {
    s,
    async rpc(name: string, args: any) {
      s.rpcs.push({ name, args });
      const f = s.rpcImpl[name];
      if (f) return f(args);
      return { data: null, error: null };
    },
    async getAuth() { return { ...s.auth }; },
    async updateAuth(p: any) { Object.assign(s.auth, p); },
    async completeSetup(h: string, p: any) {
      if (s.auth.setup_done || s.auth.setup_code_hash !== h) return false;
      Object.assign(s.auth, p); return true;
    },
    async claimOp(id: string, kind: string) {
      if (s.ops.has(id)) return { inserted: false, result: s.ops.get(id).result };
      s.ops.set(id, { kind, result: null }); return { inserted: true, result: null };
    },
    async finishOp(id: string, r: any) { s.ops.get(id).result = r; },
    async releaseOp(id: string) { s.ops.delete(id); },
    async updatePost(url: string, patch: any) {
      const p = s.posts.get(url); if (!p) return false; Object.assign(p, patch); return true;
    },
    async getConfigRows() { return [...s.config].map(([key, value]) => ({ key, value })); },
    async getConfigValue(k: string) { return s.config.has(k) ? s.config.get(k) : null; },
    async setConfig(key: string, old: any, nv: any, source: string) {
      s.config.set(key, nv);
      s.history.push({ id: s.history.length + 1, key, old_value: old, new_value: nv, source });
      return s.history.length;
    },
    async getHistory(id: number) { return s.history.find((h: any) => h.id === id) ?? null; },
    async latestListNo() {
      const n = s.labels.map((l: any) => l.list_no).filter((x: any) => x != null);
      return n.length ? Math.max(...n) : null;
    },
    // 本物のDB層は列を絞るが、ここでは「全列(ai_*含む)が来ても漏らさない」ことを確かめるため全部返す
    async labelRows(n: number) { return s.labels.filter((l: any) => l.list_no === n).map((l: any) => ({ ...l })); },
    async labelSubmit(id: number, score: number, cls: string, at: string) {
      const l = s.labels.find((x: any) => x.id === id); if (!l) return { found: false, list_no: null };
      Object.assign(l, { label_score: score, label_class: cls, labeled_at: at }); return { found: true, list_no: l.list_no };
    },
    async weekReport() { return init.week ?? null; },
    async costMonthly() { return init.months ?? []; },
    async recentErrors() { return init.errors ?? []; },
    async modelLastSwitchAt() { return null; },
    async opsEvents(n: number) { return (init.events ?? []).slice(0, n); },
  };
  return db;
}

function mk(db: any) {
  const deps = { db, auth, tokenKey: KEY, now: () => NOW } as any;
  return (body: any, token: string | null = null) => L.handleAdmin(deps, token, body);
}

async function loggedIn(init: Record<string, any> = {}) {
  const h = await auth.hashPassphrase(PASS);
  const db = fakeDb({ ...init, auth: { ...h, setup_done: true, ...(init.auth ?? {}) } });
  const call = mk(db);
  const r = await call({ action: "login", passphrase: PASS });
  return { db, call, token: r.body.token as string };
}

// ---- setup / login -------------------------------------------------------------------
async function freshSetupDb() {
  const code = "ABCDE-FGHJK-LMNPQ-RSTUV";
  return {
    code,
    db: fakeDb({ auth: {
      setup_code_hash: await A.hashSetupCode(code),
      setup_code_expires_at: new Date(NOW + A.SETUP_CODE_TTL_MS).toISOString(),
    } }),
  };
}

test("setup: 正しいコードで初回パスフレーズを設定→一回限り", async () => {
  const { db, code } = await freshSetupDb();
  const call = mk(db);
  assert.equal((await call({ action: "setup", setup_code: code, passphrase: "short" })).body.error, "passphrase_too_short");
  const r = await call({ action: "setup", setup_code: code.toLowerCase().replaceAll("-", ""), passphrase: PASS });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.token, "string");
  assert.equal(db.s.auth.setup_done, true);
  assert.equal(db.s.auth.setup_code_hash, null);
  assert.equal(db.s.auth.hash.includes(PASS), false);
  const again = await call({ action: "setup", setup_code: code, passphrase: PASS + "2" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "setup_done");
  assert.equal((await call({ action: "login", passphrase: PASS })).status, 200);
});

test("setup: 期限切れ・不一致", async () => {
  const { db, code } = await freshSetupDb();
  const call = mk(db);
  const bad = await call({ action: "setup", setup_code: "AAAAA-AAAAA-AAAAA-AAAAA", passphrase: PASS });
  assert.equal(bad.status, 401);
  assert.equal(db.s.auth.failed_count, 1);
  NOW += A.SETUP_CODE_TTL_MS + 1000;
  const exp = await call({ action: "setup", setup_code: code, passphrase: PASS });
  assert.equal(exp.body.error, "setup_code_expired");
  assert.equal(db.s.auth.setup_done, false);
  NOW -= A.SETUP_CODE_TTL_MS + 1000;
});

test("login: 失敗5回で待ち→429(秒数)、待ち中は正解でも429、経過後に成功でリセット", async () => {
  const { db, call } = await loggedIn();
  for (let i = 1; i <= 4; i++) {
    const r = await call({ action: "login", passphrase: "wrong-passphrase-x" });
    assert.equal(r.status, 401);
    assert.equal(r.body.retry_after, undefined);
  }
  const fifth = await call({ action: "login", passphrase: "wrong-passphrase-x" });
  assert.equal(fifth.status, 401);
  assert.equal(fifth.body.retry_after, 60);
  const wait = await call({ action: "login", passphrase: PASS });
  assert.equal(wait.status, 429);
  assert.equal(wait.body.retry_after, 60);
  NOW += 61_000;
  const okr = await call({ action: "login", passphrase: PASS });
  assert.equal(okr.status, 200);
  assert.equal(db.s.auth.failed_count, 0);
  NOW -= 61_000;
});

test("待ち中でも発行済みトークンは影響されない", async () => {
  const { db, call, token } = await loggedIn();
  db.s.auth.failed_count = 9;
  db.s.auth.last_failed_at = new Date(NOW).toISOString();
  assert.equal((await call({ action: "login", passphrase: PASS })).status, 429);
  const me = await call({ action: "me" }, token);
  assert.equal(me.status, 200);
  assert.equal(me.body.authed, true);
  assert.equal((await call({ action: "config_get" }, token)).status, 200);
});

// ---- me / トークン -------------------------------------------------------------------
test("me: 未認証でも setup_done を返す(key_versionは返さない)/ 認証済みは key_version", async () => {
  const { call, token } = await loggedIn();
  const anon = await call({ action: "me" });
  assert.deepEqual(anon.body, { ok: true, authed: false, setup_done: true });
  const me = await call({ action: "me" }, token);
  assert.equal(me.body.key_version, 1);
  assert.equal(me.body.token, undefined); // 発行直後は更新しない
  const before = mk(fakeDb());
  assert.equal((await before({ action: "me" })).body.setup_done, false);
});

test("認証が必要なactionはトークン無し・不正・期限切れ・鍵版違いで401", async () => {
  const { db, call, token } = await loggedIn();
  assert.equal((await call({ action: "config_get" })).status, 401);
  assert.equal((await call({ action: "config_get" }, "garbage")).status, 401);
  assert.equal((await call({ action: "config_get" }, token.slice(0, -2) + "xx")).status, 401);
  NOW += 31 * 86400_000;
  assert.equal((await call({ action: "config_get" }, token)).status, 401);
  NOW -= 31 * 86400_000;
  db.s.auth.key_version = 2;
  assert.equal((await call({ action: "config_get" }, token)).status, 401);
  assert.equal((await call({ action: "nope" }, token)).body.error, "unknown_action");
});

test("使うたびに残り29日未満なら新トークンを返す", async () => {
  const { call, token } = await loggedIn();
  NOW += 2 * 86400_000;
  const r = await call({ action: "config_get" }, token);
  assert.equal(typeof r.body.token, "string");
  assert.notEqual(r.body.token, token);
  assert.equal((await call({ action: "me" }, r.body.token as string)).body.authed, true);
  NOW -= 2 * 86400_000;
});

test("change_passphrase: 旧パス必須・鍵版+1で旧トークン失効・新トークン発行", async () => {
  const { db, call, token } = await loggedIn();
  assert.equal((await call({ action: "change_passphrase", old: "wrong-wrong-wrong", new: "another-long-pass-2" }, token)).status, 401);
  assert.equal((await call({ action: "change_passphrase", old: PASS, new: "short" }, token)).body.error, "passphrase_too_short");
  const r = await call({ action: "change_passphrase", old: PASS, new: "another-long-pass-2" }, token);
  assert.equal(r.status, 200);
  assert.equal(db.s.auth.key_version, 2);
  assert.equal((await call({ action: "me" }, token)).body.authed, false);
  assert.equal((await call({ action: "me" }, r.body.token as string)).body.authed, true);
  assert.equal((await call({ action: "login", passphrase: "another-long-pass-2" })).status, 200);
});

// ---- 設定 ----------------------------------------------------------------------------
test("config: 値域・型・白リスト", () => {
  const v = L.validateConfigValue;
  assert.equal(v("listen_threshold", 3), null);
  assert.equal(v("listen_threshold", 5), null);
  assert.notEqual(v("listen_threshold", 2), null);
  assert.notEqual(v("listen_threshold", 6), null);
  assert.notEqual(v("listen_threshold", 4.5), null);
  assert.notEqual(v("listen_threshold", "4"), null);
  assert.equal(v("listen_quota_min", 1), null);
  assert.equal(v("listen_quota_min", 60), null);
  assert.notEqual(v("listen_quota_min", 0), null);
  assert.notEqual(v("listen_quota_min", 61), null);
  assert.equal(v("monthly_cap_jpy", 100), null);
  assert.equal(v("monthly_cap_jpy", 50000), null);
  assert.notEqual(v("monthly_cap_jpy", 99), null);
  assert.notEqual(v("monthly_cap_jpy", 50001), null);
  assert.equal(v("daily_cap_jpy", 50), null);
  assert.notEqual(v("daily_cap_jpy", 5001), null);
  assert.equal(v("hourly_call_cap", 50), null);
  assert.notEqual(v("hourly_call_cap", 5001), null);
  assert.equal(v("pipeline_auth_mode", "enforce"), null);
  assert.notEqual(v("pipeline_auth_mode", "off"), null);
  for (const k of ["kill_switch", "auto_expire_enabled", "cap_opinion", "backfill_enabled", "speech_enabled", "score_enabled", "tier_assign_enabled"]) {
    assert.equal(v(k, true), null);
    assert.notEqual(v(k, "true"), null);
    assert.notEqual(v(k, 1), null);
  }
  assert.equal(v("listen_speed", 0.5), null);
  assert.equal(v("listen_speed", 3), null);
  assert.notEqual(v("listen_speed", 3.1), null);
  assert.equal(v("listen_chars_per_sec", 6.5), null);
  assert.notEqual(v("listen_chars_per_sec", 2), null);
  assert.notEqual(v("listen_chars_per_sec", NaN), null);
  assert.equal(v("tier_scope_from", "2026-10-05T00:00:00+09:00"), null);
  assert.notEqual(v("tier_scope_from", "yesterday"), null);
  assert.equal(v("not_a_key", 1), "key_not_allowed");
  for (const k of ["interest_profile", "threshold_version", "ref_enabled", "__proto__", "constructor"]) {
    assert.equal(L.isAllowedConfigKey(k), false, k);
  }
});

test("config_set: 通常キーはpassphrase不要・履歴にadminで記録・同値は履歴なし", async () => {
  const { db, call, token } = await loggedIn({ config: { listen_threshold: 4 } });
  const r = await call({ action: "config_set", key: "listen_threshold", value: 3 }, token);
  assert.equal(r.status, 200);
  assert.equal(db.s.config.get("listen_threshold"), 3);
  assert.deepEqual(db.s.history[0], { id: 1, key: "listen_threshold", old_value: 4, new_value: 3, source: "admin" });
  assert.equal((await call({ action: "config_set", key: "listen_threshold", value: 3 }, token)).body.unchanged, true);
  assert.equal(db.s.history.length, 1);
  assert.equal((await call({ action: "config_set", key: "listen_threshold", value: 9 }, token)).body.error, "invalid_value");
  assert.equal((await call({ action: "config_set", key: "evil_key", value: 1 }, token)).body.error, "key_not_allowed");
  assert.equal((await call({ action: "config_set", key: "interest_profile", value: {} }, token)).body.error, "key_not_allowed");
  assert.equal(db.s.history.length, 1);
});

test("config_set: 保護キーはpassphrase再入力が必須(誤りは拒否・失敗カウント)", async () => {
  const keys = ["monthly_cap_jpy", "daily_cap_jpy", "hourly_call_cap", "pipeline_auth_mode", "kill_switch", "auto_expire_enabled", "usd_jpy", "cap_warn_ratio"];
  const vals: any = { usd_jpy: 150, cap_warn_ratio: 0.9, monthly_cap_jpy: 5000, daily_cap_jpy: 500, hourly_call_cap: 700, pipeline_auth_mode: "enforce", kill_switch: false, auto_expire_enabled: true };
  const { db, call, token } = await loggedIn();
  for (const k of keys) {
    assert.equal((await call({ action: "config_set", key: k, value: vals[k] }, token)).body.error, "passphrase_required", k);
    assert.equal((await call({ action: "config_set", key: k, value: vals[k], passphrase: "wrong-wrong-wrong" }, token)).status, 401, k);
    assert.equal(db.s.auth.failed_count, 1, k);
    db.s.auth.failed_count = 0; db.s.auth.last_failed_at = null; // 待ち時間の確認は login テストで実施
  }
  assert.equal(db.s.config.size, 0);
  db.s.auth.failed_count = 0; db.s.auth.last_failed_at = null;
  for (const k of keys) {
    assert.equal((await call({ action: "config_set", key: k, value: vals[k], passphrase: PASS }, token)).status, 200, k);
    assert.equal(db.s.config.get(k), vals[k]);
  }
});

test("config_set: 緊急停止(kill_switch=true・上限を下げる)は有効トークンだけで通る。戻す/上げるは再入力必須", async () => {
  const { db, call, token } = await loggedIn({
    config: { kill_switch: false, monthly_cap_jpy: 4000, daily_cap_jpy: 400, hourly_call_cap: 600, ti_daily_call_cap: 500, cap_warn_ratio: 0.8 },
  });
  const set = (key: string, value: unknown, extra: any = {}) => call({ action: "config_set", key, value, ...extra }, token);
  // 安全側: パスフレーズなしで通る(誤ったパスフレーズが付いていても検証しない=失敗に数えない)
  assert.equal((await set("kill_switch", true)).status, 200);
  assert.equal(db.s.config.get("kill_switch"), true);
  for (const [k, nv] of [["monthly_cap_jpy", 3000], ["daily_cap_jpy", 300], ["hourly_call_cap", 100], ["ti_daily_call_cap", 50]] as const) {
    assert.equal((await set(k, nv)).status, 200, k);
    assert.equal(db.s.config.get(k), nv, k);
  }
  assert.equal(db.s.auth.failed_count, 0);
  assert.equal(db.s.history.length, 5);
  assert.equal(db.s.history[1].source, "admin");
  // 危険側(解除・引き上げ・同値・他の保護キー)は再入力が必要
  assert.equal((await set("kill_switch", false)).body.error, "passphrase_required");
  for (const [k, nv] of [["monthly_cap_jpy", 3500], ["daily_cap_jpy", 300], ["hourly_call_cap", 700], ["ti_daily_call_cap", 60]] as const) {
    assert.equal((await set(k, nv)).body.error, "passphrase_required", k);
  }
  assert.equal((await set("cap_warn_ratio", 0.5)).body.error, "passphrase_required"); // 下げても対象外のキー
  assert.equal((await set("pipeline_auth_mode", "log")).body.error, "passphrase_required");
  assert.equal((await set("auto_expire_enabled", true)).body.error, "passphrase_required");
  assert.equal((await set("kill_switch", false, { passphrase: PASS })).status, 200);
  assert.equal(db.s.config.get("kill_switch"), false);
  // 値域は変わらない(下げでも範囲外は拒否)
  assert.equal((await set("monthly_cap_jpy", 50)).body.error, "invalid_value");
  // 旧値が未設定のときは下げかどうか分からないので再入力必須
  const fresh = await loggedIn();
  assert.equal((await fresh.call({ action: "config_set", key: "monthly_cap_jpy", value: 1000 }, fresh.token)).body.error, "passphrase_required");
  assert.equal((await fresh.call({ action: "config_set", key: "kill_switch", value: true }, fresh.token)).status, 200);
});

test("config_set: ログイン失敗の待ち時間中でも有効トークンの通常操作・緊急停止は通り、再入力経路だけ429", async () => {
  const { db, call, token } = await loggedIn({ config: { kill_switch: false, monthly_cap_jpy: 4000, listen_threshold: 4 } });
  for (let i = 0; i < 6; i++) await call({ action: "login", passphrase: "wrong-wrong-wrong" });
  assert.equal(db.s.auth.failed_count, 5); // 5回目で待ちに入り、以降は429で数えない
  assert.equal((await call({ action: "login", passphrase: PASS })).status, 429);
  assert.equal((await call({ action: "config_set", key: "kill_switch", value: true }, token)).status, 200);
  assert.equal((await call({ action: "config_set", key: "monthly_cap_jpy", value: 2000 }, token)).status, 200);
  assert.equal((await call({ action: "config_set", key: "listen_threshold", value: 3 }, token)).status, 200);
  assert.equal((await call({ action: "config_get" }, token)).status, 200);
  assert.equal((await call({ action: "me" }, token)).body.authed, true);
  const r = await call({ action: "config_set", key: "kill_switch", value: false, passphrase: PASS }, token); // 解除は再入力経路 → 待ち中は429
  assert.equal(r.status, 429);
  assert.equal(db.s.config.get("kill_switch"), true);
});

test("config_get: 許可キーだけ(interest_profile等は出さない)", async () => {
  const { call, token } = await loggedIn({ config: { listen_threshold: 4, interest_profile: { text: "SECRET" }, threshold_version: 2, other: 1 } });
  const r = await call({ action: "config_get" }, token);
  assert.deepEqual(r.body.config, { listen_threshold: 4, threshold_version: 2 });
  assert.equal(JSON.stringify(r.body).includes("SECRET"), false);
});

test("config_undo: 旧値に戻し、これも履歴に残す。保護キーはpassphrase必須", async () => {
  const { db, call, token } = await loggedIn({ config: { listen_threshold: 4, kill_switch: false } });
  await call({ action: "config_set", key: "listen_threshold", value: 3 }, token);
  const r = await call({ action: "config_undo", history_id: 1 }, token);
  assert.equal(r.status, 200);
  assert.equal(db.s.config.get("listen_threshold"), 4);
  assert.equal(db.s.history.length, 2);
  assert.deepEqual(db.s.history[1], { id: 2, key: "listen_threshold", old_value: 3, new_value: 4, source: "undo:1" });
  await call({ action: "config_set", key: "kill_switch", value: true, passphrase: PASS }, token);
  assert.equal((await call({ action: "config_undo", history_id: 3 }, token)).body.error, "passphrase_required");
  assert.equal(db.s.config.get("kill_switch"), true);
  assert.equal((await call({ action: "config_undo", history_id: 3, passphrase: PASS }, token)).status, 200);
  assert.equal(db.s.config.get("kill_switch"), false);
  assert.equal((await call({ action: "config_undo", history_id: 999 }, token)).status, 404);
  db.s.history.push({ id: 50, key: "evil", old_value: 1, new_value: 2, source: "x" });
  assert.equal((await call({ action: "config_undo", history_id: 50 }, token)).body.error, "key_not_allowed");
  db.s.history.push({ id: 51, key: "listen_threshold", old_value: null, new_value: 3, source: "x" });
  assert.equal((await call({ action: "config_undo", history_id: 51 }, token)).body.error, "cannot_undo");
});

// ---- 冪等・区分 ---------------------------------------------------------------------
test("tier_set: promote/demote の更新内容とop_id冪等", async () => {
  const url = "https://x.com/a/status/1";
  const { db, call, token } = await loggedIn({ posts: [[url, { listen_tier: "skim", is_read: false }]] });
  assert.equal((await call({ action: "tier_set", post_url: url, how: "promote" }, token)).body.op_id, undefined);
  assert.equal((await call({ action: "tier_set", post_url: url, how: "promote" }, token)).body.error, "op_id_required");
  const r = await call({ action: "tier_set", op_id: "op1", post_url: url, how: "demote" }, token);
  assert.deepEqual(r.body, { ok: true });
  const p = db.s.posts.get(url);
  assert.equal(p.listen_tier, "hold");
  assert.equal(p.is_read, true);
  assert.equal(p.read_via, "user");
  assert.equal(p.manual_action, "demote");
  p.listen_tier = "skim"; // 再送で巻き戻らないこと
  const dup = await call({ action: "tier_set", op_id: "op1", post_url: url, how: "demote" }, token);
  assert.deepEqual(dup.body, { ok: true, duplicate: true });
  assert.equal(p.listen_tier, "skim");
  const pr = await call({ action: "tier_set", op_id: "op2", post_url: url, how: "promote" }, token);
  assert.equal(pr.status, 200);
  assert.equal(p.listen_tier, "listen");
  assert.equal(p.manual_action, "promote");
  assert.equal(p.tier_reason, "manual_promote");
  assert.equal((await call({ action: "tier_set", op_id: "op3", post_url: "https://x.com/none", how: "promote" }, token)).status, 404);
  assert.equal(db.s.ops.has("op3"), false); // 失敗した操作は再送可能
  assert.equal((await call({ action: "tier_set", op_id: "op4", post_url: url, how: "hack" }, token)).status, 400);
});

// ---- ラベル(盲検) ----------------------------------------------------------------------
const LABELS = () => [
  { id: 1, list_no: 7, slot: "ai4", author_handle: "@alice", content: "c1", summary: "s1", image_urls: ["https://i/1.png"], ai_score: 5, ai_kind: "primary", ai_model: "m", inclusion_prob: 0.9, post_url: "https://x/1", label_score: null },
  { id: 2, list_no: 7, slot: "low", author_handle: "@bob", content: "c2", summary: null, image_urls: null, ai_score: 1, ai_kind: "announce", ai_model: "m", inclusion_prob: 0.1, post_url: "https://x/2", label_score: null },
  { id: 3, list_no: 7, slot: "uniform", author_handle: "@carol", content: "c3", summary: "s3", image_urls: [], ai_score: 3, ai_kind: "news", ai_model: "m", inclusion_prob: 0.5, post_url: "https://x/3", label_score: 4 },
  { id: 4, list_no: 6, slot: "uniform", author_handle: "@dave", content: "old", summary: "s", image_urls: [], ai_score: 3, ai_kind: "news", ai_model: "m", inclusion_prob: 0.5, post_url: "https://x/4", label_score: null },
];

test("label_next: 盲検(ai_*・author・slot・post_url等を返さない)・最新list・未回答のみ", async () => {
  const { call, token } = await loggedIn({ labels: LABELS() });
  const r = await call({ action: "label_next" }, token);
  assert.equal(r.body.list_no, 7);
  assert.equal(r.body.remaining, 2);
  assert.equal(r.body.total, 3);
  const items = r.body.items as any[];
  assert.deepEqual(items.map((i) => i.id).sort(), [1, 2]);
  for (const it of items) assert.deepEqual(Object.keys(it).sort(), ["content", "id", "image_urls", "summary"]);
  const text = JSON.stringify(r.body);
  for (const leak of ["ai_score", "ai_kind", "ai_model", "author", "alice", "bob", "carol", "slot", "inclusion", "post_url", "primary", "announce"]) {
    assert.equal(text.includes(leak), false, leak);
  }
  assert.deepEqual((items.find((i) => i.id === 2)).image_urls, []);
  const other = await call({ action: "label_next", list_no: 6 }, token);
  assert.equal((other.body.items as any[])[0].content, "old");
  const none = await call({ action: "label_next", list_no: 99 }, token);
  assert.deepEqual([none.body.remaining, none.body.total, (none.body.items as any[]).length], [0, 0, 0]);
  assert.equal((await call({ action: "label_next", list_no: "x" }, token)).status, 400);
});

test("label_next: 並び順は枠(挿入順)に依存しない", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, content: "c", summary: null, image_urls: [], label_score: null }));
  const ids = L.blindLabelItems(rows as any).map((x) => x.id);
  assert.notDeepEqual(ids, rows.map((r) => r.id));
  assert.deepEqual([...ids].sort((a, b) => a - b), rows.map((r) => r.id));
});

test("label_submit: 保存・残り件数・冪等・入力検査・盲検(応答にAI点なし)", async () => {
  const { db, call, token } = await loggedIn({ labels: LABELS() });
  const r = await call({ action: "label_submit", op_id: "l1", id: 1, score: 5, cls: "other" }, token);
  assert.deepEqual(r.body, { ok: true, remaining: 1 });
  assert.equal(db.s.labels[0].label_score, 5);
  assert.equal(db.s.labels[0].label_class, "other");
  assert.ok(db.s.labels[0].labeled_at);
  const dup = await call({ action: "label_submit", op_id: "l1", id: 1, score: 1, cls: "other" }, token);
  assert.deepEqual(dup.body, { ok: true, duplicate: true, remaining: 1 });
  assert.equal(db.s.labels[0].label_score, 5);
  for (const bad of [{ id: 2, score: 0, cls: "other" }, { id: 2, score: 6, cls: "other" }, { id: 2, score: 3, cls: "x" }, { id: "a", score: 3, cls: "other" }]) {
    assert.equal((await call({ action: "label_submit", op_id: "lx", ...bad }, token)).status, 400);
  }
  assert.equal((await call({ action: "label_submit", op_id: "l9", id: 777, score: 3, cls: "other" }, token)).status, 404);
});

test("label_create: create_label_list(p_n)を呼ぶだけ", async () => {
  const { db, call, token } = await loggedIn({ rpcImpl: { create_label_list: () => ({ data: [{ list_no: 3, created: 20 }], error: null }) } });
  const r = await call({ action: "label_create" }, token);
  assert.deepEqual(r.body, { ok: true, list_no: 3, created: 20 });
  assert.deepEqual(db.s.rpcs.at(-1), { name: "create_label_list", args: { p_n: 20 } });
  await call({ action: "label_create", n: 5 }, token);
  assert.equal(db.s.rpcs.at(-1).args.p_n, 5);
  assert.equal((await call({ action: "label_create", n: 0 }, token)).status, 400);
  assert.equal((await call({ action: "label_create", n: 61 }, token)).status, 400);
  assert.equal((await call({ action: "label_create", n: 101 }, token)).status, 400);
  assert.equal((await call({ action: "label_create", n: 60 }, token)).status, 200);
  assert.equal(db.s.rpcs.at(-1).args.p_n, 60);
});

// ---- レポート・費用 ---------------------------------------------------------------------
test("week_report / authors", async () => {
  const { db, call, token } = await loggedIn({
    week: { week_start: "2026-10-05", body: { a: 1 }, text_ja: "本文" },
    rpcImpl: { author_scoreboard: () => ({ data: [{ author_handle: "@a", author_name: "A", n: 9, low_n: 1, high_n: 5, low_rate: 0.1, high_rate: 0.5, low_lo: 0, high_hi: 1, mean: 3.2, verdict: "keep", secret_extra: "x" }], error: null }) },
  });
  assert.deepEqual((await call({ action: "week_report" }, token)).body, { ok: true, week_start: "2026-10-05", text_ja: "本文", body: { a: 1 } });
  const a = await call({ action: "authors", weeks: 8 }, token);
  assert.equal((a.body.rows as any[])[0].verdict, "keep");
  assert.equal("secret_extra" in (a.body.rows as any[])[0], false);
  assert.deepEqual(db.s.rpcs.at(-1), { name: "author_scoreboard", args: { p_weeks: 8 } });
  assert.equal((await call({ action: "authors", weeks: 0 }, token)).status, 400);
  const empty = await loggedIn();
  assert.deepEqual((await empty.call({ action: "week_report" }, empty.token)).body, { ok: true, empty: true });
  assert.equal((await empty.call({ action: "week_report", week_start: "bad" }, empty.token)).status, 400);
});

test("cost_summary: 月末見込み=実績÷経過日数×月日数、グループ別・先月・月次", async () => {
  const row = (month: string, grp: string, purpose: string, model: string, calls: number, usd: number, jpy: number, fin = false) =>
    ({ month, grp, purpose, model, calls, cost_usd: usd, cost_jpy: jpy, finalized: fin });
  const months = [
    row("2026-09-01", "x", "score", "m1", 100, 1, 160, true),
    row("2026-10-01", "x", "score", "m1", 10, 2, 320),
    row("2026-10-01", "x", "summary", "m2", 5, 1, 160),
    row("2026-10-01", "ti", "summary", "m2", 3, 0.5, 80),
  ];
  const errors = [{ called_at: "2026-10-14T00:00:00Z", fn: "f", purpose: "score", model: "m1", http_status: 500, status: "error", error: "boom https://g/v1?key=AIzaSyABCDEFGHIJKL secret" }];
  const { call, token } = await loggedIn({
    months, errors,
    rpcImpl: {
      cost_guard: () => ({ data: { allowed: true, level: "ok", day_jpy: 12.3 }, error: null }),
      get_model_state: () => ({ data: { current_model: "m1", candidates: ["m1", "m2"] }, error: null }),
    },
  });
  // 2026-10-15 03:00 UTC = JST 12:00 → 経過 14.5日、10月は31日
  const r = await call({ action: "cost_summary" }, token);
  const b = r.body as any;
  assert.equal(b.ok, true);
  assert.equal(b.today_jpy, 12.3);
  assert.equal(b.this_month.jpy, 560);
  assert.equal(b.this_month.calls, 18);
  assert.equal(b.this_month.forecast_jpy, Math.round((560 / 14.5) * 31));
  assert.deepEqual(b.this_month.by_model, [{ model: "m1", jpy: 320, calls: 10 }, { model: "m2", jpy: 240, calls: 8 }]);
  assert.deepEqual(b.this_month.by_grp, [{ grp: "x", jpy: 480 }, { grp: "ti", jpy: 80 }]);
  assert.deepEqual(b.this_month.by_purpose[0], { purpose: "score", jpy: 320, calls: 10 });
  assert.deepEqual(b.last_month, { jpy: 160, usd: 1, calls: 100 });
  assert.deepEqual(b.months, [{ month: "2026-09", jpy: 160, usd: 1, finalized: true }, { month: "2026-10", jpy: 560, usd: 3.5, finalized: false }]);
  assert.equal(b.guard.level, "ok");
  assert.deepEqual(b.model_state, { current_model: "m1", candidates: ["m1", "m2"], last_switch_at: null });
  assert.equal(JSON.stringify(b.recent_errors).includes("AIza"), false);
  assert.equal(JSON.stringify(b.recent_errors).includes("https://"), false);
  assert.equal(b.recent_errors[0].status, 500);
});

test("cost_summary: データなしでも壊れない", async () => {
  const { call, token } = await loggedIn();
  const b = (await call({ action: "cost_summary" }, token)).body as any;
  assert.equal(b.this_month.forecast_jpy, 0);
  assert.equal(b.last_month, null);
  assert.deepEqual(b.months, []);
});

// ---- 通知・プロファイル・その他 -----------------------------------------------------------
test("notify_info / notify_test / ops_events", async () => {
  const events = [{ id: 2, at: "t2", level: "warn", kind: "k", message: "m", suppressed: true, data: { secret: 1 } }, { id: 1, at: "t1", level: "info", kind: "k", message: "m", suppressed: false }];
  const { call, token } = await loggedIn({ events, rpcImpl: { get_secret: () => ({ data: "xdash-abc", error: null }), notify_test: () => ({ data: 5, error: null }) } });
  const n = await call({ action: "notify_info" }, token);
  assert.equal(n.body.topic, "xdash-abc");
  assert.equal(n.body.configured, true);
  assert.deepEqual((n.body.events as any[])[0], { at: "t2", level: "warn", kind: "k", message: "m", suppressed: true });
  assert.deepEqual((await call({ action: "notify_test" }, token)).body, { ok: true });
  const o = await call({ action: "ops_events", limit: 1 }, token);
  assert.equal((o.body.events as any[]).length, 1);
  assert.equal(JSON.stringify(o.body).includes("secret"), false);
  const none = await loggedIn({ rpcImpl: { notify_test: () => ({ data: null, error: null }) } });
  assert.equal((await none.call({ action: "notify_test" }, none.token)).status, 400);
});

test("set_healthcheck: passphrase必須・https・Vaultへ。URLはログ(ops_event)に残さない", async () => {
  const { db, call, token } = await loggedIn();
  const url = "https://hc-ping.com/abc-123";
  assert.equal((await call({ action: "set_healthcheck", kind: "daily", url }, token)).body.error, "passphrase_required");
  assert.equal((await call({ action: "set_healthcheck", kind: "daily", url: "http://x.com/a", passphrase: PASS }, token)).body.error, "invalid_value");
  assert.equal((await call({ action: "set_healthcheck", kind: "monthly", url, passphrase: PASS }, token)).status, 400);
  assert.equal((await call({ action: "set_healthcheck", kind: "weekly", url, passphrase: PASS }, token)).status, 200);
  const set = db.s.rpcs.find((x: any) => x.name === "set_secret");
  assert.deepEqual(set.args, { p_name: "xd_healthcheck_weekly_url", p_value: url });
  assert.equal(JSON.stringify(db.s.rpcs.filter((x: any) => x.name === "ops_event")).includes("hc-ping"), false);
});

test("profile_get / profile_set: 版+1・approveのみapproved・passphrase必須・600字", async () => {
  const { db, call, token } = await loggedIn();
  assert.deepEqual((await call({ action: "profile_get" }, token)).body, { ok: true, version: 0, status: "draft", text: "" });
  assert.equal((await call({ action: "profile_set", text: "t", approve: false }, token)).body.error, "passphrase_required");
  const a = await call({ action: "profile_set", text: "A", approve: false, passphrase: PASS }, token);
  assert.deepEqual(a.body, { ok: true, version: 1, status: "draft" });
  const b = await call({ action: "profile_set", text: "B", approve: true, passphrase: PASS }, token);
  assert.deepEqual(b.body, { ok: true, version: 2, status: "approved" });
  assert.deepEqual((await call({ action: "profile_get" }, token)).body, { ok: true, version: 2, status: "approved", text: "B" });
  assert.equal(db.s.history.length, 2);
  assert.equal((await call({ action: "profile_set", text: "あ".repeat(601), approve: false, passphrase: PASS }, token)).status, 400);
  assert.equal((await call({ action: "profile_set", text: "あ".repeat(600), approve: false, passphrase: PASS }, token)).status, 200);
  assert.equal((await call({ action: "profile_set", text: "  ", approve: false, passphrase: PASS }, token)).status, 400);
});

test("不正な入力", async () => {
  const { call } = await loggedIn();
  const bad = [null, "x", [], {}, { action: 5 }];
  for (const b of bad) assert.equal((await call(b as any)).status, 400);
  assert.equal((await call({ action: "toString" })).body.error, "unknown_action");
});

test("費用集計の月キー(JST)", () => {
  assert.equal(L.jstMonthKey(Date.UTC(2026, 9, 31, 16, 0, 0)), "2026-11-01"); // JST 11/1 01:00
  assert.equal(L.jstMonthKey(Date.UTC(2026, 0, 15), -1), "2025-12-01");
  assert.equal(L.jstMonthKey(Date.UTC(2026, 9, 15), -12), "2025-10-01");
});
