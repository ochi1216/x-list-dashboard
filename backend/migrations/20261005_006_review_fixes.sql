-- 006: レビュー指摘の修正(冪等・create or replace・加算のみ。DELETE文は無い)
-- 適用順: 005 → 006。Edge Function(新関数・summarize-x-post)の配備より先に適用する(docs/RUNBOOK.md「デプロイ順」)。
-- 内容: F1 x_postsのanon書き込み権限を列単位へ / A finalize_tiers 完全版 / B author_scoreboard・weekly_report
--       / C notify_ops 二重送信防止・digest_due バックオフ・x_tick・x_hourly(警報追加)・x_daily・x_weekly
--       / N2 fetch_runs・digest_summaries の anon/authenticated 書き込み権限の剥奪

-- ---------------------------------------------------------------------------------------------
-- F1(致命): x_posts の anon / authenticated は INSERT・UPDATE・DELETE を表単位で持たない。
--   書けるのは is_read / is_starred の2列のUPDATEだけ。select権限とRLSは触らない。
--   mark_read(p_url,p_via) は SECURITY DEFINER のまま(read_via/read_at はこのRPC経由でのみ書ける)。
--   truncate / references / trigger も不要なので併せて外す(Supabaseの既定付与の取り残し対策)。
--   表単位のREVOKEは列単位の権限も外すので、直後に必要な2列だけ付け直す。何度流しても同じ結果。
-- ---------------------------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger on table public.x_posts from anon, authenticated;
grant update (is_read, is_starred) on table public.x_posts to anon, authenticated;

-- N2(重大): fetch_runs / digest_summaries も anon / authenticated は読み取り(SELECT)のみ。書き込み系はすべて外す。
--   書くのはEdge Function(service role)なので影響なし。SELECT権限は触らない。
revoke insert, update, delete, truncate, references, trigger on public.fetch_runs, public.digest_summaries from anon, authenticated;

-- 005の列(安全のため。既にあれば何もしない)
alter table public.x_posts add column if not exists summary_attempts smallint not null default 0;

-- ---------------------------------------------------------------------------------------------
-- A: finalize_tiers 完全版(001〜003cの定義を置き換える)
--  ① 未採点(pending)は「採点の対象で未処理」= score_state is null かつ not (summary is null and summary_attempts >= 3)。
--     要約不能な投稿が1件あるだけでバッチが4時間確定しない問題の解消。
--  ② score_enabled=false でも tier_assign_enabled=true なら確定する(この関数は元から score_enabled と独立)。
--  ③ 確定前の手動降格(manual_action='demote')→hold、昇格('promote')→listen。聴くの枠は消費しない。
--     tier_initial は手動を無視したアルゴリズム判定(score等から計算した区分)を保存し、listen_tier だけに手動結果を入れる。
--  ④ 既読(is_read)で score>=閾値 の投稿は聴くの枠を消費せず skim(tier_reason='already_read')。
--     (既読でも閾値未満なら従来どおり below_threshold / low_score / unscored のまま)
-- ---------------------------------------------------------------------------------------------
create or replace function public.finalize_tiers(p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_scope timestamptz; v_gap interval; v_quiet interval; v_confirm interval;
  v_thr int; v_tver int; v_quota numeric; v_cps numeric; v_speed numeric; v_morning numeric;
  b record; p record; v_key text; v_slot text; v_day timestamptz;
  v_alloc numeric; v_used numeric; v_est numeric; v_tier text; v_algo text; v_reason text;
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
      select post_url, fetched_at,
             (score_state is null and not (summary is null and summary_attempts >= 3)) as is_pending,
             lag(fetched_at) over (order by fetched_at, post_url) as prev_at
      from public.x_posts
      where batch_key is null and fetched_at >= v_scope
    ), g as (
      select *, sum(case when prev_at is null or fetched_at - prev_at > v_gap then 1 else 0 end)
                over (order by fetched_at, post_url) as grp
      from u
    )
    select grp, min(fetched_at) as first_at, max(fetched_at) as last_at, count(*) as n,
           count(*) filter (where is_pending) as pending
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
      select post_url, score, is_read, manual_action,
             coalesce(length(gist), 0) + coalesce(length(summary), 0) as chars
      from public.x_posts
      where batch_key is null and fetched_at >= v_scope and fetched_at between b.first_at and b.last_at
      order by score desc nulls last, coalesce(posted_at, fetched_at) desc, post_url
    loop
      v_est := p.chars / (v_cps * v_speed);
      -- アルゴリズム判定(手動操作を無視した区分)。tier_initial はこれを保存する(評価の分母を歪めない)。
      -- 手動昇降格の投稿は枠を消費しない(枠に収まるかは見るだけ)。
      if p.score is null then
        v_algo := 'skim'; v_reason := 'unscored';
      elsif p.score >= v_thr and p.is_read then
        v_algo := 'skim'; v_reason := 'already_read';                     -- 既読は枠を消費しない
      elsif p.score >= v_thr and v_used + v_est <= v_alloc then
        v_algo := 'listen'; v_reason := 'score>=' || v_thr;
      elsif p.score >= v_thr then
        v_algo := 'skim'; v_reason := 'quota';
      elsif p.score >= 3 then
        v_algo := 'skim'; v_reason := 'below_threshold';
      else
        v_algo := 'hold'; v_reason := 'low_score';
      end if;
      if p.manual_action = 'demote' then
        v_tier := 'hold'; v_reason := 'manual_demote';                    -- 手動降格を尊重(枠は消費しない)
      elsif p.manual_action = 'promote' then
        v_tier := 'listen'; v_reason := 'manual_promote';                 -- 手動昇格を尊重(枠は消費しない)
      else
        v_tier := v_algo;
        if v_tier = 'listen' then v_used := v_used + v_est; end if;
      end if;
      update public.x_posts
         set batch_key = v_key, listen_tier = v_tier, tier_initial = v_algo, tier_reason = v_reason,
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

-- ---------------------------------------------------------------------------------------------
-- B: author_scoreboard
--  採点モデル・プロファイル版の条件は score_state='scored' の行にだけ課す。
--  score_state='rule'(重複・本文なし。コードで点を付けるのでモデルもプロファイルも無関係)は常に母集団に含める。
--  score_state='skipped'(短文日本語)は score が NULL なので除外のまま。件数 n・scored_n にも含めない。
--  基準のモデル/版は「最新のscored行」から決める(rule行は scored_model が空なので基準に使わない)。
-- ---------------------------------------------------------------------------------------------
create or replace function public.author_scoreboard(p_weeks int default 4)
returns table (author_handle text, author_name text, n int, scored_n int, low_n int, high_n int, promotes int,
               low_rate numeric, high_rate numeric, low_lo numeric, high_hi numeric, mean numeric, verdict text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_model text; v_pv int;
begin
  select ps.scored_model, ps.profile_version into v_model, v_pv
    from public.post_scores ps
   where ps.score is not null and ps.score_state is distinct from 'rule' and ps.score_state is distinct from 'skipped'
   order by ps.posted_at desc nulls last limit 1;
  return query
  with b as (
    select ps.* from public.post_scores ps
    where ps.posted_at >= now() - make_interval(weeks => p_weeks)
      and ps.score is not null
      and (ps.score_state = 'rule'
           or (ps.scored_model is not distinct from v_model and ps.profile_version is not distinct from v_pv))
  ), a as (
    select b.author_handle as ah, max(b.author_name) as an, count(*)::int as cnt,
           count(*) filter (where b.score <= 2)::int as lown, count(*) filter (where b.score >= 4)::int as highn,
           count(*) filter (where b.manual_action = 'promote')::int as prom, avg(b.score) as m
    from b group by b.author_handle)
  select a.ah, a.an, a.cnt, a.cnt, a.lown, a.highn, a.prom,
         round(a.lown::numeric / a.cnt, 3), round(a.highn::numeric / a.cnt, 3),
         round(public.wilson_lo(a.lown, a.cnt), 3), round(public.wilson_hi(a.highn, a.cnt), 3), round(a.m, 2),
         case when a.cnt < 12 then 'hold'
              when public.wilson_lo(a.lown, a.cnt) >= 0.6 and a.prom = 0 then 'exclude_candidate'
              else 'keep' end
  from a order by a.lown desc, a.cnt desc;
end $$;

-- weekly_report: 週ラベルは常に「n月n日からの週」(p_week_start指定時も正しい)。4点以上の割合がNULLなら割合は出さない。
--  除外候補数は author_scoreboard(直近4週・現在時点)で数えるため、文面は「現在の」と明記する。
create or replace function public.weekly_report(p_week_start date default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws date; v_start timestamptz; v_end timestamptz; v_rate numeric := public.cfg_num('usd_jpy', 160);
  m jsonb; c jsonb; l jsonb; v_missing int; v_ratio numeric; v_text text; v_body jsonb; v_warn text := '';
  n_scored int; n_hi int; ln int; lex int; lw1 int; ex_cnt int; v_hi_txt text; v_wk text;
begin
  -- 既定=直近の完了した週(月曜02:00 JST起点)
  v_ws := coalesce(p_week_start, (date_trunc('week', (now() at time zone 'Asia/Tokyo') - interval '2 hours'))::date - 7);
  v_start := (v_ws::timestamp + interval '2 hours') at time zone 'Asia/Tokyo';
  v_end := v_start + interval '7 days';
  v_wk := to_char(v_ws, 'FMMM') || '月' || to_char(v_ws, 'FMDD') || '日からの週';

  select jsonb_build_object(
    'posts', count(*), 'scored', count(*) filter (where score is not null), 'unscored', count(*) filter (where score is null),
    'dist', jsonb_build_object('1', count(*) filter (where score = 1), '2', count(*) filter (where score = 2),
                               '3', count(*) filter (where score = 3), '4', count(*) filter (where score = 4),
                               '5', count(*) filter (where score = 5)),
    'listen', count(*) filter (where tier_initial = 'listen'), 'skim', count(*) filter (where tier_initial = 'skim'),
    'hold', count(*) filter (where tier_initial = 'hold'),
    'promote', count(*) filter (where manual_action = 'promote'), 'demote', count(*) filter (where manual_action = 'demote'),
    'read_listen', count(*) filter (where read_via = 'listen'), 'read_flow', count(*) filter (where read_via = 'flow'),
    'read_user', count(*) filter (where read_via = 'user'), 'read_auto', count(*) filter (where read_via = 'auto72h'))
    into m
  from public.post_scores where fetched_at >= v_start and fetched_at < v_end;

  select jsonb_build_object('jpy', round(coalesce(sum(cost_usd), 0) * v_rate, 1), 'calls', count(*),
                            'errors', count(*) filter (where status = 'error'))
    into c
  from public.llm_usage where grp = 'x' and called_at >= v_start and called_at < v_end;

  select count(*) into v_missing from generate_series(0, 6) d
   where not exists (select 1 from public.tier_batches b
                     where b.first_at >= v_start + d * interval '1 day' and b.first_at < v_start + (d + 1) * interval '1 day');

  select count(*), count(*) filter (where label_score = ai_score), count(*) filter (where abs(label_score - ai_score) <= 1)
    into ln, lex, lw1
  from public.score_labels
  where label_score is not null and repeat_of is null and ai_score is not null and labeled_at >= v_end - interval '28 days';
  l := jsonb_build_object('n', ln, 'exact', lex, 'within1', lw1);

  n_scored := (m ->> 'scored')::int;
  n_hi := coalesce((m -> 'dist' ->> '4')::int, 0) + coalesce((m -> 'dist' ->> '5')::int, 0);
  v_ratio := case when n_scored > 0 then round(n_hi::numeric / n_scored, 3) else null end;
  select count(*) into ex_cnt from public.author_scoreboard(4) where verdict = 'exclude_candidate';

  v_hi_txt := case when v_ratio is null then '' else format('(%s%%)', round(v_ratio * 100)) end;
  v_text := format('%sの投稿は%s件、採点済みは%s件でした。4点以上は%s件%s。聴く%s件・流す%s件・保留%s件。手動の昇格%s件・降格%s件。Gemini費用は%s円。',
    v_wk, m ->> 'posts', m ->> 'scored', n_hi, v_hi_txt, m ->> 'listen', m ->> 'skim', m ->> 'hold',
    m ->> 'promote', m ->> 'demote', c ->> 'jpy');
  if v_ratio is not null and (v_ratio < 0.05 or v_ratio > 0.25) then
    v_warn := v_warn || '4点以上の割合が基準の5〜25%を外れています。';
    perform public.ops_event('warn', 'score_quality', '4点以上の割合が基準を外れました(' || v_wk || ')',
                             jsonb_build_object('detail', 'ratio ' || round(v_ratio * 100) || '%'), 1440);
  end if;
  if v_missing > 0 then v_warn := v_warn || format('取得のない日が%s日ありました。', v_missing); end if;
  if ln < 30 then v_warn := v_warn || format('答え合わせは%s件で暫定です。', ln);
  else v_warn := v_warn || format('答え合わせとの一致(±1)は%s%%です。', round(100.0 * lw1 / ln)); end if;
  if ex_cnt > 0 then v_warn := v_warn || format('現在の除外候補の投稿者(直近4週)が%s人います。', ex_cnt); end if;
  v_text := v_text || v_warn;

  v_body := jsonb_build_object('week_start', v_ws, 'metrics', m, 'cost', c, 'labels', l,
                               'missing_days', v_missing, 'high_ratio', v_ratio, 'exclude_candidates', ex_cnt);
  insert into public.weekly_reports(week_start, generated_at, body, text_ja)
  values (v_ws, now(), v_body, v_text)
  on conflict (week_start) do update set generated_at = now(), body = excluded.body, text_ja = excluded.text_ja;
  return v_body;
end $$;

-- create_label_list の上限は60のまま(003a。admin-api側が60に揃える)。

-- ---------------------------------------------------------------------------------------------
-- C: notify_ops 二重送信防止。x_tick と x_hourly が同時に走っても同じ通知を2回送らない。
--    ロックが取れなければ何もせず0を返す(取れなかった側の分は、先行側が送る/次回の実行が拾う)。
-- ---------------------------------------------------------------------------------------------
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

-- digest_due: Edge側(digest.ts の runToday)と基準を揃える。条件は次の2つだけ(failed/paused 行の有無は見ない)。
--   ① tuning_config 'digest_last_attempt_at'(ISO文字列。Edge側が各試行の開始時に書く)から30分以内なら false(失敗の連打防止)
--   ② 当日の ok/empty 行の generated_at から digest_min_interval_hours 以内なら false
--   そのうえで「前回生成以降に区分確定があり、score>=3 の新規が digest_min_new_scored 件以上」なら true。
create or replace function public.digest_due()
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_day_start timestamptz := public.jst_day2_start(now());
  v_day date := (public.jst_day2_start(now()) at time zone 'Asia/Tokyo')::date;
  v_last timestamptz; v_new int; v_attempt timestamptz;
begin
  if public.cfg('tier_scope_from') is null then return false; end if;
  begin
    v_attempt := (public.cfg('digest_last_attempt_at') #>> '{}')::timestamptz;
  exception when others then
    v_attempt := null;
  end;
  if v_attempt is not null and now() - v_attempt < interval '30 minutes' then return false; end if;
  select generated_at into v_last from public.digest_daily where day = v_day and status in ('ok', 'empty');
  if v_last is not null and now() - v_last < make_interval(secs => (public.cfg_num('digest_min_interval_hours', 6) * 3600)::int) then
    return false;
  end if;
  if not exists (select 1 from public.tier_batches where finalized_at > coalesce(v_last, v_day_start)) then return false; end if;
  select count(*) into v_new from public.x_posts
   where score >= 3 and scored_at > coalesce(v_last, v_day_start) and fetched_at >= v_day_start;
  return v_new >= public.cfg_num('digest_min_new_scored', 5);
end $$;

-- x_tick(005を置き換え)
--  ① 採点の起動条件(未採点・読み下し待ち)は score_enabled=true の時だけ。区分確定のための起動条件
--     (batch_key is null)は score_enabled に縛らない(false でも score-x-posts を呼び、関数側が採点だけ飛ばす)。
--     ただし tier_assign_enabled=false なら確定は行われないので呼ばない(空振り防止)。
--  ② 要約は summary_attempts < 3 のものだけ(005と同じ)。
--  ③ 読み下し待ちは speech_at is null のまま(Edge側が失敗時も speech_at を書く)。speech_attempts は使わない。
create or replace function public.x_tick()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_from timestamptz; v_scope timestamptz; r jsonb := '{}'::jsonb; v_call boolean;
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
  v_call := false;
  if v_from is not null and public.cfg_bool('score_enabled', true) and (
       exists (select 1 from public.x_posts where summary is not null and score_state is null
               and score_attempts < 3 and fetched_at >= v_from)
    or (public.cfg_bool('speech_enabled', true) and exists (
          select 1 from public.x_posts where listen_tier = 'listen' and speech_body is null and speech_at is null and not is_read))) then
    v_call := true;
  end if;
  if not v_call and v_scope is not null and public.cfg_bool('tier_assign_enabled', true)
     and exists (select 1 from public.x_posts where batch_key is null and fetched_at >= v_scope) then
    v_call := true;
  end if;
  if v_call then
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

-- x_hourly(003cを置き換え): 003cの処理に警報2つを追加
--  ・llm_error_rate: 直近1時間のllm_usageでエラー率50%以上(呼び出し10回以上のとき)
--  ・tier_stalled: batch_key が null のまま、最初の投稿から batch_confirm_hours(既定4)+5分を超えた投稿群が残っている
--    (強制確定は x_tick(5分ごと)が拾うので、確定時刻ちょうどに警報すると毎回誤報になる。5分の余裕を持たせる)
--    (tier_scope_from が未設定、または tier_assign_enabled=false の間は確定しないのが正常なので出さない)
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
  if v_last_fetch is not null and v_last_fetch < now() - interval '20 hours' then
    perform public.ops_event('warn', 'fetch_stale', 'Xの取得が20時間以上ありません',
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

-- x_daily(毎日05:00 JST): モデル確認・今週の流れの日次更新・整理・死活信号
create or replace function public.x_daily()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.call_fn('model-health', '{}'::jsonb, 120000);
  perform public.call_fn('generate-digest-summary', jsonb_build_object('period_type', 'week'));
  perform public.llm_usage_retention();
  update public.score_labels set content = null, summary = null, image_urls = null
   where created_at < now() - interval '6 months' and content is not null;
  perform public.ping_healthcheck('daily');
end $$;

-- x_weekly(日曜18:45 UTC=月曜03:45 JST): 週次レポートのみ
create or replace function public.x_weekly()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.weekly_report();
  perform public.ping_healthcheck('weekly');
end $$;

-- 実行権限(create or replaceは既存の権限を保つが、念のため明示。サービスロールのみ)
do $$
declare f text;
begin
  foreach f in array array['finalize_tiers(boolean)', 'author_scoreboard(int)', 'weekly_report(date)', 'notify_ops()',
                           'digest_due()', 'x_tick()', 'x_hourly()', 'x_daily()', 'x_weekly()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
