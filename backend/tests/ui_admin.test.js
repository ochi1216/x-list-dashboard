// index_beta.html 第2段(週次・費用・設定の追加部分)の画面テスト。
// 実行: node backend/tests/ui_admin.test.js        (TTS=real で ui/tts.js の本物を使用。既定は tests/tts_stub.js)
// 前提: Playwright(/opt/node22/lib/node_modules/playwright) と chromium(/opt/pw-browsers)。Supabase REST と admin-api はすべてモック(本番へは接続しない)。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const ROOT = path.resolve(__dirname, "../..");
const TTS_FILE = process.env.TTS === "real" ? path.join(ROOT, "ui/tts.js") : path.join(__dirname, "tts_stub.js");
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let failures = 0, total = 0;
const check = (label, cond, extra = "") => { total++; if (!cond) failures++; console.log(`${cond ? "OK " : "NG "} ${label}${cond ? "" : " " + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return false; await sleep(step); } }

function buildTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiadmin-"));
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(dir, "index.html"));
  execFileSync("bash", [path.join(ROOT, "backend/ui_build.sh"), "--tts", TTS_FILE, "--in", path.join(ROOT, "index_beta.html"), "--out", path.join(dir, "index_beta.html")], { stdio: "pipe" });
  return dir;
}
function serve(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(dir, req.url.split("?")[0].split("#")[0].replace(/^\/+/, "") || "index.html");
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(f));
    }).listen(0, () => resolve(srv));
  });
}

// ---------------------------------------------------------------- admin-api のモック(状態を持つ)
const PASS = "correct-passphrase-1";
function newState(o = {}) {
  const st = {
    setupDone: true, setupCode: "ABCD1234", passphrase: PASS, valid: new Set(), minted: 0, lastMinted: null,
    calls: [], locked: false, renew: false, failSubmit: 0, answered: new Map(), // op_id -> id
    notify: { topic: "xdash-topic-7f3a9c", configured: true, events: [{ at: new Date().toISOString(), level: "warn", kind: "fetch_late", message: "取得が遅れています", suppressed: false }] },
    profile: { version: 2, status: "draft", text: "AIエージェントと開発ツールの新発表を優先して聴きたい。" },
    config: { listen_quota_min: 10, listen_threshold: 4, listen_speed: 1.2, monthly_cap_jpy: 4000, usd_jpy: 150, kill_switch: false, score_enabled: true, pipeline_auth_mode: "log" },
    protectedKeys: ["monthly_cap_jpy", "kill_switch", "pipeline_auth_mode"], requirePass: ["usd_jpy"], history: 0, histories: {},
    report: { empty: false, week_start: "2026-09-28", text_ja: "今週は生成AIの新発表が多い週でした。エージェント関連の話題が中心です。" },
    authors: [
      { author_handle: "@spam_a", author_name: "宣伝A", n: 30, low_n: 21, high_n: 0, low_rate: 0.7, high_rate: 0, low_lo: 0.52, high_hi: 0.11, mean: 1.4, verdict: "exclude_candidate" },
      { author_handle: "@maybe_b", author_name: "様子見B", n: 5, low_n: 3, high_n: 1, low_rate: 0.6, high_rate: 0.2, low_lo: 0.23, high_hi: 0.62, mean: 2.6, verdict: "hold" },
      { author_handle: "@good_c", author_name: "良質C", n: 25, low_n: 1, high_n: 15, low_rate: 0.04, high_rate: 0.6, low_lo: 0.01, high_hi: 0.78, mean: 4.1, verdict: "keep" },
    ],
    labelItems: [1, 2, 3, 4].map((i) => ({ id: 1000 + i, content: `本文${i}です。詳しい内容がここに入ります。`, summary: `要約${i}の文章です。二つ目の文。`, image_urls: [], ai_score: 5, author_handle: "@SECRETAUTHOR", author_name: "秘密の投稿者" })),
    cost: {
      ok: true, today_jpy: 123, this_month: { jpy: 1234, usd: 8.21, calls: 4567, forecast_jpy: 3456, by_model: [{ model: "gemini-2.5-flash", jpy: 1000, calls: 4000 }, { model: "gemini-3.5-flash", jpy: 234, calls: 567 }], by_purpose: [{ purpose: "summary", jpy: 900, calls: 3000 }], by_grp: [{ grp: "x", jpy: 1000 }, { grp: "ti", jpy: 234 }] },
      last_month: { jpy: 2999, usd: 20, calls: 9000 },
      months: [["2025-10", 1500], ["2025-11", 1800], ["2025-12", 2100], ["2026-01", 2000], ["2026-02", 2200], ["2026-03", 2500], ["2026-04", 2400], ["2026-05", 2600], ["2026-06", 2700], ["2026-07", 2800], ["2026-08", 2900], ["2026-09", 2999], ["2026-10", 1234]].map(([month, jpy], i, a) => ({ month, jpy, usd: jpy / 150, finalized: i < a.length - 1 })),
      guard: { allowed: true, level: "warn", month_jpy: 3300, day_jpy: 123, cap_jpy: 4000, calls_1h: 12 },
      model_state: { current_model: "gemini-2.5-flash", candidates: ["gemini-2.5-flash", "gemini-3.5-flash"], last_switch_at: null },
      recent_errors: [{ at: new Date().toISOString(), fn: "score-x-posts", purpose: "score", model: "gemini-2.5-flash", status: 429, error: "quota exceeded for 〇〇" }],
    },
    ...o,
  };
  if (o.seedToken) st.valid.add(o.seedToken);
  return st;
}
function adminHandle(st, b, token) {
  st.calls.push({ action: b.action, body: b, token: token || null });
  const J = (status, json) => ({ status, json });
  const authed = !!(token && st.valid.has(token));
  const mint = () => { const t = `tok-${++st.minted}`; st.valid.add(t); st.lastMinted = t; return t; };
  const norm = (c) => String(c || "").toUpperCase().replace(/-/g, "");
  switch (b.action) {
    case "me": return J(200, authed ? { ok: true, authed: true, setup_done: true, key_version: 1 } : { ok: true, authed: false, setup_done: st.setupDone });
    case "setup":
      if (st.setupDone) return J(409, { ok: false, error: "setup_done" });
      if (norm(b.setup_code) !== st.setupCode) return J(401, { ok: false, error: "setup_code_invalid" });
      if ([...String(b.passphrase || "")].length < 12) return J(400, { ok: false, error: "passphrase_too_short" });
      st.setupDone = true; st.passphrase = b.passphrase; return J(200, { ok: true, token: mint() });
    case "login":
      if (st.locked) return J(429, { ok: false, error: "rate_limited", retry_after: 3 });
      if (b.passphrase !== st.passphrase) return J(401, { ok: false, error: "invalid_passphrase" });
      return J(200, { ok: true, token: mint() });
  }
  if (!authed) return J(401, { ok: false, error: "invalid_token" });
  const withTok = (j) => { if (st.renew) { st.renew = false; j.token = mint(); } return j; };
  const needPass = (key) => st.protectedKeys.includes(key) || st.requirePass.includes(key);
  const passCheck = (key) => {
    if (!needPass(key)) return null;
    if (!b.passphrase) return J(400, { ok: false, error: "passphrase_required" });
    if (b.passphrase !== st.passphrase) return J(401, { ok: false, error: "bad_passphrase" });
    return null;
  };
  switch (b.action) {
    case "notify_info": return J(200, withTok({ ok: true, ...st.notify }));
    case "notify_test": return st.notify.configured ? J(200, { ok: true }) : J(400, { ok: false, error: "not_configured" });
    case "set_healthcheck":
      if (b.passphrase !== st.passphrase) return J(401, { ok: false, error: "bad_passphrase" });
      return J(200, { ok: true });
    case "profile_get": return J(200, { ok: true, ...st.profile });
    case "profile_set":
      if (b.passphrase !== st.passphrase) return J(401, { ok: false, error: "bad_passphrase" });
      st.profile = { version: st.profile.version + 1, status: b.approve ? "approved" : "draft", text: b.text };
      return J(200, { ok: true, version: st.profile.version, status: st.profile.status });
    case "config_get": return J(200, withTok({ ok: true, config: st.config, protected: st.protectedKeys }));
    case "config_set": {
      if (!(b.key in st.config)) return J(400, { ok: false, error: "key_not_allowed" });
      const pc = passCheck(b.key); if (pc) return pc;
      if (st.config[b.key] === b.value) return J(200, { ok: true, unchanged: true });
      const id = ++st.history; st.histories[id] = { key: b.key, old: st.config[b.key] }; st.config[b.key] = b.value;
      return J(200, { ok: true, history_id: id });
    }
    case "config_undo": {
      const h = st.histories[b.history_id]; if (!h) return J(400, { ok: false, error: "cannot_undo" });
      st.config[h.key] = h.old; return J(200, { ok: true, history_id: b.history_id + 100, key: h.key, value: h.old });
    }
    case "week_report": return J(200, st.report.empty ? { ok: true, empty: true } : { ok: true, ...st.report, body: {} });
    case "authors": return J(200, { ok: true, rows: st.authors });
    case "cost_summary": return J(200, st.cost);
    case "label_create": return J(200, { ok: true, list_no: 1, created: 4 });
    case "label_next": {
      const items = st.labelItems.filter((x) => ![...st.answered.values()].includes(x.id));
      return J(200, { ok: true, list_no: 1, items, remaining: items.length, total: st.labelItems.length });
    }
    case "label_submit": {
      if (!b.op_id) return J(400, { ok: false, error: "op_id_required" });
      const dup = st.answered.has(b.op_id);
      if (!dup) st.answered.set(b.op_id, b.id);
      const remaining = st.labelItems.length - st.answered.size;
      if (st.failSubmit > 0) { st.failSubmit--; return J(500, { ok: false, error: "server_error" }); } // サーバーは記録したが応答が届かない場合
      return J(200, dup ? { ok: true, duplicate: true, remaining } : { ok: true, remaining });
    }
    case "tier_set": return J(200, { ok: true });
  }
  return J(400, { ok: false, error: "unknown_action" });
}

// ---------------------------------------------------------------- ページ生成
async function open(browser, base, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const st = o.st || newState();
  const rec = { st, errors: [], rest: [] };
  page.on("pageerror", (e) => rec.errors.push(e.message));
  const storage = { ...(o.storage || {}) };
  if (o.token) { storage.xdash_admin_token = o.token; st.valid.add(o.token); }
  await page.addInitScript(({ storage }) => {
    for (const [k, v] of Object.entries(storage)) { try { if (localStorage.getItem("__seeded") === null) localStorage.setItem(k, v); } catch (e) { /* */ } }
    try { localStorage.setItem("__seeded", "1"); } catch (e) { /* */ }
    window.XDASH_PAUSE_MS = 0;
    window.__spoken = [];
    function Utt(t) { this.text = t; }
    const synth = {
      _cur: null,
      speak(u) { window.__spoken.push(u.text); const me = u; synth._cur = me; setTimeout(() => { if (synth._cur !== me) return; u.onstart && u.onstart({}); setTimeout(() => { if (synth._cur !== me) return; synth._cur = null; u.onend && u.onend({}); }, 30); }, 5); },
      cancel() { synth._cur = null; }, pause() {}, resume() {}, getVoices() { return []; }, speaking: false,
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = Utt;
  }, { storage });
  await page.route("**/rest/v1/**", (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url());
    rec.rest.push(`${req.method()} ${url}`);
    if (req.method() === "GET") {
      if (url.includes("/rest/v1/digest_week")) {
        if (o.digestWeek === "404") return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "relation does not exist" }) });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o.digestWeek || []) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/functions/v1/admin-api", async (route) => {
    const req = route.request(); const b = JSON.parse(req.postData() || "{}");
    if (o.adminDelay) await sleep(o.adminDelay);
    const r = o.netDown && o.netDown() ? null : adminHandle(st, b, req.headers()["x-admin-token"]);
    if (!r) return route.abort("failed");
    return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json) });
  });
  await page.goto(`${base}/index_beta.html`, { waitUntil: "domcontentloaded" });
  await sleep(350);
  return { page, ctx, rec, st };
}
const vis = (page, sel) => page.$eval(sel, (el) => { for (let e = el; e; e = e.parentElement) { if (e.hidden) return false; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return false; } return true; }).catch(() => false);
const txt = (page, sel) => page.$eval(sel, (el) => el.innerText).catch(() => null);
const tok = (page) => page.evaluate(() => localStorage.getItem("xdash_admin_token"));
const queueOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("xdash_admin_queue") || "[]"));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const goTab = async (page, name) => { await page.click(`#tabBar button[data-tab="${name}"]`); await sleep(120); };
const callsOf = (st, action) => st.calls.filter((c) => c.action === action);
const openAll = (page) => page.evaluate(() => document.querySelectorAll("#sx-config details").forEach((d) => { d.open = true; }));

(async () => {
  const dir = buildTmp();
  const srv = await serve(dir);
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  console.log(`TTS=${path.basename(TTS_FILE)}  base=${base}`);

  // ================================================================ 1. setup → login
  console.log("\n--- 1. セットアップとログイン ---");
  try {
    const s = await open(browser, base, { st: newState({ setupDone: false }) });
    const p = s.page, st = s.st;
    await goTab(p, "settings");
    check("初回: セットアップ欄(コード+新パスフレーズ)が出る", await until(() => vis(p, "#sxSetupCode")) && await vis(p, "#sxSetupPass") && !(await vis(p, "#sxLoginPass")));
    await p.fill("#sxSetupCode", "abcd-1234"); await p.fill("#sxSetupPass", "short");
    await p.click("#sxSetupBtn"); await sleep(150);
    check("12字未満は送らず案内する", callsOf(st, "setup").length === 0 && (await txt(p, "#sxAuthMsg")).includes("12文字"), await txt(p, "#sxAuthMsg"));
    await p.fill("#sxSetupCode", "wrong-code"); await p.fill("#sxSetupPass", "my-new-passphrase-ok");
    await p.click("#sxSetupBtn"); await sleep(250);
    check("コード違いはメッセージ表示・トークンは保存しない", (await txt(p, "#sxAuthMsg")).includes("セットアップコードが違います") && !(await tok(p)));
    await p.fill("#sxSetupCode", "abcd-1234");
    await p.click("#sxSetupBtn");
    await until(async () => (await tok(p)) === "tok-1");
    const sc = callsOf(st, "setup").pop();
    check("setup: コード+新パスフレーズを送り、応答のトークンをAdminQueueへ保存", sc && sc.body.setup_code === "abcd-1234" && sc.body.passphrase === "my-new-passphrase-ok" && (await tok(p)) === "tok-1");
    check("ログイン後は「ログイン中」表示(フォームは消える)", (await txt(p, "#sx-auth")).includes("ログイン中") && !(await vis(p, "#sxSetupBtn")));
    check("ログイン後、通知先・プロファイル・設定値を読み込む", await until(() => callsOf(st, "notify_info").length > 0 && callsOf(st, "profile_get").length > 0 && callsOf(st, "config_get").length > 0));
    check("以降の呼び出しに x-admin-token が付く", callsOf(st, "config_get")[0].token === "tok-1");
    // トークン更新(応答の token で置き換え)
    st.renew = true;
    await p.evaluate(() => Admin2.api("notify_info", {}));
    check("応答の token で端末のトークンが更新される", (await tok(p)) === st.lastMinted && st.lastMinted !== "tok-1", await tok(p));
    // ログアウト→ログイン
    await p.click("#sxLogout"); await sleep(200);
    check("ログアウトでトークン削除・ログイン欄に切り替わる", !(await tok(p)) && await vis(p, "#sxLoginPass") && !(await vis(p, "#sxSetupBtn")));
    await p.fill("#sxLoginPass", "wrong-pass"); await p.click("#sxLoginBtn"); await sleep(250);
    check("パスフレーズ違いはメッセージのみ", (await txt(p, "#sxAuthMsg")).includes("パスフレーズが違います") && !(await tok(p)));
    st.locked = true;
    await p.fill("#sxLoginPass", PASS); await p.click("#sxLoginBtn"); await sleep(250);
    check("待ち時間(429)は秒数を表示しボタンを止める", /あと\d+秒/.test(await txt(p, "#sxAuthMsg")) && await p.$eval("#sxLoginBtn", (b) => b.disabled), await txt(p, "#sxAuthMsg"));
    st.locked = false;
    check("待ち時間が過ぎるとボタンが戻る", !!(await until(() => p.$eval("#sxLoginBtn", (b) => !b.disabled), 5000, 100)));
    await p.click("#sxLoginBtn");
    await until(async () => !!(await tok(p)));
    check("login成功でトークン保存・ログイン中表示", !!(await tok(p)) && (await txt(p, "#sx-auth")).includes("ログイン中"));
    check("設定タブ: 横スクロールなし(390px)", await noOverflow(p));
    check("JSエラーなし(ログイン)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
  } catch (e) { check("ログインのテストが完走", false, e.stack); }

  // ================================================================ 2. 設定: 通知先・ヘルスチェック・プロファイル・設定値
  console.log("\n--- 2. 設定タブ(通知先・プロファイル・設定値) ---");
  try {
    const s = await open(browser, base, { token: "tok-seed" });
    const p = s.page, st = s.st;
    await goTab(p, "settings");
    await until(() => vis(p, "#sxTopic"));
    check("通知先: トピックを表示", (await txt(p, "#sxTopic")) === st.notify.topic);
    await p.click("#sxCopy"); await sleep(200);
    const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
    check("トピックのコピーボタン(クリップボードへ)", clip === st.notify.topic && (await txt(p, "#sxNotifyMsg")).includes("コピーしました"), `${clip} / ${await txt(p, "#sxNotifyMsg")}`);
    await p.click("#sxNotifyTest"); await sleep(250);
    check("テスト通知(notify_test)を送る", callsOf(st, "notify_test").length === 1 && (await txt(p, "#sxNotifyMsg")).includes("テスト通知"));
    // ヘルスチェックURL(パスフレーズ再入力)
    await p.fill("#sxHcUrl", "http://example.com/x"); await p.fill("#sxHcPass", PASS); await p.click("#sxHcSave"); await sleep(120);
    check("ヘルスチェック: https以外は送らない", callsOf(st, "set_healthcheck").length === 0 && (await txt(p, "#sxHcMsg")).includes("https://"));
    await p.fill("#sxHcUrl", "https://hc-ping.com/abc-123"); await p.fill("#sxHcPass", ""); await p.click("#sxHcSave"); await sleep(120);
    check("ヘルスチェック: パスフレーズ無しは送らず再入力を求める", callsOf(st, "set_healthcheck").length === 0 && (await txt(p, "#sxHcMsg")).includes("パスフレーズ"));
    await p.fill("#sxHcPass", PASS); await p.click('#sxHcKind button[data-kind="weekly"]'); await p.click("#sxHcSave"); await sleep(250);
    const hc = callsOf(st, "set_healthcheck")[0];
    check("ヘルスチェック: kind/url/passphraseを送信し、入力欄を空に戻す", hc && hc.body.kind === "weekly" && hc.body.url === "https://hc-ping.com/abc-123" && hc.body.passphrase === PASS && (await p.$eval("#sxHcUrl", (e) => e.value)) === "" && (await p.$eval("#sxHcPass", (e) => e.value)) === "");

    // 関心プロファイル
    await until(() => vis(p, "#sxPfView"));
    check("プロファイル: 本文・下書きバッジ・版を表示し、承認/あとで/編集の大ボタン", (await txt(p, "#sxPfView")).includes("AIエージェント") && (await txt(p, "#sxPfStatus")).includes("下書き") && await vis(p, "#sxPfApprove") && await vis(p, "#sxPfLater") && await vis(p, "#sxPfEdit"));
    const bigH = await p.$eval("#sxPfApprove", (b) => b.getBoundingClientRect().height);
    check("プロファイル: 大ボタン(高さ60px以上)", bigH >= 60, String(bigH));
    await p.click("#sxPfRead"); await sleep(250);
    const spokenPf = await p.evaluate(() => window.__spoken.join(""));
    check("プロファイル: ▶読み上げで本文を読む(TTS)", spokenPf.includes("AIエージェント"), spokenPf);
    await p.click("#sxPfLater"); await sleep(100);
    check("あとで: 何も送らず案内のみ", callsOf(st, "profile_set").length === 0 && (await txt(p, "#sxPfMsg")).includes("あとで"));
    await p.click("#sxPfApprove"); await sleep(100);
    check("承認: パスフレーズ無しは送らず再入力を求める", callsOf(st, "profile_set").length === 0 && (await txt(p, "#sxPfMsg")).includes("パスフレーズ"));
    await p.fill("#sxPfPass", PASS); await p.click("#sxPfApprove"); await sleep(250);
    const ps = callsOf(st, "profile_set")[0];
    check("承認: profile_set(approve:true, 同じ本文, passphrase)→承認済み表示", ps && ps.body.approve === true && ps.body.text === st.profile.text && ps.body.passphrase === PASS && (await txt(p, "#sxPfStatus")).includes("承認済み"), JSON.stringify(ps && ps.body));
    await p.click("#sxPfEdit"); await sleep(100);
    await p.fill("#sxPfText", "新しい関心: ロボットと半導体"); await p.fill("#sxPfPass", PASS);
    await p.click("#sxPfSaveDraft"); await sleep(250);
    const ps2 = callsOf(st, "profile_set")[1];
    check("編集→下書き保存: approve:false・版が進む", ps2 && ps2.body.approve === false && ps2.body.text === "新しい関心: ロボットと半導体" && st.profile.version === 4 && (await txt(p, "#sxPfStatus")).includes("下書き"));

    // 設定値
    await openAll(p);
    check("設定値: 聴く量(listen_quota_min)・閾値・速度の行がある", !!(await p.$('.cfrow[data-key="listen_quota_min"]')) && !!(await p.$('.cfrow[data-key="listen_threshold"]')) && !!(await p.$('.cfrow[data-key="listen_speed"]')));
    check("設定値: 再入力不要キーにパスフレーズ欄は無い / 必要キーにはある", !(await p.$('.cfrow[data-key="listen_quota_min"] .cf-pass')) && !!(await p.$('.cfrow[data-key="monthly_cap_jpy"] .cf-pass')) && !!(await p.$('.cfrow[data-key="kill_switch"] .cf-pass')));
    const row = (k) => `.cfrow[data-key="${k}"]`;
    await p.fill(`${row("listen_quota_min")} .cf-in`, "99"); await p.click(`${row("listen_quota_min")} .cf-save`); await sleep(100);
    check("値域外はサーバーへ送らず範囲を案内", callsOf(st, "config_set").length === 0 && (await txt(p, `${row("listen_quota_min")} .cf-msg`)).includes("1〜60"));
    await p.fill(`${row("listen_quota_min")} .cf-in`, "20"); await p.click(`${row("listen_quota_min")} .cf-save`); await sleep(250);
    const c1 = callsOf(st, "config_set")[0];
    check("聴く量を20分に変更(数値型・passphraseなし)", c1 && c1.body.key === "listen_quota_min" && c1.body.value === 20 && !("passphrase" in c1.body) && st.config.listen_quota_min === 20 && (await txt(p, `${row("listen_quota_min")} .cf-msg`)).includes("保存しました"));
    await p.click(`${row("listen_quota_min")} .cf-undo-btn`); await sleep(250);
    check("元に戻す(config_undo)で10分に戻る", callsOf(st, "config_undo").length === 1 && st.config.listen_quota_min === 10 && (await p.$eval(`${row("listen_quota_min")} .cf-in`, (e) => e.value)) === "10");
    // 再入力が必要なキー
    await openAll(p);
    await p.fill(`${row("monthly_cap_jpy")} .cf-in`, "5000"); await p.click(`${row("monthly_cap_jpy")} .cf-save`); await sleep(100);
    check("再入力が必要なキー: パスフレーズ無しは送らず要求する", callsOf(st, "config_set").length === 1 && (await txt(p, `${row("monthly_cap_jpy")} .cf-msg`)).includes("再入力") && st.config.monthly_cap_jpy === 4000);
    await p.fill(`${row("monthly_cap_jpy")} .cf-pass`, "wrong-passphrase"); await p.click(`${row("monthly_cap_jpy")} .cf-save`); await sleep(250);
    check("パスフレーズ違いは変更されずメッセージ", callsOf(st, "config_set").length === 2 && st.config.monthly_cap_jpy === 4000 && (await txt(p, `${row("monthly_cap_jpy")} .cf-msg`)).includes("パスフレーズが違います"));
    await p.fill(`${row("monthly_cap_jpy")} .cf-pass`, PASS); await p.click(`${row("monthly_cap_jpy")} .cf-save`); await sleep(250);
    const c3 = callsOf(st, "config_set")[2];
    check("パスフレーズ付きで月上限を変更", c3.body.passphrase === PASS && c3.body.value === 5000 && st.config.monthly_cap_jpy === 5000 && (await p.$eval(`${row("monthly_cap_jpy")} .cf-pass`, (e) => e.value)) === "");
    await p.click(`${row("kill_switch")} button[data-val="true"]`); await p.fill(`${row("kill_switch")} .cf-pass`, PASS); await p.click(`${row("kill_switch")} .cf-save`); await sleep(250);
    const c4 = callsOf(st, "config_set")[3];
    check("真偽値はboolで送る(kill_switch)", c4.body.key === "kill_switch" && c4.body.value === true && st.config.kill_switch === true);
    // サーバーだけが再入力を求めるキー(protected一覧に無い)でも入力欄を出す
    await p.fill(`${row("usd_jpy")} .cf-in`, "155"); await p.click(`${row("usd_jpy")} .cf-save`); await sleep(250);
    check("サーバーが passphrase_required を返したらパスフレーズ欄を出す", !!(await p.$(`${row("usd_jpy")} .cf-pass`)) && (await txt(p, `${row("usd_jpy")} .cf-msg`)).includes("再入力"), await txt(p, `${row("usd_jpy")} .cf-msg`));
    await p.fill(`${row("usd_jpy")} .cf-pass`, PASS); await p.click(`${row("usd_jpy")} .cf-save`); await sleep(250);
    check("→入力して再送すると反映される", st.config.usd_jpy === 155);
    check("設定タブ(ログイン後): 横スクロールなし", await noOverflow(p));
    check("JSエラーなし(設定)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
  } catch (e) { check("設定タブのテストが完走", false, e.stack); }

  // ---- 2b. 未ログイン: 未送信キュー表示・再送・破棄
  console.log("\n--- 2b. 未ログイン時の設定タブ・未送信キュー ---");
  try {
    const ops = [
      { op_id: "op-a", kind: "tier_set", payload: { post_url: "https://x.com/u1/status/1", how: "promote" }, at: Date.now() - 60000, tries: 0 },
      { op_id: "op-b", kind: "label_submit", payload: { id: 1001, score: 4, cls: "other" }, at: Date.now() - 50000, tries: 0 },
      { op_id: "op-c", kind: "tier_set", payload: { post_url: "https://x.com/u3/status/3", how: "demote" }, at: Date.now() - 40000, tries: 5, dead: true, last_error: "not_found" },
    ];
    const s = await open(browser, base, { storage: { xdash_admin_queue: JSON.stringify(ops) } });
    const p = s.page, st = s.st;
    await goTab(p, "settings"); await sleep(300);
    check("未ログイン: ログイン欄が出る(通常login)", await vis(p, "#sxLoginPass"));
    check("未ログイン: 通知先/プロファイル/設定値は「ログインが必要」", (await p.$$eval("#settings-extra .need-login", (e) => e.length)) === 3);
    check("未ログイン: notify_info等は呼ばない", callsOf(st, "notify_info").length === 0 && callsOf(st, "config_get").length === 0);
    const qt = await txt(p, "#sx-queue");
    check("キュー表示: 件数(未送信2・保留中1)と内容", qt.includes("未送信 2件") && qt.includes("保留中(失敗) 1件") && qt.includes("聴くへ昇格") && qt.includes("答え合わせ 4点") && qt.includes("保留へ降格") && qt.includes("ログインすると送信されます"), qt);
    check("キュー: 保留中(dead)に「保留中(失敗)」バッジと再送ボタン", (await p.$$('#sx-queue .qop[data-op="op-c"] [data-q="retry"]')).length === 1 && (await txt(p, '#sx-queue .qop[data-op="op-c"]')).includes("保留中(失敗)"));
    await p.click('#sx-queue .qop[data-op="op-c"] [data-q="retry"]'); await sleep(100);
    const q1 = await queueOf(p);
    check("再送: 試行回数を戻して同じ操作IDで積み直す", q1.length === 3 && q1.find((o) => o.op_id === "op-c" && !o.dead && !o.tries));
    await p.click('#sx-queue .qop[data-op="op-a"] [data-q="discard"]'); await sleep(80);
    check("破棄は1回目では消えず確認表示", (await queueOf(p)).length === 3 && (await txt(p, '#sx-queue .qop[data-op="op-a"]')).includes("本当に破棄"));
    await p.click('#sx-queue .qop[data-op="op-a"] [data-q="discard"]'); await sleep(80);
    check("2回目で破棄される", (await queueOf(p)).length === 2 && !(await p.$('#sx-queue .qop[data-op="op-a"]')));
    check("上部の帯に未送信件数", (await txt(p, "#topBand")).includes("未送信の操作が2件"));
    check("未ログインの週次: レポート/通信簿/答え合わせは「ログインが必要」・今週の流れは匿名で出る", await (async () => {
      await goTab(p, "weekly"); await sleep(300);
      return (await p.$$eval("#tab-weekly .need-login", (e) => e.length)) === 3 && !!(await txt(p, "#wk-flow")) && callsOf(st, "week_report").length === 0 && callsOf(st, "authors").length === 0 && callsOf(st, "label_next").length === 0;
    })());
    await p.click("#wk-report [data-goto]"); await sleep(120);
    check("「設定タブでログイン」ボタンで設定タブへ", await vis(p, "#tab-settings"));
    await goTab(p, "cost"); await sleep(250);
    check("未ログインの費用: 「ログインが必要」+設定タブへの導線・cost_summaryは呼ばない", (await txt(p, "#cost-body")).includes("ログインが必要") && !!(await p.$("#cost-body [data-goto=settings]")) && callsOf(st, "cost_summary").length === 0);
    check("JSエラーなし(未ログイン)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
  } catch (e) { check("未ログインのテストが完走", false, e.stack); }

  // ================================================================ 3. 週次: レポート・通信簿・今週の流れ
  console.log("\n--- 3. 週次タブ ---");
  try {
    const flow3 = [{ week_start: "2026-10-05", status: "accumulating", days_covered: 3, generated_at: new Date().toISOString(), themes: [{ title: "エージェントの普及", summary: "各社が相次いで発表した。", day_refs: ["2026-10-05", "2026-10-06"] }] }];
    const s = await open(browser, base, { token: "tok-seed", digestWeek: flow3 });
    const p = s.page, st = s.st;
    await goTab(p, "weekly");
    await until(() => vis(p, "#wkReportText"));
    check("週次レポート本文を表示", (await txt(p, "#wkReportText")).includes("生成AIの新発表が多い週") && (await txt(p, "#wk-report")).includes("9/28"));
    await p.click("#wkRead"); await sleep(300);
    const sp = await p.evaluate(() => window.__spoken.join(""));
    check("読み上げボタン: text_ja を TTS.utterances 経由で読む", sp.includes("生成AIの新発表が多い週") && sp.includes("週次レポート"), sp);
    check("読み上げ中はボタンが「止める」に変わる", (await txt(p, "#wkRead")).includes("止める") || !(await p.evaluate(() => Admin2.Reader.isPlaying("weekly"))));
    await until(async () => !(await p.evaluate(() => Admin2.Reader.isPlaying("weekly"))), 4000);
    check("読み終えるとボタンが戻る", (await txt(p, "#wkRead")).includes("読み上げ"));
    // 通信簿
    await until(() => p.$(".au-row"));
    const ar = await p.$$eval(".au-row", (e) => e.map((x) => x.innerText));
    check("通信簿: 3人表示・総数併記", ar.length === 3 && ar[0].includes("総数 30件") && ar[1].includes("総数 5件") && ar[2].includes("総数 25件"), JSON.stringify(ar));
    check("通信簿: 低評価率・高評価率と区間(low_lo/high_hi)を併記", ar[0].includes("70%") && ar[0].includes("区間の下限 52%") && ar[0].includes("区間の上限 11%") && ar[2].includes("60%") && ar[2].includes("区間の上限 78%"), ar[0]);
    check("通信簿: exclude_candidate=「除外候補」・hold=「判定保留」・keepはバッジ無し", ar[0].includes("除外候補") && ar[1].includes("判定保留") && !ar[2].includes("除外候補") && !ar[2].includes("判定保留"));
    check("通信簿: 週数切替(8週)でauthors{weeks:8}を再取得", await (async () => { await p.click('#auWeeks button[data-w="8"]'); return !!(await until(() => callsOf(st, "authors").some((c) => c.body.weeks === 8))); })());
    // 今週の流れ
    const ft = await txt(p, "#wk-flow");
    check("今週の流れ: days_covered<7 は「蓄積中 3/7」", (await txt(p, "#wkAccum")).includes("蓄積中 3/7") && ft.includes("エージェントの普及") && ft.includes("10/5"), ft);
    check("今週の流れは匿名RESTで取得(digest_week)・admin-apiは使わない", s.rec.rest.some((r) => r.includes("digest_week")) && !st.calls.some((c) => c.action === "digest_week"));
    check("週次タブ: 横スクロールなし(390px)", await noOverflow(p));
    check("JSエラーなし(週次)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
    // 7日そろった場合 / テーブルなし
    const s2 = await open(browser, base, { token: "tok-seed", digestWeek: [{ ...flow3[0], status: "ok", days_covered: 7 }] });
    await goTab(s2.page, "weekly"); await sleep(400);
    check("7日そろえば「蓄積中」は出ない", !(await s2.page.$("#wkAccum")) && (await txt(s2.page, "#wk-flow")).includes("エージェントの普及"));
    await s2.ctx.close();
    const s3 = await open(browser, base, { token: "tok-seed", digestWeek: [{ ...flow3[0], status: "ok", days_covered: 7 }].map((r) => ({ ...r, days_covered: 7, status: "accumulating" })) });
    await goTab(s3.page, "weekly"); await sleep(400);
    check("status が accumulating なら days_covered=7 でも「蓄積中」", !!(await s3.page.$("#wkAccum")));
    await s3.ctx.close();
    const s4 = await open(browser, base, { token: "tok-seed", digestWeek: "404", st: newState({ report: { empty: true } }) });
    await goTab(s4.page, "weekly"); await sleep(400);
    check("digest_week が無い/週次レポート未生成でも画面は壊れない", (await txt(s4.page, "#wk-flow")).includes("まだ") && (await txt(s4.page, "#wk-report")).includes("まだ週次レポートがありません") && s4.rec.errors.length === 0, JSON.stringify(s4.rec.errors));
    await s4.ctx.close();
    const s5 = await open(browser, base, { token: "tok-seed", digestWeek: [] });
    await goTab(s5.page, "weekly"); await sleep(400);
    check("今週の流れの行が無ければ「蓄積中 0/7」", (await txt(s5.page, "#wkAccum")).includes("蓄積中 0/7"));
    await s5.ctx.close();
  } catch (e) { check("週次のテストが完走", false, e.stack); }

  // ================================================================ 4. 答え合わせ
  console.log("\n--- 4. 答え合わせ ---");
  try {
    const s = await open(browser, base, { token: "tok-seed" });
    const p = s.page, st = s.st;
    await goTab(p, "weekly");
    await until(() => vis(p, "#lbCard"));
    const pageText = async () => (await p.evaluate(() => document.body.innerText));
    check("実画面と同じカード表示: 要約が出る・残り件数と分", (await txt(p, "#lbCard")).includes("要約1の文章です") && (await txt(p, "#lbRemain")) === "4" && /約\d+分/.test(await txt(p, "#lbMeta")), await txt(p, "#lbMeta"));
    const pt = await pageText();
    check("盲検: AI点・投稿者名/ハンドルは画面に出ない", !pt.includes("SECRETAUTHOR") && !pt.includes("秘密の投稿者") && !(await p.$(".sbadge")) && !/AI点|AIの点/.test(pt.replace("AIの点数や投稿者名は見えない状態で", "")));
    check("大きな1〜5ボタン(高さ60px以上)と区分4択(既定その他)", (await p.$$("#lbScores button")).length === 5 && (await p.$eval("#lbScores button", (b) => b.getBoundingClientRect().height)) >= 60 && (await p.$$eval("#lbCls button", (e) => e.map((x) => x.textContent + (x.classList.contains("on") ? "*" : "")).join(","))) === "告知,参照のみ,意見・感想,その他*");
    await p.click("#lbPlay"); await sleep(300);
    check("▶で聴ける(要約をTTSで読む)", (await p.evaluate(() => window.__spoken.join(""))).includes("要約1の文章です"));
    // 1問目: 区分=意見・感想, 5点相当でなく4点。サーバーは応答を落とす(記録はされる)
    st.failSubmit = 1;
    await p.click('#lbCls button[data-cls="opinion"]');
    await p.click('#lbScores button[data-score="4"]');
    await sleep(120);
    check("1タップで残り件数が減る(即時反映)", (await txt(p, "#lbRemain")) === "3" && (await txt(p, "#lbCard")).includes("要約2の文章です"));
    check("次のカードの区分は既定(その他)に戻る", (await p.$eval('#lbCls button[data-cls="other"]', (b) => b.classList.contains("on"))));
    await until(() => callsOf(st, "label_submit").length >= 1);
    const sub1 = callsOf(st, "label_submit")[0];
    check("label_submit: 操作ID・id・score・clsを送る", sub1 && !!sub1.body.op_id && sub1.body.id === 1001 && sub1.body.score === 4 && sub1.body.cls === "opinion" && sub1.token === "tok-seed", JSON.stringify(sub1 && sub1.body));
    await sleep(200);
    const q = await queueOf(p);
    check("サーバーが受理を返すまで端末キューに残る(500のとき)", q.some((o) => o.op_id === sub1.body.op_id));
    // 再送(同じ操作ID)→ duplicate:true で受理 → キューから消える。サーバー上では1件のまま。
    await p.evaluate(() => AdminQueue.flush());
    await sleep(200);
    const resent = callsOf(st, "label_submit").filter((c) => c.body.op_id === sub1.body.op_id);
    check("冪等: 再送は同じ操作ID・サーバーでは1件だけ・受理後にキューから消える", resent.length >= 2 && st.answered.size >= 1 && [...st.answered.values()].filter((id) => id === 1001).length === 1 && !(await queueOf(p)).some((o) => o.op_id === sub1.body.op_id));
    // 2問目: 既定の区分(その他)で3点
    await sleep(350);
    await p.click('#lbScores button[data-score="3"]'); await sleep(120);
    const sub2 = callsOf(st, "label_submit").find((c) => c.body.id === 1002);
    check("既定の区分「その他」で保存", await until(() => callsOf(st, "label_submit").find((c) => c.body.id === 1002), 2000) && callsOf(st, "label_submit").find((c) => c.body.id === 1002).body.cls === "other");
    check("連打しても次の1件を誤って付けない(300msのロック)", await (async () => { await sleep(350); const before = callsOf(st, "label_submit").length; await p.click('#lbScores button[data-score="5"]'); await p.click('#lbScores button[data-score="1"]').catch(() => {}); await sleep(250); return callsOf(st, "label_submit").length === before + 1; })());
    check("残り2→1件へ", (await txt(p, "#lbRemain")) === "1");
    // 今日はしない
    await p.click("#lbSkip"); await sleep(100);
    const skip = await p.evaluate(() => Number(localStorage.getItem("xdash_label_skip_until")));
    const days = (skip - Date.now()) / 86400e3;
    check("「今日はしない」で3日間非表示", days > 2.9 && days < 3.1 && (await txt(p, "#wk-label")).includes("お休み中") && !(await p.$("#lbCard")), String(days));
    await p.reload({ waitUntil: "domcontentloaded" }); await sleep(500);
    await goTab(p, "weekly"); await sleep(400);
    check("再読み込みしても3日間は出ない・label_nextも呼ばない", (await txt(p, "#wk-label")).includes("お休み中") && callsOf(st, "label_next").length === 1, String(callsOf(st, "label_next").length));
    await p.click("#lbResume"); await until(() => vis(p, "#lbCard"));
    check("「今すぐ再開」で残り1件が出る", (await txt(p, "#lbRemain")) === "1");
    await sleep(350);
    await p.click('#lbScores button[data-score="2"]');
    await until(() => vis(p, "#lbMore"), 4000);
    check("最後の1件で完了表示と「次の20件」ボタン", (await txt(p, "#wk-label")).includes("終わりました") && (await txt(p, "#lbMore")).includes("20件"));
    check("全件ぶんの label_submit が1回ずつ受理されている(サーバー側4件)", st.answered.size === 4 && (await queueOf(p)).length === 0, `${st.answered.size}`);
    check("答え合わせ中: 横スクロールなし", await noOverflow(p));
    check("JSエラーなし(答え合わせ)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
  } catch (e) { check("答え合わせのテストが完走", false, e.stack); }

  // ---- 4b. 未ログインで答えた分は溜まり、ログイン後に送られる / まだ無ければ「始める」
  try {
    const st = newState({ labelItems: [] });
    const s = await open(browser, base, { token: "tok-seed", st });
    const p = s.page;
    await goTab(p, "weekly"); await until(() => vis(p, "#lbStart"));
    check("リストが無ければ「答え合わせを始める(20件)」", (await txt(p, "#lbStart")).includes("20件"));
    st.labelItems = [1, 2].map((i) => ({ id: 2000 + i, content: `本文${i}`, summary: `要約${i}`, image_urls: ["https://example.com/a.png"] }));
    await p.click("#lbStart"); await until(() => vis(p, "#lbCard"));
    const lc = callsOf(st, "label_create")[0];
    check("label_create{n:20}→label_next で1枚目を表示・画像も出る", lc.body.n === 20 && (await txt(p, "#lbRemain")) === "2" && (await p.$$("#lbCard img")).length === 1);
    await s.ctx.close();
    const s2 = await open(browser, base, { token: "tok-seed", st: newState(), netDown: () => false });
    await s2.ctx.close();
  } catch (e) { check("答え合わせ(開始)のテストが完走", false, e.stack); }

  // ================================================================ 5. 費用タブ
  console.log("\n--- 5. 費用タブ ---");
  try {
    const s = await open(browser, base, { token: "tok-seed" });
    const p = s.page, st = s.st;
    await goTab(p, "cost");
    await until(() => vis(p, "#coMonth"));
    check("今月の実績と月末見込み", (await txt(p, "#coMonth")) === "¥1,234" && (await txt(p, "#coForecast")) === "¥3,456", `${await txt(p, "#coMonth")} ${await txt(p, "#coForecast")}`);
    check("先月・直近24時間", (await txt(p, "#coLast")) === "¥2,999" && (await txt(p, "#coToday")) === "¥123");
    const ct = await txt(p, "#cost-body");
    check("ドル・呼び出し回数", ct.includes("$8.21") && ct.includes("4,567回"));
    check("月別の棒グラフ(13本のSVG)", (await p.$$("#coChart rect.cur, #coChart rect.past")).length === 13 && (await p.$$("#coChart rect.cur")).length === 1);
    check("棒グラフに今月の月末見込みの点線", (await p.$$("#coChart rect.fc")).length === 1);
    check("X系とTI系の内訳", ct.includes("X系") && ct.includes("¥1,000 ・ 81%") && ct.includes("TI系") && ct.includes("¥234 ・ 19%"), ct);
    check("モデル別の内訳", ct.includes("gemini-2.5-flash") && ct.includes("¥1,000 ・ 4,000回") && ct.includes("gemini-3.5-flash"));
    check("ガード段階(警告)と月の使用状況", (await txt(p, "#coGuard")).includes("警告") && ct.includes("¥3,300") && ct.includes("¥4,000"));
    check("現行モデル", (await txt(p, "#coModel")).includes("gemini-2.5-flash") && ct.includes("候補"));
    check("直近のエラー", ct.includes("score-x-posts") && ct.includes("quota exceeded") && ct.includes("429"));
    check("費用タブ: 横スクロールなし(390px)", await noOverflow(p));
    await p.click("#btnCostReload"); await sleep(250);
    check("↻で再取得", callsOf(st, "cost_summary").length >= 2);
    // 空に近いデータ
    st.cost = { ...st.cost, last_month: null, months: [], recent_errors: [], this_month: { jpy: 0, usd: 0, calls: 0, forecast_jpy: 0, by_model: [], by_purpose: [], by_grp: [] } };
    await p.click("#btnCostReload"); await sleep(300);
    check("データが空でも壊れない(先月は「–」・エラー0件)", (await txt(p, "#coLast")) === "–" && (await txt(p, "#cost-body")).includes("エラーはありません") && s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
    // トークン失効 → 「ログインが必要」へ
    const s2 = await open(browser, base, { storage: { xdash_admin_token: "stale-token" } });
    await goTab(s2.page, "cost"); await sleep(500);
    check("トークンが失効していたら破棄して「ログインが必要」(費用)", !(await tok(s2.page)) && (await txt(s2.page, "#cost-body")).includes("ログインが必要"));
    await s2.ctx.close();
  } catch (e) { check("費用のテストが完走", false, e.stack); }

  // ================================================================ 6. 通知先未設定の帯・第1段との共存
  console.log("\n--- 6. 帯・共存 ---");
  try {
    const st = newState(); st.notify = { topic: "", configured: false, events: [] };
    const s = await open(browser, base, { token: "tok-seed", st });
    const p = s.page;
    await sleep(300);
    check("通知先が未設定なら帯に出る(TopBand notify)", (await p.evaluate(() => TopBand.current())) === "notify" && (await txt(p, "#topBand")).includes("通知先が未設定"));
    await goTab(p, "settings"); await sleep(300);
    check("設定タブ: 未設定の案内を表示・テスト通知ボタンは出さない", (await txt(p, "#sx-notify")).includes("まだ設定されていません") && !(await p.$("#sxNotifyTest")));
    await p.click("#topBand").catch(() => {});
    check("再生(聴く)の設定は壊れていない(速度ボタンが残る)", (await p.$$("#setSpeedBtns button")).length > 0);
    check("初期表示(今日タブ)で週次/費用/設定の管理APIを呼びすぎない", true);
    await s.ctx.close();
    const s2 = await open(browser, base, { token: "tok-seed" });
    await sleep(500);
    check("今日タブのままなら週次/費用/設定の取得はしない(起動時は me と通知先のみ)", s2.st.calls.every((c) => ["me", "notify_info"].includes(c.action)), s2.st.calls.map((c) => c.action).join(","));
    await s2.ctx.close();
  } catch (e) { check("帯のテストが完走", false, e.stack); }

  await browser.close(); srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? `\n全${total}項目OK` : `\nNG ${failures}/${total}件`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
