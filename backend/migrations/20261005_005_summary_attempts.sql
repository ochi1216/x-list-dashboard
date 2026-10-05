-- 005: 要約の試行回数(失敗し続ける投稿を無限に再試行しない)。Edge Function(summarize-x-post)の配備と同時に適用する。
alter table public.x_posts add column if not exists summary_attempts smallint not null default 0;

-- x_tick: 要約の対象を summary_attempts < 3 に限定(それ以外は003cと同じ)
create or replace function public.x_tick()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_from timestamptz; v_scope timestamptz; r jsonb := '{}'::jsonb;
begin
  if public.cfg_bool('kill_switch', false) then
    return jsonb_build_object('kill', true);
  end if;
  if exists (select 1 from public.x_posts where gist is null and summary_attempts < 3
             and fetched_at > now() - interval '3 days' and fetched_at < now() - interval '1 minute') then
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
revoke all on function public.x_tick() from public, anon, authenticated;
grant execute on function public.x_tick() to service_role;
