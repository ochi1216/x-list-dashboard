-- 001d foundation: cost guard / monthly aggregation / bootstrap

create or replace function public.llm_month_cost_jpy(p_month timestamptz default null, p_grp text default 'x')
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(cost_usd), 0) * public.cfg_num('usd_jpy', 160)
  from public.llm_usage
  where grp = p_grp
    and called_at >= coalesce(p_month, public.jst_month_start())
    and called_at <  ((coalesce(p_month, public.jst_month_start()) at time zone 'Asia/Tokyo') + interval '1 month') at time zone 'Asia/Tokyo'
$$;

-- 直近24時間の費用(円)。日次上限の判定に使う。
create or replace function public.llm_day_cost_jpy(p_grp text default 'x')
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(cost_usd), 0) * public.cfg_num('usd_jpy', 160)
  from public.llm_usage where grp = p_grp and called_at > now() - interval '24 hours'
$$;

-- 呼び出し直前の上限判定。level: ok | warn | stop_extra | stop_all | stop_day | rate | kill | ti | probe
-- 追加用途(参照先・要点・提案・再採点・読み下し)は月額100%で止め、全体は130%で止める。
create or replace function public.cost_guard(p_purpose text, p_grp text default 'x')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  cap numeric; warn_r numeric; extra_r numeric; all_r numeric; m numeric; d numeric;
  lvl text := 'ok'; allowed boolean := true; n_hour int; n_ti int;
begin
  if p_purpose = 'probe' then
    return jsonb_build_object('allowed', true, 'level', 'probe');
  end if;
  if public.cfg_bool('kill_switch', false) then
    return jsonb_build_object('allowed', false, 'level', 'kill');
  end if;
  if p_grp = 'ti' then
    select count(*) into n_ti from public.llm_usage where grp = 'ti' and called_at > now() - interval '24 hours';
    return jsonb_build_object('allowed', n_ti < public.cfg_num('ti_daily_call_cap', 500), 'level', 'ti', 'calls_24h', n_ti);
  end if;
  cap     := public.cfg_num('monthly_cap_jpy', 4000);
  warn_r  := public.cfg_num('cap_warn_ratio', 0.8);
  extra_r := public.cfg_num('cap_stop_extra_ratio', 1.0);
  all_r   := public.cfg_num('cap_stop_all_ratio', 1.3);
  m := public.llm_month_cost_jpy(null, 'x');
  d := public.llm_day_cost_jpy('x');
  select count(*) into n_hour from public.llm_usage where grp = 'x' and called_at > now() - interval '1 hour';
  if m >= cap * all_r then lvl := 'stop_all';
  elsif m >= cap * extra_r then lvl := 'stop_extra';
  elsif m >= cap * warn_r then lvl := 'warn';
  end if;
  if lvl = 'stop_all' then
    allowed := false;
  elsif lvl = 'stop_extra' and p_purpose in ('ref', 'digest', 'digest24', 'digest7', 'proposal', 'rescore', 'speech') then
    allowed := false;
  end if;
  if allowed and d >= public.cfg_num('daily_cap_jpy', 400) then
    allowed := false; lvl := 'stop_day';
  end if;
  if allowed and n_hour >= public.cfg_num('hourly_call_cap', 600) then
    allowed := false; lvl := 'rate';
  end if;
  return jsonb_build_object('allowed', allowed, 'level', lvl, 'month_jpy', round(m, 1),
                            'day_jpy', round(d, 1), 'cap_jpy', cap, 'calls_1h', n_hour);
end $$;

-- 月次集計(upsert。確定済みの月は触らない)。当月は毎時更新、月初に前月を確定する。
create or replace function public.refresh_cost_monthly(p_month timestamptz default null, p_finalize boolean default false)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare v_start timestamptz; v_end timestamptz; v_rate numeric; v_month date; n int;
begin
  v_start := public.jst_month_start(coalesce(p_month, now()));
  v_end := ((v_start at time zone 'Asia/Tokyo') + interval '1 month') at time zone 'Asia/Tokyo';
  v_month := (v_start at time zone 'Asia/Tokyo')::date;
  v_rate := public.cfg_num('usd_jpy', 160);
  if not p_finalize and exists (select 1 from public.llm_cost_monthly where month = v_month and finalized) then
    return 0;
  end if;
  insert into public.llm_cost_monthly(month, grp, fn, purpose, model, calls, errors, prompt_tokens, output_tokens,
                                      thoughts_tokens, cost_usd, cost_jpy, usd_jpy, finalized, updated_at)
  select v_month, grp, fn, purpose, model,
         count(*), count(*) filter (where status = 'error'),
         coalesce(sum(prompt_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(thoughts_tokens), 0),
         coalesce(sum(cost_usd), 0), round(coalesce(sum(cost_usd), 0) * v_rate, 2), v_rate, p_finalize, now()
  from public.llm_usage
  where called_at >= v_start and called_at < v_end
  group by grp, fn, purpose, model
  on conflict (month, grp, fn, purpose, model) do update
    set calls = excluded.calls, errors = excluded.errors, prompt_tokens = excluded.prompt_tokens,
        output_tokens = excluded.output_tokens, thoughts_tokens = excluded.thoughts_tokens,
        cost_usd = excluded.cost_usd, cost_jpy = excluded.cost_jpy, usd_jpy = excluded.usd_jpy,
        finalized = excluded.finalized, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- 使用量の明細は13か月保持(月次集計は永続)
create or replace function public.llm_usage_retention()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from public.llm_usage where called_at < now() - interval '13 months';
  get diagnostics n = row_count;
  return n;
end $$;

-- 初期化(一度だけ手動で呼ぶ): 秘密の生成(Vault)とセットアップコードの発行。
-- セットアップコードは一回限り・7日有効。戻り値にだけ平文が出る。
create or replace function public.ops_bootstrap()
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea; v_code text := ''; i int; v_done boolean; v_exp timestamptz; v_out jsonb;
begin
  if public.get_secret('xd_ntfy_topic') is null then
    perform public.set_secret('xd_ntfy_topic', 'xdash-' || encode(extensions.gen_random_bytes(12), 'hex'));
  end if;
  if public.get_secret('xd_pipeline_secret_cron') is null then
    perform public.set_secret('xd_pipeline_secret_cron', encode(extensions.gen_random_bytes(24), 'hex'));
  end if;
  if public.get_secret('xd_pipeline_secret_win') is null then
    perform public.set_secret('xd_pipeline_secret_win', encode(extensions.gen_random_bytes(24), 'hex'));
  end if;
  if public.get_secret('xd_admin_token_key') is null then
    perform public.set_secret('xd_admin_token_key', encode(extensions.gen_random_bytes(32), 'hex'));
  end if;
  insert into public.admin_auth(id) values (1) on conflict (id) do nothing;
  select setup_done into v_done from public.admin_auth where id = 1;
  if not v_done then
    v_bytes := extensions.gen_random_bytes(20);
    for i in 0 .. 19 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
      if i in (4, 9, 14) then v_code := v_code || '-'; end if;
    end loop;
    v_exp := now() + interval '7 days';
    update public.admin_auth
       set setup_code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex'),
           setup_code_expires_at = v_exp, failed_count = 0
     where id = 1;
    v_out := jsonb_build_object('setup_code', v_code, 'setup_code_expires_at', v_exp);
  else
    v_out := jsonb_build_object('setup_done', true);
  end if;
  return v_out || jsonb_build_object('ntfy_topic', public.get_secret('xd_ntfy_topic'));
end $$;
