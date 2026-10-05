-- 002a: x_posts へ採点・区分・読み下し・参照先の列を加算(すべてnullable。新しい列は初めからanon書き込み不可)
-- 既存の動作は変えない。anonの書き込み権限は is_read / is_starred のみのまま(mark_read RPCは下で別に許可)。

alter table public.x_posts
  add column if not exists score            smallint,      -- 採用した点(1〜5)
  add column if not exists score_raw        smallint,      -- 上限(キャップ)適用前の点
  add column if not exists score_kind       text,          -- duplicate|announce|ref_only|primary|news|numbers|howto|explain|opinion|none
  add column if not exists score_reason     text,          -- 20字以内の理由
  add column if not exists cap_reason       text,          -- 上限を適用した理由(dup/none/announce/announce_conflict/ref_only/no_evidence/injection/opinion_would_cap)
  add column if not exists interest         text,          -- 関心プロファイルのid(W1..、無ければX)
  add column if not exists score_state      text,          -- null=未処理 | scored | rule | skipped | failed
  add column if not exists scored_model     text,
  add column if not exists scored_at        timestamptz,
  add column if not exists profile_version  int,
  add column if not exists score_attempts   smallint not null default 0,
  add column if not exists speech_title     text,          -- 音声用の読み下し(聴くカードのみ生成)
  add column if not exists speech_body      text,
  add column if not exists speech_model     text,
  add column if not exists speech_at        timestamptz,
  add column if not exists dup_key          text,          -- 投稿者×正規化本文のハッシュ(重複判定)
  add column if not exists batch_key        text,          -- 取得バッチ(区分確定の単位)
  add column if not exists listen_tier      text,          -- listen | skim | hold
  add column if not exists tier_reason      text,
  add column if not exists tier_assigned_at timestamptz,   -- 現在の区分になった時刻(72時間/24時間の起点)
  add column if not exists tier_initial     text,          -- 確定時の区分(不変。評価に使う)
  add column if not exists threshold_version int,
  add column if not exists manual_action    text,          -- promote | demote
  add column if not exists manual_at        timestamptz,
  add column if not exists read_via         text,          -- user | listen | flow | auto72h
  add column if not exists read_at          timestamptz,
  -- Phase 5 の受け皿(列のみ。取得側が書き込むまで空。url_context取得処理は置かない)
  add column if not exists ref_url          text,
  add column if not exists ref_title        text,
  add column if not exists ref_desc         text,
  add column if not exists quoted_text      text,
  add column if not exists ref_status       text,
  add column if not exists ref_summary      text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'x_posts_score_chk') then
    alter table public.x_posts add constraint x_posts_score_chk check (score is null or score between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'x_posts_tier_chk') then
    alter table public.x_posts add constraint x_posts_tier_chk check (listen_tier is null or listen_tier in ('listen','skim','hold'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'x_posts_score_state_chk') then
    alter table public.x_posts add constraint x_posts_score_state_chk check (score_state is null or score_state in ('scored','rule','skipped','failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'x_posts_read_via_chk') then
    alter table public.x_posts add constraint x_posts_read_via_chk check (read_via is null or read_via in ('user','listen','flow','auto72h'));
  end if;
end $$;

create index if not exists x_posts_fetched_at_idx   on public.x_posts (fetched_at desc);
create index if not exists x_posts_batch_key_idx    on public.x_posts (batch_key) where batch_key is not null;
create index if not exists x_posts_tier_idx         on public.x_posts (listen_tier, tier_assigned_at) where listen_tier is not null;
create index if not exists x_posts_dup_key_idx      on public.x_posts (dup_key) where dup_key is not null;
create index if not exists x_posts_score_pending_idx on public.x_posts (fetched_at) where score_state is null;

-- 既読にする(出所つき)。anonが既にis_readを直接更新できるため、権限の拡大にはならない。
-- 既読済みの投稿は最初の出所を保つ。未読に戻された後の再既読は出所を更新する。
create or replace function public.mark_read(p_url text, p_via text default 'user')
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_via not in ('user', 'listen', 'flow') then
    raise exception 'invalid via';
  end if;
  update public.x_posts
     set read_via = case when is_read then coalesce(read_via, p_via) else p_via end,
         read_at  = case when is_read then coalesce(read_at, now()) else now() end,
         is_read  = true
   where post_url = p_url;
end $$;
revoke all on function public.mark_read(text, text) from public;
grant execute on function public.mark_read(text, text) to anon, authenticated, service_role;

-- 設定キー(区分・聴く量・バッチ・フラグ)
insert into public.tuning_config(key, value, note) values
  ('score_enabled',            'true'::jsonb,  '採点を行う'),
  ('tier_assign_enabled',      'true'::jsonb,  '区分(聴く/流す/保留)の確定を行う'),
  ('auto_expire_enabled',      'false'::jsonb, '流す・保留の自動既読化(暫定期間中はfalse)'),
  ('auto_expire_max_per_run',  '400'::jsonb,   '自動既読化の1回あたり上限件数'),
  ('listen_threshold',         '4'::jsonb,     '聴くの閾値(この点以上)'),
  ('threshold_version',        '1'::jsonb,     '閾値の版(変更時に上げる)'),
  ('listen_quota_min',         '10'::jsonb,    '1日の聴く量の枠(分)。暫定期間は半分の10分、本番は20分'),
  ('listen_chars_per_sec',     '6.5'::jsonb,   '読み上げ速度(文字/秒、速度1倍)'),
  ('listen_speed',             '1.2'::jsonb,   '見積もりに使う読み上げ速度倍率'),
  ('listen_morning_share',     '0.6'::jsonb,   '朝の枠の割合(夕=日枠−朝の実割当)'),
  ('batch_gap_minutes',        '90'::jsonb,    '取得バッチの分割: fetched_atがこの分数以上空いたら別バッチ'),
  ('batch_quiet_minutes',      '20'::jsonb,    '最後のINSERTからこの分数静止したら取得完了とみなす'),
  ('batch_confirm_hours',      '4'::jsonb,     '最初の投稿からこの時間が経てば未採点があっても確定'),
  ('expire_listen_hours',      '24'::jsonb,    '聴くの失効(流すへ)までの時間'),
  ('expire_flow_hours',        '72'::jsonb,    '流す・保留の既読化までの時間'),
  ('cap_opinion',              'false'::jsonb, '意見・感想の最大3点キャップ(初期は記録のみ)'),
  ('backfill_enabled',         'false'::jsonb, '区分確定の対象外の既存投稿を、分布確認用に採点する'),
  ('speech_enabled',           'true'::jsonb,  '聴くカードの音声用読み下しを生成する'),
  ('speech_max_per_run',       '40'::jsonb,    '読み下し生成の1回あたり上限'),
  ('digest_min_interval_hours','6'::jsonb,     '今日の要点の最短再生成間隔'),
  ('digest_min_new_scored',    '5'::jsonb,     '今日の要点を再生成するのに必要な新規score3以上の件数'),
  ('ref_enabled',              'false'::jsonb, '参照先要約(Phase 5)。休止')
on conflict (key) do nothing;
