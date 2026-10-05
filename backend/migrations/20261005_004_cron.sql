-- 004: 定期実行の登録(Edge Functionの配備と動作確認が済んでから適用する)
-- 旧cron(jobid 5〜8)は残す。x_tickが安定したら jobid 6(要約キャッチアップ)だけを無効化(削除はせず1週間残す)。
select cron.schedule('x_tick',          '*/5 * * * *', $$select public.x_tick()$$);
select cron.schedule('x_hourly',        '10 * * * *',  $$select public.x_hourly()$$);
select cron.schedule('x_pre_retention', '55 4 * * *',  $$select public.snapshot_post_scores()$$);   -- 既存の削除(0 5)の5分前に点数を写す
select cron.schedule('x_daily',         '0 20 * * *',  $$select public.x_daily()$$);               -- 05:00 JST
select cron.schedule('x_weekly',        '45 18 * * 0', $$select public.x_weekly()$$);              -- 月曜03:45 JST
select cron.schedule('x_report_check',  '0 3 * * 1',   $$select public.weekly_report_check()$$);   -- 月曜12:00 JST
