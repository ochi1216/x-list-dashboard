# 運用手順(障害時・設定変更)

## 止める・戻す
- 全LLM呼び出しを止める: `update tuning_config set value='true'::jsonb where key='kill_switch';`(画面の設定タブからも可。解除は false)。
- 採点・区分だけ止める: `score_enabled` / `tier_assign_enabled` を false。
- 自動既読化: `auto_expire_enabled`(暫定中は false。本番化は答え合わせ60件の後)。
- 旧版へ戻す: `backend/legacy/*.ts` をそのまま再デプロイ(summarize-x-post=v7, generate-digest-summary=v1, TI系=各最新)。新cronは `select cron.unschedule('x_tick');` 等で停止(旧cron jobid 5〜8は残してある)。
- DBの退避: スキーマ `backup_20261005` に x_posts / fetch_runs / digest_summaries / cron定義の写し。

## モデル切替
- 現行は `model_state.current_model`。提供終了(404等)を連続3回検知すると、`model_config.enabled=true` の次候補へ自動で切替(通知あり)。3.5/3.1は予行演習(model-healthの `rehearse`)で検証し `commit` するまで enabled=false。
- 手動切替: `select model_set_current('gemini-3.5-flash-lite','manual');`

## 秘密(Vault。名前は xd_ 始まり)
xd_pipeline_secret_cron(cron→各関数)、xd_pipeline_secret_win(Windows→summarize-x-post用の低権限)、xd_admin_token_key(管理トークン署名)、xd_ntfy_topic、xd_healthcheck_daily_url / weekly_url、xd_anon_jwt。表示・変更は SQL か 管理API(`set_healthcheck`)のみ。リポジトリには置かない。

## X専用Geminiキー(越智さんの作業)
1. Google AI Studio で新しいプロジェクト(例: x-dashboard)を作りAPIキーを発行(請求はプロジェクト単位で見える)。
2. Supabase ダッシュボード > Edge Functions > Secrets に `GEMINI_API_KEY_X` として登録。未設定の間は従来の `GEMINI_API_KEY` で動く。
3. 月に1回、Googleの請求額を画面の費用タブへ入力して実績と照合(任意)。

## Windows側の取得スキル(文書のみ・今回は未配備)
- 認証必須化の準備: summarize-x-post を呼ぶ箇所に `x-pipeline-secret: <xd_pipeline_secret_win の値>` ヘッダを追加(値はSQLで取得して越智さんが貼る)。未付与の呼び出し件数は ops_events(kind=unauth_call)で確認できる。付与後に管理APIで `pipeline_auth_mode` を `enforce` へ。
- Phase 5(参照先要約)の取得拡張: 外部リンクURL・カード題名/説明・引用元本文を x_posts.ref_url/ref_title/ref_desc/quoted_text へ保存する固定JS抽出を追加(抽出失敗でも従来どおり動くこと)。サーバー側は `ref_enabled=false` の列のみ。有効化は別途検証。
