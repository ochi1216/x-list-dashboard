-- 002c: 区分(聴く/流す/保留)の確定・維持・スナップショット(すべてサービスロール専用)

-- 日の区切りは02:00(JST)
create or replace function public.jst_day2_start(p_ts timestamptz default now())
returns timestamptz language sql stable set search_path = public, pg_temp as $$
  select (date_trunc('day', (p_ts at time zone 'Asia/Tokyo') - interval '2 hours') + interval '2 hours') at time zone 'Asia/Tokyo'
$$;

-- 取得バッチごとに区分を確定する。tier_scope_from 以降のbatch_key未設定の投稿だけが対象。
--  バッチ = fetched_at の空きが batch_gap_minutes 未満で連なる投稿のまとまり(fetch_runsには依存しない)
--  確定条件 = 最後のINSERTから batch_quiet_minutes 静止 かつ (未採点が無い または 最初の投稿から batch_confirm_hours 経過)
--  聴く = 閾値以上かつ枠内(点数順・同点は新しい順)、流す = 3点以上の残り・未採点、保留 = 2点以下
create or replace function public.finalize_tiers(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_scope timestamptz; v_gap interval; v_quiet interval; v_confirm interval;
  v_thr int; v_tver int; v_quota numeric; v_cps numeric; v_speed numeric; v_morning numeric;
  b record; p record; v_key text; v_slot text; v_day timestamptz;
  v_alloc numeric; v_used numeric; v_est numeric; v_tier text; v_reason text;
  v_nl int; v_ns int; v_nh int; v_forced boolean; v_am_used numeric; v_day_used numeric; v_slot_used numeric;
  v_out jsonb := '[]'::jsonb;
begin
  begin
    v_scope := (public.cfg('tier_scope_from') #>> '{}')::timestamptz;
  exception when others then
    v_scope := null;
  end;
  if v_scope is null or not public.cfg_bool('tier_assign_enabled', true) then
    return jsonb_build_object('skipped', true);
  end if;
  perform pg_advisory_xact_lock(hashtext('finalize_tiers'));

  v_gap     := make_interval(mins  => public.cfg_num('batch_gap_minutes', 90)::int);
  v_quiet   := make_interval(mins  => public.cfg_num('batch_quiet_minutes', 20)::int);
  v_confirm := make_interval(hours => public.cfg_num('batch_confirm_hours', 4)::int);
  v_thr     := public.cfg_num('listen_threshold', 4)::int;
  v_tver    := public.cfg_num('threshold_version', 1)::int;
  v_quota   := public.cfg_num('listen_quota_min', 10);
  v_cps     := greatest(public.cfg_num('listen_chars_per_sec', 6.5), 1);
  v_speed   := greatest(public.cfg_num('listen_speed', 1.2), 0.5);
  v_morning := public.cfg_num('listen_morning_share', 0.6);

  for b in
    with u as (
      select post_url, fetched_at, score_state,
             lag(fetched_at) over (order by fetched_at, post_url) as prev_at
      from public.x_posts
      where batch_key is null and fetched_at >= v_scope
    ), g as (
      select *, sum(case when prev_at is null or fetched_at - prev_at > v_gap then 1 else 0 end)
                over (order by fetched_at, post_url) as grp
      from u
    )
    select grp, min(fetched_at) as first_at, max(fetched_at) as last_at, count(*) as n,
           count(*) filter (where score_state is null) as pending
    from g group by grp order by grp
  loop
    v_forced := false;
    if not p_force then
      if now() - b.last_at < v_quiet then continue; end if;
      if b.pending > 0 then
        if now() - b.first_at < v_confirm then continue; end if;
        v_forced := true;
      end if;
    else
      v_forced := b.pending > 0;
    end if;

    v_key  := 'b' || to_char(b.first_at at time zone 'UTC', 'YYYYMMDD"T"HH24MISS');
    v_day  := public.jst_day2_start(b.first_at);
    v_slot := case when extract(hour from (b.first_at at time zone 'Asia/Tokyo')) between 2 and 11 then 'am' else 'pm' end;

    select coalesce(sum(used_sec) filter (where slot = 'am'), 0), coalesce(sum(used_sec), 0),
           coalesce(sum(used_sec) filter (where slot = v_slot), 0)
      into v_am_used, v_day_used, v_slot_used
      from public.tier_batches where day_start = v_day;
    if v_slot = 'am' then
      v_alloc := greatest(0, v_quota * 60 * v_morning - v_slot_used);
    else
      v_alloc := greatest(0, v_quota * 60 - v_day_used);
    end if;

    v_used := 0; v_nl := 0; v_ns := 0; v_nh := 0;
    for p in
      select post_url, score, coalesce(length(gist), 0) + coalesce(length(summary), 0) as chars
      from public.x_posts
      where batch_key is null and fetched_at >= v_scope and fetched_at between b.first_at and b.last_at
      order by score desc nulls last, coalesce(posted_at, fetched_at) desc, post_url
    loop
      v_est := p.chars / (v_cps * v_speed);
      if p.score is null then
        v_tier := 'skim'; v_reason := 'unscored';
      elsif p.score >= v_thr and v_used + v_est <= v_alloc then
        v_tier := 'listen'; v_reason := 'score>=' || v_thr; v_used := v_used + v_est;
      elsif p.score >= v_thr then
        v_tier := 'skim'; v_reason := 'quota';
      elsif p.score >= 3 then
        v_tier := 'skim'; v_reason := 'below_threshold';
      else
        v_tier := 'hold'; v_reason := 'low_score';
      end if;
      update public.x_posts
         set batch_key = v_key, listen_tier = v_tier, tier_initial = v_tier, tier_reason = v_reason,
             tier_assigned_at = now(), threshold_version = v_tver
       where post_url = p.post_url;
      if v_tier = 'listen' then v_nl := v_nl + 1; elsif v_tier = 'skim' then v_ns := v_ns + 1; else v_nh := v_nh + 1; end if;
    end loop;

    insert into public.tier_batches(batch_key, day_start, slot, first_at, last_at, n_posts, n_listen, n_skim, n_hold,
                                    alloc_sec, used_sec, threshold, threshold_version, forced)
    values (v_key, v_day, v_slot, b.first_at, b.last_at, v_nl + v_ns + v_nh, v_nl, v_ns, v_nh,
            round(v_alloc), round(v_used), v_thr, v_tver, v_forced)
    on conflict (batch_key) do update
      set n_posts = public.tier_batches.n_posts + excluded.n_posts,
          n_listen = public.tier_batches.n_listen + excluded.n_listen,
          n_skim = public.tier_batches.n_skim + excluded.n_skim,
          n_hold = public.tier_batches.n_hold + excluded.n_hold,
          used_sec = public.tier_batches.used_sec + excluded.used_sec;
    v_out := v_out || jsonb_build_array(jsonb_build_object('batch', v_key, 'slot', v_slot, 'n', v_nl + v_ns + v_nh,
                       'listen', v_nl, 'skim', v_ns, 'hold', v_nh, 'alloc_sec', round(v_alloc), 'used_sec', round(v_used),
                       'forced', v_forced));
  end loop;
  return jsonb_build_object('batches', v_out);
end $$;

-- 毎時: 聴くの失効(24時間で流すへ)と、流す・保留の既読化(72時間。フラグがtrueの時だけ・1回の上限つき)
create or replace function public.tier_maintenance()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n_demoted int := 0; n_read int := 0; v_max int;
begin
  update public.x_posts
     set listen_tier = 'skim', tier_reason = 'expired', tier_assigned_at = now()
   where listen_tier = 'listen' and not is_read
     and tier_assigned_at < now() - make_interval(hours => public.cfg_num('expire_listen_hours', 24)::int);
  get diagnostics n_demoted = row_count;

  if public.cfg_bool('auto_expire_enabled', false) then
    v_max := public.cfg_num('auto_expire_max_per_run', 400)::int;
    with c as (
      select post_url from public.x_posts
      where listen_tier in ('skim', 'hold') and not is_read
        and tier_assigned_at < now() - make_interval(hours => public.cfg_num('expire_flow_hours', 72)::int)
      order by tier_assigned_at limit v_max)
    update public.x_posts x
       set is_read = true, read_via = 'auto72h', read_at = now()
      from c where x.post_url = c.post_url;
    get diagnostics n_read = row_count;
  end if;
  return jsonb_build_object('demoted', n_demoted, 'auto_read', n_read);
end $$;

-- 採点済み・区分済みの投稿の点数を長期保持用テーブルへ写す(本文は持たない)
create or replace function public.snapshot_post_scores()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into public.post_scores(post_url, author_handle, author_name, posted_at, fetched_at, batch_key, score, score_raw,
         score_kind, interest, cap_reason, score_state, listen_tier, tier_initial, manual_action, read_via, is_read,
         is_starred, scored_model, profile_version, threshold_version, body_len, has_image, dup_key, snapshot_at)
  select post_url, author_handle, author_name, posted_at, fetched_at, batch_key, score, score_raw,
         score_kind, interest, cap_reason, score_state, listen_tier, tier_initial, manual_action, read_via, is_read,
         is_starred, scored_model, profile_version, threshold_version, length(coalesce(content, '')),
         coalesce(array_length(image_urls, 1), 0) > 0, dup_key, now()
  from public.x_posts
  where score_state is not null or batch_key is not null
  on conflict (post_url) do update
    set batch_key = excluded.batch_key, score = excluded.score, score_raw = excluded.score_raw,
        score_kind = excluded.score_kind, interest = excluded.interest, cap_reason = excluded.cap_reason,
        score_state = excluded.score_state, listen_tier = excluded.listen_tier, tier_initial = excluded.tier_initial,
        manual_action = excluded.manual_action, read_via = excluded.read_via, is_read = excluded.is_read,
        is_starred = excluded.is_starred, scored_model = excluded.scored_model,
        profile_version = excluded.profile_version, threshold_version = excluded.threshold_version,
        dup_key = excluded.dup_key, snapshot_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- 既読7日超の削除は既存cron(jobid 5)のまま。post_scoresへの写しは毎時:30と、削除の5分前(04:55 UTC)に実行して先行させる。

do $$
declare f text;
begin
  foreach f in array array['jst_day2_start(timestamptz)', 'finalize_tiers(boolean)', 'tier_maintenance()',
                           'snapshot_post_scores()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
