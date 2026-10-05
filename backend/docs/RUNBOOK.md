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
7. ヘルス確認: ops_events に error が無いこと、`select public.x_tick();` が例外なく返ること、cron.job に新6本(旧7本と合わせて13本)あること、管理画面の費用・通知タブが開くこと。

### 本番適用前チェック(006の直後・必須)
anon / authenticated が書ける範囲を確認する。x_posts は `is_read` と `is_starred` の更新だけ、fetch_runs と digest_summaries は SELECT のみ。
```sql
-- (1) x_posts: 書ける列
select grantee, privilege_type, column_name from information_schema.column_privileges
 where table_name='x_posts' and grantee in ('anon','authenticated') and privilege_type='UPDATE'
 order by grantee, column_name;
-- 期待: anon / authenticated それぞれ is_read, is_starred の2行ずつ(計4行)だけ
-- (2) 3表の表権限
select table_name, grantee, privilege_type from information_schema.role_table_grants
 where table_schema='public' and table_name in ('x_posts','fetch_runs','digest_summaries')
   and grantee in ('anon','authenticated')
 order by table_name, grantee, privilege_type;
-- 期待: 3表×(anon, authenticated)とも SELECT の行だけ(計6行)。
--       INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER が1行でもあれば未適用か取り残し → 006のREVOKEを再実行
-- (3) fetch_runs / digest_summaries に列単位のUPDATE/INSERT権限が残っていないこと
select table_name, grantee, privilege_type, column_name from information_schema.column_privileges
 where table_schema='public' and table_name in ('fetch_runs','digest_summaries')
   and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE');
-- 期待: 0行
```
(x_postsのUPDATEが2列だけ、fetch_runs / digest_summaries はanonにSELECTのみ。書くのはEdge Function(service role)だけ。)

### 要約の試行回数のリセット
要約が3回失敗した投稿(`summary_attempts >= 3`)は自動では再試行されない。原因(キー・モデル・入力)を直した後に再開する:
```sql
update public.x_posts set summary_attempts = 0 where gist is null;
```
(要約不能の投稿は区分確定の「未採点待ち」からも外れるため、バッチの確定は遅れない。)

## 初期設定手順(本番反映後・越智さんの作業)
1. 初期化(一度だけ): `select public.ops_bootstrap();` が秘密4種(xd_ntfy_topic / xd_pipeline_secret_cron / xd_pipeline_secret_win / xd_admin_token_key。未設定のものだけ作る)と、一回限り・7日有効のセットアップコードを作って返す。コードは戻り値にだけ出るので、その場で管理画面の初回設定に入力しパスフレーズを決める。`xd_anon_jwt` は ops_bootstrap の対象外で、別途 `set_secret` で設定済み。
2. 区分確定の開始日 `tier_scope_from`(ISO文字列)を tuning_config へ(これより前は区分・自動既読の対象外。未設定の間は確定も要点生成も動かない):
   ```sql
   insert into public.tuning_config(key, value) values ('tier_scope_from', to_jsonb('2026-10-06T00:00:00Z'::text))
   on conflict (key) do update set value = excluded.value, updated_at = now();
   ```
3. 関心プロファイル `interest_profile`: 本文はDBのみ(リポジトリ・文書には書かない)。管理画面の設定タブで本文を入力し承認(approve)する。承認されるまで status=draft。
4. `GEMINI_API_KEY_X` を Edge Functions の Secrets へ(上の「X専用Geminiキー」参照)。
5. モデルの予行演習(3.5 / 3.1 を有効化する前に): model-health の `rehearse` を n>=20 で実行し、`commit:true` で enabled に確定する。cron専用なので `x-pipeline-secret` が要る。値はリポジトリに書かず、SQLで取得して使う:
   ```sql
   select public.get_secret('xd_pipeline_secret_cron');   -- 出力をシェルの変数に入れる(履歴・ファイルに残さない)
   ```
   ```bash
   curl -sS -X POST "https://bpdkdwtevqsqgsxlahmd.supabase.co/functions/v1/model-health" \
     -H "Authorization: Bearer $ANON_JWT" -H "apikey: $ANON_JWT" \
     -H "x-pipeline-secret: $PIPELINE_SECRET_CRON" -H "Content-Type: application/json" \
     -d '{"action":"rehearse","model":"gemini-3.5-flash-lite","n":20,"commit":true}'
   ```
   `$ANON_JWT` は anon key、`$PIPELINE_SECRET_CRON` は上のSQLの出力。n は20以上。`commit:true` を付けない呼び出しは確認だけ(確定しない)。
6. cron(`20261005_004_cron.sql`)を最後に適用。登録後の `cron.job` は新6本(x_tick / x_hourly / x_pre_retention / x_daily / x_weekly / x_report_check)+ 旧7本 = 13本。

## 失敗状態のリセット(原因を直した後に実行)
```sql
-- 採点が3回失敗(score_state='failed')した投稿を再採点の対象へ戻す
update public.x_posts set score_state=null, score_attempts=0 where score_state='failed';
-- 読み下し(speech)を再試行の対象へ戻す(speech_at が入っていると再起動しない)
update public.x_posts set speech_at=null where speech_body is null and speech_at is not null;
-- 管理画面のログイン失敗回数(ロックアウト)を解除
update public.admin_auth set failed_count=0;
```
(speech のリセットは、条件を付けずに `update public.x_posts set speech_at=null` とすると読み下し済みの行も対象になるので、上の条件付きを使う。)

### 備考
- `xd_anon_jwt` は Vault に設定済み(`set_secret` で別途設定。`ops_bootstrap()` の対象ではない)。`ops_bootstrap()` は存在し、秘密4種(ntfyトピック・cron用/Windows用の共有シークレット・管理トークン署名鍵)とセットアップコードを作る(上の初期設定手順1)。
- `digest_due()` の条件は2つだけ(Edge側 digest.ts の runToday と同じ基準): `tuning_config.digest_last_attempt_at`(ISO文字列)から30分以内なら false(失敗の連打防止)/ 当日の ok・empty 行から `digest_min_interval_hours` 以内なら false。failed・paused 行の有無は見ない。キーが無ければ試行の制限なし。
- x_hourly の警報: 直近1時間のGemini呼び出しでエラー率50%以上(10回以上のとき)→ `llm_error_rate`、最初の投稿から4時間超えて区分が確定しない投稿が残る → `tier_stalled`(どちらも warn・360分に1回)。
