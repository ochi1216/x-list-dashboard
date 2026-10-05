// テスト用の最小TTSスタブ(本物は ui/tts.js。CONTRACT.md の TTS節と同じAPI)。
// ブラウザでは window.TTS、Nodeでは module.exports。
(function (root) {
  "use strict";
  function clean(text) {
    return String(text == null ? "" : text)
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[#＃]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function split(text, maxLen) {
    maxLen = maxLen || 80;
    const out = [];
    for (const part of String(text || "").split(/(?<=[。！？\n])/)) {
      const t = part.trim();
      if (!t) continue;
      if (t.length <= maxLen) out.push(t);
      else for (let i = 0; i < t.length; i += maxLen) out.push(t.slice(i, i + maxLen));
    }
    return out;
  }
  function utterances(post) {
    const out = [];
    const title = clean(post.speech_title || post.gist || "");
    const body = post.speech_body || post.summary || "";
    if (title) out.push({ kind: "title", text: title });
    for (const s of split(clean(body))) out.push({ kind: "body", text: s });
    return out;
  }
  function pickVoice(voices, quality) {
    const ja = (voices || []).filter((v) => /^ja/i.test(v.lang || ""));
    if (!ja.length) return null;
    if (quality === "high") { const hi = ja.find((v) => /Enhanced|Premium|Siri|Kyoko/i.test(v.name || "")); if (hi) return hi; }
    return ja[0];
  }
  function createPlayer(opts) {
    let items = [], token = 0, state = "idle", idx = -1;
    const st = opts.setTimeoutFn || setTimeout;
    const pauseMs = opts.pauseMs == null ? 400 : opts.pauseMs;
    function speak(i, tk) {
      if (tk !== token) return;
      if (i >= items.length) { state = "idle"; opts.onDone && opts.onDone(); return; }
      idx = i;
      opts.onItemStart && opts.onItemStart(i);
      const u = new opts.Utterance(items[i].text);
      u.lang = "ja-JP"; u.rate = opts.getRate ? opts.getRate() : 1;
      const v = opts.getVoice && opts.getVoice(); if (v) u.voice = v;
      let ended = false;
      u.onend = function () {
        if (ended || tk !== token) return; ended = true;
        opts.onItemEnd && opts.onItemEnd(i);
        st(function () { speak(i + 1, tk); }, pauseMs);
      };
      u.onerror = u.onend;
      opts.synth.speak(u);
    }
    return {
      play(list, start) { items = list; token++; state = "playing"; try { opts.synth.cancel(); } catch (e) {} const tk = token; st(function () { speak(start || 0, tk); }, 0); },
      pause() { state = "paused"; opts.synth.pause && opts.synth.pause(); },
      resume() { state = "playing"; opts.synth.resume && opts.synth.resume(); },
      stop() { token++; state = "idle"; try { opts.synth.cancel(); } catch (e) {} },
      setRate() {},
      state() { return { state, index: idx }; },
    };
  }
  const TTS = { clean, split, utterances, pickVoice, createPlayer, DICT: {} };
  if (typeof module !== "undefined" && module.exports) module.exports = TTS;
  if (typeof window !== "undefined") window.TTS = TTS;
})(typeof globalThis !== "undefined" ? globalThis : this);
