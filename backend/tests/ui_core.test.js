// index_beta.html 第1段(タブ骨格・今日・聴く・流す・端末キュー)の画面テスト。
// 実行: node backend/tests/ui_core.test.js        (TTS=real で ui/tts.js の本物を使用。既定は tests/tts_stub.js)
// 前提: Playwright(/opt/node22/lib/node_modules/playwright) と chromium(/opt/pw-browsers)。Supabase REST/admin-api はすべてモック。
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

// ---- 検証用ヘルパ
let failures = 0, total = 0;
const check = (label, cond, extra = "") => { total++; if (!cond) failures++; console.log(`${cond ? "OK " : "NG "} ${label}${cond ? "" : " " + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 40) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return false; await sleep(step); } }

// ---- 静的サーバ(ビルド済みbetaをtmpに置く。リポジトリのindex_beta.htmlは書き換えない)
function buildTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uicore-"));
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

// ---- 時間・データ
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const dayKeyOf = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const DS = Date.parse(dayKeyOf(NOW) + "T02:00:00+09:00"); // 今日(02:00 JST)の開始
const TODAY_T = iso(DS + 1000), YDAY_T = iso(DS - 3 * 3600e3);
const NAMES = ["桜", "梅", "藤", "菊", "蓮", "楓", "柳", "竹", "松", "杉", "桃", "栗", "榊", "樫"];
const mk = (i, over = {}, bodyLen = 70) => ({
  id: i, post_url: `https://x.com/u${i}/status/${i}`, author_handle: `@u${i}`, author_name: `U${i}`,
  posted_at: iso(NOW - i * 60000), fetched_at: iso(NOW - i * 60000),
  gist: `${NAMES[i % NAMES.length]}の話`, summary: "要" .repeat(30), content: `十分に長い本文です。内容があります。${i}`,
  speech_title: `${NAMES[i % NAMES.length]}の話`, speech_body: "ボ".repeat(bodyLen) + "。",
  image_urls: [], is_read: false, is_starred: false,
  score: null, score_kind: null, score_reason: null, score_state: null, scored_model: null,
  listen_tier: null, tier_assigned_at: null, manual_action: null, manual_at: null, ...over,
});
// 今日タブの標準シナリオ
function scenario(bodyLen = 70) {
  const L = (i, o) => mk(i, { listen_tier: "listen", tier_assigned_at: TODAY_T, score_state: "scored", scored_model: "gemini-3.5", ...o }, bodyLen);
  const S = (i, o) => mk(i, { listen_tier: "skim", tier_assigned_at: TODAY_T, score_state: "scored", scored_model: "gemini-3.5", ...o }, bodyLen);
  const H = (i, o) => mk(i, { listen_tier: "hold", tier_assigned_at: TODAY_T, score_state: "scored", scored_model: "gemini-3.5", ...o }, bodyLen);
  return [
    L(1, { score: 4, score_kind: "news", score_reason: "新発表です" }),
    L(2, { score: 5, score_kind: "primary", score_reason: "一次情報" }),
    L(3, { score: 4 }),
    L(4, { score: 3, manual_action: "promote", manual_at: iso(NOW - 1000) }),                  // 手動昇格(後)
    L(5, { score: 5, manual_action: "promote", manual_at: iso(NOW - 5000) }),                  // 手動昇格(先)
    L(6, { score: 4, is_read: true }),                                                          // 既読は対象外
    L(7, { score: 4, tier_assigned_at: YDAY_T }),                                               // 昨日からの聴き残し(聴くに含む)
    S(8, { score: 4 }), S(9, { score: 5 }), S(10, { score: 3 }), S(11, { score: null }),        // 流す4件(4点以上=2件)
    S(12, { score: 4, tier_assigned_at: YDAY_T }), S(13, { score: 4, is_read: true }),          // 昨日分・既読は数えない
    H(14, { score: 2 }), H(15, { score: 3 }),
    H(16, { score: 5, manual_action: "demote", manual_at: TODAY_T, is_read: true }),            // 手動降格(見出し読み上げから除く)
    H(0, { score: 2, tier_assigned_at: YDAY_T }),                                               // 昨日の保留は数えない
  ];
}
const DIGEST = { day: dayKeyOf(NOW), generated_at: iso(NOW - 3600e3), model: "m", status: "ok", input_count: 9, dropped_ratio: 0, version: 1,
  topics: [{ headline: "要点見出し甲", summary: "要点の要約文です。", new_facts: [], card_urls: [], is_followup: false }, { headline: "要点見出し乙", summary: "二つ目の要約です。", new_facts: [], card_urls: [], is_followup: true }] };

// ---- ページ生成(Supabase RESTとadmin-apiをモック)
async function open(browser, base, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: o.width || 390, height: 780 } });
  const page = await ctx.newPage();
  const rec = { reads: [], patches: [], admin: [], errors: [], rpcMode: o.rpcMode || "ok", adminMode: o.adminMode || "ok", digest: o.digest === undefined ? "none" : o.digest, spoken: [] };
  page.on("pageerror", (e) => rec.errors.push(e.message));
  await page.addInitScript(({ storage, speakMs, silentMs, noWake, width }) => {
    for (const [k, v] of Object.entries(storage || {})) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }
    window.XDASH_PAUSE_MS = 0;
    if (silentMs) window.XDASH_SILENT_STOP_MS = silentMs;
    window.__SPEAK_MS = speakMs;
    window.__spoken = [];
    window.__rates = [];
    // 画面点灯(Wake Lock)と効果音(WebAudio)の記録用スタブ
    window.__wake = { req: 0, rel: 0, cur: null };
    if (!noWake) Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async (t) => { window.__wake.req++; const s = { type: t, released: false, release: async () => { if (!s.released) { s.released = true; window.__wake.rel++; } }, addEventListener() {} }; window.__wake.cur = s; return s; } } });
    else Object.defineProperty(navigator, "wakeLock", { configurable: true, value: undefined });
    window.__beeps = 0;
    window.AudioContext = function () { window.__beeps++; this.currentTime = 0; this.destination = {}; this.createOscillator = () => ({ frequency: {}, connect() {}, start() {}, stop() {} }); this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }); this.resume = () => Promise.resolve(); this.close = () => {}; };
    function Utt(t) { this.text = t; }
    const synth = {
      _cur: null, paused: false,
      speak(u) {
        window.__spoken.push(u.text); window.__rates.push(u.rate);
        const me = u; synth._cur = me;
        setTimeout(() => { if (synth._cur !== me) return; u.onstart && u.onstart({}); setTimeout(() => { if (synth._cur !== me) return; synth._cur = null; u.onend && u.onend({}); }, window.__SPEAK_MS); }, 5);
      },
      cancel() { synth._cur = null; }, pause() {}, resume() {}, getVoices() { return []; }, speaking: false,
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = Utt;
  }, { storage: o.storage, speakMs: o.speakMs || 25, silentMs: o.silentMs || 0, noWake: !!o.noWake });
  await page.route("**/rest/v1/**", (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url());
    if (req.method() === "GET") {
      if (url.includes("/rest/v1/x_posts") && rec.postsFail) return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      if (url.includes("/rest/v1/x_posts")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o.posts || []) });
      if (url.includes("/rest/v1/digest_daily")) {
        if (rec.digest === "404") return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "relation does not exist" }) });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rec.digest === "none" ? [] : [rec.digest]) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    if (req.method() === "POST" && url.includes("/rpc/mark_read")) {
      if (rec.rpcMode === "fail") return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      const b = JSON.parse(req.postData() || "{}"); rec.reads.push({ url: b.p_url, via: b.p_via });
      return route.fulfill({ status: 204, body: "" });
    }
    if (req.method() === "PATCH") { rec.patches.push({ url, body: req.postData() }); if (rec.patchFail) return route.fulfill({ status: 500, contentType: "application/json", body: "{}" }); return route.fulfill({ status: 204, body: "" }); }
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/functions/v1/admin-api", (route) => {
    const req = route.request(); const b = JSON.parse(req.postData() || "{}");
    rec.admin.push({ body: b, token: req.headers()["x-admin-token"] || null, auth: req.headers()["authorization"] });
    const m = rec.adminMode;
    if (m === "fail500") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "boom" }) });
    if (m === "auth401") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, error: "unauthorized" }) });
    if (m === "dup") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, duplicate: true }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, token: "tok-renewed" }) });
  });
  rec.postsFail = !!o.postsFail;
  // テスト用の名前空間 __XD_TEST__ は #test の時だけ公開される。ハッシュ指定の無い index_beta.html には #test を付ける
  const url = o.path || "/index_beta.html";
  await page.goto(`${base}${/index_beta\.html$/.test(url) ? url + "#test" : url}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".row").length > 0 || /エラー/.test(document.getElementById("status").textContent) || document.getElementById("status").textContent.endsWith("件"), null, { timeout: 8000 }).catch(() => {});
  await sleep(250);
  return { page, ctx, rec };
}
const vis = (page, sel) => page.$eval(sel, (el) => {
  for (let e = el; e; e = e.parentElement) { if (e.hidden) return false; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return false; }
  return true;
}).catch(() => false);
const txt = (page, sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);
const queueOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("xdash_admin_queue") || "[]"));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0);

(async () => {
  const dir = buildTmp();
  const srv = await serve(dir);
  const base = `http://localhost:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  console.log(`TTS=${path.basename(TTS_FILE)}  base=${base}`);

  // ================================================================ 1. 一覧モードの既存動作が不変
  console.log("\n--- 1. 一覧モードの既存動作(index.html と index_beta.html#list を同一シナリオで比較) ---");
  const listPosts = [];
  for (let i = 0; i < 24; i++) listPosts.push(mk(i, { author_handle: `@g${i % 4}`, author_name: `G${i % 4}`, gist: `一覧${i}`, summary: `要約${i}`, speech_title: null, speech_body: null }));
  listPosts.push(mk(30, { content: "", summary: "不明", gist: "不明" }), mk(31, { content: "詳細はこちら", summary: "詳細はこちら", gist: "詳細はこちら" }));
  const readsOf = (rec) => {
    const out = [];
    for (const r of rec.reads) out.push(r.url);
    for (const p of rec.patches) { const m = p.url.match(/post_url=in\.\((.*)\)/); if (m && /"is_read":true/.test(p.body || "")) out.push(...m[1].split(",")); }
    return out;
  };
  async function listScenario(pathName) {
    const s = await open(browser, base, { path: pathName, posts: listPosts, speakMs: 20 });
    const p = s.page; const R = { errors: s.rec.errors };
    R.rows = await p.$$eval(".row", (els) => els.map((e) => e.dataset.url));
    R.title = await txt(p, "#pageTitle");
    R.lvNote = await txt(p, "#lowValueNote");
    R.groups = await p.$$eval(".group-header .gh-name", (els) => els.map((e) => e.textContent));
    // ▶ で連続読み上げ→3枚既読になったら停止
    await p.evaluate(() => { document.getElementById("groupByAuthor").checked = false; document.getElementById("groupByAuthor").dispatchEvent(new Event("change")); });
    await p.click("#btnPlayPause");
    await until(() => readsOf(s.rec).length >= 3, 6000);
    await p.click("#btnPlayPause");
    await sleep(150);
    R.playReads = readsOf(s.rec).slice(0, 3);
    R.spokenHead = (await p.evaluate(() => window.__spoken)).slice(0, 3);
    R.afterPlayActive = await p.evaluate(() => activeUrl);
    // ▼ 単発移動(離脱カードは既読化)
    await sleep(400);
    const before = readsOf(s.rec).length;
    const seq = [];
    for (let i = 0; i < 3; i++) { await p.dispatchEvent("#btnCardNext", "pointerdown"); await p.dispatchEvent("#btnCardNext", "pointerup"); await sleep(120); seq.push(await p.evaluate(() => activeUrl)); }
    R.moveSeq = seq;
    await sleep(200);
    R.moveReads = readsOf(s.rec).slice(before);
    // ▼ 長押しで無音の連続移動(既読は飛ばす)
    await p.evaluate(() => setSpeed(3));
    await p.dispatchEvent("#btnCardNext", "pointerdown");
    await sleep(520);
    const seen = [];
    await until(async () => { const a = await p.evaluate(() => activeUrl); if (seen[seen.length - 1] !== a) seen.push(a); return seen.length >= 4; }, 6000, 50);
    await p.evaluate(() => stopAutoMove());
    await p.dispatchEvent("#btnCardNext", "pointerup");
    R.autoSeq = seen.slice(0, 4);
    // 低情報フィルタ
    await p.selectOption("#lowValueMode", "include"); await sleep(150);
    R.lvIncludeRows = (await p.$$(".row")).length;
    await p.selectOption("#lowValueMode", "only"); await sleep(150);
    R.lvOnlyRows = (await p.$$(".row")).length;
    await p.selectOption("#lowValueMode", "hide"); await sleep(150);
    // すべて既読(非表示の低情報も含む)
    s.rec.reads.length = 0; s.rec.patches.length = 0;
    await p.click("#markAllRead"); await sleep(400);
    R.markAll = [...new Set(readsOf(s.rec))].sort();
    R.titleAfter = await txt(p, "#pageTitle");
    await s.ctx.close();
    return R;
  }
  try {
    const A = await listScenario("/index.html");
    const B = await listScenario("/index_beta.html#list");
    check("一覧: 行の並び(URL順)が旧版と同一", JSON.stringify(A.rows) === JSON.stringify(B.rows) && A.rows.length > 20, `${A.rows.length} vs ${B.rows.length}`);
    check("一覧: 見出し・低情報注記・グループ順が同一", A.title === B.title && A.lvNote === B.lvNote && JSON.stringify(A.groups) === JSON.stringify(B.groups), `${A.title}/${B.title}`);
    check("一覧: ▶連続読み上げ=3枚が同じ順で既読・読み上げ文も同一", JSON.stringify(A.playReads) === JSON.stringify(B.playReads) && A.playReads.length === 3 && JSON.stringify(A.spokenHead) === JSON.stringify(B.spokenHead) && A.afterPlayActive === B.afterPlayActive, JSON.stringify([A.playReads, B.playReads]));
    check("一覧: ▼単発移動の移動先と既読化が同一", JSON.stringify(A.moveSeq) === JSON.stringify(B.moveSeq) && JSON.stringify([...A.moveReads].sort()) === JSON.stringify([...B.moveReads].sort()), JSON.stringify([A.moveReads, B.moveReads]));
    check("一覧: ▼長押しの連続移動が同じ順路(既読は飛ばす)", JSON.stringify(A.autoSeq) === JSON.stringify(B.autoSeq) && A.autoSeq.length === 4, JSON.stringify([A.autoSeq, B.autoSeq]));
    check("一覧: 低情報フィルタの件数が同一(含める/のみ)", A.lvIncludeRows === B.lvIncludeRows && A.lvOnlyRows === B.lvOnlyRows && A.lvOnlyRows === 2, `${A.lvIncludeRows}/${B.lvIncludeRows} ${A.lvOnlyRows}/${B.lvOnlyRows}`);
    check("一覧: すべて既読が同一(非表示の低情報も既読化)", JSON.stringify(A.markAll) === JSON.stringify(B.markAll) && A.markAll.some((u) => u.endsWith("/30")) && A.markAll.some((u) => u.endsWith("/31")) && A.titleAfter === B.titleAfter, `${A.markAll.length}/${B.markAll.length}`);
    check("一覧: JSエラーなし", A.errors.length === 0 && B.errors.length === 0, JSON.stringify([A.errors, B.errors]));
  } catch (e) { check("一覧モード比較が例外なく完走", false, e.stack); }

  // ---- 既読化: rpcが失敗したら従来のPATCH(1件のタイトルタップ=少数なのでRPC経路)
  try {
    const tapTitle = async (p) => { await p.evaluate(() => document.addEventListener("click", (e) => e.preventDefault(), true)); await p.click(".row a.gist"); await sleep(400); };
    const s = await open(browser, base, { path: "/index_beta.html#list", posts: listPosts, rpcMode: "fail" });
    await tapTitle(s.page);
    check("既読化: rpc失敗時は従来のPATCHへフォールバック", s.rec.patches.some((p) => /"is_read":true/.test(p.body)) && s.rec.reads.length === 0, JSON.stringify(s.rec.patches).slice(0, 200));
    await s.ctx.close();
    const s2 = await open(browser, base, { path: "/index_beta.html#list", posts: listPosts });
    await tapTitle(s2.page);
    check("既読化: 通常はrpc/mark_read(via=user)でPATCHなし", s2.rec.reads.length === 1 && s2.rec.reads[0].via === "user" && s2.rec.patches.length === 0, JSON.stringify(s2.rec.reads).slice(0, 200));
    await s2.ctx.close();
    const s3 = await open(browser, base, { path: "/index_beta.html#list", posts: listPosts });
    await s3.page.click("#markAllRead"); await sleep(400);
    check("既読化: 大量の一括(すべて既読)は従来どおり1回のPATCH", s3.rec.reads.length === 0 && s3.rec.patches.length === 1, `${s3.rec.reads.length}/${s3.rec.patches.length}`);
    await s3.ctx.close();
  } catch (e) { check("既読化テストが完走", false, e.stack); }

  // ================================================================ 2. 今日タブ・内訳・タブ骨格・モード切替
  console.log("\n--- 2. 今日タブ・内訳・タブ骨格・モード切替 ---");
  try {
    const big = scenario(400);
    const s = await open(browser, base, { posts: big, digest: DIGEST });
    const p = s.page;
    check("タブ: 今日/週次/費用/設定が並ぶ", JSON.stringify(await p.$$eval("#tabBar button", (b) => b.map((x) => x.textContent))) === JSON.stringify(["今日", "週次", "費用", "設定"]));
    check("タブ: 週次/費用/設定の空コンテナ(#tab-weekly/#tab-cost/#tab-settings/#settings-extra)がある", !!(await p.$("#tab-weekly")) && !!(await p.$("#tab-cost")) && !!(await p.$("#tab-settings")) && !!(await p.$("#settings-extra")));
    // 内訳の期待値(仕様どおり: 文字数÷(6.5×速度1.2))
    const T = await p.evaluate(() => { const t = __XD_TEST__.Beta.computeToday(); return { listen: t.listen.map((x) => x.post_url), skim: t.skim.length, hold: t.hold.length, min: t.listenMin, carry: t.carry, high: t.skimHigh.length, holdTop: t.holdTop.map((x) => x.post_url) }; });
    const byId = (i) => big.find((x) => x.id === i);
    const tagLen = { 4: 9, 5: 14, 2: 5 };
    const chars = [4, 5, 2, 1, 3, 7].reduce((n, i) => n + byId(i).speech_title.length + byId(i).speech_body.length + (tagLen[i] || 0), 0);
    const expectMin = Math.max(1, Math.round(chars / (6.5 * 1.2) / 60));
    check("内訳: 聴く順=手動昇格(新しい順)→点数降順→新しい順", JSON.stringify(T.listen) === JSON.stringify([4, 5, 2, 1, 3, 7].map((i) => byId(i).post_url)), JSON.stringify(T.listen.map((u) => u.match(/u(\d+)/)[1])));
    check("内訳の数字: 聴く6件・流す4件・保留3件(昨日分と既読は除外、降格は保留に残る)", (await txt(p, "#breakdown")).replace(/\s/g, "") === `聴く6件・約${expectMin}分/流す4件/保留3件`, await txt(p, "#breakdown"));
    check(`主ボタン: ▶聴く(約${expectMin}分)=文字数÷(6.5×1.2)`, (await txt(p, "#btnListen")) === `▶聴く(約${expectMin}分)` && expectMin === 5, `${await txt(p, "#btnListen")} chars=${chars}`);
    check("昨日の聴き残し1件・流す4点以上2件・保留見出しは手動降格を除く(点数順)", T.carry === 1 && T.high === 2 && JSON.stringify(T.holdTop) === JSON.stringify([15, 14].map((i) => byId(i).post_url)));
    // 速度を変えると分が再計算される
    await p.evaluate(() => { localStorage.setItem("xdash_listen_speed", "2"); __XD_TEST__.Beta.refreshToday(); });
    const min2 = Math.max(1, Math.round(chars / (6.5 * 2) / 60));
    check("速度2.0へ変更すると約N分を端末で再計算", (await txt(p, "#btnListen")) === `▶聴く(約${min2}分)`, await txt(p, "#btnListen"));
    await p.evaluate(() => { localStorage.setItem("xdash_listen_speed", "1.2"); __XD_TEST__.Beta.refreshToday(); });
    // 今日の要点カード
    const dg = await txt(p, "#digestCard");
    check("今日の要点カード: 見出し・要約・生成時刻・続報チップ", dg.includes("要点見出し甲") && dg.includes("二つ目の要約です。") && /生成 \d\d:\d\d/.test(dg) && dg.includes("続報"), dg);
    // 保留一覧
    check("保留: 「保留 3件」を押すと一覧が開き、手動降格チップが付く", (await txt(p, "#btnHoldToggle")).includes("保留 3件"));
    await p.click("#btnHoldToggle");
    const hold = await txt(p, "#holdList");
    check("保留一覧: 3件+手動降格表示", (await p.$$("#holdList .holditem")).length === 3 && hold.includes("手動降格"), hold);
    // 副ボタン・モード切替
    check("副ボタン: 流す/一覧", (await txt(p, "#btnFlow")).includes("流す") && (await txt(p, "#btnList")).includes("一覧"));
    await p.click("#btnList"); await sleep(150);
    check("一覧モード: 既存画面が出てタブは隠れる", (await vis(p, "#listMode")) && !(await vis(p, "#tabBar")) && (await p.$$(".row")).length > 0);
    await p.click("#btnBackToday"); await sleep(100);
    check("一覧→‹今日で戻る", (await vis(p, "#tabBar")) && !(await vis(p, "#listMode")));
    await p.click("#btnFlow"); await sleep(150);
    check("流す: フルスクリーン表示でタブは隠れる", (await vis(p, "#flowView")) && !(await vis(p, "#tabBar")));
    await p.click("#flExit"); await sleep(100);
    await p.click('#tabBar button[data-tab="settings"]');
    check("設定タブ: 再生(速度・声)がある", (await p.$$("#setSpeedBtns button")).length >= 5 && (await p.$$("#setVoiceBtns button")).length === 2 && (await txt(p, "#set-playback")).includes("再生"));
    await p.click('#setSpeedBtns button[data-speed="1.5"]'); await p.click('#setVoiceBtns button[data-voice="standard"]');
    check("設定: 速度・声がlocalStorageに保存される", await p.evaluate(() => localStorage.getItem("xdash_listen_speed") === "1.5" && localStorage.getItem("xdash_voice_quality") === "standard"));
    check("既定速度1.2が初回に保存される", await (async () => { const s3 = await open(browser, base, { posts: [] }); const v = await s3.page.evaluate(() => localStorage.getItem("xdash_listen_speed")); await s3.ctx.close(); return v === "1.2"; })());
    check("幅390pxで横スクロールなし(今日/設定)", await noOverflow(p));
    check("JSエラーなし", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();

    // digest: paused / 404 / 別の日 / 聴く0件の案内
    for (const [name, dg2, expect] of [
      ["paused", { ...DIGEST, status: "paused", topics: [] }, "費用上限"],
      ["failed", { ...DIGEST, status: "failed", topics: [] }, "生成できませんでした"],
      ["別の日", { ...DIGEST, day: "2020-01-01" }, "まだありません"],
    ]) {
      const t = await open(browser, base, { posts: [], digest: dg2 });
      check(`要点カード(${name}): 「${expect}」`, (await txt(t.page, "#digestCard")).includes(expect), await txt(t.page, "#digestCard"));
      await t.ctx.close();
    }
    const t404 = await open(browser, base, { posts: scenario(), digest: "404" });
    check("digest_dailyが無い(404)でも壊れず、カードは出ない", !(await vis(t404.page, "#digestCard")) && t404.rec.errors.length === 0 && (await txt(t404.page, "#btnListen")).startsWith("▶聴く"));
    await t404.ctx.close();
    const t0 = await open(browser, base, { posts: [mk(1, { listen_tier: "skim", tier_assigned_at: TODAY_T, score: 4 }), mk(2, { listen_tier: "skim", tier_assigned_at: TODAY_T, score: 3 })] });
    check("聴くが0件: 主ボタンの代わりに案内文(+10分ボタンが出る)", !(await vis(t0.page, "#btnListen")) && (await txt(t0.page, "#listenGuide")).includes("聴く」カードはありません") && (await vis(t0.page, "#btnExtraToday")), await txt(t0.page, "#listenGuide"));
    await t0.ctx.close();
  } catch (e) { check("今日タブのテストが完走", false, e.stack); }

  // ================================================================ 3. カード表示(点数バッジ・種類+理由・暫定チップ)
  console.log("\n--- 3. カード表示 ---");
  try {
    const cards = [
      mk(1, { score: 5, score_kind: "primary", score_reason: "公式が仕様を公開", score_state: "scored", scored_model: "gemini-2.5-flash" }),
      mk(2, { score: 3, score_kind: "opinion", score_reason: "個人の感想", score_state: "scored", scored_model: "gemini-3.5" }),
      mk(3, { score: null }),
      mk(4, { score: 1, score_kind: "duplicate", score_reason: "同内容", score_state: "rule", scored_model: null }),
    ];
    const s = await open(browser, base, { path: "/index_beta.html#list", posts: cards });
    const info = await s.page.$$eval(".row", (rows) => rows.map((r) => ({ url: r.dataset.url, badge: r.querySelector(".sbadge").textContent, cls: r.querySelector(".sbadge").className, kind: r.querySelector(".kindline") ? r.querySelector(".kindline").textContent.replace("暫定", "") : null, chips: r.querySelectorAll(".chip-prov").length, badgeFirst: r.querySelector(".title-line").firstElementChild.classList.contains("sbadge"), gist: !!r.querySelector("a.gist") })));
    const g = (i) => info.find((x) => x.url.endsWith("/" + i));
    check("バッジ: 5点=s5・タイトル先頭、3点=s3、未採点は「–」", g(1).badge === "5" && g(1).cls.includes("s5") && g(1).badgeFirst && g(2).cls.includes("s3") && g(3).badge === "–" && g(3).cls.includes("s0") && g(4).cls.includes("s1"), JSON.stringify(info));
    check("種類+理由が直下の1行(日本語)・未採点は行なし", g(1).kind === "一次情報・公式が仕様を公開" && g(2).kind === "意見・感想・個人の感想" && g(4).kind === "重複・同内容" && g(3).kind === null, JSON.stringify(info.map((x) => x.kind)));
    check("暫定チップ: 2.5採点のカードに1つだけ・他は無し", g(1).chips === 1 && g(2).chips === 0 && g(3).chips === 0 && g(4).chips === 0 && info.every((x) => x.gist), JSON.stringify(info.map((x) => x.chips)));
    check("幅390pxで横スクロールなし(一覧)", await noOverflow(s.page));
    await s.ctx.close();
  } catch (e) { check("カード表示テストが完走", false, e.stack); }

  // ================================================================ 4. 聴くモード
  console.log("\n--- 4. 聴くモード ---");
  const spokenOf = (p) => p.evaluate(() => window.__spoken.slice());
  const titleOfId = (i) => `${NAMES[i % NAMES.length]}の話`;
  try {
    // 4a. 初回(その日の最初): 今日の要点→聴くカード→保留上位の見出し。順序は手動昇格→点数降順→新しい順
    const s = await open(browser, base, { posts: scenario(70), digest: DIGEST, speakMs: 20 });
    const p = s.page;
    await p.click("#btnListen");
    check("聴く: プレイヤー画面になりタブ・一覧は隠れる", (await vis(p, "#listenView")) && !(await vis(p, "#tabBar")) && !(await vis(p, "#listMode")));
    const geo = await p.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const bottom = r("plBottom");
      const css = [...document.styleSheets].flatMap((ss) => [...ss.cssRules]).find((x) => x.selectorText === ".pl-bottom");
      return { H: innerHeight, bottomTop: bottom.top, bottomBottom: bottom.bottom, btns: ["plReject", "plToggle", "plNext"].map((id) => { const b = r(id); return { w: b.width, h: b.height, top: b.top, bottom: b.bottom }; }), safe: !!css && /safe-area-inset-bottom/.test(css.cssText) };
    });
    check("3タップ領域: 下半分に3つ(幅≥100px・高さ≥150px)", geo.bottomTop >= geo.H / 2 - 2 && geo.btns.every((b) => b.w >= 100 && b.h >= 150 && b.top >= geo.H / 2 - 2), JSON.stringify(geo));
    check("3タップ領域: 下端はsafe-areaを避ける(env(safe-area-inset-bottom)の余白)", geo.safe && geo.btns.every((b) => b.bottom <= geo.H));
    check("プレイヤー画面: 横スクロールなし(390px)", await noOverflow(p));
    check("3つのボタン名: これは不要/止める/次へ", (await txt(p, "#plReject")).includes("これは不要") && (await txt(p, "#plToggle")).includes("止める") && (await txt(p, "#plNext")).includes("次へ"));
    // 全再生を待つ(自然終了)
    await until(() => vis(p, "#plFinish"), 15000);
    const sp = await spokenOf(p);
    const idx = (s) => sp.findIndex((x) => x.includes(s));
    const order = [4, 5, 2, 1, 3, 7].map((i) => idx(titleOfId(i)));
    const holdIdx = idx("保留の上位");
    check("初回の読み上げ順: 要点→(聴く)→保留の見出し", sp[0].includes("今日の要点") && idx("要点見出し甲") > 0 && idx("要点見出し乙") > idx("要点見出し甲") && holdIdx > Math.max(...order), JSON.stringify(sp.slice(0, 4)));
    check("聴く順: 手動昇格→点数降順→新しい順(桜..)", order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])) && order[0] > idx("要点見出し乙"), JSON.stringify(order));
    check("冒頭の重要度は5点と手動昇格のみ(「重要度5」「昇格した投稿です」)", sp.filter((x) => x.includes("重要度5")).length === 2 && sp.filter((x) => x.includes("昇格した投稿です")).length === 2 && !sp.some((x) => x.includes("重要度4") || x.includes("重要度3")), JSON.stringify(sp.filter((x) => /重要度|昇格/.test(x))));
    check("保留の見出し: 上位=15,14のみ(手動降格16は読まない)", sp.slice(holdIdx).join("|").includes(titleOfId(15)) && sp.slice(holdIdx).join("|").includes(titleOfId(14)) && !sp.slice(holdIdx).join("|").includes(titleOfId(16)));
    check("最後まで再生したカードは rpc/mark_read via=listen で既読(6件)", s.rec.reads.filter((r) => r.via === "listen").length === 6 && new Set(s.rec.reads.map((r) => r.url)).size === 6, JSON.stringify(s.rec.reads.map((r) => r.via)));
    const fin = await txt(p, "#plFinish");
    check("聴き終え: 「上限で流すに回った4点以上が2件あります。続けますか」+「+10分聴く」", fin.includes("上限で流すに回った4点以上が2件あります。続けますか") && (await vis(p, "#plMoreTen")), fin);
    check("初回フラグ(その日の最初)が保存された", await p.evaluate(() => localStorage.getItem("xdash_intro_day")) === dayKeyOf(NOW));
    // +10分聴く: 流す4点以上を点数順に(9→8)
    const before = (await spokenOf(p)).length;
    await p.click("#plMoreTen");
    await until(() => vis(p, "#plFinish"), 8000);
    const sp2 = (await spokenOf(p)).slice(before);
    check("+10分聴く: 点数順(5点→4点)で再生し既読(via=listen)", sp2.findIndex((x) => x.includes(titleOfId(9))) >= 0 && sp2.findIndex((x) => x.includes(titleOfId(9))) < sp2.findIndex((x) => x.includes(titleOfId(8))) && s.rec.reads.filter((r) => r.via === "listen").length === 8, JSON.stringify(sp2));
    check("+10分の後は案内が消える(流す4点以上=0件)", !(await vis(p, "#plMoreTen")) && !(await txt(p, "#plOverflow")).includes("2件"), await txt(p, "#plFinish"));
    await p.click("#plBackB"); await sleep(100);
    check("今日へ戻ると内訳に反映(聴く0件→案内文)", (await txt(p, "#breakdown")).includes("聴く0件") && (await vis(p, "#listenGuide")));
    check("JSエラーなし(聴く)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();

    // 4b. 2回目以降(要点・保留見出しは出さない) + 次へ(既読)
    const s2 = await open(browser, base, { posts: scenario(70), digest: DIGEST, speakMs: 1500, storage: { xdash_intro_day: dayKeyOf(NOW) } });
    const p2 = s2.page;
    await p2.click("#btnListen");
    await until(async () => (await spokenOf(p2)).length >= 1, 3000);
    check("2回目以降は要点から始まらない(最初は手動昇格カード)", !(await spokenOf(p2))[0].includes("今日の要点") && (await spokenOf(p2)).some((x) => x.includes("昇格した投稿です")));
    check("再生中はカード(桜..)・位置表示・残り時間が出る", (await txt(p2, "#plCard")).includes(titleOfId(4)) && /1 \/ 6/.test(await txt(p2, "#plPos")) && /残り約\d+分/.test(await txt(p2, "#plPos")), `${await txt(p2, "#plPos")}`);
    await p2.click("#plNext"); await sleep(300);
    check("次へ=既読(via=user)にして次のカードへ", s2.rec.reads.length === 1 && s2.rec.reads[0].url.endsWith("/4") && s2.rec.reads[0].via === "user" && (await txt(p2, "#plCard")).includes(titleOfId(5)) && /2 \/ 6/.test(await txt(p2, "#plPos")), JSON.stringify(s2.rec.reads));
    // 止める・再開
    await p2.click("#plToggle");
    check("止める→ボタンが「再開」になる", (await txt(p2, "#plToggle")).includes("再開") && (await p2.evaluate(() => __XD_TEST__.Beta.LP.state)) === "paused");
    await p2.click("#plToggle");
    check("再開→再び再生", (await txt(p2, "#plToggle")).includes("止める") && (await p2.evaluate(() => __XD_TEST__.Beta.LP.state)) === "playing");

    // 4c. これは不要: 5秒の取り消し
    const cardBefore = await txt(p2, "#plCard");
    await p2.click("#plReject"); await sleep(150);
    check("不要: 取り消しの帯が出て次のカードへ進む", (await vis(p2, "#plToast")) && (await txt(p2, "#plCard")) !== cardBefore && (await txt(p2, "#plToast")).includes("取り消し"));
    await p2.click("#plUndo"); await sleep(250);
    const st = await p2.evaluate((u) => { const x = allPosts.find((q) => q.post_url === u); return { tier: x.listen_tier, act: x.manual_action, read: x.is_read }; }, "https://x.com/u5/status/5");
    check("取り消し: 状態が元に戻り、そのカードへ戻って再生・キューに何も積まれない", st.tier === "listen" && st.act === "promote" && !st.read && (await txt(p2, "#plCard")).includes(titleOfId(5)) && (await queueOf(p2)).length === 0 && !(await vis(p2, "#plToast")), JSON.stringify(st));
    await p2.click("#plReject");
    await sleep(5400);
    const q = await queueOf(p2);
    check("不要を5秒放置: 確定→保留へ降格+既読(rpc via=user)+端末キューにtier_set(demote)", q.length === 1 && q[0].kind === "tier_set" && q[0].payload.how === "demote" && q[0].payload.post_url.endsWith("/5") && !!q[0].op_id && s2.rec.reads.some((r) => r.url.endsWith("/5") && r.via === "user") && !(await vis(p2, "#plToast")), JSON.stringify(q));
    check("トークンが無い間は送信せず溜めるだけ・ログイン画面は出ない", s2.rec.admin.length === 0 && (await p2.$$('input[type="password"]')).length === 0 && !(await txt(p2, "#listenView")).includes("ログイン"));
    const opId = q[0].op_id;

    // 4d. 中断→続きから
    await p2.click("#plExit"); await sleep(200);
    check("✕中断: 今日へ戻り「中断しました。続きから再生」の大ボタンと聴き残しの帯", (await vis(p2, "#resumeBox")) && (await txt(p2, "#btnResume")).includes("中断しました。続きから再生") && (await p2.evaluate(() => __XD_TEST__.TopBand.current())) === "leftover");
    const readsBefore = s2.rec.reads.length;
    await p2.click("#btnResume"); await sleep(300);
    check("続きから再生: 中断したカードの先頭から・途中のカードは既読になっていない", (await vis(p2, "#listenView")) && s2.rec.reads.length === readsBefore, `${await txt(p2, "#plPos")}`);
    // 画面が裏に回った(iPhoneで読み上げが止まる)→中断パネル
    await p2.evaluate(() => { Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await sleep(100);
    check("バックグラウンド化で中断パネル(続きから再生の大ボタン)", (await vis(p2, "#plInterrupted")) && (await txt(p2, "#plResume")).includes("中断しました。続きから再生"));
    await p2.evaluate(() => { Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await p2.click("#plResume"); await sleep(250);
    check("パネルから続きから再生できる", !(await vis(p2, "#plInterrupted")) && (await p2.evaluate(() => __XD_TEST__.Beta.LP.state)) === "playing");

    // 4e. 端末キューの冪等・再送(第2段が使うAdminQueue)
    await p2.evaluate(() => { window.__r = {}; });
    s2.rec.adminMode = "fail500";
    await p2.evaluate(() => __XD_TEST__.AdminQueue.setToken("tok-1"));
    await sleep(300);
    const qa = await queueOf(p2);
    check("送信失敗(500): 溜めたまま残る・同じ操作IDで送られる(トークンはヘッダ)", qa.length === 1 && qa[0].op_id === opId && s2.rec.admin.length >= 1 && s2.rec.admin.every((a) => a.body.op_id === opId && a.body.action === "tier_set" && a.body.how === "demote" && a.token === "tok-1" && /^Bearer /.test(a.auth)), JSON.stringify(s2.rec.admin.map((a) => a.body)));
    s2.rec.adminMode = "dup";
    const n0 = s2.rec.admin.length;
    const fr = await p2.evaluate(() => __XD_TEST__.AdminQueue.flush());
    const qb = await queueOf(p2);
    check("再送でサーバーが duplicate:true を返しても受理扱い→キューから削除、操作IDは同一(冪等)", qb.length === 0 && s2.rec.admin.length === n0 + 1 && s2.rec.admin[n0].body.op_id === opId && fr.sent === 1, JSON.stringify(fr));
    const idem = await p2.evaluate(() => { const a = __XD_TEST__.AdminQueue.add("tier_set", { post_url: "https://x.com/z", how: "promote" }, "fixed-op-1"); const b = __XD_TEST__.AdminQueue.add("tier_set", { post_url: "https://x.com/z", how: "promote" }, "fixed-op-1"); return { same: a.op_id === b.op_id, n: __XD_TEST__.AdminQueue.list().filter((o) => o.op_id === "fixed-op-1").length }; });
    check("同じ操作IDを2回addしても1件(冪等)", idem.same && idem.n === 1);
    await sleep(300);
    // 並行flushは1回に束ねる
    s2.rec.adminMode = "auth401";
    await p2.evaluate(() => { __XD_TEST__.AdminQueue.add("tier_set", { post_url: "https://x.com/y", how: "demote" }, "op-auth"); });
    await sleep(300);
    const stt = await p2.evaluate(() => __XD_TEST__.AdminQueue.stats());
    check("トークン失効(401): キューは保持し needLogin=true・帯に「未送信」(再生画面にログインUIは出さない)", stt.needLogin === true && stt.pending >= 1 && (await p2.evaluate(() => __XD_TEST__.TopBand.current())) !== null && (await p2.$$('input[type="password"]')).length === 0, JSON.stringify(stt));
    s2.rec.adminMode = "ok";
    const fr2 = await p2.evaluate(() => __XD_TEST__.AdminQueue.flush());
    check("復旧後の再送で全件削除・応答のtokenでトークンを更新", fr2.remaining === 0 && (await p2.evaluate(() => localStorage.getItem("xdash_admin_token"))) === "tok-renewed", JSON.stringify(fr2));
    check("JSエラーなし(聴く2)", s2.rec.errors.length === 0, JSON.stringify(s2.rec.errors));
    await s2.ctx.close();
  } catch (e) { check("聴くモードのテストが完走", false, e.stack); }

  try {
    // 4f. ▶押下時に当日の聴くカードを端末に確保 → 再読込後に通信できなくても続きから再生
    const s = await open(browser, base, { posts: scenario(70), digest: DIGEST, speakMs: 3000, storage: { xdash_intro_day: dayKeyOf(NOW) } });
    const p = s.page;
    await p.click("#btnListen"); await sleep(400);
    const cache = await p.evaluate(() => JSON.parse(localStorage.getItem("xdash_listen_cache") || "null"));
    check("▶押下時に当日の聴く全件(6件)を端末に確保(localStorage)", !!cache && cache.posts.length === 6 && cache.day === dayKeyOf(NOW), JSON.stringify(cache && cache.posts.length));
    await p.click("#plExit"); await sleep(150);
    s.rec.postsFail = true;
    await p.reload({ waitUntil: "domcontentloaded" }); await sleep(600);
    check("再読込+通信失敗でも「中断しました。続きから再生」が出る", await vis(p, "#btnResume"));
    await p.click("#btnResume"); await sleep(500);
    check("端末の確保分から続きから再生できる(読み上げが始まる)", (await vis(p, "#listenView")) && (await p.evaluate(() => window.__spoken.length)) > 0 && (await txt(p, "#plCard")).includes(titleOfId(4)), await txt(p, "#plCard"));
    await s.ctx.close();
  } catch (e) { check("端末確保のテストが完走", false, e.stack); }

  // ================================================================ 5. 流すモード
  console.log("\n--- 5. 流すモード ---");
  try {
    const flowPosts = [
      mk(1, { listen_tier: "skim", tier_assigned_at: TODAY_T, score: 4 }),
      mk(2, { listen_tier: "skim", tier_assigned_at: TODAY_T, score: 5 }),
      mk(3, { listen_tier: "skim", tier_assigned_at: TODAY_T, score: 3 }),
    ];
    const s = await open(browser, base, { posts: flowPosts, storage: { xdash_flow_sec: "3" } });
    const p = s.page;
    await p.click("#btnFlow");
    check("流す: 音声なし(読み上げ0)・点数順で最初は5点", (await txt(p, "#flCard")).includes(titleOfId(2)) && (await spokenOf(p)).length === 0 && /1 \/ 3/.test(await txt(p, "#flPos")));
    await sleep(1000);
    check("2秒未満では既読にならない", s.rec.reads.length === 0);
    await until(() => s.rec.reads.length >= 1, 3000);
    check("2秒以上表示で既読(rpc via=flow)", s.rec.reads.length === 1 && s.rec.reads[0].url.endsWith("/2") && s.rec.reads[0].via === "flow", JSON.stringify(s.rec.reads));
    await until(async () => (await txt(p, "#flCard")).includes(titleOfId(1)), 3000);
    check("約3秒で自動送り(2枚目=4点)", (await txt(p, "#flCard")).includes(titleOfId(1)) && /2 \/ 3/.test(await txt(p, "#flPos")));
    await sleep(300);
    await p.click("#flListen"); await sleep(200);
    const qf = await queueOf(p);
    check("これ聴く(2秒未満): tier_set(promote)が端末キューへ・既読にはならず・次のカードへ", qf.length === 1 && qf[0].kind === "tier_set" && qf[0].payload.how === "promote" && qf[0].payload.post_url.endsWith("/1") && !s.rec.reads.some((r) => r.url.endsWith("/1")) && (await txt(p, "#flCard")).includes(titleOfId(3)) && /2 \/ 2/.test(await txt(p, "#flPos")), JSON.stringify(qf));
    // タップで一時停止
    await p.click("#flCard"); await sleep(150);
    check("カードタップで一時停止の表示", await vis(p, "#flPaused"));
    await sleep(2400);
    check("一時停止中は既読にならない", !s.rec.reads.some((r) => r.url.endsWith("/3")));
    await p.click("#flCard");
    await until(() => vis(p, "#flEnd"), 5000);
    check("再開→2秒で既読→終了表示", s.rec.reads.some((r) => r.url.endsWith("/3") && r.via === "flow") && (await vis(p, "#flEnd")) && (await txt(p, "#flEndMsg")).includes("流し終わりました"));
    check("流す画面: 横スクロールなし", await noOverflow(p));
    await p.click("#flBack"); await sleep(150);
    const top = await p.evaluate(() => { const t = __XD_TEST__.Beta.computeToday(); return { first: t.listen[0] && t.listen[0].post_url, n: t.listen.length, skim: t.skim.length }; });
    check("昇格したカードが聴く待ちの先頭に入り、流すからは外れる", top.first.endsWith("/1") && top.n === 1 && top.skim === 0 && (await txt(p, "#breakdown")).includes("聴く1件"), JSON.stringify(top));
    check("JSエラーなし(流す)", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
  } catch (e) { check("流すモードのテストが完走", false, e.stack); }

  // ================================================================ 6. 上部の帯(同時に1件・優先順)
  console.log("\n--- 6. 上部の帯 ---");
  try {
    const old = (o) => ({ fetched_at: iso(NOW - 40 * 3600e3), ...o });
    // 取得遅れ > 聴き残し > 通知先未設定 > 暫定 > 未送信
    const s = await open(browser, base, { posts: [mk(1, old({ listen_tier: "listen", tier_assigned_at: YDAY_T, score: 4, score_state: "scored", scored_model: "gemini-2.5-flash" }))], storage: { xdash_admin_queue: JSON.stringify([{ op_id: "q1", kind: "tier_set", payload: { post_url: "u", how: "demote" }, at: 1, tries: 0 }]) } });
    const p = s.page;
    const cur = () => p.evaluate(() => __XD_TEST__.TopBand.current());
    check("帯: 取得遅れが最優先(同時に1件だけ表示)", (await cur()) === "late" && (await p.$$("#topBand:not([hidden])")).length === 1 && (await txt(p, "#topBand")).includes("取得が遅れています"), await txt(p, "#topBand"));
    await p.evaluate(() => { const x = allPosts[0]; x.fetched_at = new Date().toISOString(); __XD_TEST__.Beta.refreshToday(); });
    check("帯: 次に聴き残し(昨日からの聴き残し)", (await cur()) === "leftover" && (await txt(p, "#topBand")).includes("聴き残し"), await txt(p, "#topBand"));
    await p.evaluate(() => { allPosts[0].tier_assigned_at = new Date().toISOString(); __XD_TEST__.Beta.refreshToday(); __XD_TEST__.TopBand.set("notify", { text: "🔔 通知先が未設定です" }); });
    check("帯: 次に通知先未設定(第2段が TopBand.set('notify',…) で出す)", (await cur()) === "notify");
    await p.evaluate(() => __XD_TEST__.TopBand.set("notify", null));
    check("帯: 次に暫定", (await cur()) === "provisional" && (await txt(p, "#topBand")).includes("暫定"));
    await p.evaluate(() => { allPosts[0].scored_model = "gemini-3.5"; __XD_TEST__.Beta.refreshToday(); });
    check("帯: 最後に未送信N件(タップで設定タブ)", (await cur()) === "unsent" && (await txt(p, "#topBand")).includes("未送信の操作が1件"));
    await p.click("#topBand"); await sleep(100);
    check("未送信の帯をタップ→設定タブ", await vis(p, "#tab-settings"));
    check("帯: 再生中(聴く)は表示されない", await (async () => { await p.click('#tabBar button[data-tab="today"]'); await p.evaluate(() => { allPosts[0].fetched_at = new Date().toISOString(); }); await p.click("#btnListen"); const v = await vis(p, "#topBand"); await p.click("#plExit"); return !v; })());
    await s.ctx.close();
  } catch (e) { check("帯のテストが完走", false, e.stack); }

  // ================================================================ 7. レビュー指摘の修正(重大4件+軽微)
  console.log("\n--- 7. レビュー指摘の修正 ---");
  const REAL = process.env.TTS === "real";
  const setVis = (p, v) => p.evaluate((vv) => { Object.defineProperty(document, "visibilityState", { get: () => vv, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, v);
  const wakeOf = (p) => p.evaluate(() => ({ req: window.__wake.req, rel: window.__wake.rel, cur: window.__wake.cur && { type: window.__wake.cur.type, released: window.__wake.cur.released }, beeps: window.__beeps }));
  const MID = { score_state: "scored", scored_model: "gemini-3.5" };
  const lt = (i, o = {}) => mk(i, { listen_tier: "listen", tier_assigned_at: TODAY_T, ...MID, ...o });
  const sk = (i, o = {}) => mk(i, { listen_tier: "skim", tier_assigned_at: TODAY_T, ...MID, ...o });
  const hd = (i, o = {}) => mk(i, { listen_tier: "hold", tier_assigned_at: TODAY_T, ...MID, ...o });
  const silentOf = (i, o = {}) => lt(i, { gist: "", summary: "", speech_title: null, speech_body: null, content: "https://example.com/abcdef", ...o });
  const INTRO = { xdash_intro_day: dayKeyOf(NOW) };

  // ① 「+10分聴く」で足した skim 区分のカードも、中断→続きから再生で復元できる
  try {
    const s = await open(browser, base, { posts: [sk(21, { score: 5 }), sk(22, { score: 4 }), sk(23, { score: 3 })], speakMs: 3000, storage: INTRO });
    const p = s.page;
    check("①+10分: 聴くが0件・4点以上の流す2件で「+10分聴く」が出る", !(await vis(p, "#btnListen")) && (await vis(p, "#btnExtraToday")));
    await p.click("#btnExtraToday");
    await until(async () => (await spokenOf(p)).length >= 1, 3000);
    await p.click("#plExit"); await sleep(200);
    const sess = await p.evaluate(() => JSON.parse(localStorage.getItem("xdash_listen_session") || "null"));
    check("①中断すると追加分フラグ(extra:true)とskim区分の2件が保存される", !!sess && sess.extra === true && sess.cardUrls.length === 2 && sess.cardUrls[0].endsWith("/21"), JSON.stringify(sess));
    check("①今日タブに「中断しました。続きから再生」(残り2件)", (await vis(p, "#btnResume")) && (await txt(p, "#btnResume")).includes("残り2件"), await txt(p, "#btnResume"));
    await p.reload({ waitUntil: "domcontentloaded" }); await sleep(600);
    check("①再読込後も続きから再生が出る", await vis(p, "#btnResume"));
    await p.click("#btnResume"); await sleep(400);
    check("①skim区分のカードが復元されて再生される(listenに限らない)・追加分フラグを引き継ぐ", (await vis(p, "#listenView")) && (await txt(p, "#plCard")).includes(titleOfId(21)) && (await p.evaluate(() => __XD_TEST__.Beta.LP.extra)) === true && /1 \/ 2/.test(await txt(p, "#plPos")), await txt(p, "#plPos"));
    check("①JSエラーなし", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();

    // 復元できるカードが0件 → 今日タブへ戻して案内(プレイヤー画面で固まらない)
    const s2 = await open(browser, base, { posts: scenario(70), speakMs: 3000, storage: INTRO });
    const p2 = s2.page;
    await p2.click("#btnListen");
    await until(async () => (await spokenOf(p2)).length >= 1, 3000);
    await p2.evaluate(() => { for (const x of allPosts) x.is_read = true; });
    await setVis(p2, "hidden"); await setVis(p2, "visible");
    check("①(0件)中断パネルが出る", await vis(p2, "#plInterrupted"));
    await p2.click("#plResume"); await sleep(300);
    check("①復元0件: 今日タブへ戻り案内が出る(プレイヤー画面に残らない)", (await vis(p2, "#tabBar")) && !(await vis(p2, "#listenView")) && (await vis(p2, "#todayNote")) && (await txt(p2, "#todayNote")).includes("続きから再生できるカードがありません"), await txt(p2, "#todayNote"));
    check("①復元0件: 保存セッションは破棄される", (await p2.evaluate(() => localStorage.getItem("xdash_listen_session"))) === null);
    await s2.ctx.close();
  } catch (e) { check("①続きから再生のテストが完走", false, e.stack); }

  // ② 読み上げ文が空の聴くカードは件数・所要時間から除き、流す扱いにする(▶が無反応にならない)
  try {
    const posts = [lt(31, { score: 4 }), silentOf(32, { score: 5 }), silentOf(33, { score: 4 }), sk(34, { score: 4 })];
    const s = await open(browser, base, { posts, speakMs: 20, storage: INTRO });
    const p = s.page;
    const b = (await txt(p, "#breakdown")).replace(/\s/g, "");
    check("②空の聴くカード2件は聴く件数・時間から除き「流す」に入れる(聴く1件・流す3件)", b.startsWith("聴く1件・約1分/流す3件/保留0件") && b.includes("読み上げる文章がない2件"), b);
    check("②流す件数にも含まれる(ボタン表示)", (await txt(p, "#btnFlow")).includes("流す(3)"));
    await p.click("#btnListen");
    await until(() => vis(p, "#plFinish"), 8000);
    const sp = await spokenOf(p);
    check("②聴くのは読み上げ文のある1件だけ・空カードの「重要度5」などは読まない・既読にもしない", sp.some((x) => x.includes(titleOfId(31))) && !sp.some((x) => x.includes("重要度")) && s.rec.reads.length === 1 && s.rec.reads[0].url.endsWith("/31"), JSON.stringify([sp, s.rec.reads]));
    check("②+10分の対象は読み上げ文のある流す4点以上(空カードは含まない=1件)", (await txt(p, "#plOverflow")).includes("1件") && (await vis(p, "#plMoreTen")), await txt(p, "#plOverflow"));
    await s.ctx.close();
    const s2 = await open(browser, base, { posts: [silentOf(41, { score: 5 }), silentOf(42, { score: 4 })], storage: INTRO });
    const p2 = s2.page;
    check("②全部空: ▶は出さず案内(無反応にならない)・+10分も出さない・流すで見られる", !(await vis(p2, "#btnListen")) && (await vis(p2, "#listenGuide")) && (await txt(p2, "#listenGuide")).includes("読み上げる文章がない2件") && !(await vis(p2, "#btnExtraToday")) && !(await p2.$eval("#btnFlow", (b) => b.disabled)), `${await txt(p2, "#listenGuide")}`);
    const items = await p2.evaluate(() => { const t = __XD_TEST__.Beta.computeToday(); return { listen: t.listen.length, sec: t.listenSec, min: t.listenMin, silent: t.silent.length, skim: t.skim.length }; });
    check("②所要時間0・聴く0件・流す2件", items.listen === 0 && items.sec === 0 && items.min === 0 && items.skim === 2 && items.silent === 2, JSON.stringify(items));
    await s2.ctx.close();
  } catch (e) { check("②空の読み上げ文のテストが完走", false, e.stack); }

  // ④ 画面点灯(Wake Lock)・「停止中」の大表示・復帰の効果音(再開ボタンのタップ後)
  try {
    const s = await open(browser, base, { posts: scenario(70), speakMs: 4000, silentMs: 1200, storage: INTRO });
    const p = s.page;
    check("④聴く開始前は画面点灯を取らない", (await wakeOf(p)).req === 0);
    await p.click("#btnListen");
    await until(async () => (await wakeOf(p)).req >= 1, 2000);
    const w1 = await wakeOf(p);
    check("④聴くの再生中は wakeLock.request('screen') を取得", w1.req === 1 && w1.cur.type === "screen" && !w1.cur.released, JSON.stringify(w1));
    check("④聴く画面に「画面を点灯したままにしてください(ロックすると読み上げが止まります)」", (await vis(p, "#plWake")) && (await txt(p, "#plWake")) === "画面を点灯したままにしてください(ロックすると読み上げが止まります)", await txt(p, "#plWake"));
    await p.click("#plToggle");
    check("④止める→点灯を解放", (await wakeOf(p)).cur.released === true && (await wakeOf(p)).rel === 1);
    check("④止めてすぐは「停止中」を出さない", !(await vis(p, "#plStopped")));
    await sleep(1500);
    const big = await p.$eval("#plStopped", (e) => parseFloat(getComputedStyle(e).fontSize)).catch(() => 0);
    check("④一定時間(テストでは1.2秒)以上無音で止まると画面に「停止中」を大きく表示", (await vis(p, "#plStopped")) && (await txt(p, "#plStopped")).includes("停止中") && big >= 30, `${big}`);
    const b0 = (await wakeOf(p)).beeps;
    await p.click("#plToggle");
    const w2 = await wakeOf(p);
    check("④長い停止からの再開: タップ後に効果音(WebAudio)が1回鳴り、点灯を取り直し、「停止中」は消える", w2.beeps === b0 + 1 && w2.req === 2 && !(await vis(p, "#plStopped")), JSON.stringify(w2));
    await setVis(p, "hidden");
    check("④画面が裏に回ると中断(点灯を解放)・この時点では効果音は鳴らさない", (await vis(p, "#plInterrupted")) && (await wakeOf(p)).cur.released === true && (await wakeOf(p)).beeps === b0 + 1);
    await sleep(1500);
    await setVis(p, "visible");
    const it = await p.$eval("#plIntrTitle", (e) => ({ t: e.textContent, big: parseFloat(getComputedStyle(e).fontSize), cls: e.className }));
    check("④戻った時、一定時間以上止まっていたら中断パネルに「停止中」を大きく表示", it.t.includes("停止中") && it.big >= 30, JSON.stringify(it));
    check("④復帰しただけ(再開ボタンを押す前)では効果音は鳴らない", (await wakeOf(p)).beeps === b0 + 1);
    await p.click("#plResume"); await sleep(250);
    const w3 = await wakeOf(p);
    check("④再開ボタンのタップ後に効果音が鳴り、点灯を取り直す", w3.beeps === b0 + 2 && w3.req === 3 && !w3.cur.released && (await p.evaluate(() => __XD_TEST__.Beta.LP.state)) === "playing", JSON.stringify(w3));
    await p.evaluate(() => { window.__wake.cur.released = true; }); // OSが解放した状態を再現
    await setVis(p, "hidden"); await setVis(p, "visible"); // 裏→表(interruptされるので再開してから確認)
    await p.click("#plResume"); await sleep(250);
    const reqBefore = (await wakeOf(p)).req;
    await p.evaluate(() => { window.__wake.cur.released = true; });
    await setVis(p, "visible");
    check("④再生中に画面へ復帰(visibilitychange)したら点灯を取り直す", (await wakeOf(p)).req === reqBefore + 1, JSON.stringify(await wakeOf(p)));
    await p.click("#plExit"); await sleep(150);
    check("④✕中断(終了)で点灯を解放", (await wakeOf(p)).cur.released === true);
    check("④JSエラーなし", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
    // Wake Lock 非対応でも聴ける
    const sn = await open(browser, base, { posts: scenario(70), speakMs: 3000, storage: INTRO, noWake: true });
    await sn.page.click("#btnListen");
    await until(async () => (await spokenOf(sn.page)).length >= 1, 3000);
    check("④Wake Lock 非対応端末でもエラーなく再生できる", (await vis(sn.page, "#listenView")) && sn.rec.errors.length === 0 && (await spokenOf(sn.page)).length >= 1, JSON.stringify(sn.rec.errors));
    await sn.ctx.close();
  } catch (e) { check("④画面点灯のテストが完走", false, e.stack); }

  // ⑤ 停止中に速度を変えたら再開時に反映
  try {
    const s = await open(browser, base, { posts: scenario(70), speakMs: 4000, storage: { ...INTRO, xdash_listen_speed: "1.2" } });
    const p = s.page;
    await p.click("#btnListen");
    await until(async () => (await spokenOf(p)).length >= 1, 3000);
    await p.click("#plSpeed"); // 再生中に 1.2→1.5(rateOverride が付く)
    await sleep(300);
    await p.click("#plToggle"); // 止める
    await p.click("#plSpeed"); // 停止中に 1.5→1.8
    check("⑤停止中に速度を変えると設定は1.8になる", (await p.evaluate(() => localStorage.getItem("xdash_listen_speed"))) === "1.8" && (await txt(p, "#plSpeed")) === "1.8x");
    const n0 = await p.evaluate(() => window.__rates.length);
    await p.click("#plToggle"); // 再開
    // 本物のTTS(TTS=real)は再開時に今の文を読み直す。スタブは再読み上げしないので速度の反映は本物でだけ確認する
    if (REAL) await until(async () => (await p.evaluate(() => window.__rates.length)) > n0, 3000);
    const last = await p.evaluate(() => window.__rates[window.__rates.length - 1]);
    check("⑤再開時に変えた速度(1.8)で読み直す(古い速度1.5を持ち越さない)" + (REAL ? "" : "【スタブでは省略】"), !REAL || last === 1.8, `${last}`);
    await s.ctx.close();
  } catch (e) { check("⑤速度のテストが完走", false, e.stack); }

  // ⑧ 流すは画面が裏のとき停止し既読にしない
  try {
    const s = await open(browser, base, { posts: [sk(61, { score: 5 }), sk(62, { score: 4 }), sk(63, { score: 3 })], storage: { xdash_flow_sec: "6" } });
    const p = s.page;
    await p.click("#btnFlow");
    await setVis(p, "hidden");
    await sleep(2800);
    check("⑧流す: 画面が裏の間は既読にならない・一時停止になる(2.8秒経過しても未読)", s.rec.reads.length === 0 && (await p.evaluate(() => __XD_TEST__.Beta.FL.paused)) === true && (await vis(p, "#flPaused")) && /1 \/ 3/.test(await txt(p, "#flPos")), JSON.stringify(s.rec.reads));
    await setVis(p, "visible");
    await sleep(700);
    check("⑧画面が戻っても自動では進まず(一時停止のまま)、既読にもならない", s.rec.reads.length === 0 && /1 \/ 3/.test(await txt(p, "#flPos")));
    await p.click("#flCard");
    await until(() => s.rec.reads.length >= 1, 4000);
    check("⑧タップで再開→2秒表示で既読(via=flow)", s.rec.reads.length === 1 && s.rec.reads[0].via === "flow");
    // 裏にしただけ(イベントなし)でも tick が進めない
    await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true }); });
    const pos0 = await txt(p, "#flPos");
    await sleep(6500);
    check("⑧イベントが来なくても裏では自動送りしない", (await txt(p, "#flPos")) === pos0 && s.rec.reads.length === 1, `${pos0} -> ${await txt(p, "#flPos")} / reads ${s.rec.reads.length}`);
    await s.ctx.close();
  } catch (e) { check("⑧流すの裏回りテストが完走", false, e.stack); }

  // ⑨ 長い英字・URLで390px(と320px)を超えない
  try {
    const LONG = "Supercalifragilistic".repeat(10), URLX = "https://example.com/" + "x".repeat(150);
    const longPosts = [
      lt(51, { score: 5, score_kind: "news", score_reason: LONG, gist: LONG, speech_title: LONG, speech_body: `${LONG}。${URLX}`, author_name: LONG, author_handle: "@" + LONG }),
      hd(52, { score: 3, gist: LONG, speech_title: LONG, score_reason: URLX }),
      sk(53, { score: 4, gist: URLX, speech_title: URLX, speech_body: LONG, summary: LONG }),
    ];
    const dg = { ...DIGEST, topics: [{ headline: LONG, summary: URLX, new_facts: [], card_urls: [], is_followup: false }, { headline: URLX, summary: LONG, new_facts: [], card_urls: [], is_followup: true }] };
    for (const width of [390, 320]) {
      const s = await open(browser, base, { posts: longPosts, digest: dg, speakMs: 3000, storage: INTRO, width });
      const p = s.page;
      await p.click("#btnHoldToggle");
      check(`⑨今日タブ(要点・保留一覧に長い英字/URL)が${width}pxを超えない`, await noOverflow(p), await p.evaluate(() => `${document.documentElement.scrollWidth}/${innerWidth}`));
      await p.click("#btnListen"); await sleep(400);
      const inner = await p.evaluate(() => { const c = document.getElementById("plCard"); return { sw: c.scrollWidth, cw: c.clientWidth, doc: document.documentElement.scrollWidth <= innerWidth }; });
      check(`⑨聴く画面(カード・メタ・理由)が${width}pxを超えない`, inner.doc && inner.sw <= inner.cw + 1, JSON.stringify(inner));
      await p.click("#plExit"); await sleep(100);
      await p.click("#btnFlow"); await sleep(300);
      const inf = await p.evaluate(() => { const c = document.getElementById("flCard"); return { sw: c.scrollWidth, cw: c.clientWidth, doc: document.documentElement.scrollWidth <= innerWidth }; });
      check(`⑨流す画面が${width}pxを超えない`, inf.doc && inf.sw <= inf.cw + 1, JSON.stringify(inf));
      await s.ctx.close();
    }
  } catch (e) { check("⑨長い文字列のテストが完走", false, e.stack); }

  // ⑩ 読み込み失敗(オフライン)は今日タブに「取得できませんでした。再読み込み」
  try {
    const s = await open(browser, base, { posts: scenario(70), postsFail: true });
    const p = s.page;
    check("⑩読み込み失敗: 今日タブに「取得できませんでした。再読み込み」ボタンが出る", (await vis(p, "#btnOffline")) && (await txt(p, "#btnOffline")).includes("取得できませんでした。再読み込み"), await txt(p, "#btnOffline"));
    s.rec.postsFail = false;
    await p.click("#btnOffline"); await sleep(600);
    check("⑩押すと再読み込みされ、成功すると案内は消えて今日の内訳が出る", !(await vis(p, "#btnOffline")) && (await txt(p, "#breakdown")).includes("聴く6件"), await txt(p, "#breakdown"));
    await s.ctx.close();
    const ok = await open(browser, base, { posts: scenario(70) });
    check("⑩通信できている時は案内を出さない", !(await vis(ok.page, "#offlineBox")));
    await ok.ctx.close();
  } catch (e) { check("⑩オフライン案内のテストが完走", false, e.stack); }

  // ⑪ 「これは不要」の取り消し猶予は、中断・裏回りでも保つ
  try {
    const open11 = async (extra = {}) => { const s = await open(browser, base, { posts: scenario(70), speakMs: 6000, storage: INTRO, ...extra }); await s.page.click("#btnListen"); await until(async () => (await spokenOf(s.page)).length >= 1, 3000); return s; };
    // 裏に回って5秒以上放置しても確定せず、戻ったら取り消せる
    const s = await open11();
    const p = s.page;
    await p.click("#plReject"); await sleep(150);
    check("⑪不要を押すと猶予の間は端末に降格を控える(pending)", (await p.evaluate(() => localStorage.getItem("xdash_pending_demote"))) !== null);
    await setVis(p, "hidden");
    await sleep(5600);
    check("⑪裏に回って5.6秒経っても確定しない(キューに積まない・取り消し帯は残る)", (await queueOf(p)).length === 0 && (await p.evaluate(() => !!__XD_TEST__.Beta.LP.undo)), JSON.stringify(await queueOf(p)));
    await setVis(p, "visible");
    check("⑪画面が戻ると取り消し帯が見える(中断パネルの上)", (await vis(p, "#plToast")) && (await vis(p, "#plInterrupted")));
    await p.click("#plUndo"); await sleep(250);
    const st = await p.evaluate(() => { const x = allPosts.find((q) => q.post_url === "https://x.com/u4/status/4"); return { tier: x.listen_tier, act: x.manual_action, read: x.is_read }; });
    check("⑪戻ってから取り消せる: 状態が戻り、キューに何も積まれない・保留中の記録も消える", st.tier === "listen" && st.act === "promote" && !st.read && (await queueOf(p)).length === 0 && (await p.evaluate(() => localStorage.getItem("xdash_pending_demote"))) === null, JSON.stringify(st));
    await s.ctx.close();
    // 猶予は画面が見えている時間で数える: 1.5秒見て→裏3秒→戻って、残り3.5秒で確定
    const s2 = await open11();
    const p2 = s2.page;
    await p2.click("#plReject"); await sleep(1500);
    await setVis(p2, "hidden"); await sleep(3000); await setVis(p2, "visible");
    await sleep(2000);
    check("⑪戻ってから残り時間(約3.5秒)の間はまだ確定しない(見ていない間は数えない)", (await queueOf(p2)).length === 0 && (await vis(p2, "#plToast")));
    await sleep(2200);
    const q2 = await queueOf(p2);
    check("⑪残り時間が過ぎたら確定(tier_set demote+既読via=user)", q2.length === 1 && q2[0].payload.how === "demote" && s2.rec.reads.some((r) => r.via === "user") && !(await vis(p2, "#plToast")), JSON.stringify(q2));
    await s2.ctx.close();
    // ✕中断しても今日タブで取り消せる
    const s3 = await open11();
    const p3 = s3.page;
    await p3.click("#plReject"); await sleep(100);
    await p3.click("#plExit"); await sleep(250);
    check("⑪✕中断で今日タブへ戻っても取り消し帯が残る", (await vis(p3, "#tabBar")) && (await vis(p3, "#plToast")));
    await p3.click("#plUndo"); await sleep(250);
    check("⑪今日タブから取り消すと聴く待ちへ戻る(キューは空)", (await queueOf(p3)).length === 0 && (await txt(p3, "#breakdown")).includes("聴く6件"), await txt(p3, "#breakdown"));
    await s3.ctx.close();
    // ページが破棄された場合: 次回起動時に確定する
    const s4 = await open11();
    const p4 = s4.page;
    await p4.click("#plReject"); await sleep(150);
    await setVis(p4, "hidden");
    s4.rec.reads.length = 0;
    await p4.reload({ waitUntil: "domcontentloaded" }); await sleep(700);
    const q4 = await queueOf(p4);
    check("⑪裏で破棄されて再読込した場合は、次回起動時に降格を確定する", q4.length === 1 && q4[0].payload.how === "demote" && q4[0].payload.post_url.endsWith("/4") && s4.rec.reads.some((r) => r.url.endsWith("/4")), JSON.stringify(q4));
    await s4.ctx.close();
  } catch (e) { check("⑪取り消し猶予のテストが完走", false, e.stack); }

  // ⑫ 「これ聴く」の既読戻しPATCHが失敗したら端末キューで再送
  try {
    const s = await open(browser, base, { posts: [sk(71, { score: 5 }), sk(72, { score: 4 })], storage: { xdash_flow_sec: "4" } });
    const p = s.page;
    await p.click("#btnFlow");
    await until(() => s.rec.reads.length >= 1, 3500);
    s.rec.patchFail = true;
    await p.click("#flListen"); await sleep(300);
    const uq = await p.evaluate(() => JSON.parse(localStorage.getItem("xdash_unread_queue") || "[]"));
    check("⑫PATCH is_read:false が失敗したら端末キューに積む", uq.length === 1 && uq[0].url.endsWith("/71") && s.rec.patches.some((x) => /"is_read":false/.test(x.body)), JSON.stringify(uq));
    check("⑫未送信の帯に件数が出る(昇格のtier_set 1件+既読戻し 1件=2件)", (await txt(p, "#topBand")).includes("未送信の操作が2件"), await txt(p, "#topBand"));
    s.rec.patchFail = false;
    const n0 = s.rec.patches.length;
    await p.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await p.evaluate(() => JSON.parse(localStorage.getItem("xdash_unread_queue") || "[]"))).length === 0, 3000);
    check("⑫通信が戻ると再送して、成功したらキューから消える", s.rec.patches.length > n0 && /"is_read":false/.test(s.rec.patches[s.rec.patches.length - 1].body) && (await p.evaluate(() => __XD_TEST__.Beta.UnreadQueue.count())) === 0);
    await s.ctx.close();
  } catch (e) { check("⑫既読戻しの再送テストが完走", false, e.stack); }

  // ⑭ 聴き終わりの「上限で流すに回った○件…続けますか」を音声でも読み上げる
  try {
    const s = await open(browser, base, { posts: [lt(81, { score: 4 }), sk(82, { score: 5 }), sk(83, { score: 4 })], speakMs: 20, storage: INTRO });
    const p = s.page;
    await p.click("#btnListen");
    await until(() => vis(p, "#plFinish"), 8000);
    await sleep(200);
    const sp = await spokenOf(p);
    check("⑭聴き終わりに音声でも「上限で流すに回った4点以上が2件あります。続けますか」", sp.includes("上限で流すに回った4点以上が2件あります。続けますか"), JSON.stringify(sp));
    await p.click("#plBackB"); await sleep(100);
    await s.ctx.close();
    const s0 = await open(browser, base, { posts: [lt(84, { score: 4 })], speakMs: 20, storage: INTRO });
    await s0.page.click("#btnListen");
    await until(() => vis(s0.page, "#plFinish"), 8000); await sleep(200);
    check("⑭流すに回った分が無ければ案内は読まない", !(await spokenOf(s0.page)).some((x) => x.includes("続けますか")));
    await s0.ctx.close();
  } catch (e) { check("⑭聴き終わり音声のテストが完走", false, e.stack); }

  // ⑯ 一覧ヘッダの「‹今日」で固定領域が増えない・「これは不要」が折り返さない
  try {
    const lp = []; for (let i = 0; i < 12; i++) lp.push(mk(i, { author_handle: `@g${i % 3}`, author_name: `G${i % 3}`, gist: `一覧${i}`, summary: `要約${i}` }));
    for (const width of [390, 320]) {
      const A = await open(browser, base, { path: "/index.html", posts: lp, width });
      const B = await open(browser, base, { path: "/index_beta.html#list", posts: lp, width });
      const ha = await A.page.$eval("#headerBar", (e) => e.offsetHeight), hb = await B.page.$eval("#headerBar", (e) => e.offsetHeight);
      check(`⑯一覧ヘッダ(固定領域)の高さが旧版と同じ(増えない)(${width}px: 旧${ha}px/新${hb}px)`, hb <= ha);
      check(`⑯「‹ 今日」ボタンが見えて一覧が${width}pxを超えない`, (await vis(B.page, "#btnBackToday")) && (await noOverflow(B.page)));
      await A.ctx.close(); await B.ctx.close();
    }
    { // 投稿0件(題名が1行になる場合)でも増えない
      const A = await open(browser, base, { path: "/index.html", posts: [] }), B = await open(browser, base, { path: "/index_beta.html#list", posts: [] });
      const ha = await A.page.$eval("#headerBar", (e) => e.offsetHeight), hb = await B.page.$eval("#headerBar", (e) => e.offsetHeight);
      check(`⑯投稿0件の一覧ヘッダも旧版と同じ高さ(旧${ha}px/新${hb}px)`, hb <= ha);
      await B.page.click("#btnBackToday"); await sleep(150);
      check("⑯「‹ 今日」で今日タブへ戻る(ダイジェスト開閉の副作用なし)", (await vis(B.page, "#tabBar")) && !(await vis(B.page, "#listMode")));
      await A.ctx.close(); await B.ctx.close();
    }
    for (const width of [390, 360, 320]) {
      const s = await open(browser, base, { posts: scenario(70), speakMs: 3000, storage: INTRO, width });
      await s.page.click("#btnListen"); await sleep(300);
      const lines = await s.page.evaluate(() => ["plReject", "plToggle", "plNext"].map((id) => { const b = document.getElementById(id); const r = document.createRange(); r.selectNodeContents(b.firstChild); return { lines: r.getClientRects().length, over: b.scrollWidth > b.clientWidth + 1 }; }));
      check(`⑯聴く画面の3ボタン(これは不要/止める/次へ)の文言が${width}pxでも折り返さない`, lines.every((l) => l.lines === 1 && !l.over), JSON.stringify(lines));
      await s.ctx.close();
    }
  } catch (e) { check("⑯レイアウトのテストが完走", false, e.stack); }

  // ================================================================ 8. 第2回レビューC
  console.log("\n--- 8. 第2回レビューC(既読の再送キュー・読み込み表示・自動更新ほか) ---");
  const readQ = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("xdash_read_queue") || "[]"));

  // 重大1: 既読化の失敗は黙って捨てず、再送キューに積む
  try {
    const s = await open(browser, base, { posts: [lt(91, { score: 4 })], speakMs: 20, storage: INTRO, rpcMode: "fail" });
    const p = s.page; s.rec.patchFail = true;
    await p.click("#btnListen");
    await until(() => vis(p, "#plFinish"), 8000); await sleep(250);
    const q = await readQ(p);
    check("重大1: 圏外(RPCもPATCHも失敗)で最後まで聴くと、既読が再送キューに {url,via,at} で積まれる", q.length === 1 && q[0].url.endsWith("/91") && q[0].via === "listen" && Number.isFinite(q[0].at), JSON.stringify(q));
    check("重大1: 未送信の帯に既読分が加算される(1件)", (await txt(p, "#topBand")).includes("未送信の操作が1件"), await txt(p, "#topBand"));
    await p.evaluate(() => { __XD_TEST__.ReadQueue.add("https://x.com/u91/status/91", "listen"); __XD_TEST__.ReadQueue.add("https://x.com/u91/status/91", "flow"); });
    check("重大1: 同じURLは二重に積まない(重複排除)", (await readQ(p)).length === 1);
    await p.click("#plBackB"); await sleep(150);
    await p.evaluate(() => __XD_TEST__.Tabs.show("settings")); await sleep(400);
    check("重大1: 設定タブのキュー表示に既読の再送待ち件数が出る", (await vis(p, "#sxReadQ")) && (await txt(p, "#sxReadQ")).includes("1件"), await txt(p, "#sxReadQ"));
    // 通信できないまま再読込→復帰しても、聴いたカードは「聴く」に戻らない
    await p.reload({ waitUntil: "domcontentloaded" }); await sleep(900);
    const after = await p.evaluate(() => { const t = __XD_TEST__.Beta.computeToday(); const x = allPosts.find((q) => q.post_url.endsWith("/91")); return { listen: t.listen.length, read: x && x.is_read, btn: !document.getElementById("btnListen").hidden }; });
    check("重大1: 再読込後(サーバーは未読のまま・まだ送れない)も、キューの内容をローカルで既読として反映し「聴く」に戻らない", after.listen === 0 && after.read === true && !after.btn && (await txt(p, "#breakdown")).includes("聴く0件"), JSON.stringify(after));
    check("重大1: 送れていない間は帯に件数が残り、キューも消えない(サーバー受理後にだけ削除)", (await txt(p, "#topBand")).includes("未送信の操作が1件") && (await readQ(p)).length === 1);
    s.rec.rpcMode = "ok"; s.rec.patchFail = false;
    const r0 = s.rec.reads.length;
    await setVis(p, "visible");
    await until(async () => (await readQ(p)).length === 0, 3000);
    check("重大1: 画面が戻る(visibilitychange)と再送され、サーバーが受理したらキューから消えて via=listen で送られる", (await readQ(p)).length === 0 && s.rec.reads.length > r0 && s.rec.reads.some((x) => x.url.endsWith("/91") && x.via === "listen"), JSON.stringify(s.rec.reads));
    check("重大1: 送り終わると帯が消える", !(await vis(p, "#topBand")));
    // online でも再送される。RPCが失敗してもPATCHで受理されれば消える
    s.rec.rpcMode = "fail";
    await p.evaluate(() => { __XD_TEST__.ReadQueue.add("https://x.com/u92/status/92", "flow"); });
    const pt0 = s.rec.patches.length;
    await p.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(async () => (await readQ(p)).length === 0, 3000);
    check("重大1: online で再送され、RPC失敗時はPATCH(is_read:true)で受理されたら消える", (await readQ(p)).length === 0 && s.rec.patches.slice(pt0).some((x) => /u92/.test(x.url) && /"is_read":true/.test(x.body)), JSON.stringify(s.rec.patches.slice(pt0)));
    check("重大1: JSエラーなし", s.rec.errors.length === 0, JSON.stringify(s.rec.errors));
    await s.ctx.close();
  } catch (e) { check("重大1のテストが完走", false, e.stack); }

  // 重大1続き: 「次へ」(既読)・流す(2秒)の既読失敗も同じキュー、これ聴くで外れる
  try {
    const s = await open(browser, base, { posts: [lt(93, { score: 4 }), lt(94, { score: 4 })], speakMs: 4000, storage: INTRO, rpcMode: "fail" });
    const p = s.page; s.rec.patchFail = true;
    await p.click("#btnListen"); await until(async () => (await spokenOf(p)).length >= 1, 3000);
    await p.click("#plNext"); await sleep(300);
    const q = await readQ(p);
    check("重大1: 「次へ」の既読失敗も再送キューに via=user で積まれる", q.length === 1 && q[0].via === "user", JSON.stringify(q));
    await s.ctx.close();
    const f = await open(browser, base, { posts: [sk(95, { score: 5 }), sk(96, { score: 4 })], storage: { xdash_flow_sec: "4" }, rpcMode: "fail" });
    const fp = f.page; f.rec.patchFail = true;
    await fp.click("#btnFlow"); await sleep(2600);
    const fq = await readQ(fp);
    check("重大1: 流す(2秒表示)の既読失敗も再送キューに via=flow で積まれる", fq.length >= 1 && fq[0].via === "flow", JSON.stringify(fq));
    await fp.click("#flListen"); await sleep(300);
    check("重大1: 「これ聴く」(昇格)で、そのURLの未送信の既読は取り消される", (await readQ(fp)).every((x) => !x.url.endsWith("/95") && !x.url.endsWith("/96")) || (await readQ(fp)).length === 0, JSON.stringify(await readQ(fp)));
    await f.ctx.close();
  } catch (e) { check("重大1(次へ・流す・昇格)のテストが完走", false, e.stack); }

  // 軽微3: 読み込み中/失敗は「聴く0件/まだありません」と断定しない
  try {
    const s = await open(browser, base, { posts: scenario(70), storage: INTRO });
    const p = s.page;
    await p.evaluate(() => { allPosts = []; postsLoading = true; loadFailed = false; __XD_TEST__.Beta.refreshToday(); });
    const g1 = await txt(p, "#listenGuide"), b1 = await txt(p, "#breakdown");
    check("軽微3: 読み込み中は「読み込み中…」(「聴く0件/まだありません」と出さない)", (await vis(p, "#listenGuide")) && g1 === "読み込み中…" && b1.includes("読み込み中…") && !/0件|まだありません/.test(g1 + b1), g1 + "/" + b1);
    await p.evaluate(() => { postsLoading = false; loadFailed = true; __XD_TEST__.Beta.refreshToday(); });
    const g2 = await txt(p, "#listenGuide"), b2 = await txt(p, "#breakdown");
    check("軽微3: 失敗時は「取得できませんでした。再読み込み」ボタンと案内(0件・まだありませんと断定しない)", (await vis(p, "#btnOffline")) && (await txt(p, "#btnOffline")).includes("取得できませんでした。再読み込み") && g2.includes("取得できませんでした") && !/0件|まだありません/.test(g2 + b2), g2 + "/" + b2);
    await p.evaluate(() => { postsLoading = false; loadFailed = false; });
    await s.ctx.close();
    const f = await open(browser, base, { posts: scenario(70), postsFail: true });
    const gf = await txt(f.page, "#listenGuide");
    check("軽微3: 実際に取得に失敗した時も「取得できませんでした」で、「まだありません」とは出さない", gf.includes("取得できませんでした") && !gf.includes("まだありません") && !(await txt(f.page, "#breakdown")).includes("聴く0件"), gf);
    await f.ctx.close();
  } catch (e) { check("軽微3のテストが完走", false, e.stack); }

  // 軽微4: 自動更新(visibleに戻った時、30分超か日が変わっていたら再取得。再生中はしない)
  try {
    const s = await open(browser, base, { posts: scenario(70), speakMs: 5000, storage: INTRO });
    const p = s.page; let gets = 0;
    p.on("request", (r) => { if (r.method() === "GET" && r.url().includes("/rest/v1/x_posts") && decodeURIComponent(r.url()).includes("select=*&or=")) gets++; });
    const shiftVis = (ms) => p.evaluate((d) => { const orig = Date.now; Date.now = () => orig.call(Date) + d; try { document.dispatchEvent(new Event("visibilitychange")); } finally { Date.now = orig; } }, ms);
    await shiftVis(0); await sleep(300);
    check("軽微4: 取得から30分以内なら再取得しない", gets === 0, String(gets));
    await shiftVis(29 * 60e3); await sleep(300);
    check("軽微4: 29分では再取得しない", gets === 0, String(gets));
    await shiftVis(31 * 60e3); await until(() => gets >= 1, 3000); await sleep(300);
    check("軽微4: 30分超で再取得して今日タブを再描画する", gets === 1 && (await txt(p, "#breakdown")).includes("聴く6件"), String(gets));
    await shiftVis(25 * 3600e3); await until(() => gets >= 2, 3000); await sleep(300);
    check("軽微4: 日(02:00 JST区切り)が変わっていたら30分以内でも再取得する", gets === 2, String(gets));
    await p.click("#btnListen"); await until(async () => (await spokenOf(p)).length >= 1, 3000);
    await shiftVis(40 * 60e3); await sleep(400);
    check("軽微4: 再生中(聴く画面)は再取得しない", gets === 2, String(gets));
    await s.ctx.close();
  } catch (e) { check("軽微4のテストが完走", false, e.stack); }

  // 軽微6: 「‹今日」は44px以上のタップ領域(見た目の高さは増やさない)
  try {
    const s = await open(browser, base, { path: "/index_beta.html#list", posts: [mk(1), mk(2)] });
    const p = s.page;
    const r = await p.evaluate(() => {
      const b = document.getElementById("btnBackToday"); const rc = b.getBoundingClientRect(); const cs = getComputedStyle(b, "::before");
      const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
      const hit = (dy) => { const e = document.elementFromPoint(cx, cy + dy); return e === b; };
      return { h: rc.height, ph: parseFloat(cs.height), pw: rc.width + parseFloat(cs.left || 0) * -2, up: hit(-20), down: hit(20), mid: hit(0) };
    });
    check("軽微6: 「‹今日」の見た目の高さは増えない(40px未満のまま)", r.h < 30, JSON.stringify(r));
    check("軽微6: タップ領域が44px以上(::before 44px・上下20px離れても同じボタンに当たる)", r.ph >= 44 && r.up && r.down && r.mid && r.pw >= 44, JSON.stringify(r));
    await s.ctx.close();
  } catch (e) { check("軽微6のテストが完走", false, e.stack); }

  // 軽微7: 取り消しボタンは「取り消し」(5秒の固定表記をしない)
  try {
    const s = await open(browser, base, { posts: scenario(70), speakMs: 5000, storage: INTRO });
    const p = s.page;
    await p.click("#btnListen"); await until(async () => (await spokenOf(p)).length >= 1, 3000);
    await p.click("#plReject"); await sleep(150);
    check("軽微7: 取り消しボタンの文言は「取り消し」(「(5秒)」と固定表記しない)", (await txt(p, "#plUndo")) === "取り消し", await txt(p, "#plUndo"));
    await s.ctx.close();
  } catch (e) { check("軽微7のテストが完走", false, e.stack); }

  // 軽微8: 中断中の今日タブは「続きから再生」だけを主に出し、+10分聴くは隠す
  try {
    const s = await open(browser, base, { posts: [sk(21, { score: 5 }), sk(22, { score: 4 }), sk(23, { score: 3 })], speakMs: 3000, storage: INTRO });
    const p = s.page;
    await p.click("#btnExtraToday"); await until(async () => (await spokenOf(p)).length >= 1, 3000);
    await p.click("#plExit"); await sleep(250);
    const cls = await p.evaluate(() => ({ resume: document.getElementById("btnResume").classList.contains("primary"), listen: document.getElementById("btnListen").classList.contains("primary") }));
    check("軽微8: 中断中の今日タブでは「続きから再生」が主ボタン・「+10分聴く」は隠れる", (await vis(p, "#btnResume")) && !(await vis(p, "#btnExtraToday")) && cls.resume && !cls.listen, JSON.stringify(cls));
    await p.evaluate(() => { localStorage.removeItem("xdash_listen_session"); __XD_TEST__.Beta.refreshToday(); });
    check("軽微8: 中断が片付くと「+10分聴く」がまた出る", !(await vis(p, "#btnResume")) && (await vis(p, "#btnExtraToday")));
    await s.ctx.close();
  } catch (e) { check("軽微8のテストが完走", false, e.stack); }

  // 軽微9: 「約N分」の見積もりに文間100ms・見出し/本文400msの間を加算
  try {
    const s = await open(browser, base, { posts: scenario(70), storage: { ...INTRO, xdash_listen_speed: "1.2" } });
    const p = s.page;
    const r = await p.evaluate(() => {
      const T = __XD_TEST__.Beta.computeToday(); const sp = __XD_TEST__.Beta.listenSpeed();
      let chars = 0, sent = 0, kind = 0;
      for (const x of T.listen) { const its = __XD_TEST__.Beta.cardItems(x); its.forEach((it, i) => { chars += it.text.length; sent++; if (i > 0 && it.kind !== its[i - 1].kind) kind++; }); }
      return { sec: T.listenSec, expect: chars / (6.5 * sp) + sent * 0.1 + kind * 0.4, plain: chars / (6.5 * sp), sent, kind };
    });
    check("軽微9: 聴く合計の見積もり秒 = 文字数÷(6.5×速度) + 文数×0.1 + 見出し→本文×0.4", Math.abs(r.sec - r.expect) < 1e-6 && r.sec > r.plain, JSON.stringify(r));
    await s.ctx.close();
  } catch (e) { check("軽微9のテストが完走", false, e.stack); }

  // 軽微10: refreshToday の読み上げ文は投稿ごとに1回だけ作る(二重cleanを避ける)
  try {
    const s = await open(browser, base, { posts: scenario(70), storage: INTRO });
    const p = s.page;
    const n = await p.evaluate(() => {
      const bust = allPosts.filter((x) => x.listen_tier === "listen" && !x.is_read).slice(0, 3);
      bust.forEach((x, i) => { x.speech_body = "書き換え" + i + "。" + x.speech_body; });
      let c = 0; const o = TTS.utterances; TTS.utterances = function () { c++; return o.apply(this, arguments); };
      try { __XD_TEST__.Beta.refreshToday(); const first = c; __XD_TEST__.Beta.refreshToday(); __XD_TEST__.Beta.refreshToday(); return { first, total: c, bust: bust.length }; } finally { TTS.utterances = o; }
    });
    check("軽微10: 3件だけ本文が変わった時、refreshToday を3回呼んでも読み上げ文の生成は3回だけ(キャッシュ)", n.first === 3 && n.total === 3, JSON.stringify(n));
    await s.ctx.close();
  } catch (e) { check("軽微10のテストが完走", false, e.stack); }

  // 軽微12: グローバル公開は window.__XD_TEST__ だけ、#test のハッシュがある時だけ
  try {
    const q = await open(browser, base, { path: "/index_beta.html?prod=1", posts: scenario(70) });
    const g = await q.page.evaluate(() => ({ test: typeof window.__XD_TEST__, names: ["AdminQueue", "Admin2", "Beta", "TopBand", "Tabs", "UnreadQueue", "ReadQueue", "__xdBridge"].filter((k) => k in window), tok: !!(window.AdminQueue && window.AdminQueue.getToken) }));
    check("軽微12: 通常の画面(#testなし)では __XD_TEST__ も AdminQueue 等のグローバルも公開されない", g.test === "undefined" && g.names.length === 0 && !g.tok, JSON.stringify(g));
    await q.page.click("#tabBar button[data-tab=settings]"); await sleep(300);
    await q.page.click("#tabBar button[data-tab=today]"); await sleep(100);
    check("軽微12: 公開しなくてもタブ・設定は動き、JSエラーがない", (await vis(q.page, "#btnListen")) && q.rec.errors.length === 0, JSON.stringify(q.rec.errors));
    await q.ctx.close();
    const t = await open(browser, base, { posts: scenario(70) });
    const h = await t.page.evaluate(() => ({ keys: Object.keys(window.__XD_TEST__).sort(), leaked: ["AdminQueue", "Admin2", "Beta", "TopBand", "Tabs", "UnreadQueue", "__xdBridge"].filter((k) => k in window) }));
    check("軽微12: #test の時は単一の名前空間 __XD_TEST__ にだけ公開(AdminQueue/Admin2/Beta/TopBand/Tabs/UnreadQueue/ReadQueue)", ["Admin2", "AdminQueue", "Beta", "ReadQueue", "Tabs", "TopBand", "UnreadQueue"].every((k) => h.keys.includes(k)) && h.leaked.length === 0, JSON.stringify(h));
    await t.ctx.close();
  } catch (e) { check("軽微12のテストが完走", false, e.stack); }

  await browser.close(); srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? `\n全${total}項目OK` : `\nNG ${failures}/${total}件`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
