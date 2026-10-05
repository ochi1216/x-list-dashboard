-- 003c: 定期実行の本体(関数のみ。cronへの登録は 004_cron.sql で、Edge Functionの配備後に行う)

-- Edge Functionを呼ぶ(pg_net。匿名JWTと共有シークレットはVaultから)。秘密が無い時は記録して何もしない。
create or replace function public.call_fn(p_fn text, p_body jsonb default '{}'::jsonb, p_timeout int default 150000)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_anon text; v_secret text; v_req bigint;
begin
  v_anon := public.get_secret('xd_anon_jwt');
  v_secret := public.get_secret('xd_pipeline_secret_cron');
  if v_anon is null or v_secret is null then
    perform public.ops_event('warn', 'secrets_missing', '呼び出し用の秘密が未設定です', jsonb_build_object('detail', p_fn), 720);
    return null;
  end if;
  select net.http_post(
    url := 'https://bpdkdwtevqsqgsxlahmd.supabase.co/functions/v1/' || p_fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_anon,
                                  'x-pipeline-secret', v_secret),
    body := p_body, timeout_milliseconds := p_timeout) into v_req;
  return v_req;
end $$;

-- 採点の対象範囲の下限(backfill有効時はscore_backfill_from、無効時はtier_scope_from)
create or replace function public.score_pool_from()
returns timestamptz language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v timestamptz;
begin
  begin
    if public.cfg_bool('backfill_enabled', false) then
      v := (public.cfg('score_backfill_from') #>> '{}')::timestamptz;
    end if;
    if v is null then v := (public.cfg('tier_scope_from') #>> '{}')::timestamptz; end if;
  exception when others then
    v := null;
  end;
  return v;
end $$;

-- 今日の要点を再生成すべきか(区分確定の直後・新規score3以上が既定5件以上・最短6時間。その日の初回は間隔を無視)
create or replace function public.digest_due()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_day_start timestamptz := public.jst_day2_start(now());
  v_day date := (public.jst_day2_start(now()) at time zone 'Asia/Tokyo')::date;
  v_last timestamptz; v_new int;
begin
  if public.cfg('tier_scope_from') is null then return false; end if;
  select generated_at into v_last from public.digest_daily where day = v_day and status in ('ok', 'empty');
  if v_last is not null and now() - v_last < make_interval(secs => (public.cfg_num('digest_min_interval_hours', 6) * 3600)::int) then
    return false;
  end if;
  if exists (select 1 from public.digest_daily where day = v_day and status in ('paused', 'failed')
             and generated_at > now() - interval '60 minutes') then
    return false;
  end if;
  if not exists (select 1 from public.tier_batches where finalized_at > coalesce(v_last, v_day_start)) then return false; end if;
  select count(*) into v_new from public.x_posts
   where score >= 3 and scored_at > coalesce(v_last, v_day_start) and fetched_at >= v_day_start;
  return v_new >= public.cfg_num('digest_min_new_scored', 5);
end $$;

-- 5分ごと: 処理すべき仕事がある時だけ各関数を起動する
create or replace function public.x_tick()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_from timestamptz; v_scope timestamptz; r jsonb := '{}'::jsonb;
begin
  if public.cfg_bool('kill_switch', false) then
    return jsonb_build_object('kill', true);
  end if;
  if exists (select 1 from public.x_posts where gist is null and fetched_at > now() - interval '3 days'
             and fetched_at < now() - interval '1 minute') then
    perform public.call_fn('summarize-x-post', jsonb_build_object('limit', 60, 'mode', 'tick'));
    r := r || jsonb_build_object('summarize', true);
  end if;
  v_from := public.score_pool_from();
  begin
    v_scope := (public.cfg('tier_scope_from') #>> '{}')::timestamptz;
  exception when others then
    v_scope := null;
  end;
  if v_from is not null and public.cfg_bool('score_enabled', true) and (
       exists (select 1 from public.x_posts where summary is not null and score_state is null
               and score_attempts < 3 and fetched_at >= v_from)
    or exists (select 1 from public.x_posts where batch_key is null and fetched_at >= v_scope)
    or (public.cfg_bool('speech_enabled', true) and exists (
          select 1 from public.x_posts where listen_tier = 'listen' and speech_body is null and speech_at is null and not is_read))) then
    perform public.call_fn('score-x-posts', jsonb_build_object('mode', 'tick'));
    r := r || jsonb_build_object('score', true);
  end if;
  if public.digest_due() then
    perform public.call_fn('generate-digest-summary', jsonb_build_object('period_type', 'today'));
    r := r || jsonb_build_object('digest', true);
  end if;
  perform public.notify_ops();
  return r;
end $$;

-- 毎時: 失効・写し・費用の集計と監視・取得停止の検知・通知
create or replace function public.x_hourly()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev timestamptz; v_prev_date date; v_last_fetch timestamptz; r jsonb;
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
  if v_last_fetch is not null and v_last_fetch < now() - interval '20 hours' then
    perform public.ops_event('warn', 'fetch_stale', 'Xの取得が20時間以上ありません',
                             jsonb_build_object('detail', round(extract(epoch from (now() - v_last_fetch)) / 3600) || ' hours'), 720);
  end if;
  perform public.notify_ops();
  return r;
end $$;

-- 毎日: モデルの提供確認・死活信号・古いデータの整理
create or replace function public.x_daily()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.call_fn('model-health', '{}'::jsonb, 120000);
  perform public.llm_usage_retention();
  update public.score_labels set content = null, summary = null, image_urls = null
   where created_at < now() - interval '6 months' and content is not null;
  perform public.ping_healthcheck('daily');
end $$;

-- 毎週(日曜18:45 UTC=月曜03:45 JST): 週次レポートと今週の流れ
create or replace function public.x_weekly()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.weekly_report();
  perform public.call_fn('generate-digest-summary', jsonb_build_object('period_type', 'week'));
  perform public.ping_healthcheck('weekly');
end $$;

do $$
declare f text;
begin
  foreach f in array array['call_fn(text,jsonb,int)', 'score_pool_from()', 'digest_due()', 'x_tick()', 'x_hourly()', 'x_daily()', 'x_weekly()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
