-- 003b: 週次レポート(LLM不使用・SQLの結果をテンプレートで文章化)と未生成の検知

create or replace function public.weekly_report(p_week_start date default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ws date; v_start timestamptz; v_end timestamptz; v_rate numeric := public.cfg_num('usd_jpy', 160);
  m jsonb; c jsonb; l jsonb; v_missing int; v_ratio numeric; v_text text; v_body jsonb; v_warn text := '';
  n_scored int; n_hi int; ln int; lex int; lw1 int; ex_cnt int;
begin
  -- 既定=直近の完了した週(月曜02:00 JST起点)
  v_ws := coalesce(p_week_start, (date_trunc('week', (now() at time zone 'Asia/Tokyo') - interval '2 hours'))::date - 7);
  v_start := (v_ws::timestamp + interval '2 hours') at time zone 'Asia/Tokyo';
  v_end := v_start + interval '7 days';

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

  v_text := format('先週(%s月%s日から)の投稿は%s件、採点済みは%s件でした。4点以上は%s件(%s%%)。聴く%s件・流す%s件・保留%s件。手動の昇格%s件・降格%s件。Gemini費用は%s円。',
    to_char(v_ws, 'FMMM'), to_char(v_ws, 'FMDD'), m ->> 'posts', m ->> 'scored', n_hi,
    coalesce(round(v_ratio * 100)::text, '-'), m ->> 'listen', m ->> 'skim', m ->> 'hold',
    m ->> 'promote', m ->> 'demote', c ->> 'jpy');
  if v_ratio is not null and (v_ratio < 0.05 or v_ratio > 0.25) then
    v_warn := v_warn || '4点以上の割合が基準の5〜25%を外れています。';
    perform public.ops_event('warn', 'score_quality', '先週の4点以上の割合が基準を外れました',
                             jsonb_build_object('detail', 'ratio ' || round(v_ratio * 100) || '%'), 1440);
  end if;
  if v_missing > 0 then v_warn := v_warn || format('取得のない日が%s日ありました。', v_missing); end if;
  if ln < 30 then v_warn := v_warn || format('答え合わせは%s件で暫定です。', ln);
  else v_warn := v_warn || format('答え合わせとの一致(±1)は%s%%です。', round(100.0 * lw1 / ln)); end if;
  if ex_cnt > 0 then v_warn := v_warn || format('除外候補の投稿者が%s人います。', ex_cnt); end if;
  v_text := v_text || v_warn;

  v_body := jsonb_build_object('week_start', v_ws, 'metrics', m, 'cost', c, 'labels', l,
                               'missing_days', v_missing, 'high_ratio', v_ratio, 'exclude_candidates', ex_cnt);
  insert into public.weekly_reports(week_start, generated_at, body, text_ja)
  values (v_ws, now(), v_body, v_text)
  on conflict (week_start) do update set generated_at = now(), body = excluded.body, text_ja = excluded.text_ja;
  return v_body;
end $$;

-- 月曜12:00(JST)を過ぎても直近の完了週のレポートが無ければ記録(通知)
create or replace function public.weekly_report_check()
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws date := (date_trunc('week', (now() at time zone 'Asia/Tokyo') - interval '2 hours'))::date - 7;
begin
  if public.cfg('tier_scope_from') is null then return true; end if;
  if exists (select 1 from public.weekly_reports where week_start = v_ws) then return true; end if;
  perform public.ops_event('error', 'report_missing', '週次レポートが生成されていません',
                           jsonb_build_object('detail', 'week ' || v_ws::text), 1440);
  return false;
end $$;

do $$
declare f text;
begin
  foreach f in array array['weekly_report(date)', 'weekly_report_check()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
