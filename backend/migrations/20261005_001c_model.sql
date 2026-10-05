-- 001c foundation: model state / failover functions

-- 現在のモデル・候補・モデル別設定・単価をまとめて返す(全Edge Functionが呼び出し前に参照)
create or replace function public.get_model_state()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s record; cfgs jsonb;
begin
  select * into s from public.model_state where id = 1;
  select coalesce(jsonb_object_agg(m.model, jsonb_build_object(
           'gen_config', m.gen_config, 'enabled', m.enabled,
           'in_usd', p.in_usd, 'out_usd', p.out_usd)), '{}'::jsonb)
    into cfgs
  from public.model_config m
  left join lateral (
     select lp.in_usd, lp.out_usd from public.llm_prices lp
     where lp.model = m.model and lp.effective_from <= (now() at time zone 'Asia/Tokyo')::date
     order by lp.effective_from desc limit 1) p on true;
  return jsonb_build_object(
    'current_model', s.current_model,
    'candidates', s.candidates,
    'gone_streak', s.gone_streak,
    'configs', cfgs,
    'usd_jpy', public.cfg_num('usd_jpy', 160));
end $$;

-- 「モデルが存在しない・提供終了」の応答を報告する。連続3回で次の(検証済みの)候補へ切り替える。
create or replace function public.model_report_gone(p_model text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; next_model text; switched boolean := false; cands jsonb; idx int := -1; i int;
begin
  select * into s from public.model_state where id = 1 for update;
  if s.current_model <> p_model then
    return jsonb_build_object('current_model', s.current_model, 'switched', false, 'streak', s.gone_streak, 'stale', true);
  end if;
  update public.model_state set gone_streak = gone_streak + 1, updated_at = now() where id = 1
  returning * into s;
  if s.gone_streak >= 3 then
    cands := s.candidates;
    for i in 0 .. jsonb_array_length(cands) - 1 loop
      if cands ->> i = s.current_model then idx := i; end if;
    end loop;
    next_model := null;
    for i in idx + 1 .. jsonb_array_length(cands) - 1 loop
      if exists (select 1 from public.model_config c where c.model = cands ->> i and c.enabled) then
        next_model := cands ->> i; exit;
      end if;
    end loop;
    if next_model is not null then
      update public.model_state
         set current_model = next_model, gone_streak = 0, last_switch_at = now(),
             last_switch_reason = left(coalesce(p_reason, 'model gone x3'), 500), updated_at = now()
       where id = 1 returning * into s;
      switched := true;
      perform public.ops_event('error', 'model_switched',
        format('モデルを %s から %s へ自動で切り替えました', p_model, next_model),
        jsonb_build_object('from', p_model, 'to', next_model, 'detail', p_model || ' to ' || next_model));
    else
      perform public.ops_event('error', 'model_no_fallback',
        format('モデル %s が使えませんが、切替先の候補がありません', p_model),
        jsonb_build_object('model', p_model, 'detail', p_model), 60);
    end if;
  end if;
  return jsonb_build_object('current_model', s.current_model, 'switched', switched, 'streak', s.gone_streak);
end $$;

create or replace function public.model_report_ok(p_model text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.model_state set gone_streak = 0, updated_at = now()
  where id = 1 and current_model = p_model and gone_streak > 0
$$;

create or replace function public.model_set_current(p_model text, p_reason text default 'manual')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.model_config where model = p_model) then
    raise exception 'unknown model %', p_model;
  end if;
  update public.model_state
     set current_model = p_model, gone_streak = 0, last_switch_at = now(),
         last_switch_reason = left(p_reason, 500), updated_at = now()
   where id = 1;
end $$;
