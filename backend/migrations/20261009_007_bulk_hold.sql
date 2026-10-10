-- 007: 保留の一括既読と取り消し(追加のみ。既存の表・関数は変更しない)
-- 内容: bulk_read_hold(p_dry) = 未読の保留(listen_tier='hold')を日付に関係なく全件、既読にする(read_via='user')。
--       p_dry=true は件数だけ返す。実行時は {n, at} を返し、at は取り消しに使う(1回の実行で全行が同じread_at)。
--       bulk_unread_hold(p_at) = 15分以内の一括既読(read_atがp_atと一致し read_via='user' のもの)だけを未読に戻す。
-- 権限: anon は x_posts.is_read を既に直接更新できる(002a)ため、権限の拡大にはならない。

create or replace function public.bulk_read_hold(p_dry boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_at timestamptz := now();
begin
  if p_dry then
    select count(*) into n from public.x_posts where listen_tier = 'hold' and not is_read;
    return jsonb_build_object('n', n);
  end if;
  update public.x_posts
     set is_read = true, read_via = 'user', read_at = v_at
   where listen_tier = 'hold' and not is_read;
  get diagnostics n = row_count;
  return jsonb_build_object('n', n, 'at', v_at);
end $$;

create or replace function public.bulk_unread_hold(p_at timestamptz)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_at is null or p_at < now() - interval '15 minutes' then
    return 0;
  end if;
  update public.x_posts
     set is_read = false, read_via = null, read_at = null
   where listen_tier = 'hold' and is_read and read_via = 'user'
     and abs(extract(epoch from (read_at - p_at))) < 0.001;
  get diagnostics n = row_count;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['bulk_read_hold(boolean)', 'bulk_unread_hold(timestamptz)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;
