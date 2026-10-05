# legacy: 改修前のEdge Function原本

2026-10-05 時点で本番に載っていたソースの写し(Supabaseから取得した内容そのまま)。
改修後に問題が起きた場合は、この版をそのまま再デプロイすれば元の動作に戻る(verify_jwtは下表のとおり)。
Supabase側は再デプロイ後に旧版を取得できないため、必ずここを原本とする。

| 関数 | 版 | verify_jwt | 文字数 | 内容のsha256(先頭16桁) | 備考 |
|---|---|---|---|---|---|
| generate-digest-summary | v1 | true | 9054 | a2b28ca89d96dfe1 | 取得時のbundle sha256先頭: b1a15b44c40956b6 |
| summarize-ti-lesson | v3 | true | 6283 | 48a54c8e6a6ca04c | 取得時のbundle sha256先頭: 8c9606289017467a |
| summarize-ti-news | v2 | true | 4083 | c68421df7325f3e7 | 取得時のbundle sha256先頭: 8e0352b872a639a2 |
| summarize-ti-news-headline | v1 | true | 2910 | f745d137233f7c35 | 取得時のbundle sha256先頭: 249b7b85f994eebd |
| summarize-x-post | v7 | true | 8662 | c84e9a9eaffb541b | 取得時のbundle sha256先頭: 0a0f30649d8f84f8 |

## 旧cron定義(2026-10-05時点。無効化はしても削除せず、1週間は残す方針)

- jobid 5 `x_posts_retention_cleanup` `0 5 * * *`: `delete from public.x_posts where is_read = true and coalesce(posted_at, fetched_at) < now() - interval '7 days'`
- jobid 6 `x_posts_summarize_catchup` `15 */3 * * *`: summarize-x-post へ `{"limit": 60}`
- jobid 7 `x_digest_24h_refresh` `45 */3 * * *`: generate-digest-summary へ `{"period_type":"24h"}`
- jobid 8 `x_digest_7d_refresh` `30 5 * * *`: generate-digest-summary へ `{"period_type":"7d"}`
- jobid 1〜3: TI系の取得(変更しない)
