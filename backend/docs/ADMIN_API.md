# admin-api リクエスト/レスポンス(実装の正)

`POST` のみ。ブラウザは `Authorization: Bearer <anon>` + `apikey` + `x-admin-token` を付ける。CORS: `Access-Control-Allow-Origin: *`、許可ヘッダ `authorization, apikey, x-admin-token, content-type, x-client-info`、`OPTIONS` は 204。
本文は `{action, ...}`(64KB以内)。応答は常に `{ok:boolean, ...}`。失敗は `{ok:false, error:"コード", ...}`。
ソース: `functions/admin-api/index.ts`(薄い層)、`logic.ts`(分岐。Nodeでテスト)、`functions/_shared/adminauth.ts`(認証部品)。

## 共通
- 認証前: `setup` / `login` / `me`。それ以外は `x-admin-token` 必須(無し・改ざん・期限切れ・鍵版違い → 401 `invalid_token`、setup未完了 → 401 `setup_required`)。
- **トークン更新**: 成功応答に `token` が付いたら端末は置き換える(残り29日未満のとき。`change_passphrase` は常に新トークン)。
- **待ち時間**: パスフレーズ(または setup コード)の失敗が5回以上で `2^(n-5)` 分(上限15分)。待ち中の `login` / setup / パスフレーズ再入力は **429** `{error:"rate_limited", retry_after:秒}`(`Retry-After` ヘッダ付き)。正解でも待ち中は429。成功で失敗回数を0に戻す。**発行済みトークンは待ち中も有効**。n回目の失敗で待ちに入った場合、その401にも `retry_after` が付く。
- **passphrase再入力**: 要求項目は `passphrase`。無し → 400 `passphrase_required`、誤り → 401 `bad_passphrase`(失敗に数える)。
- **op_id 冪等**: `admin_ops` に記録。同じ `op_id` の再送は `{ok:true, duplicate:true}`(`label_submit` は `remaining` も付く)。失敗した操作の `op_id` は解放され再送できる。
- 500: `{ok:false,error:"server_error"}`(原因は返さない・ログにも詳細を出さない)。鍵が読めない場合 503 `server_not_ready`。
- エラーコード: `bad_request, unknown_action, invalid_token, setup_required, setup_done, setup_unavailable, setup_code_invalid, setup_code_expired, passphrase_too_short, invalid_passphrase, passphrase_required, bad_passphrase, rate_limited, op_id_required, not_found, key_not_allowed, invalid_value, cannot_undo, not_configured, server_error`。

## 認証
| action | リクエスト | 応答 |
|---|---|---|
| `setup` | `{setup_code, passphrase}`(コードは大文字小文字・ハイフン有無を許容。passphrase 12字以上) | `{ok, token}`。期限切れ 400 `setup_code_expired`、不一致 401 `setup_code_invalid`、済 409 `setup_done` |
| `login` | `{passphrase}` | `{ok, token}` |
| `me` | `{}`(トークン任意) | 認証済み `{ok, authed:true, setup_done:true, key_version, token?}` / 未認証 `{ok, authed:false, setup_done}`(401にしない) |
| `change_passphrase` | `{old, new}` | `{ok, token, key_version}`。`key_version`+1で他端末のトークンは失効 |

## 区分・ラベル
| action | リクエスト | 応答 |
|---|---|---|
| `tier_set` | `{op_id, post_url, how:"promote"\|"demote"}` | `{ok}` / `{ok, duplicate:true}` / 404 `not_found`。promote: `listen_tier=listen, manual_action=promote, manual_at, tier_reason=manual_promote, tier_assigned_at`。demote: `listen_tier=hold, is_read=true, read_via=user, read_at, manual_action=demote, manual_at, tier_reason=manual_demote, tier_assigned_at` |
| `label_create` | `{n?:20}`(1〜100) | `{ok, list_no, created}`(SQL `create_label_list(p_n)` の戻り) |
| `label_next` | `{list_no?}`(省略=最新list) | `{ok, list_no, items:[{id, content, summary, image_urls:string[]}], remaining, total}`。**未回答の全件**を、idのハッシュ順(枠の並びが推測できない順)で返す。AI点・投稿者・枠・post_url は返さない。listが無ければ `list_no:null, items:[]` |
| `label_submit` | `{op_id, id, score:1-5, cls:"announce"\|"ref_only"\|"opinion"\|"other"}` | `{ok, remaining}` / `{ok, duplicate:true, remaining}` |

## レポート・費用
| action | リクエスト | 応答 |
|---|---|---|
| `week_report` | `{week_start?:"YYYY-MM-DD"}`(省略=最新) | `{ok, week_start, text_ja, body}` / `{ok:true, empty:true}` |
| `authors` | `{weeks?:4}`(1〜52) | `{ok, rows:[{author_handle, author_name, n, low_n, high_n, low_rate, high_rate, low_lo, high_hi, mean, verdict}]}`(SQL `author_scoreboard(p_weeks)` の行配列から該当列だけ) |
| `cost_summary` | `{}` | 下記 |

`cost_summary` 応答: `{ok, today_jpy, this_month:{jpy, usd, calls, forecast_jpy, by_model:[{model,jpy,calls}], by_purpose:[{purpose,jpy,calls}], by_grp:[{grp,jpy}]}, last_month:{jpy,usd,calls}|null, months:[{month:"YYYY-MM",jpy,usd,finalized}](最大13), guard, model_state:{current_model,candidates,last_switch_at}, recent_errors:[{at,fn,purpose,model,status,error}](10件。errorはURL・キーを伏せ120字)}`。
- 集計元は `llm_cost_monthly`(呼び出し時に `refresh_cost_monthly(null,false)` で当月を最新化。失敗しても続行)。`this_month`/`by_*` は **X系+TI系の合計**、`guard`・`today_jpy` は X系のみ。
- `today_jpy` は `cost_guard('summary','x').day_jpy` = **直近24時間**(X系)。
- `forecast_jpy` = 今月の実績 ÷ 経過日数 × 月日数(JST、経過日数は最低1日)。
- `guard` = `cost_guard('summary','x')` の戻りそのまま。

## 設定
| action | リクエスト | 応答 |
|---|---|---|
| `config_get` | `{}` | `{ok, config:{key:value}, protected:[key...]}`(許可キー+`threshold_version`(読取のみ)。`interest_profile`は含めない) |
| `config_set` | `{key, value, passphrase?}` | `{ok, history_id}` / `{ok, unchanged:true}`(同値)。許可外 400 `key_not_allowed`、値域外/型違い 400 `invalid_value` |
| `config_undo` | `{history_id, passphrase?}` | `{ok, history_id, key, value}`。旧値(`old_value`)へ戻し、`source="undo:<id>"`で履歴にも残す。旧値なし/値域外は 400 `cannot_undo` |

履歴は `tuning_config_history(key, old_value, new_value, source)`。`config_set` の source は `"admin"`。

許可キーと値域(値の型は厳密: 数値は数値・真偽は真偽・文字列は文字列)。`*` は passphrase 再入力必須。
- 費用: `monthly_cap_jpy*` 整数100〜50000 / `daily_cap_jpy*` 整数50〜5000 / `hourly_call_cap*` 整数50〜5000 / `ti_daily_call_cap*` 整数10〜5000 / `cap_warn_ratio*` 0.3〜1 / `cap_stop_extra_ratio*` 0.5〜3 / `cap_stop_all_ratio*` 1〜5 / `usd_jpy` 50〜500
- 安全: `pipeline_auth_mode*` `"log"|"enforce"` / `kill_switch*` `auto_expire_enabled*`(bool) / `auto_expire_max_per_run` 整数1〜2000
- 機能スイッチ(bool): `score_enabled, tier_assign_enabled, cap_opinion, backfill_enabled, speech_enabled`
- 聴く: `listen_threshold` 整数3〜5 / `listen_quota_min` 整数1〜60 / `listen_chars_per_sec` 3〜15 / `listen_speed` 0.5〜3 / `listen_morning_share` 0.1〜0.9
- バッチ・期限: `batch_gap_minutes` 整数10〜600 / `batch_quiet_minutes` 5〜120 / `batch_confirm_hours` 1〜24 / `expire_listen_hours` 1〜168 / `expire_flow_hours` 1〜336 / `speech_max_per_run` 1〜100 / `digest_min_interval_hours` 1〜48 / `digest_min_new_scored` 1〜100
- 日時(ISO文字列): `tier_scope_from`, `score_backfill_from`
- 設定不可: `interest_profile`(profile_set 経由)、`threshold_version`、`ref_enabled`(Phase 5)

## 通知・プロファイル・運用
| action | リクエスト | 応答 |
|---|---|---|
| `notify_info` | `{}` | `{ok, topic, configured, events:[{at,level,kind,message,suppressed}](20件)}`。`topic` は設定画面表示用(契約どおり) |
| `notify_test` | `{}` | `{ok}` / 400 `not_configured`(トピック未設定) |
| `set_healthcheck` | `{kind:"daily"\|"weekly", url, passphrase}` | `{ok}`。url は `https://` のみ(空文字=削除)。Vault `xd_healthcheck_<kind>_url` へ。ops_event にURLは残さない |
| `profile_get` | `{}` | `{ok, version, status:"draft"\|"approved", text}`(未設定は 0/draft/"") |
| `profile_set` | `{text, approve:boolean, passphrase}` | `{ok, version, status}`。text は trim 後 1〜600字。版を+1。approve=true のときだけ approved。履歴は `tuning_config_history`(key=interest_profile) |
| `ops_events` | `{limit?:50}`(最大200) | `{ok, events:[{id,at,level,kind,message,suppressed}]}`(新しい順。`data` は返さない) |

## SQL側に必要な関数(別担当)
- `create_label_list(p_n int)` → `{list_no, created}`(1行のテーブルでも jsonb でも可)
- `author_scoreboard(p_weeks int)` → 行の配列(列: author_handle, author_name, n, low_n, high_n, low_rate, high_rate, low_lo, high_hi, mean, verdict)
- 既存の `get_secret/set_secret/cost_guard/get_model_state/refresh_cost_monthly/notify_test/ops_event(p_level,p_kind,p_message,p_data,p_dedupe_minutes)` を使用。`weekly_reports(week_start, body, text_ja)` を直接参照。
