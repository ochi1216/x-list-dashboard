# CHANGELOG(backend)

## v1.1.0 (2026-10-09) 流すの操作追加・保留の一括既読
- UI(index_beta.html): 流すに「⏮前へ」「⏸止める/▶再開」を追加(戻ったカードは既読のまま。「これ聴く」で未読へ戻して昇格)。保留一覧に「✅保留をすべて既読にする」(確認あり・8秒の取り消し帯)。保留の見出しは、既読が混じるとき「保留 N件(未読M件)」。
- DB(追加のみ): `bulk_read_hold(p_dry)`(未読の保留を日付に関係なく全件既読。read_via=user)、`bulk_unread_hold(p_at)`(15分以内の一括分だけ未読へ戻す)。マイグレーション 20261009_007_bulk_hold.sql。
- テスト: SQL 89件、ui_core 211項目、ui_admin 129項目、単体255件がすべて合格。

## v1.0.0 (2026-10-06) 仕様v11の実装
- DB: 基盤(設定・使用量・月次集計・モデル状態/自動切替・費用ガード・通知・管理認証・Vault)、採点/区分/読み下し列、score_runs、post_scores、tier_batches、score_labels、digest_daily/week、weekly_reports。
- Edge Functions: 共通Gemini部品(モデル解決・使用量記録・費用ガード・自動切替)、summarize-x-post(時間予算・ロック・認証)、score-x-posts(新)、generate-digest-summary(今日の要点/今週の流れ追加)、admin-api(新)、model-health(新)、TI系3本(共通部品へ差し替え)。
- UI: index_beta.html(聴く/流す/一覧・今日/週次/費用/設定・答え合わせ)、読み上げ品質(ui/tts.js)。
- 運用: cron(x_tick 5分、x_hourly、x_daily、x_weekly)。旧cronは残置。
