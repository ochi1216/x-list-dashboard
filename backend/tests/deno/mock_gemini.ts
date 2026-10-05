// Gemini API のモック(結合試験用)。
//   POST /v1beta/models/<model>:generateContent   GET /v1beta/models   GET /files/<name>(TIの字幕取得の代用)
// 応答は responseSchema の項目名から決める(要約・採点・読み下し・probe・今日の要点・今週の流れ・旧ダイジェスト・TI)。
// 認証は x-goog-api-key ヘッダのみ受け付ける(URLの key= は拒否して記録する)。

// deno-lint-ignore no-explicit-any
type Any = any;

export interface GeminiCall {
  model: string;
  url: string;
  headers: Record<string, string>;
  body: Any;
  status: number;
}

export class MockGemini {
  apiKey = "AIzaSyTEST_KEY_1234567890abcdefghijklmnopqrstuv";
  calls: GeminiCall[] = [];
  listCalls = 0;
  urlKeyLeaks = 0; // URLに key= が付いていた回数(あってはならない)
  // 常に失敗させるモデル(404など) と 次のN回だけ失敗させる応答
  modelStatus = new Map<string, number>();
  failNext: { status: number; body: string }[] = [];
  listedModels: string[] = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-flash"];
  todayHallucinate = false;
  usage = { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 0 };
  includeUsage = true;
  delayMs = 0;
  server!: Deno.HttpServer;
  url = "";

  start(): void {
    this.server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => this.handle(req));
    this.url = `http://127.0.0.1:${(this.server.addr as Deno.NetAddr).port}`;
  }
  async stop(): Promise<void> {
    await this.server.shutdown();
  }
  reset(): void {
    this.calls = [];
    this.listCalls = 0;
    this.urlKeyLeaks = 0;
    this.modelStatus.clear();
    this.failNext = [];
    this.listedModels = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-3.1-flash"];
    this.todayHallucinate = false;
    this.includeUsage = true;
    this.delayMs = 0;
  }

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.search.toLowerCase().includes("key=")) this.urlKeyLeaks++;
    const sent = req.headers.get("x-goog-api-key");
    if (u.pathname.startsWith("/img/")) {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      return new Response(png, { headers: { "Content-Type": "image/png" } });
    }
    if (u.pathname.startsWith("/files/")) {
      return new Response("WEBVTT\n\nこれは字幕のテキストです。", { headers: { "Content-Type": "text/plain" } });
    }
    if (sent !== this.apiKey) {
      return Response.json({ error: { code: 403, message: `API key not valid (${sent ?? "missing"})` } }, { status: 403 });
    }
    if (req.method === "GET" && u.pathname === "/v1beta/models") {
      this.listCalls++;
      return Response.json({ models: this.listedModels.map((m) => ({ name: `models/${m}` })) });
    }
    const m = u.pathname.match(/^\/v1beta\/models\/([^:]+):generateContent$/);
    if (!m || req.method !== "POST") return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
    const model = decodeURIComponent(m[1]);
    const body = await req.json();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const call: GeminiCall = { model, url: req.url, headers, body, status: 200 };
    this.calls.push(call);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));

    const fail = this.failNext.shift();
    if (fail) {
      call.status = fail.status;
      return new Response(fail.body, { status: fail.status, headers: { "Content-Type": "application/json" } });
    }
    const ms = this.modelStatus.get(model);
    if (ms) {
      call.status = ms;
      return Response.json({ error: { code: ms, message: `models/${model} is not found for API version v1beta` } }, { status: ms });
    }
    const out = this.answer(body);
    const resp: Any = { candidates: [{ content: { parts: [{ text: out }], role: "model" }, finishReason: "STOP" }] };
    if (this.includeUsage) resp.usageMetadata = this.usage;
    return Response.json(resp);
  }

  private answer(body: Any): string {
    const prompt: string = body?.contents?.[0]?.parts?.map((p: Any) => p.text ?? "").join("\n") ?? "";
    const schema = body?.generationConfig?.responseSchema;
    const props = Object.keys(schema?.properties ?? {});
    const has = (...k: string[]) => k.every((x) => props.includes(x));
    if (!schema) return "■ タイトル：テスト講座\n■ 要旨：テストの要約です\n■ 要約終了";
    if (has("gist", "summary")) {
      const text = (prompt.match(/本文:\n([\s\S]*)$/)?.[1] ?? prompt).trim();
      return JSON.stringify({ gist: `要旨:${text.slice(0, 12)}`, summary: `${text.slice(0, 30)}という話です。` });
    }
    if (has("kind", "evidence", "score")) {
      const text = (prompt.match(/<post>\n([\s\S]*?)\n<\/post>/)?.[1] ?? "").trim();
      const sc = Number(text.match(/SCORE=(\d)/)?.[1] ?? 3);
      return JSON.stringify({ kind: "news", evidence: text.slice(0, 12), score: sc, interest: "W1", reason: "テスト理由" });
    }
    if (has("score", "kind", "reason")) return JSON.stringify({ score: 3, kind: "news", reason: "テスト" });
    if (has("speech_title", "speech_body")) return JSON.stringify({ speech_title: "読み下し見出し", speech_body: "要点を読み上げます。" });
    if (has("ok", "msg")) return JSON.stringify({ ok: true, msg: "こんにちは" });
    if (has("topics")) {
      const cards = [...prompt.matchAll(/URL: (\S+)\n要旨: (.*)\n要約: (.*)\n本文: (.*)/g)];
      const topics = cards.slice(0, 2).map((c) => ({
        headline: c[4].replace(/\s+/g, "").slice(0, 12), summary: `${c[4].slice(0, 20)}という話です。`,
        new_facts: [], card_urls: [c[1]], is_followup: false,
      }));
      if (this.todayHallucinate && cards.length > 0) {
        topics.push({ headline: "GPT-9が発表された", summary: "GPT-9が発表されました。", new_facts: [], card_urls: [cards[0][1]], is_followup: false });
      }
      return JSON.stringify({ topics });
    }
    if (has("themes")) {
      const days = [...prompt.matchAll(/^## (\d{4}-\d{2}-\d{2})\n- ([^:\n]+): ([^\n]+)/gm)];
      const first = days[0];
      return JSON.stringify({
        themes: first ? [{ title: first[2].slice(0, 15), summary: first[3].split("。")[0] + "。", day_refs: days.map((d) => d[1]) }] : [],
      });
    }
    if (has("highlights", "new_terms")) return JSON.stringify({ highlights: [{ author_handle: "@a", text: "見出し" }], new_terms: ["語"] });
    if (has("trend", "advice")) return JSON.stringify({ trend: "傾向です。", advice: "助言です。" });
    if (has("summary", "advice")) return JSON.stringify({ summary: "総括です。", advice: "提案です。" });
    if (has("bullets")) return JSON.stringify({ bullets: ["一行目", "二行目", "三行目"] });
    return "{}";
  }
}
