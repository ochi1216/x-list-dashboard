import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkPipelineAuth, clearAuthCache, timingSafeEqual } from "../functions/_shared/auth.ts";

const SECRETS: Record<string, string | null> = {
  xd_pipeline_secret_cron: "cron-secret-AAAA",
  xd_pipeline_secret_win: "win-secret-BBBB",
};

function mk(secrets: Record<string, string | null> = SECRETS) {
  const calls: { name: string; args: any }[] = [];
  const db = {
    async rpc(name: string, args?: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "get_secret") return { data: secrets[(args as any).p_name] ?? null, error: null };
      return { data: null, error: null };
    },
  };
  return { db, calls };
}
const reqWith = (h?: string) => ({ headers: { get: (n: string) => (n.toLowerCase() === "x-pipeline-secret" ? h ?? null : null) } });

beforeEach(() => clearAuthCache());

test("cronの秘密はcron、winの秘密はwin", async () => {
  const { db } = mk();
  assert.deepEqual(await checkPipelineAuth(reqWith("cron-secret-AAAA"), { db, mode: "enforce", allow: ["cron", "win"] }), { caller: "cron", ok: true, limited: false });
  assert.deepEqual(await checkPipelineAuth(reqWith("win-secret-BBBB"), { db, mode: "enforce", allow: ["cron", "win"] }), { caller: "win", ok: true, limited: false });
});

test("allowに無い呼び出し元は秘密が正しくてもng(winは新関数で不可)", async () => {
  const { db } = mk();
  const r = await checkPipelineAuth(reqWith("win-secret-BBBB"), { db, mode: "log", allow: ["cron"] });
  assert.equal(r.caller, "win");
  assert.equal(r.ok, false);
});

test("新関数(allow=[cron])は秘密なしだとlogモードでもng", async () => {
  const { db, calls } = mk();
  const r = await checkPipelineAuth(reqWith(), { db, mode: "log", allow: ["cron"] });
  assert.deepEqual(r, { caller: "none", ok: false, limited: false });
  assert.ok(!calls.some((c) => c.name === "ops_event"));
});

test("logモード: 秘密なし/不一致は制限付きで許可しops_event(warn,unauth_call,dedupe360)", async () => {
  for (const h of [undefined, "wrong"]) {
    clearAuthCache();
    const { db, calls } = mk();
    const r = await checkPipelineAuth(reqWith(h), { db, mode: "log", allow: ["cron", "win", "none"], fn: "summarize-x-post" });
    assert.deepEqual(r, { caller: "none", ok: true, limited: true });
    const ev = calls.find((c) => c.name === "ops_event")!;
    assert.equal(ev.args.p_level, "warn");
    assert.equal(ev.args.p_kind, "unauth_call");
    assert.equal(ev.args.p_dedupe_minutes, 360);
    assert.ok(!JSON.stringify(ev.args).includes("wrong"));
  }
});

test("enforceモード: 秘密なし/不一致は拒否", async () => {
  const { db } = mk();
  for (const h of [undefined, "", "wrong", "cron-secret-AAA", "cron-secret-AAAAA"]) {
    const r = await checkPipelineAuth(reqWith(h), { db, mode: "enforce", allow: ["cron", "win", "none"] });
    assert.deepEqual(r, { caller: "none", ok: false, limited: false });
  }
});

test("秘密が未設定(null/空)のとき、空ヘッダは一致しない", async () => {
  const { db } = mk({ xd_pipeline_secret_cron: null, xd_pipeline_secret_win: "" });
  const r = await checkPipelineAuth(reqWith(""), { db, mode: "enforce", allow: ["cron", "win"] });
  assert.equal(r.ok, false);
  assert.equal(r.caller, "none");
});

test("Vault秘密は60秒キャッシュ(取得失敗はキャッシュしない)", async () => {
  const { db, calls } = mk();
  let t = 100_000;
  const now = () => t;
  await checkPipelineAuth(reqWith("cron-secret-AAAA"), { db, mode: "enforce", allow: ["cron"], now });
  t += 59_000;
  await checkPipelineAuth(reqWith("cron-secret-AAAA"), { db, mode: "enforce", allow: ["cron"], now });
  assert.equal(calls.filter((c) => c.name === "get_secret").length, 2); // cron+win を1回ずつ
  t += 2_000;
  await checkPipelineAuth(reqWith("cron-secret-AAAA"), { db, mode: "enforce", allow: ["cron"], now });
  assert.equal(calls.filter((c) => c.name === "get_secret").length, 4);

  clearAuthCache();
  let fail = true;
  const db2 = { async rpc(_n: string, _a?: Record<string, unknown>) { return fail ? { data: null, error: { message: "down" } } : { data: "cron-secret-AAAA", error: null }; } };
  const bad = await checkPipelineAuth(reqWith("cron-secret-AAAA"), { db: db2, mode: "enforce", allow: ["cron"], now });
  assert.equal(bad.ok, false);
  fail = false;
  const good = await checkPipelineAuth(reqWith("cron-secret-AAAA"), { db: db2, mode: "enforce", allow: ["cron"], now });
  assert.equal(good.ok, true);
});

test("timingSafeEqual: 一致/不一致/長さ違い/マルチバイト", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
  assert.equal(timingSafeEqual("あい", "あい"), true);
  assert.equal(timingSafeEqual("あい", "あう"), false);
});
