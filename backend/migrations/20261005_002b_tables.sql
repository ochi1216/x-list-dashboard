-- 002b: 採点の全試行・長期スナップショット・ラベル・区分バッチ・冪等キー(すべてRLS有効・anon不可)

create table if not exists public.score_runs (
  id             bigint generated always as identity primary key,
  post_url       text not null,
  purpose        text not null default 'score',   -- score | rescore
  attempt        int  not null default 1,
  model          text not null,
  profile_version int,
  prompt_version text,
  score_raw      smallint,
  kind           text,
  interest       text,
  reason         text,
  evidence       text,                            -- 入力からの引用(最大40字)
  usage_id       bigint,
  created_at     timestamptz not null default now()
);
create index if not exists score_runs_post_idx on public.score_runs (post_url);
create index if not exists score_runs_created_idx on public.score_runs (created_at desc);

-- 7日削除後も残す点数の写し(本文は持たない)
create table if not exists public.post_scores (
  post_url        text primary key,
  author_handle   text,
  author_name     text,
  posted_at       timestamptz,
  fetched_at      timestamptz,
  batch_key       text,
  score           smallint,
  score_raw       smallint,
  score_kind      text,
  interest        text,
  cap_reason      text,
  score_state     text,
  listen_tier     text,
  tier_initial    text,
  manual_action   text,
  read_via        text,
  is_read         boolean,
  is_starred      boolean,
  scored_model    text,
  profile_version int,
  threshold_version int,
  body_len        int,
  has_image       boolean,
  dup_key         text,
  snapshot_at     timestamptz not null default now()
);
create index if not exists post_scores_author_idx on public.post_scores (author_handle, posted_at desc);
create index if not exists post_scores_posted_idx on public.post_scores (posted_at desc);
create index if not exists post_scores_dup_idx on public.post_scores (dup_key) where dup_key is not null;

create table if not exists public.tier_batches (
  batch_key     text primary key,
  day_start     timestamptz not null,
  slot          text not null,                    -- am | pm
  first_at      timestamptz not null,
  last_at       timestamptz not null,
  n_posts       int not null,
  n_listen      int not null default 0,
  n_skim        int not null default 0,
  n_hold        int not null default 0,
  alloc_sec     numeric not null default 0,
  used_sec      numeric not null default 0,
  threshold     int,
  threshold_version int,
  forced        boolean not null default false,
  finalized_at  timestamptz not null default now()
);
create index if not exists tier_batches_day_idx on public.tier_batches (day_start, slot);

-- 答え合わせ(正解データ)。本文スナップショットは6か月で本文を消す。AI点はUIに返さない(盲検)。
create table if not exists public.score_labels (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  list_no        int,
  slot           text,                            -- uniform | ai4 | ai3 | low | unscored | repeat
  post_url       text not null,
  author_handle  text,
  content        text,
  summary        text,
  image_urls     jsonb,
  inclusion_prob numeric,
  ai_score       smallint,
  ai_kind        text,
  ai_model       text,
  profile_version int,
  label_score    smallint check (label_score between 1 and 5),
  label_class    text check (label_class in ('announce','ref_only','opinion','other')),
  labeled_at     timestamptz,
  repeat_of      bigint
);
create index if not exists score_labels_list_idx on public.score_labels (list_no);

-- 端末に溜めた操作の再送を二重計上しないための冪等キー
create table if not exists public.admin_ops (
  op_id  text primary key,
  kind   text not null,
  at     timestamptz not null default now(),
  result jsonb
);

do $$
declare t text;
begin
  foreach t in array array['score_runs','post_scores','tier_batches','score_labels','admin_ops']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
