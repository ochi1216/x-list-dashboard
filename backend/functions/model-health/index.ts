import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkPipelineAuth } from "./_auth.ts";
import { runHealth, runRehearse, sanitize } from "./logic.ts";
import type { HealthDeps } from "./logic.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const rpc = async (name: string, args?: Record<string, unknown>) => {
    const r = await supabase.rpc(name, args ?? {});
    return { data: r.data as unknown, error: r.error ? { message: r.error.message } : null };
  };

  // cron専用: mode に関わらず秘密必須
  const auth = await checkPipelineAuth(req, { db: { rpc }, mode: "enforce", allow: ["cron"], fn: "model-health" });
  if (!auth.ok) return json({ ok: false, error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ ok: false, error: "GEMINI_API_KEY secret is not set on this Supabase project." }, 500);

  let body: { action?: string; model?: string; n?: number; commit?: boolean };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const deps: HealthDeps = {
    rpc,
    insertUsage: async (row) => {
      const r = await supabase.from("llm_usage").insert(row).select("id").single();
      const id = r?.data?.id;
      return id == null ? null : Number(id);
    },
    fetchFn: fetch,
    apiKey,
    now: () => Date.now(),
    batchId: `model-health-${crypto.randomUUID()}`,
    saveHealth: async (health, atIso) => {
      const { error } = await supabase
        .from("model_state")
        .update({ last_health: health, last_health_at: atIso })
        .eq("id", 1);
      if (error) throw new Error(error.message);
    },
    loadRecentPosts: async (n) => {
      const { data, error } = await supabase
        .from("x_posts")
        .select("content, image_urls")
        .not("content", "is", null)
        .order("fetched_at", { ascending: false })
        .limit(n * 2); // 本文が空の投稿を除いた後でn件に近づけるため多めに取得
      if (error) throw new Error(error.message);
      return (data ?? []).filter((p) => (p.content ?? "").trim().length > 0).slice(0, n);
    },
    commitConfig: async (model, genConfig, atIso) => {
      const { error } = await supabase
        .from("model_config")
        .upsert({ model, gen_config: genConfig, enabled: true, verified_at: atIso, updated_at: atIso }, { onConflict: "model" });
      if (error) throw new Error(error.message);
    },
  };

  try {
    if (body.action === "rehearse") {
      const result = await runRehearse(deps, {
        model: String(body.model ?? ""),
        n: typeof body.n === "number" ? body.n : 20,
        commit: body.commit === true,
      });
      return json(result, result.ok ? 200 : 400);
    }
    if (body.action !== undefined && body.action !== "health") {
      return json({ ok: false, error: "unknown action" }, 400);
    }
    const result = await runHealth(deps);
    return json(result, result.ok ? 200 : 500);
  } catch (err) {
    console.error("model-health error:", sanitize(err, apiKey));
    return json({ ok: false, error: sanitize(err, apiKey) }, 500);
  }
});
