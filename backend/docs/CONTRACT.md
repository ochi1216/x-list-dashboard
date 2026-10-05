# 実装契約(DB・関数・設定の正)

プロジェクト: Supabase `bpdkdwtevqsqgsxlahmd`。Edge FunctionはDeno(TypeScript)。ソースの正は `backend/functions/<名前>/index.ts`。
共通部品の正は `backend/functions/_shared/*.ts`。**デプロイ時は各関数フォルダへ `_<名前>.ts` としてコピー**し、`index.ts` は `./_gemini.ts` のように相対importする(ビルド手順: `backend/build.sh`)。
共通部品は **`jsr:`/`npm:`/URL importを使わない純粋なTS**(型だけの`import type`も不可)にして、Node 22 の `node --test`(型剥がし。enum・namespace・parameter propertyは使わない、import先は `.ts` 拡張子付き)で単体テストできるようにする。外部依存は引数で注入する。`index.ts` だけが `jsr:@supabase/supabase-js@2` と `Deno.*` を使う。

## 既存(変更しない)テーブル
`x_posts`(id, list_name, author_handle, author_name, content, post_url unique, posted_at, fetched_at, is_starred, summary, summarized_at, tags, gist, is_read, image_urls text[] + 新規列)、`fetch_runs`、`digest_summaries(list_name, period_type, body jsonb, generated_at)`。
x_postsはanonが読めるが、書けるのは `is_read`/`is_starred` と RPC `mark_read(p_url, p_via)` のみ。

## x_posts 新規列(加算済み)
score, score_raw, score_kind, score_reason, cap_reason, interest, score_state(null|scored|rule|skipped|failed), scored_model, scored_at, profile_version, score_attempts, speech_title, speech_body, speech_model, speech_at, dup_key, batch_key, listen_tier(listen|skim|hold), tier_reason, tier_assigned_at, tier_initial, threshold_version, manual_action(promote|demote), manual_at, read_via(user|listen|flow|auto72h), read_at, ref_url/ref_title/ref_desc/quoted_text/ref_status/ref_summary(Phase 5・列のみ)。
score_kind の値: `duplicate|announce|ref_only|primary|news|numbers|howto|explain|opinion|none`(優先順は左から: 重複>告知宣伝>参照のみ>一次情報>新発表>数値・比較>手順・実践>解説>意見・感想)。

## 基盤テーブル(RLS有効・anon不可・サービスロールのみ)
tuning_config(key,value jsonb,note,updated_at,updated_by) / tuning_config_history / admin_auth(salt,hash,iterations,key_version,failed_count,last_failed_at,setup_done,setup_code_hash,setup_code_expires_at,set_at) / ops_events / pipeline_lock / model_state / model_config(model,gen_config jsonb,enabled,note,verified_at) / llm_prices / llm_usage(called_at,batch_id,fn,purpose,grp,model,prompt_tokens,output_tokens,thoughts_tokens,cost_usd,in_price,out_price,status,http_status,latency_ms,attempt,error,post_url) / llm_cost_monthly / score_runs(post_url,purpose,attempt,model,profile_version,prompt_version,score_raw,kind,interest,reason,evidence,usage_id) / post_scores / tier_batches / score_labels(list_no,slot,post_url,author_handle,content,summary,image_urls jsonb,inclusion_prob,ai_score,ai_kind,ai_model,profile_version,label_score,label_class,labeled_at,repeat_of) / admin_ops(op_id,kind,at,result)。

## RPC(サービスロールのみ。Edge Functionから `supabase.rpc(name, args)`)
- `get_secret(p_name)` / `set_secret(p_name,p_value)`: Vault。名前は `xd_` 始まりのみ。使う名前: `xd_pipeline_secret_cron`, `xd_pipeline_secret_win`, `xd_admin_token_key`, `xd_ntfy_topic`, `xd_healthcheck_daily_url`, `xd_healthcheck_weekly_url`, `xd_anon_jwt`。
- `cfg(key,default)` jsonb / `cfg_num` / `cfg_bool`。
- `get_model_state()` → `{current_model, candidates[], gone_streak, configs:{<model>:{gen_config,enabled,in_usd,out_usd}}, usd_jpy}`
- `model_report_gone(p_model,p_reason)` → `{current_model,switched,streak}`(連続3回でenabledな次候補へ切替) / `model_report_ok(p_model)` / `model_set_current(p_model,p_reason)`
- `cost_guard(p_purpose,p_grp)` → `{allowed,level,month_jpy,day_jpy,cap_jpy,calls_1h}`。purpose: summary|score|rescore|speech|digest|digest24|digest7|proposal|ref|probe。grp: x|ti。
- `ops_event(level,kind,message,data,dedupe_minutes)`、`lock_acquire(name,seconds,owner)` boolean / `lock_release(name,owner)`
- `finalize_tiers(p_force)` → `{batches:[{batch,slot,n,listen,skim,hold,alloc_sec,used_sec,forced}]}` / `tier_maintenance()` / `snapshot_post_scores()`
- `refresh_cost_monthly(month,finalize)`、`notify_ops()`、`notify_test()`、`ping_healthcheck(kind)`、`cost_watch()`、`ops_bootstrap()`
anon可能なRPC: `mark_read(p_url,p_via)` のみ。

## 設定キー(tuning_config)
usd_jpy, monthly_cap_jpy, daily_cap_jpy, hourly_call_cap, cap_warn_ratio, cap_stop_extra_ratio, cap_stop_all_ratio, ti_daily_call_cap, pipeline_auth_mode("log"|"enforce"), kill_switch, score_enabled, tier_assign_enabled, auto_expire_enabled, auto_expire_max_per_run, listen_threshold(4), threshold_version, listen_quota_min(10), listen_chars_per_sec(6.5), listen_speed(1.2), listen_morning_share(0.6), batch_gap_minutes, batch_quiet_minutes, batch_confirm_hours, expire_listen_hours, expire_flow_hours, cap_opinion, backfill_enabled, speech_enabled, speech_max_per_run, digest_min_interval_hours, digest_min_new_scored, ref_enabled, tier_scope_from(ISO文字列), score_backfill_from(ISO文字列), interest_profile(`{"version":n,"status":"draft|approved","text":"..."}`)。値はjsonb(数値は数値、真偽は真偽、文字列は文字列)。

## 共通Gemini呼び出し(`_shared/gemini.ts`)
```ts
export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
export interface GeminiDb { rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
                            insertUsage(row: Record<string, unknown>): Promise<number | null>; }   // llm_usageへINSERTしidを返す
export interface GeminiCtx { db: GeminiDb; apiKey: string; fn: string; grp: "x" | "ti"; batchId: string;
                             fetchFn?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; }
export interface GeminiRequest { purpose: string; parts: GeminiPart[]; schema?: Record<string, unknown>; // responseSchema(JSON応答時)
                                 maxOutputTokens: number;   // 必須
                                 temperature?: number; seed?: number; postUrl?: string; }
export type GeminiResult =
  | { ok: true; text: string; json: unknown | null; model: string; usageId: number | null;
      usage: { prompt: number; output: number; thoughts: number; costUsd: number | null } }
  | { ok: false; kind: "guard" | "gone" | "http" | "empty" | "parse" | "network"; error: string; status?: number; model?: string; level?: string };
export async function callGemini(ctx: GeminiCtx, req: GeminiRequest): Promise<GeminiResult>;
```
挙動: ①`get_model_state`(30秒キャッシュ)で現在モデルと設定 ②`cost_guard`(拒否なら即`kind:"guard"`) ③`x-goog-api-key`ヘッダ(URLにキーを載せない)で `…/models/<model>:generateContent` へPOST。`generationConfig` = `{responseMimeType:"application/json", responseSchema}`(schema有り時)+`maxOutputTokens`+ モデル設定 `gen_config.default` と `gen_config[purpose]`(thinkingConfig/temperature/seed等)をマージ。④応答は思考part(`thought:true`)を除いた全textを結合。`usageMetadata`(promptTokenCount/candidatesTokenCount/thoughtsTokenCount)から費用=(prompt×in+(output+thoughts)×out)/1e6を計算し、**成功・失敗を問わず**`llm_usage`へ1呼び出し1行(status ok|error|unpriced|no_usage)。⑤429/500/503は1.5秒後に1回だけ再試行(再試行も別行で記録、attempt=2)。⑥「提供終了」判定(HTTP 404、または400/410で本文が not found|no longer|deprecated|retired|decommission|discontinued に一致)は`model_report_gone`を呼び、`switched`なら新モデルで同じ要求を1回だけ再実行。⑦成功したら`model_report_ok`。⑧例外・エラー本文はAPIキー(`AIza...`)や`key=`を含めず、先頭200字に丸めて返す(`sanitize`)。

## 認証(`_shared/auth.ts`)
`checkPipelineAuth(req, {db, mode, allow})` → `{caller:"cron"|"win"|"none", ok:boolean}`。ヘッダ `x-pipeline-secret` を Vault の `xd_pipeline_secret_cron`(全関数可)/`xd_pipeline_secret_win`(summarize-x-postのみ)と定数時間比較。`none` は mode=log のとき制限付きで許可(limit≤60、post_url指定不可)し`ops_event('warn','unauth_call',…,dedupe 360分)`、mode=enforceなら401。新関数(score-x-posts, model-health, generate-digest-summaryの新モード)は `allow:["cron"]` 固定で mode に関わらず必須。

## Edge Function 一覧
| 関数 | verify_jwt | 役割 |
|---|---|---|
| summarize-x-post | true(現状維持) | 要約のみ(従来仕様: `gist is null` が未処理)。共通部品・ロック・100秒の時間予算・並列4。 |
| score-x-posts | true | 採点・読み下し・`finalize_tiers`の起動。cron専用(秘密必須)。 |
| generate-digest-summary | true | 旧3モード(last_run/24h/7d)を維持+新モード `today`/`week`。 |
| admin-api | true | 管理(setup/login/ラベル/区分変更/設定/レポート/費用/通知)。ブラウザからは `Authorization: Bearer <anon>`+`apikey`+`x-admin-token`。CORS(OPTIONS)対応。 |
| model-health | true | 毎日: 現行・候補モデルの提供確認(モデル一覧+probe呼び出し)。プローブ(予行演習)もここ。cron専用。 |
| summarize-ti-news / -headline / -lesson | true | 共通部品へ差し替え(grp="ti")。挙動は変えない。 |

## 時間・制約
Edge Function実行は約150秒が上限 → 各処理は100秒の時間予算で打ち切り、残りは次のtick(5分ごと)が拾う。二重処理は `lock_acquire`(関数名、170秒、owner=batchId)。

## 追加テーブル(migration 003で作成。サービスロール専用。ただし digest_daily / digest_week は匿名の読み取りのみ許可)
- `digest_daily(day date primary key /*JSTの02:00区切りの日*/, generated_at timestamptz, model text, status text /*ok|empty|failed|paused*/, topics jsonb, input_count int, dropped_ratio numeric, version int)`
  topics = `[{ "headline": "20字", "summary": "2文120字", "new_facts": ["..."], "card_urls": ["post_url",...], "is_followup": false }]`(最大4件)。anon SELECT可。
- `digest_week(week_start date primary key, generated_at timestamptz, status text, themes jsonb, days_covered int)`。themes = `[{ "title","summary","day_refs":["2026-10-05",...] }]`(2〜3件)。anon SELECT可。
- `weekly_reports(week_start date primary key, generated_at, body jsonb, text_ja text)`、`author_weekly`(週×投稿者の集計)は管理API経由でのみ読める。

## admin-api(`POST {action,...}` → JSON `{ok:boolean, ...}`。エラーは `{ok:false,error:"コード"}`)
認証以外は `x-admin-token` 必須。応答に `token`(更新済み)が付く場合は端末が置き換える。失敗は429で待ち時間を返す。
- `setup {setup_code, passphrase}` → `{ok, token}`(passphrase 12字以上)/ `login {passphrase}` → `{ok, token}` / `me` → `{ok, setup_done, key_version}` / `change_passphrase {old, new}`
- `tier_set {op_id, post_url, how:"promote"|"demote"}`: promote=listen_tier→listen(manual_action=promote, manual_at=now, tier_reason=manual_promote, tier_assigned_at=now)、demote=listen_tier→hold+is_read=true+read_via=user(manual_action=demote)。`op_id`で冪等(admin_ops)。→ `{ok, duplicate?:true}`
- `label_create {n?:20}` → `{ok, list_no, created}`(層化+一様ランダム) / `label_next {list_no?}` → `{ok, list_no, items:[{id, content, summary, image_urls}], remaining, total}`(盲検: AI点・投稿者名は返さない) / `label_submit {op_id, id, score:1-5, cls:"announce"|"ref_only"|"opinion"|"other"}` → `{ok, remaining}`
- `week_report {week_start?}` → `{ok, week_start, text_ja, body}`(無ければ `{ok:true, empty:true}`) / `authors {weeks?:4}` → `{ok, rows:[{author_handle, author_name, n, low_n, high_n, low_rate, high_rate, low_lo, high_hi, mean, verdict:"exclude_candidate"|"keep"|"hold"}]}`
- `cost_summary` → `{ok, today_jpy, this_month:{jpy, usd, calls, forecast_jpy, by_model:[{model,jpy,calls}], by_purpose:[{purpose,jpy,calls}], by_grp:[{grp,jpy}]}, last_month:{jpy,usd,calls}|null, months:[{month,jpy,usd,finalized}], guard, model_state:{current_model,candidates,last_switch_at}, recent_errors:[{at,fn,purpose,model,status,error}]}`
- `config_get` → `{ok, config:{key:value}}`(許可キーのみ) / `config_set {key, value, passphrase?}`: 許可リストと値域を検査。monthly_cap_jpy・daily_cap_jpy・pipeline_auth_mode・kill_switch・ntfy関連はpassphrase再入力必須。履歴を`tuning_config_history`に記録 → `{ok}` / `config_undo {history_id}`
- `notify_info` → `{ok, topic, configured:boolean, events:[{at,level,kind,message,suppressed}]}` / `notify_test` → `{ok}` / `set_healthcheck {kind:"daily"|"weekly", url, passphrase}`
- `profile_get` → `{ok, version, status, text}` / `profile_set {text, approve:boolean, passphrase}`(版を+1、approve時のみstatus=approved)
- `ops_events {limit?:50}` → `{ok, events:[...]}`

## TTS(`ui/tts.js` → ビルド時に `index_beta.html` の `/*TTS:BEGIN*/…/*TTS:END*/` へ展開。ブラウザでは `window.TTS`、Nodeでは `module.exports`)
```js
TTS.clean(text): string                 // URL・絵文字・#・記号の除去/置換、@handle→読める表示名、「1.」→「1件目」、改行→句点、括弧内の読み飛ばし、数字・単位・通貨・日付・%の読み下し($300→300ドル、3.5%→3.5パーセント、2026/10/9→10月9日)、英略語辞書TTS.DICT(GPT→ジーピーティー等。localStorageのxdash_tts_dictで追加可)
TTS.split(text, maxLen=80): string[]    // 文単位(。！？改行)。長文は句読点で再分割
TTS.utterances(post): {kind:"title"|"body", text}[]   // post.speech_title/speech_body があればそれを(検査後)使い、無ければ gist/summary を clean+split。title→body の間は呼び出し側が pauseMs(400)を入れる
TTS.pickVoice(voices, quality /*"high"|"standard"*/): SpeechSynthesisVoice|null   // 姉妹pickJaVoice相当: ja-JPのうち Enhanced/Premium/Siri/Kyoko 等の高品質を優先、無ければ標準
TTS.createPlayer(opts): { play(items, startIndex=0), pause(), resume(), stop(), setRate(r), state() }
   // opts: { synth, Utterance, getVoice(), getRate(), pauseMs=400, onItemStart(i), onItemEnd(i), onDone(), onStall({reason,index}), setTimeoutFn, clearTimeoutFn, now }
   // iOS対策: cancel→100ms待ってspeak、発話開始が3秒なければ1回再試行、想定時間(文字数/6.5/rate)の2倍で次へ強制移動、onerror・二重発火ガード、速度変更は今の文から再開、停止時はonStall
```
