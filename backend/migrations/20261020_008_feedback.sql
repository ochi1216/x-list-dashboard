-- 008: 👍👎フィードバック(第1段階=記録して測る。採点・区分・閾値・プロファイルは変更しない。追加のみ)
-- post_feedback: 投稿ごとに最新の評価1件(+1=AIの点数より上げたい / -1=下げたい)。本文は持たない。
--   押した時点のAI点数・採点モデル・プロファイル版を併記する(あとで同じ条件どうしで比べるため)。x_postsの整理(削除)の影響を受けない(外部キーなし)。
-- 権限: 表は anon から直接読み書きできない。書き込みは feedback_set、読み取りは feedback_list / feedback_report の関数だけ。

create table if not exists public.post_feedback (
  post_url        text primary key,
  value           smallint not null check (value in (-1, 1)),
  ai_score        int,
  scored_model    text,
  profile_version int,
  surface         text not null default 'unknown' check (surface in ('listen', 'flow', 'list', 'hold', 'unknown')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists post_feedback_updated_idx on public.post_feedback (updated_at desc);
alter table public.post_feedback enable row level security;
revoke all on table public.post_feedback from public, anon, authenticated;

-- 評価の保存(0=取り消し)。同じ投稿は上書き。投稿が存在しなければ保存しない。
create or replace function public.feedback_set(p_url text, p_value int, p_surface text default 'unknown')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_score int; v_model text; v_pv int; v_surface text;
begin
  if p_url is null or length(p_url) = 0 or length(p_url) > 2000 then raise exception 'invalid url'; end if;
  if p_value is null or p_value not in (-1, 0, 1) then raise exception 'invalid value'; end if;
  v_surface := case when p_surface in ('listen', 'flow', 'list', 'hold') then p_surface else 'unknown' end;
  if p_value = 0 then
    delete from public.post_feedback where post_url = p_url;
    return jsonb_build_object('ok', true, 'value', 0);
  end if;
  select score, scored_model, profile_version into v_score, v_model, v_pv from public.x_posts where post_url = p_url;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into public.post_feedback(post_url, value, ai_score, scored_model, profile_version, surface)
  values (p_url, p_value, v_score, v_model, v_pv, v_surface)
  on conflict (post_url) do update
    set value = excluded.value, ai_score = excluded.ai_score, scored_model = excluded.scored_model,
        profile_version = excluded.profile_version, surface = excluded.surface, updated_at = now();
  return jsonb_build_object('ok', true, 'value', p_value);
end $$;

-- 直近の評価の一覧(画面の「あなた: N」表示用)。最大2000件。
create or replace function public.feedback_list(p_days int default 30)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('url', post_url, 'v', value)), '[]'::jsonb)
  from (select post_url, value from public.post_feedback
         where updated_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
         order by updated_at desc limit 2000) t
$$;

-- 週次タブ用の集計: 件数・AI点数別・投稿者別(3件以上)。
create or replace function public.feedback_report(p_days int default 28)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_days int := greatest(1, least(coalesce(p_days, 28), 365)); r jsonb;
begin
  select jsonb_build_object(
    'days', v_days,
    'n', count(*), 'up', count(*) filter (where f.value = 1), 'down', count(*) filter (where f.value = -1),
    'by_ai', coalesce((select jsonb_agg(jsonb_build_object('score', s, 'n', n, 'up', up, 'down', dn) order by s desc nulls last)
                       from (select ai_score s, count(*) n, count(*) filter (where value = 1) up, count(*) filter (where value = -1) dn
                               from public.post_feedback where updated_at > now() - make_interval(days => v_days) group by 1) g), '[]'::jsonb),
    'authors', coalesce((select jsonb_agg(jsonb_build_object('handle', h, 'n', n, 'up', up, 'down', dn) order by n desc)
                         from (select p.author_handle h, count(*) n, count(*) filter (where f2.value = 1) up, count(*) filter (where f2.value = -1) dn
                                 from public.post_feedback f2 join public.x_posts p on p.post_url = f2.post_url
                                where f2.updated_at > now() - make_interval(days => v_days)
                                group by 1 having count(*) >= 3 order by 2 desc limit 10) a), '[]'::jsonb))
    into r
  from public.post_feedback f where f.updated_at > now() - make_interval(days => v_days);
  return r;
end $$;

do $$
declare f text;
begin
  foreach f in array array['feedback_set(text,int,text)', 'feedback_list(int)', 'feedback_report(int)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;
