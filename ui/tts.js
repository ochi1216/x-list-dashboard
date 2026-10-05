/*
 * tts.js - 読み上げ前処理とプレイヤー(外部依存なし)
 * ブラウザでは window.TTS、Node では module.exports。
 * 注意: 古いiOS Safariで構文エラーになるため、後読み(lookbehind)は使わない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.TTS = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 辞書 ----------
  var DICT = {
    "AI": "エーアイ", "AGI": "エージーアイ", "GPT": "ジーピーティー", "ChatGPT": "チャットジーピーティー",
    "LLM": "エルエルエム", "ML": "エムエル", "API": "エーピーアイ", "SDK": "エスディーケイ", "MCP": "エムシーピー",
    "RAG": "ラグ", "SaaS": "サース", "GaN": "ガン", "SiC": "シリコンカーバイド", "EMC": "イーエムシー",
    "EMI": "イーエムアイ", "CPU": "シーピーユー", "GPU": "ジーピーユー", "NPU": "エヌピーユー", "TPU": "ティーピーユー",
    "MCU": "エムシーユー", "SoC": "エスオーシー", "FPGA": "エフピージーエー", "ASIC": "エーシック",
    "HBM": "エイチビーエム", "DRAM": "ディーラム", "SRAM": "エスラム", "NAND": "ナンド", "SSD": "エスエスディー",
    "HDD": "エイチディーディー", "PCB": "ピーシービー", "MOSFET": "モスフェット", "IGBT": "アイジービーティー",
    "RF": "アールエフ", "LED": "エルイーディー", "OLED": "オーレッド", "LiDAR": "ライダー", "EDA": "イーディーエー",
    "TSMC": "ティーエスエムシー", "NVIDIA": "エヌビディア", "OpenAI": "オープンエーアイ", "Anthropic": "アンスロピック",
    "Claude": "クロード", "Gemini": "ジェミニ", "Google": "グーグル", "Microsoft": "マイクロソフト",
    "Apple": "アップル", "Amazon": "アマゾン", "AWS": "エーダブリューエス", "Meta": "メタ", "Tesla": "テスラ",
    "Intel": "インテル", "AMD": "エーエムディー", "Qualcomm": "クアルコム", "Samsung": "サムスン",
    "SpaceX": "スペースエックス", "xAI": "エックスエーアイ", "DeepSeek": "ディープシーク", "Llama": "ラマ",
    "Mistral": "ミストラル", "Copilot": "コパイロット", "Siri": "シリ", "TI": "ティーアイ",
    "iPhone": "アイフォーン", "iPad": "アイパッド", "iOS": "アイオーエス", "macOS": "マックオーエス",
    "Android": "アンドロイド", "Windows": "ウィンドウズ", "GitHub": "ギットハブ", "Git": "ギット",
    "YouTube": "ユーチューブ", "Twitter": "ツイッター", "Bluetooth": "ブルートゥース", "Wi-Fi": "ワイファイ",
    "IoT": "アイオーティー", "EV": "イーブイ", "PC": "ピーシー", "OS": "オーエス", "UI": "ユーアイ", "UX": "ユーエックス",
    "AR": "エーアール", "VR": "ブイアール", "DX": "ディーエックス", "USB": "ユーエスビー", "PDF": "ピーディーエフ",
    "URL": "ユーアールエル", "CEO": "シーイーオー", "CFO": "シーエフオー", "CTO": "シーティーオー",
    "IPO": "アイピーオー", "ETF": "イーティーエフ", "GDP": "ジーディーピー", "KPI": "ケーピーアイ", "ROI": "アールオーアイ",
    "ESG": "イーエスジー", "FOMC": "エフオーエムシー", "Fed": "フェド", "ECB": "イーシービー", "OK": "オーケー",
    "OFF": "オフ", "AT&T": "エーティーアンドティー", "CO2": "シーオーツー", "M&A": "エムアンドエー", "R&D": "アールアンドディー",
    "Q&A": "キューアンドエー", "B2B": "ビーツービー", "B2C": "ビーツーシー", "FAQ": "エフエーキュー", "vs": "ブイエス"
  };

  var STORAGE_KEY = "xdash_tts_dict";
  function userDict() {
    try {
      if (typeof localStorage === "undefined" || !localStorage) return null;
      var s = localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      var o = JSON.parse(s);
      return o && typeof o === "object" ? o : null;
    } catch (e) { return null; }
  }
  function extendDict(obj) {
    if (!obj || typeof obj !== "object") return DICT;
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k) && typeof obj[k] === "string") DICT[k] = obj[k];
    return DICT;
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }

  var dictCache = { sig: null, c: null };
  function compiledDict() {
    var d = {}, k, u = userDict();
    for (k in DICT) if (Object.prototype.hasOwnProperty.call(DICT, k)) d[k] = DICT[k];
    if (u) for (k in u) if (Object.prototype.hasOwnProperty.call(u, k) && typeof u[k] === "string") d[k] = u[k];
    var keys = Object.keys(d).filter(function (x) { return x && typeof d[x] === "string"; });
    var sig = keys.map(function (x) { return x + "\u0001" + d[x]; }).join("\u0002");
    if (dictCache.sig === sig) return dictCache.c;
    keys.sort(function (a, b) { return b.length - a.length; });
    var sens = [], ins = [], plain = [], map = {}, mapL = {};
    keys.forEach(function (x) {
      if (/^[A-Za-z0-9][\x20-\x7e]*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(x)) {
        if (x.length >= 4) { ins.push(esc(x)); mapL[x.toLowerCase()] = d[x]; }
        else { sens.push(esc(x)); map[x] = d[x]; }
      } else plain.push([x, d[x]]);
    });
    var mk = function (arr, flags) {
      return arr.length ? new RegExp("(^|[^A-Za-z0-9])(" + arr.join("|") + ")s?(?![A-Za-z])", flags) : null;
    };
    var c = { ins: mk(ins, "gi"), sens: mk(sens, "g"), plain: plain, map: map, mapL: mapL };
    dictCache = { sig: sig, c: c };
    return c;
  }
  function applyDict(t) {
    var c = compiledDict();
    if (c.ins) t = t.replace(c.ins, function (m, pre, key) { return pre + (c.mapL[key.toLowerCase()] || key); });
    if (c.sens) t = t.replace(c.sens, function (m, pre, key) { return pre + (c.map[key] || key); });
    c.plain.forEach(function (p) { t = t.split(p[0]).join(p[1]); });
    return t;
  }

  // ---------- 数値の読み下し ----------
  var NUM = "\\d+(?:\\.\\d+)?";
  var MAGS = { k: 3, thousand: 3, m: 6, million: 6, b: 9, billion: 9, t: 12, trillion: 12 };
  var MAG_FALLBACK = { 3: "千", 6: "百万", 9: "十億", 12: "兆" };

  function jpFromDigits(s) {
    s = s.replace(/^0+(?=\d)/, "");
    if (s.length > 20) return s;
    var groups = [];
    for (var i = s.length; i > 0; i -= 4) groups.unshift(s.slice(Math.max(0, i - 4), i));
    var units = ["", "万", "億", "兆", "京"], out = "";
    for (var j = 0; j < groups.length; j++) {
      var v = parseInt(groups[j], 10);
      if (v > 0) out += v + units[groups.length - 1 - j];
    }
    return out || "0";
  }
  // 1.5 + B → 15億 / 300 + k → 30万。割り切れなければ素直に単位語を付ける。
  function amount(numStr, mag) {
    if (!mag) return numStr;
    mag = mag.replace(/^\s+/, "");
    if (/^[万億兆]$/.test(mag)) return numStr + mag;
    var exp = MAGS[mag.length === 1 ? mag.toLowerCase() : mag.toLowerCase()];
    if (exp == null) return numStr + mag;
    var parts = numStr.split("."), frac = parts[1] || "";
    var e = exp - frac.length;
    if (e < 0) return numStr + MAG_FALLBACK[exp];
    var digits = (parts[0] + frac).replace(/^0+(?=\d)/, "");
    for (var i = 0; i < e; i++) digits += "0";
    if (digits.length <= 4) return digits;
    return jpFromDigits(digits);
  }

  var CURRENCY = { "$": "ドル", "¥": "円", "€": "ユーロ", "£": "ポンド", "₩": "ウォン", "₹": "ルピー" };
  var MAG_RE = "(\\s?(?:million|billion|trillion|thousand)\\b|[kKmMbBtT](?![A-Za-z])|[万億兆])";
  var RE_CURRENCY = new RegExp("(?:US|U\\.S\\.)?([$¥€£₩₹])\\s?(" + NUM + ")" + MAG_RE + "?", "g");
  var RE_MAG_PLAIN = new RegExp("(^|[^A-Za-z0-9.])(" + NUM + ")(\\s?(?:million|billion|trillion)\\b|k(?![A-Za-z])|[MB](?![A-Za-z]))", "g");

  var UNITS = [
    ["THz", "テラヘルツ"], ["GHz", "ギガヘルツ"], ["MHz", "メガヘルツ"], ["kHz", "キロヘルツ"], ["Hz", "ヘルツ"],
    ["TWh", "テラワット時"], ["GWh", "ギガワット時"], ["MWh", "メガワット時"], ["kWh", "キロワット時"], ["Wh", "ワット時"],
    ["TW", "テラワット"], ["GW", "ギガワット"], ["MW", "メガワット"], ["kW", "キロワット"], ["mW", "ミリワット"], ["W", "ワット"],
    ["kV", "キロボルト"], ["mV", "ミリボルト"], ["V", "ボルト"],
    ["kA", "キロアンペア"], ["mAh", "ミリアンペア時"], ["mA", "ミリアンペア"], ["Ah", "アンペア時"], ["A", "アンペア"],
    ["nm", "ナノメートル"], ["μm", "マイクロメートル"], ["mm", "ミリメートル"], ["cm", "センチメートル"],
    ["km/h", "キロメートル毎時"], ["km", "キロメートル"], ["m", "メートル"],
    ["kg", "キログラム"], ["mg", "ミリグラム"], ["g", "グラム"],
    ["TB/s", "テラバイト毎秒"], ["GB/s", "ギガバイト毎秒"], ["MB/s", "メガバイト毎秒"],
    ["TB", "テラバイト"], ["GB", "ギガバイト"], ["MB", "メガバイト"], ["kB", "キロバイト"], ["KB", "キロバイト"],
    ["Tbps", "テラビット毎秒"], ["Gbps", "ギガビット毎秒"], ["Mbps", "メガビット毎秒"], ["kbps", "キロビット毎秒"],
    ["EFLOPS", "エクサフロップス"], ["PFLOPS", "ペタフロップス"], ["TFLOPS", "テラフロップス"], ["GFLOPS", "ギガフロップス"],
    ["ns", "ナノ秒"], ["μs", "マイクロ秒"], ["ms", "ミリ秒"], ["dB", "デシベル"], ["kcal", "キロカロリー"], ["G", "ジー"]
  ];
  var UNIT_MAP = {};
  UNITS.forEach(function (u) { UNIT_MAP[u[0]] = u[1]; });
  var UNIT_KEYS = UNITS.map(function (u) { return u[0]; }).sort(function (a, b) { return b.length - a.length; });
  var RE_UNIT = new RegExp("(" + NUM + ")(\\s?)(" + UNIT_KEYS.map(esc).join("|") + ")(?![A-Za-z])", "g");
  var SINGLE_UNITS = { W: 1, V: 1, A: 1, m: 1, g: 1, G: 1 };

  function validMD(m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= 31; }

  function readNumbers(t) {
    // 桁区切りカンマ(1,200 → 1200)
    for (var i = 0; i < 4; i++) t = t.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
    // 日付
    t = t.replace(/(^|[^\d])(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?!\d)/g, function (m, pre, y, mo, d) {
      return validMD(+mo, +d) ? pre + (+mo) + "月" + (+d) + "日" : m;
    });
    t = t.replace(/(^|[^\d\/])(\d{4})\/(\d{1,2})(?![\d\/])/g, function (m, pre, y, mo) {
      return +mo >= 1 && +mo <= 12 ? pre + y + "年" + (+mo) + "月" : m;
    });
    t = t.replace(/(^|[^\d])24\/7(?![\d\/])/g, "$124時間365日");
    t = t.replace(/(^|[^\d\/.\-:])(\d{1,2})\/(\d{1,2})(?![\d\/])/g, function (m, pre, mo, d) {
      return validMD(+mo, +d) ? pre + (+mo) + "月" + (+d) + "日" : m;
    });
    // 時刻 10:30 → 10時30分
    t = t.replace(/(^|[^\d:])(\d{1,2}):(\d{2})(?![\d:])/g, function (m, pre, h, mi) {
      if (+h > 24 || +mi > 59) return m;
      return pre + (+h) + "時" + (+mi === 0 ? "" : (+mi) + "分");
    });
    // 通貨
    t = t.replace(RE_CURRENCY, function (m, sym, num, mag) { return amount(num, mag) + CURRENCY[sym]; });
    // 通貨なしの 5M / 1.5B / 10k / 3 million
    t = t.replace(RE_MAG_PLAIN, function (m, pre, num, mag) { return pre + amount(num, mag); });
    // パーセント・温度
    t = t.replace(/(\d)\s?%/g, "$1パーセント");
    t = t.replace(new RegExp("(" + NUM + ")\\s?°\\s?F", "g"), "華氏$1度");
    t = t.replace(/(\d)\s?°\s?C?/g, "$1度");
    // 単位
    t = t.replace(RE_UNIT, function (m, num, sp, unit, off, str) {
      if (sp && SINGLE_UNITS[unit]) return m;
      var prev = off > 0 ? str.charAt(off - 1) : "";
      if (/[A-Za-z]/.test(prev)) return m; // A100, H100 など型番
      if (SINGLE_UNITS[unit] && off > 1 && /[A-Za-z]-/.test(str.substr(off - 2, 2))) return m; // GPT-4V など
      return num + UNIT_MAP[unit];
    });
    // 倍・かける
    t = t.replace(/(\d)\s?[x×](?![A-Za-z0-9])/g, "$1倍");
    t = t.replace(/(\d)\s?×(?=\d)/g, "$1かける");
    return t;
  }

  // ---------- clean ----------
  var CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  var RE_EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️︎⃣\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}]/gu;
  var RE_URL = /(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]*[A-Za-z0-9\-_~\/=%#]|\b(?:[A-Za-z0-9\-]+\.)+(?:com|net|org|io|ai|dev|app|jp|co|me|ly|gl|us|uk|tv|xyz|info|biz)(?:\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]*[A-Za-z0-9\-_~\/=%#])?(?![A-Za-z0-9])/g;
  var RE_EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  var JPC = "぀-ヿ㐀-䶿一-鿿";

  function handleReading(name, names) {
    if (names) {
      var low = name.toLowerCase();
      for (var k in names) if (Object.prototype.hasOwnProperty.call(names, k) && k.replace(/^@/, "").toLowerCase() === low) return String(names[k]);
    }
    var toks = name.split("_").filter(function (x) { return /[A-Za-z]/.test(x); });
    return toks.map(function (x) { return x.replace(/(\D)\d{3,}$/, "$1"); }).join(" ");
  }

  function clean(text, opts) {
    if (text == null) return "";
    var t = String(text);
    t = t.replace(/[①-⑳]/g, function (c) { return "\n" + (CIRCLED.indexOf(c) + 1) + ". "; });
    if (t.normalize) t = t.normalize("NFKC");
    t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f ​‌⁠﻿]/g, " ");
    t = t.replace(/\r\n?|\u2028|\u2029/g, "\n");
    t = t.replace(/[’‘`´]/g, "'");

    t = t.replace(RE_URL, " ").replace(RE_EMAIL, " ").replace(RE_EMOJI, "");

    // 箇条書き・番号(括弧処理より前)
    t = t.replace(/^[ \t]*(?:[-*]\s+|・\s*)/gm, "");
    t = t.replace(/^[ \t]*\((\d{1,2})\)\s*(?=\S)/gm, "$1. ");
    t = t.replace(/(^|[。!?]\s*)[ \t]*(\d{1,2})[.)](?!\d)[ \t]*(?=\S)/gm, "$1$2件目、");
    t = t.replace(/(^|\s)(\d{1,2})\)(?=\s|[぀-ヿ一-鿿])\s*/g, "$1$2件目、");

    // 括弧内の読み飛ばし
    for (var i = 0; i < 6; i++) {
      var before = t;
      t = t.replace(/\([^()]*\)/g, "");
      if (t === before) break;
    }
    t = t.replace(/[()]/g, " ");

    // 改行 → 句点
    t = t.split("\n").map(function (l) { return l.replace(/^\s+|\s+$/g, ""); }).filter(Boolean).map(function (l) {
      return /[。!?.]$/.test(l) ? l : l + "。";
    }).join("");

    // ハッシュタグ・キャッシュタグ・@handle
    t = t.replace(/(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,30})/g, function (m, pre, name) {
      var r = handleReading(name, opts && opts.handleNames);
      return pre + (r ? r : "");
    });
    t = t.replace(/#(?=\S)/g, "").replace(/\$([A-Za-z]{1,6})(?![A-Za-z0-9])/g, "$1");

    // 数値・単位
    t = readNumbers(t);

    // 英略語辞書
    t = applyDict(t);

    // 範囲・マイナス・プラス
    t = t.replace(/(\d|[日時分年月円度倍件])(?:[-−‐‑‒–—―~〜]|\s[-−‐‑‒–—―~〜]\s)(?=\d)/g, "$1から");
    t = t.replace(/(^|[\s、。!?぀-ゟ一-鿿])[-−–]\s?(?=\d)/g, "$1マイナス");
    t = t.replace(/(^|[\s、。!?぀-ゟ一-鿿])\+(?=\d)/g, "$1プラス");
    t = t.replace(/[-−‐‑‒–~〜]/g, " ").replace(/[—―]/g, "、");

    // 記号の置換
    t = t.replace(/&/g, "アンド").replace(/=/g, "イコール").replace(/\+/g, "プラス");
    t = t.replace(/(\d+):(\d+)/g, "$1対$2");
    t = t.replace(/(\d+)\/(\d+)/g, "$2分の$1");
    t = t.replace(/[\/|]/g, "、").replace(/[:;,]/g, "、").replace(/[【「『]/g, " ").replace(/[】」』]/g, "、");
    t = t.replace(/%/g, "パーセント").replace(/°/g, "度");
    t = t.replace(/\.{2,}|…+/g, "、").replace(/!+/g, "!").replace(/\?+/g, "?").replace(/[!]/g, "！").replace(/[?]/g, "？");

    // 英語のドット(いちドット等の誤読防止): 小数点以外は句点か空白に
    t = t.replace(/\./g, function (m, off, str) {
      var p = str.charAt(off - 1), n = str.charAt(off + 1);
      if (/\d/.test(p) && /\d/.test(n)) return m;
      if (n === "" || /[\s。、！？]/.test(n)) return "。";
      return " ";
    });
    // アポストロフィは英字間のみ残す
    t = t.replace(/'(?![A-Za-z])|(^|[^A-Za-z])'/g, "$1");
    t = t.replace(/([ァ-ヶー])'s(?![A-Za-z])/g, "$1");

    // 読める文字だけを残す
    t = t.replace(/[^\p{L}\p{M}\p{N}\s。、！？.'・]/gu, " ");
    t = t.replace(/[ \t　]+/g, " ");
    // 日本語同士の空白は除くが、カタカナ同士(辞書置換語が連続する場合など)は区切りとして残す
    t = t.replace(new RegExp("([" + JPC + "])\\s+(?=[" + JPC + "])", "g"), function (m, a, off, str) {
      var b = str.charAt(off + m.length);
      return /[ァ-ヶー]/.test(a) && /[ァ-ヶー]/.test(b) ? m : a;
    });
    t = t.replace(/\s*([。、！？])\s*/g, "$1");
    t = t.replace(/、+/g, "、").replace(/[、。]*。[、。]*/g, "。").replace(/、([！？])/g, "$1").replace(/。([！？])/g, "$1");
    t = t.replace(/([！？])[、。]/g, "$1").replace(/^[。、！？\s]+/, "");
    return t.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
  }

  // ---------- split ----------
  function hardSplit(s, maxLen) {
    var out = [];
    while (s.length > maxLen) {
      var cut = s.lastIndexOf(" ", maxLen);
      if (cut < maxLen * 0.5) cut = maxLen; else cut += 0;
      out.push(s.slice(0, cut).replace(/\s+$/, ""));
      s = s.slice(cut).replace(/^\s+/, "");
    }
    if (s) out.push(s);
    return out;
  }
  function split(text, maxLen) {
    maxLen = maxLen > 0 ? maxLen : 80;
    var t = String(text == null ? "" : text);
    var sentences = t.match(/[^。！？!?\n]+[。！？!?]*|[。！？!?]+/g) || [];
    var out = [];
    sentences.forEach(function (raw) {
      var s = raw.replace(/^\s+|\s+$/g, "");
      if (!s || /^[。！？!?\s]+$/.test(s)) return;
      if (s.length <= maxLen) { out.push(s); return; }
      var pieces = s.match(/[^、,，]+[、,，]?/g) || [s];
      var cur = "";
      pieces.forEach(function (p) {
        if (p.length > maxLen) {
          if (cur) { out.push(cur); cur = ""; }
          hardSplit(p, maxLen).forEach(function (x) { out.push(x); });
        } else if ((cur + p).length > maxLen) { out.push(cur); cur = p; }
        else cur += p;
      });
      if (cur) out.push(cur);
    });
    return out.map(function (x) { return x.replace(/^\s+|\s+$/g, ""); }).filter(Boolean);
  }

  // ---------- utterances ----------
  function utterances(post, opts) {
    post = post || {};
    var maxLen = (opts && opts.maxLen) || 80;
    var out = [];
    var titleSrc = post.speech_title || post.gist;
    if (!titleSrc && !post.speech_body && !post.summary && post.content) titleSrc = String(post.content).replace(/\s+/g, " ").slice(0, 60);
    var bodySrc = post.speech_body || post.summary;
    var title = clean(titleSrc, opts);
    var body = clean(bodySrc, opts);
    if (title) split(title, maxLen).forEach(function (s) { out.push({ kind: "title", text: s }); });
    if (body) split(body, maxLen).forEach(function (s) { out.push({ kind: "body", text: s }); });
    return out;
  }

  // ---------- pickVoice ----------
  function pickVoice(voices, quality) {
    var ja = [];
    for (var i = 0; voices && i < voices.length; i++) {
      var v = voices[i];
      if (v && /^ja([-_]|$)/i.test(v.lang || "")) ja.push(v);
    }
    if (!ja.length) return null;
    var tiers = [/premium|プレミアム/i, /enhanced|拡張/i, /siri/i, /kyoko|otoya|o-ren|hattori/i, /nanami|neural|google/i];
    function score(v) {
      var n = (v.name || "") + " " + (v.voiceURI || "");
      if (/compact/i.test(n)) return -1;
      for (var k = 0; k < tiers.length; k++) if (tiers[k].test(n)) return tiers.length - k;
      return 0;
    }
    var best = null, bs = -99, i2;
    if (quality === "standard") {
      for (i2 = 0; i2 < ja.length; i2++) {
        var sc = score(ja[i2]);
        var s2 = sc <= 0 ? (ja[i2].default ? 3 : 2) + (sc < 0 ? 0 : 0.5) : 0;
        if (s2 > bs) { bs = s2; best = ja[i2]; }
      }
      return best || ja[0];
    }
    for (i2 = 0; i2 < ja.length; i2++) {
      var s3 = score(ja[i2]) + (ja[i2].default ? 0.1 : 0);
      if (s3 > bs) { bs = s3; best = ja[i2]; }
    }
    return best;
  }

  // ---------- player ----------
  function createPlayer(opts) {
    opts = opts || {};
    var synth = opts.synth || (typeof speechSynthesis !== "undefined" ? speechSynthesis : null);
    var Utter = opts.Utterance || (typeof SpeechSynthesisUtterance !== "undefined" ? SpeechSynthesisUtterance : null);
    var pauseMs = opts.pauseMs == null ? 400 : opts.pauseMs;
    var setT = opts.setTimeoutFn || function (f, ms) { return setTimeout(f, ms); };
    var clearT = opts.clearTimeoutFn || function (id) { clearTimeout(id); };
    var CANCEL_WAIT = 100, START_TIMEOUT = 3000, CPS = 6.5, MIN_FORCE = opts.minForceMs == null ? 2000 : opts.minForceMs;

    var items = [], index = 0, status = "idle", token = 0, rateOverride = null;
    var attempt = null, retried = 0, notified = -1;
    var timers = { speak: null, start: null, force: null, next: null };

    function safe(fn, a, b) { if (typeof fn !== "function") return; try { fn(a, b); } catch (e) { /* 呼び出し側の例外で再生を止めない */ } }
    function clearTimers() {
      for (var k in timers) if (timers[k] != null) { clearT(timers[k]); timers[k] = null; }
    }
    function cancelSynth() { try { if (synth) synth.cancel(); } catch (e) { /* noop */ } }
    function rate() {
      var r = rateOverride != null ? rateOverride : (typeof opts.getRate === "function" ? opts.getRate() : 1);
      r = Number(r);
      return r > 0 ? r : 1;
    }

    function attemptSpeak() {
      clearTimers();
      var tok = ++token;
      attempt = { tok: tok, started: false, done: false };
      cancelSynth();
      timers.speak = setT(function () {
        timers.speak = null;
        if (tok !== token || status !== "playing") return;
        doSpeak();
      }, CANCEL_WAIT);
    }

    function doSpeak() {
      var a = attempt, item = items[index];
      if (!synth || !Utter || !item) { stall("no-synth"); return; }
      var u = new Utter(item.text);
      u.lang = "ja-JP";
      try {
        var voice = typeof opts.getVoice === "function" ? opts.getVoice() : null;
        if (voice) u.voice = voice;
      } catch (e) { /* noop */ }
      u.rate = rate();
      var alive = function () { return a.tok === token && !a.done; };
      u.onstart = function () { if (alive()) markStarted(a, item); };
      u.onboundary = function () { if (alive()) markStarted(a, item); };
      u.onend = function () { if (alive()) { markStarted(a, item); if (alive()) finishItem(a, "end"); } };
      u.onerror = function (e) {
        if (!alive()) return;
        var err = e && e.error;
        if (err === "canceled" || err === "interrupted") return; // 自分のcancelによるもの
        failAttempt(a, err || "error");
      };
      timers.start = setT(function () {
        timers.start = null;
        if (alive() && !a.started) failAttempt(a, "no-start");
      }, START_TIMEOUT);
      try { synth.speak(u); } catch (e) { failAttempt(a, "speak-throw"); }
    }

    function markStarted(a, item) {
      if (a.started) return;
      a.started = true;
      if (timers.start != null) { clearT(timers.start); timers.start = null; }
      if (notified !== index) { notified = index; safe(opts.onItemStart, index); }
      if (a.tok !== token || a.done) return; // コールバック内でstop等された
      var ms = Math.max(item.text.length / CPS / rate() * 1000 * 2, MIN_FORCE);
      timers.force = setT(function () {
        timers.force = null;
        if (a.tok !== token || a.done) return;
        finishItem(a, "forced");
      }, ms);
    }

    function finishItem(a, why) {
      a.done = true;
      clearTimers();
      if (why === "forced") cancelSynth();
      token++; // 遅れて届く古いイベントを無効化(二重発火ガード)
      var i = index, cur = items[i];
      safe(opts.onItemEnd, i, why);
      if (status !== "playing" || index !== i) return;
      var next = i + 1;
      if (next >= items.length) { status = "idle"; safe(opts.onDone); return; }
      var nx = items[next];
      var gap = cur && nx && cur.kind !== nx.kind ? (typeof cur.pauseMs === "number" ? cur.pauseMs : pauseMs) : 0;
      index = next;
      retried = 0;
      if (gap > 0) {
        timers.next = setT(function () { timers.next = null; if (status === "playing") attemptSpeak(); }, gap);
      } else attemptSpeak();
    }

    function failAttempt(a, reason) {
      a.done = true;
      clearTimers();
      token++;
      if (reason !== "not-allowed" && retried < 1 && status === "playing") { retried++; attemptSpeak(); return; }
      stall(reason);
    }

    function stall(reason) {
      clearTimers();
      token++;
      cancelSynth();
      status = "stalled";
      safe(opts.onStall, { reason: reason, index: index });
    }

    function norm(list) {
      var out = [];
      (list || []).forEach(function (x) {
        var it = typeof x === "string" ? { kind: "body", text: x } : x;
        if (it && typeof it.text === "string" && it.text) out.push(it);
      });
      return out;
    }

    return {
      play: function (list, startIndex) {
        clearTimers(); token++;
        items = norm(list);
        index = Math.max(0, startIndex | 0);
        notified = -1; retried = 0;
        if (index >= items.length) { status = "idle"; safe(opts.onDone); return; }
        status = "playing";
        attemptSpeak();
      },
      pause: function () {
        if (status !== "playing") return;
        clearTimers(); token++; cancelSynth();
        status = "paused"; // 再開は今の文の先頭から(iOSのpause/resumeは不安定なため)
      },
      resume: function () {
        if (status !== "paused" && status !== "stalled") return;
        status = "playing"; retried = 0;
        attemptSpeak();
      },
      stop: function () {
        clearTimers(); token++; cancelSynth();
        status = "idle";
      },
      setRate: function (r) {
        r = Number(r);
        rateOverride = r > 0 ? r : null;
        if (status === "playing" && timers.next == null) { retried = 0; attemptSpeak(); }
      },
      state: function () {
        return { status: status, playing: status === "playing", index: index, total: items.length, rate: rate(), retried: retried, item: items[index] || null };
      }
    };
  }

  return { clean: clean, split: split, utterances: utterances, pickVoice: pickVoice, createPlayer: createPlayer, DICT: DICT, extendDict: extendDict };
});
