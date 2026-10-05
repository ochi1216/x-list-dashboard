-- 001b foundation: helper functions (secrets / config / ops events / lock)
-- すべてSECURITY DEFINER。実行権限はサービスロールのみ(001eで明示的にREVOKE/GRANT)。

-- Vault(秘密)アクセス。名前は xd_ で始まるものだけ許可し、他の用途の秘密に触れない。
create or replace function public.get_secret(p_name text)
returns text language plpgsql stable security definer set search_path = public, vault, pg_temp as $$
declare v text;
begin
  if p_name is null or p_name not like 'xd\_%' escape '\' then
    raise exception 'secret name not allowed';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name limit 1;
  return v;
end $$;

create or replace function public.set_secret(p_name text, p_value text)
returns void language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_id uuid;
begin
  if p_name is null or p_name not like 'xd\_%' escape '\' then
    raise exception 'secret name not allowed';
  end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, 'x-dashboard managed');
  else
    perform vault.update_secret(v_id, p_value, p_name, 'x-dashboard managed');
  end if;
end $$;

create or replace function public.cfg(p_key text, p_default jsonb default null)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select value from public.tuning_config where key = p_key), p_default)
$$;

create or replace function public.cfg_num(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value #>> '{}')::numeric from public.tuning_config where key = p_key), p_default)
$$;

create or replace function public.cfg_bool(p_key text, p_default boolean)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select (value #>> '{}')::boolean from public.tuning_config where key = p_key), p_default)
$$;

create or replace function public.jst_month_start(p_ts timestamptz default now())
returns timestamptz language sql stable set search_path = public, pg_temp as $$
  select (date_trunc('month', p_ts at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo'
$$;

-- 運用イベントの記録。同種のイベントは p_dedupe_minutes の間は記録しない。
create or replace function public.ops_event(p_level text, p_kind text, p_message text,
                                            p_data jsonb default '{}'::jsonb, p_dedupe_minutes int default 0)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  if p_dedupe_minutes > 0 and exists (
      select 1 from public.ops_events
      where kind = p_kind and level = p_level and at > now() - make_interval(mins => p_dedupe_minutes)) then
    return null;
  end if;
  insert into public.ops_events(level, kind, message, data)
  values (p_level, p_kind, left(p_message, 1000), coalesce(p_data, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $$;

-- 同時実行を避けるリース(期限切れなら奪える)
create or replace function public.lock_acquire(p_name text, p_seconds int, p_owner text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  insert into public.pipeline_lock(name, locked_until, owner)
  values (p_name, now() + make_interval(secs => p_seconds), p_owner)
  on conflict (name) do update
    set locked_until = excluded.locked_until, owner = excluded.owner
    where public.pipeline_lock.locked_until < now()
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

create or replace function public.lock_release(p_name text, p_owner text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.pipeline_lock set locked_until = now() - interval '1 second'
  where name = p_name and owner = p_owner
$$;
