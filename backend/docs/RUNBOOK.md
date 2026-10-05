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

## デプロイ順(本番反映)
1. DB: `20261005_005_summary_attempts.sql` → `20261005_006_review_fixes.sql`(加算のみ・冪等。001〜004が未適用なら番号順に先に適用。004(cron)は最後)。
2. 新関数: score-x-posts → model-health → admin-api。
3. summarize-x-post(005の `summary_attempts` を使う版)。
4. generate-digest-summary(今日の要点の試行開始時に `tuning_config.digest_last_attempt_at` を書く版)。
5. TI系3関数(summarize-ti-news / -headline / -lesson)。
6. `20261005_004_cron.sql`(定期実行の登録。x_hourlyは毎時3分)。
7. ヘルス確認: ops_events に error が無いこと、`select public.x_tick();` が例外なく返ること、cron.job に6本あること、管理画面の費用・通知タブが開くこと。

### 本番適用前チェック(006の直後・必須)
anon / authenticated が x_posts へ書ける列は `is_read` と `is_starred` だけであること。
```sql
select grantee, privilege_type, column_name from information_schema.column_privileges
 where table_name='x_posts' and grantee in ('anon','authenticated') and privilege_type='UPDATE'
 order by grantee, column_name;
-- 期待: anon / authenticated それぞれ is_read, is_starred の2行ずつ(計4行)だけ
select grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name='x_posts' and grantee in ('anon','authenticated');
-- 期待: SELECT のみ(INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER が無い)
```

### 要約の試行回数のリセット
要約が3回失敗した投稿(`summary_attempts >= 3`)は自動では再試行されない。原因(キー・モデル・入力)を直した後に再開する:
```sql
update public.x_posts set summary_attempts = 0 where gist is null;
```
(要約不能の投稿は区分確定の「未採点待ち」からも外れるため、バッチの確定は遅れない。)

### 備考
- `xd_anon_jwt` は Vault に設定済み。`ops_bootstrap` は作らない(新たに秘密を設定する手順は無い)。
- `digest_due()` は `tuning_config.digest_last_attempt_at`(ISO文字列)から30分以内は false を返す(失敗の連打防止)。キーが無ければ制限なし。
