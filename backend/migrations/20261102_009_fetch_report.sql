-- 009: PCの取得の失敗を、数秒でntfyへ通知する(追加・置換のみ)
-- fetch_report(kind, detail): PCの取得スクリプトが、失敗の種類を判別して呼ぶ(公開キー)。許可する種類は3つだけ。
--   同じ種類は360分に1回へ束ね、通知は既存の ops_event → notify_ops(トピックはVaultのまま。PCには置かない)。
-- x_hourly: 「取得なし」の警告を20時間→15時間へ短縮(1日2回=最長の間隔は約13.5時間)。notify_opsは新しい3種のラベルを追加。

create or replace function public.fetch_report(p_kind text, p_detail text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_kind text; v_msg text; v_id bigint; v_detail text;
begin
  v_kind := case p_kind
    when 'auth_expired' then 'fetch_auth_expired'
    when 'extension_not_connected' then 'fetch_ext_disconnected'
    when 'run_failed' then 'fetch_run_failed'
    else null end;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_kind');
  end if;
  v_detail := left(regexp_replace(coalesce(p_detail, ''), '[^0-9A-Za-z .,:/%_()+-]', '', 'g'), 80);
  v_msg := case v_kind
    when 'fetch_auth_expired' then 'PCの取得: Claudeのログインが切れました'
    when 'fetch_ext_disconnected' then 'PCの取得: Chromeの拡張が接続されていません'
    else 'PCの取得が失敗しました' end;
  v_id := public.ops_event('error', v_kind, v_msg, jsonb_build_object('detail', v_detail), 360);
  perform public.notify_ops();
  return jsonb_build_object('ok', true, 'recorded', v_id is not null);
end $$;
revoke all on function public.fetch_report(text, text) from public;
grant execute on function public.fetch_report(text, text) to anon, authenticated, service_role;

create or replace function public.notify_ops()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare topic text; e record; n int := 0; v_label text; v_detail text; v_win interval; v_msg text;
begin
  if not pg_try_advisory_xact_lock(hashtext('notify_ops')) then
    return 0;
  end if;
  topic := public.get_secret('xd_ntfy_topic');
  if topic is null or btrim(topic) = '' then
    return 0;   -- 未設定: ops_eventsに残すだけ(画面に「通知先が未設定」と表示)
  end if;
  for e in select * from public.ops_events where not notified and level in ('warn', 'error') order by id limit 20 loop
    v_win := case e.level when 'error' then interval '6 hours' else interval '24 hours' end;
    if exists (select 1 from public.ops_events o
               where o.kind = e.kind and o.level = e.level and o.notified and not o.suppressed
                 and o.notified_at > now() - v_win) then
      update public.ops_events set notified = true, notified_at = now(), suppressed = true where id = e.id;
      continue;
    end if;
    v_label := case e.kind
      when 'model_switched'    then 'モデルを自動で切り替えました'
      when 'model_no_fallback' then 'モデルが使えず切替先もありません'
      when 'model_missing'     then '利用中のモデルが提供一覧から消えました'
      when 'model_health_fail' then 'モデルの動作確認に失敗しました'
      when 'cost_warn'         then '今月のGemini費用が警告域です'
      when 'cost_stop_extra'   then '費用が上限に達し追加処理を停止しました'
      when 'cost_stop_all'     then '費用が上限の130%に達し全処理を停止しました'
      when 'cost_stop_day'     then '1日の費用上限に達し処理を止めました'
      when 'fetch_stale'       then 'Xの取得が遅れています'
      when 'report_missing'    then '週次レポートが未生成です'
      when 'score_quality'     then '採点の品質が基準を外れています'
      when 'unauth_call'       then '認証なしの呼び出しを検知しました'
      when 'llm_error_rate'    then 'Geminiの呼び出しエラー率が高くなっています'
      when 'tier_stalled'      then '区分の確定が止まっています'
      when 'gemini_auth'       then 'Geminiのキーが認証に失敗しています'
      when 'digest_failed'     then '今日の要点の生成に失敗しました'
      when 'score_stalled'     then '採点が止まっています'
      when 'model_probe_failed' then 'モデルの予行演習に失敗しました'
      when 'score_no_profile'  then '関心プロファイルが未設定のため採点できません'
      when 'secrets_missing'   then '呼び出し用の秘密が未設定です'
      when 'digest_dropped'    then '今日の要点で検査により多くの文を削除しました'
      when 'digest_week_dropped' then '今週の流れで検査により多くの文を削除しました'
      when 'llm_env_error'     then 'Geminiの設定・モデル起因のエラーで処理が進みません'
      when 'usage_log_failed'  then '費用の記録に失敗が続いています'
      when 'fetch_auth_expired' then 'PCの取得: Claudeのログインが切れました(claude auth login が必要)'
      when 'fetch_ext_disconnected' then 'PCの取得: Chromeの拡張が接続されていません'
      when 'fetch_run_failed'  then 'PCの取得が失敗しました(ログを確認)'
      when 'test'              then 'テスト通知'
      else e.kind end;
    v_detail := left(regexp_replace(coalesce(e.data ->> 'detail', ''), '[^0-9A-Za-z .,:/%_()+>-]', '', 'g'), 80);
    v_msg := v_label || case when v_detail <> '' then ' (' || v_detail || ')' else '' end;
    perform net.http_post(
      url := 'https://ntfy.sh',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := jsonb_build_object(
        'topic', btrim(topic),
        'title', case e.level when 'error' then 'X Dashboard 異常' else 'X Dashboard 警告' end,
        'message', v_msg,
        'priority', case e.level when 'error' then 4 else 3 end,
        'tags', jsonb_build_array(case e.level when 'error' then 'rotating_light' else 'warning' end)),
      timeout_milliseconds := 10000);
    update public.ops_events set notified = true, notified_at = now() where id = e.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.x_hourly()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev timestamptz; v_prev_date date; v_last_fetch timestamptz; r jsonb;
        v_calls int; v_errs int; v_scope timestamptz; v_oldest timestamptz; v_hours numeric;
begin
  r := public.tier_maintenance();
  perform public.snapshot_post_scores();
  perform public.refresh_cost_monthly();
  v_prev := public.jst_month_start(public.jst_month_start(now()) - interval '1 day');
  v_prev_date := (v_prev at time zone 'Asia/Tokyo')::date;
  if extract(day from (now() at time zone 'Asia/Tokyo')) <= 3
     and not exists (select 1 from public.llm_cost_monthly where month = v_prev_date and finalized) then
    perform public.refresh_cost_monthly(v_prev, true);
  end if;
  perform public.cost_watch();
  select max(fetched_at) into v_last_fetch from public.x_posts;
  if v_last_fetch is not null and v_last_fetch < now() - interval '15 hours' then
    perform public.ops_event('warn', 'fetch_stale', 'Xの取得が15時間以上ありません',
                             jsonb_build_object('detail', round(extract(epoch from (now() - v_last_fetch)) / 3600) || ' hours'), 720);
  end if;

  select count(*), count(*) filter (where status = 'error') into v_calls, v_errs
    from public.llm_usage where called_at >= now() - interval '1 hour';
  if v_calls >= 10 and v_errs * 2 >= v_calls then
    perform public.ops_event('warn', 'llm_error_rate', 'Geminiの呼び出しエラー率が高くなっています',
                             jsonb_build_object('detail', v_errs || '/' || v_calls || ' errors in 1h'), 360);
  end if;

  begin
    v_scope := (public.cfg('tier_scope_from') #>> '{}')::timestamptz;
  exception when others then
    v_scope := null;
  end;
  if v_scope is not null and public.cfg_bool('tier_assign_enabled', true) then
    v_hours := greatest(public.cfg_num('batch_confirm_hours', 4), 4);
    select min(fetched_at) into v_oldest from public.x_posts where batch_key is null and fetched_at >= v_scope;
    if v_oldest is not null and v_oldest < now() - make_interval(secs => (v_hours * 3600)::int + 300) then
      perform public.ops_event('warn', 'tier_stalled', '区分が確定しない投稿が' || v_hours || '時間以上残っています',
                               jsonb_build_object('detail', round(extract(epoch from (now() - v_oldest)) / 3600) || ' hours'), 360);
    end if;
  end if;

  perform public.notify_ops();
  return r;
end $$;
