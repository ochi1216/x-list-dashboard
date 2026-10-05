# SQL試験(migration 006)

一時Postgres 16を立て、`00_stub.sql`(anon/authenticated/service_roleロール、Vault・pg_net・pg_cronのスタブ、既存3表。x_postsはanonに全権限がある「F1の問題状態」。fetch_runs・digest_summariesも同様(N2))→ migrations 001a〜006 を順に適用し、`10_tests.sql` を流して破棄します。本番(Supabase)には一切触れません。

```
backend/tests/sql/run.sh        # PGBIN(既定 /usr/lib/postgresql/16/bin)、PGPORT_TEST(既定 54329)で変更可
```

手動で流す場合は、空のDBに `psql -v ON_ERROR_STOP=1 -f 00_stub.sql` → 各migration → `10_tests.sql` の順(rootでなければ run.sh 不要)。`10_tests.sql` は1つでも FAIL があれば例外で終わります。

試験内容(78項目 + 並行実行1項目。006は2回適用してから流す)
- N2: fetch_runs / digest_summaries は anon・authenticated とも INSERT/UPDATE/DELETE/TRUNCATE が拒否、SELECT可、表権限はSELECTのみ。
- F1: anonは content更新・read_via直接更新・INSERT/DELETE/TRUNCATE が拒否、is_read/is_starred更新とSELECTと mark_read RPC は可。column_privileges(UPDATE)は2列のみ。
- A: finalize_tiers を 手動降格・手動昇格・既読・要約不能(summary_attempts=3, summary null)・通常の混在データで実行(手動昇降格の tier_initial はアルゴリズム判定のまま、listen_tier だけ手動結果。未採点待ちの4時間ルール、score_enabled=false / tier_assign_enabled=false の挙動を含む)。
- B: author_scoreboard(rule行を母集団に含め、別モデル・skippedは除外)、weekly_report(週ラベル・割合NULL時の文面・「現在の」除外候補)。
- C: digest_due(試行から30分以内=false / 40分前=true / 不正値でも例外なし / 古い failed・直近の paused 行は無視 / ok・empty 行から6時間以内=false)、x_hourly の警報(llm_error_rate: 10回未満は無し・50%以上で warn・360分dedupe / tier_stalled: 4時間超で warn・tier_assign無効や確定後は無し)、notify_ops の新6種の日本語ラベル、x_tick の分岐(net.http_postスタブで起動関数名を記録)、x_daily(model-health + generate-digest-summary week)、x_weekly(週次レポートのみ)、cron(x_hourly=`3 * * * *`)、notify_ops の二重送信防止(別セッションがロック保持中は0を返し、解放後は1件送る)。
- 006 の二重適用(冪等性)。
