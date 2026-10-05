-- 003a: ダイジェスト保存・週次レポート・通信簿・答え合わせの抽出(サービスロール専用。digest_daily/digest_weekのみ匿名読み取り可)

create table if not exists public.digest_daily (
  day           date primary key,                 -- JSTの02:00区切りの日
  generated_at  timestamptz not null default now(),
  model         text,
  status        text not null default 'ok',       -- ok | empty | failed | paused
  topics        jsonb not null default '[]'::jsonb,
  input_count   int not null default 0,
  dropped_ratio numeric,
  version       int not null default 1
);
create table if not exists public.digest_week (
  week_start    date primary key,                 -- 02:00 JST区切りの月曜
  generated_at  timestamptz not null default now(),
  status        text not null default 'ok',       -- ok | accumulating | failed | paused
  themes        jsonb not null default '[]'::jsonb,
  days_covered  int not null default 0
);
create table if not exists public.weekly_reports (
  week_start    date primary key,
  generated_at  timestamptz not null default now(),
  body          jsonb not null default '{}'::jsonb,
  text_ja       text
);

alter table public.digest_daily enable row level security;
alter table public.digest_week enable row level security;
alter table public.weekly_reports enable row level security;
revoke all on table public.digest_daily, public.digest_week, public.weekly_reports from anon, authenticated;
grant select on table public.digest_daily, public.digest_week to anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'digest_daily' and policyname = 'digest_daily_read') then
    create policy digest_daily_read on public.digest_daily for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'digest_week' and policyname = 'digest_week_read') then
    create policy digest_week_read on public.digest_week for select to anon, authenticated using (true);
  end if;
end $$;

-- Wilson区間
create or replace function public.wilson_lo(k numeric, n numeric)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  select case when n <= 0 then 0::numeric else
    ((k / n) + 1.9208 / n - 1.96 * sqrt(((k / n) * (1 - k / n) + 0.9604 / n) / n)) / (1 + 3.8416 / n) end
$$;
create or replace function public.wilson_hi(k numeric, n numeric)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  select case when n <= 0 then 1::numeric else
    ((k / n) + 1.9208 / n + 1.96 * sqrt(((k / n) * (1 - k / n) + 0.9604 / n) / n)) / (1 + 3.8416 / n) end
$$;

-- 投稿者の通信簿(直近p_weeks週。同じ採点モデル・同じプロファイル版の行だけ。最小12件未満は判定保留)
create or replace function public.author_scoreboard(p_weeks int default 4)
returns table (author_handle text, author_name text, n int, scored_n int, low_n int, high_n int, promotes int,
               low_rate numeric, high_rate numeric, low_lo numeric, high_hi numeric, mean numeric, verdict text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_model text; v_pv int;
begin
  select ps.scored_model, ps.profile_version into v_model, v_pv
    from public.post_scores ps where ps.score is not null order by ps.posted_at desc nulls last limit 1;
  return query
  with b as (
    select ps.* from public.post_scores ps
    where ps.posted_at >= now() - make_interval(weeks => p_weeks)
      and ps.score is not null
      and ps.scored_model is not distinct from v_model
      and ps.profile_version is not distinct from v_pv
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

-- 答え合わせリストの作成(盲検・層化+一様ランダム)。全投稿の抽出確率は0より大きい。
-- 重複・本文なしは除外。包含確率は 1-(1-一様の率)(1-層の率) で近似して保存する。
create or replace function public.create_label_list(p_n int default 20)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_list int; v_pool int; n_u int; n_4 int; n_3 int; n_l int; n_x int; v_rep int := 0; s text; n_s int; v_made int := 0;
begin
  if p_n < 1 or p_n > 60 then raise exception 'p_n out of range'; end if;
  select coalesce(max(list_no), 0) + 1 into v_list from public.score_labels;
  create temp table _lbl_pool on commit drop as
    select p.post_url, p.author_handle, p.content, p.summary, to_jsonb(p.image_urls) as image_urls, p.score, p.score_kind,
           p.scored_model, p.profile_version,
           case when p.score >= 4 then 'ai4' when p.score = 3 then 'ai3' when p.score is not null then 'low' else 'unscored' end as stratum
    from public.x_posts p
    where coalesce(p.content, '') <> '' and coalesce(p.score_kind, '') not in ('duplicate', 'none')
      and not exists (select 1 from public.score_labels l where l.post_url = p.post_url);
  select count(*) into v_pool from _lbl_pool;
  if v_pool = 0 then
    return jsonb_build_object('list_no', v_list, 'created', 0);
  end if;
  -- 過去ラベルの再提示(自己一致の測定): 2日以上前に答えた1件
  if p_n >= 5 and exists (select 1 from public.score_labels where label_score is not null and labeled_at < now() - interval '2 days') then
    v_rep := 1;
  end if;
  n_u := round((p_n - v_rep) * 0.4); n_4 := round((p_n - v_rep) * 0.25); n_3 := round((p_n - v_rep) * 0.15);
  n_l := round((p_n - v_rep) * 0.12); n_x := (p_n - v_rep) - n_u - n_4 - n_3 - n_l;
  create temp table _lbl_pick (post_url text primary key, slot text not null, p_s numeric not null) on commit drop;
  insert into _lbl_pick select post_url, 'uniform', 0 from _lbl_pool order by random() limit n_u;
  for s, n_s in select * from (values ('ai4', n_4), ('ai3', n_3), ('low', n_l), ('unscored', n_x)) as t(s, n_s) loop
    insert into _lbl_pick
      select post_url, s, least(1, n_s::numeric / greatest((select count(*) from _lbl_pool where stratum = s), 1))
      from _lbl_pool where stratum = s and post_url not in (select post_url from _lbl_pick)
      order by random() limit n_s;
  end loop;
  insert into public.score_labels(list_no, slot, post_url, author_handle, content, summary, image_urls, inclusion_prob,
                                  ai_score, ai_kind, ai_model, profile_version)
  select v_list, k.slot, p.post_url, p.author_handle, p.content, p.summary, p.image_urls,
         round(1 - (1 - least(1, n_u::numeric / v_pool)) *
                   (1 - least(1, (case p.stratum when 'ai4' then n_4 when 'ai3' then n_3 when 'low' then n_l else n_x end)::numeric
                                 / greatest((select count(*) from _lbl_pool q where q.stratum = p.stratum), 1))), 5),
         p.score, p.score_kind, p.scored_model, p.profile_version
  from _lbl_pick k join _lbl_pool p using (post_url)
  order by random();
  get diagnostics v_made = row_count;
  if v_rep = 1 then
    insert into public.score_labels(list_no, slot, post_url, author_handle, content, summary, image_urls, inclusion_prob,
                                    ai_score, ai_kind, ai_model, profile_version, repeat_of)
    select v_list, 'repeat', post_url, author_handle, content, summary, image_urls, inclusion_prob,
           ai_score, ai_kind, ai_model, profile_version, id
    from public.score_labels where label_score is not null and labeled_at < now() - interval '2 days' and repeat_of is null
    order by random() limit 1;
    v_made := v_made + 1;
  end if;
  return jsonb_build_object('list_no', v_list, 'created', v_made);
end $$;

do $$
declare f text;
begin
  foreach f in array array['wilson_lo(numeric,numeric)', 'wilson_hi(numeric,numeric)', 'author_scoreboard(int)', 'create_label_list(int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
