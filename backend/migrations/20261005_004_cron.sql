-- 004: 定期実行の登録(005・006の適用とEdge Functionの配備・動作確認が済んでから適用する。cron.scheduleは同名ジョブを上書きするので再実行可)
-- 旧cron(jobid 5〜8)は残す。x_tickが安定したら jobid 6(要約キャッチアップ)だけを無効化(削除はせず1週間残す)。
select cron.schedule('x_tick',          '*/5 * * * *', $$select public.x_tick()$$);
select cron.schedule('x_hourly',        '3 * * * *',   $$select public.x_hourly()$$);               -- 毎時3分(x_tick(*/5)の分と重ならない)
select cron.schedule('x_pre_retention', '55 4 * * *',  $$select public.snapshot_post_scores()$$);   -- 既存の削除(0 5)の5分前に点数を写す
select cron.schedule('x_daily',         '0 20 * * *',  $$select public.x_daily()$$);               -- 05:00 JST(モデル確認+今週の流れの日次更新)
select cron.schedule('x_weekly',        '45 18 * * 0', $$select public.x_weekly()$$);              -- 月曜03:45 JST(週次レポートのみ)
select cron.schedule('x_report_check',  '0 3 * * 1',   $$select public.weekly_report_check()$$);   -- 月曜12:00 JST
