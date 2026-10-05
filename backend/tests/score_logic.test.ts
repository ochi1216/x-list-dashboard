import { test } from "node:test";
import assert from "node:assert/strict";
import {
  failureClass, failureUpdate, hasEarlierDuplicate, mapPool, parseCfg, ruleFields, sanitize, speechDecision, targetFrom, wantRescore,
} from "../functions/score-x-posts/logic.ts";

test("parseCfg と targetFrom", () => {
  const c = parseCfg([
    { key: "backfill_enabled", value: true }, { key: "tier_scope_from", value: "2026-10-01T00:00:00Z" },
    { key: "score_backfill_from", value: "2026-09-01T00:00:00Z" }, { key: "listen_threshold", value: 4 },
    { key: "interest_profile", value: { version: 3, status: "approved", text: " T " } },
  ]);
  assert.equal(targetFrom(c), "2026-09-01T00:00:00Z");
  assert.equal(c.profileText, "T");
  assert.equal(c.profileVersion, 3);
  assert.equal(targetFrom({ ...c, backfillEnabled: false }), "2026-10-01T00:00:00Z");
  const d = parseCfg([]);
  assert.equal(d.listenThreshold, 4); assert.equal(d.capOpinion, false); assert.equal(targetFrom(d), null);
  assert.equal(d.profileText, "");
});

test("重複判定: 先行・14日・同時刻はpost_url昇順", () => {
  const self = { post_url: "https://x.com/a/2", posted_at: "2026-10-05T00:00:00Z" };
  assert.equal(hasEarlierDuplicate(self, [{ post_url: "https://x.com/a/1", posted_at: "2026-10-04T00:00:00Z" }]), true);
  assert.equal(hasEarlierDuplicate(self, [{ post_url: "https://x.com/a/3", posted_at: "2026-10-06T00:00:00Z" }]), false);
  assert.equal(hasEarlierDuplicate(self, [{ post_url: "https://x.com/a/1", posted_at: "2026-09-20T00:00:00Z" }]), false); // 15日前
  assert.equal(hasEarlierDuplicate(self, [{ post_url: "https://x.com/a/1", posted_at: "2026-09-21T00:00:01Z" }]), true);
  assert.equal(hasEarlierDuplicate(self, [{ post_url: "https://x.com/a/1", posted_at: "2026-10-05T00:00:00Z" }]), true);  // 同時刻・url小
  assert.equal(hasEarlierDuplicate(self, [{ post_url: "https://x.com/a/9", posted_at: "2026-10-05T00:00:00Z" }]), false); // 同時刻・url大
  assert.equal(hasEarlierDuplicate(self, [self]), false);
  // 双方向で両方が重複扱いにならない
  const other = { post_url: "https://x.com/a/1", posted_at: "2026-10-05T00:00:00Z" };
  assert.equal(hasEarlierDuplicate(other, [self]), false);
});

test("ruleFields", () => {
  assert.equal(ruleFields("duplicate").score, 1);
  assert.equal(ruleFields("none").score_state, "rule");
  assert.equal(ruleFields("duplicate").score_kind, "duplicate");
});

test("failureUpdate: 3回でfailed", () => {
  assert.deepEqual(failureUpdate(0), { score_attempts: 1, score_state: null });
  assert.deepEqual(failureUpdate(2), { score_attempts: 3, score_state: "failed" });
});

test("failureClass / wantRescore", () => {
  assert.equal(failureClass("guard"), "guard");
  assert.equal(failureClass("parse"), "content");
  assert.equal(failureClass("http"), "transport");
  assert.equal(failureClass("auth", 403), "auth");
  assert.equal(failureClass("empty"), "content");
  // 通信系(network・5xx・429・提供終了)は数えない / 認証系は auth / 429・認証系以外の4xxは応答不正として数える
  assert.equal(failureClass("network"), "transport");
  for (const st of [429, 500, 503]) assert.equal(failureClass("http", st), "transport", `http ${st}`);
  assert.equal(failureClass("gone", 404), "transport");
  for (const st of [400, 404, 422]) assert.equal(failureClass("http", st), "content", `http ${st}`);
  for (const st of [401, 403]) assert.equal(failureClass("http", st), "transport", `http ${st}(通常は auth で来る)`);
  assert.equal(wantRescore({ rescore: true }, 3, 4), true);
  assert.equal(wantRescore({ rescore: true }, 4, 4), true);
  assert.equal(wantRescore({ rescore: true }, 5, 4), false);
  assert.equal(wantRescore({ rescore: true }, 2, 4), false);
  assert.equal(wantRescore({ rescore: false }, 4, 4), false);
  assert.equal(wantRescore(undefined, 4, 4), false);
});

test("sanitize: キーを伏せ200字に丸める", () => {
  const s = sanitize("fail AIzaSyA1234567890abcdefghij and ?key=SECRET123 " + "x".repeat(500));
  assert.ok(!s.includes("AIza") && !s.includes("SECRET123") && s.length <= 200);
});

test("mapPool: 並列上限と停止", async () => {
  let active = 0, peak = 0, done = 0;
  await mapPool([...Array(10).keys()], 4, async () => {
    active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; done++;
  }, () => false);
  assert.equal(done, 10); assert.ok(peak <= 4 && peak >= 2);
  let n = 0;
  await mapPool([1, 2, 3, 4, 5, 6], 1, async () => { n++; }, () => n >= 2);
  assert.equal(n, 2);
});

test("parseCfg: tier_assign_enabled は既定true(区分確定を止めない)、falseなら止める", () => {
  assert.equal(parseCfg([]).tierAssignEnabled, true);
  assert.equal(parseCfg([{ key: "tier_assign_enabled", value: false }]).tierAssignEnabled, false);
  assert.equal(parseCfg([{ key: "tier_assign_enabled", value: "false" }]).tierAssignEnabled, true); // 型違いは既定
  assert.equal(parseCfg([{ key: "score_enabled", value: false }]).scoreEnabled, false);
});

test("speechDecision: guard停止のときだけ記録しない。それ以外の失敗(通信・parse・形式不正・数値不一致)は記録して再試行しない", () => {
  assert.equal(speechDecision({ ok: true }, true, true), "save");
  assert.equal(speechDecision({ ok: true }, false, false), "record_failure"); // 形式不正
  assert.equal(speechDecision({ ok: true }, true, false), "record_failure"); // 数値不一致
  assert.equal(speechDecision({ ok: false, kind: "parse" }, false, false), "record_failure");
  assert.equal(speechDecision({ ok: false, kind: "empty" }, false, false), "record_failure");
  assert.equal(speechDecision({ ok: false, kind: "http" }, false, false), "record_failure");
  assert.equal(speechDecision({ ok: false, kind: "network" }, false, false), "record_failure");
  assert.equal(speechDecision({ ok: false, kind: "guard" }, false, false), "guard_stop");
  assert.equal(speechDecision({ ok: false, kind: "auth" }, false, false), "auth_stop"); // 認証エラーも記録せず打ち切る
});
