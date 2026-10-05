-- 001e foundation: notifications / permissions / seed data

-- 通知: ntfyのJSON公開API(ルートURLへtopic/title/message/priority)。トピックはVaultから読む。
-- 本文は事象の種類(日本語ラベル)と英数字だけの短い詳細のみ。例外文などの自由文は送らない。
-- 同じ種類の通知は errorは6時間、warnは24時間に1回へ集約(残りは suppressed として記録だけ)。
create or replace function public.notify_ops()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare topic text; e record; n int := 0; v_label text; v_detail text; v_win interval; v_msg text;
begin
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

-- 設定画面の「テスト通知」用。重複抑制の対象外。
create or replace function public.notify_test()
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare topic text; req bigint;
begin
  topic := public.get_secret('xd_ntfy_topic');
  if topic is null or btrim(topic) = '' then return null; end if;
  select net.http_post(
    url := 'https://ntfy.sh',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('topic', btrim(topic), 'title', 'X Dashboard テスト',
                               'message', 'テスト通知です。この通知が届けば設定は完了です。',
                               'priority', 3, 'tags', jsonb_build_array('white_check_mark')),
    timeout_milliseconds := 10000) into req;
  return req;
end $$;

-- 外部の死活監視(healthchecks.io等)へ信号を送る。URLはVault(xd_healthcheck_<kind>_url)から読む。
create or replace function public.ping_healthcheck(p_kind text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare u text;
begin
  if p_kind not in ('daily', 'weekly') then return; end if;
  u := public.get_secret('xd_healthcheck_' || p_kind || '_url');
  if u is not null and btrim(u) <> '' then
    perform net.http_get(url := btrim(u), timeout_milliseconds := 10000);
  end if;
end $$;

-- 費用が上限に近づいたことを記録する(月の段階は月に1回、日次上限は1日に1回)
create or replace function public.cost_watch()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare g jsonb; lvl text;
        mkey text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM');
        dkey text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD');
begin
  g := public.cost_guard('summary', 'x');
  lvl := g ->> 'level';
  if lvl in ('warn', 'stop_extra', 'stop_all') then
    if not exists (select 1 from public.ops_events where kind = 'cost_' || lvl and data ->> 'month' = mkey) then
      perform public.ops_event(case lvl when 'warn' then 'warn' else 'error' end, 'cost_' || lvl,
        format('今月のGemini費用が%s円(上限%s円)', g ->> 'month_jpy', g ->> 'cap_jpy'),
        jsonb_build_object('month', mkey, 'guard', g, 'detail', (g ->> 'month_jpy') || ' of ' || (g ->> 'cap_jpy') || ' JPY'));
    end if;
  elsif lvl = 'stop_day' then
    if not exists (select 1 from public.ops_events where kind = 'cost_stop_day' and data ->> 'day' = dkey) then
      perform public.ops_event('error', 'cost_stop_day',
        format('直近24時間の費用が日次上限に達しました(%s円)', g ->> 'day_jpy'),
        jsonb_build_object('day', dkey, 'guard', g, 'detail', (g ->> 'day_jpy') || ' JPY/24h'));
    end if;
  end if;
end $$;

-- ---- 関数の実行権限: サービスロールだけ(関数ごとに明示。スキーマ一括の権限変更はしない) ------
do $$
declare f text;
begin
  foreach f in array array[
    'get_secret(text)', 'set_secret(text,text)', 'cfg(text,jsonb)', 'cfg_num(text,numeric)', 'cfg_bool(text,boolean)',
    'jst_month_start(timestamptz)', 'ops_event(text,text,text,jsonb,int)', 'lock_acquire(text,int,text)',
    'lock_release(text,text)', 'get_model_state()', 'model_report_gone(text,text)', 'model_report_ok(text)',
    'model_set_current(text,text)', 'llm_month_cost_jpy(timestamptz,text)', 'llm_day_cost_jpy(text)',
    'cost_guard(text,text)', 'refresh_cost_monthly(timestamptz,boolean)', 'llm_usage_retention()',
    'ops_bootstrap()', 'notify_ops()', 'notify_test()', 'ping_healthcheck(text)', 'cost_watch()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---- 初期データ -----------------------------------------------------------------
insert into public.model_state(id, current_model) values (1, 'gemini-2.5-flash-lite') on conflict (id) do nothing;

-- 切替先として使えるのは enabled=true のモデルだけ。3.x系は予行演習(プローブ)で検証できてから true にする。
insert into public.model_config(model, gen_config, enabled, note, verified_at) values
  ('gemini-2.5-flash-lite', '{}'::jsonb, true,  '現行。2026-10-16頃に終了見込み', now()),
  ('gemini-3.5-flash-lite', '{}'::jsonb, false, '切替先(予行演習で思考の指定方式を確認してから有効化)', null),
  ('gemini-3.1-flash-lite', '{}'::jsonb, false, '予備(2027-05終了。予行演習で確認してから有効化)', null)
on conflict (model) do nothing;

insert into public.llm_prices(model, effective_from, in_usd, out_usd) values
  ('gemini-2.5-flash-lite', '2026-01-01', 0.10, 0.40),
  ('gemini-2.5-flash',      '2026-01-01', 0.30, 2.50),
  ('gemini-3.1-flash-lite', '2026-01-01', 0.25, 1.50),
  ('gemini-3.5-flash-lite', '2026-01-01', 0.30, 2.50)
on conflict (model, effective_from) do nothing;

insert into public.tuning_config(key, value, note) values
  ('usd_jpy',              '160'::jsonb,   '為替(円/USD)'),
  ('monthly_cap_jpy',      '4000'::jsonb,  '月額上限(円、X系のみ)'),
  ('daily_cap_jpy',        '400'::jsonb,   '直近24時間の上限(円、X系のみ)。暴走の被害を1日で止める'),
  ('hourly_call_cap',      '600'::jsonb,   '1時間あたりのGemini呼び出し上限(X系)'),
  ('cap_warn_ratio',       '0.8'::jsonb,   '警告の割合'),
  ('cap_stop_extra_ratio', '1.0'::jsonb,   '参照先要約・今日の要点・追加採点・読み下しを止める割合'),
  ('cap_stop_all_ratio',   '1.3'::jsonb,   '全て止める割合'),
  ('ti_daily_call_cap',    '500'::jsonb,   'TI系の1日あたりGemini呼び出し上限'),
  ('pipeline_auth_mode',   '"log"'::jsonb, '呼び出し元認証: log=記録のみ(制限付きで許可) / enforce=必須'),
  ('kill_switch',          'false'::jsonb, '全停止スイッチ(trueでLLM呼び出しを全て止める)')
on conflict (key) do nothing;
