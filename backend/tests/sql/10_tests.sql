-- 006 の試験(psql -v ON_ERROR_STOP=1 で流す。001a〜006 適用済みの一時DBが前提。run.sh が一式を実行する)
-- 各項目は _res に PASS/FAIL を記録し、最後に FAIL が1つでもあれば例外で終了する。
\o /dev/null
create temp table _res(n serial, name text, ok boolean, detail text);
create function pg_temp.chk(p_name text, p_ok boolean, p_detail text default null) returns void language sql as
  $$ insert into _res(name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail) $$;
create function pg_temp.called() returns text language sql as
  $$ select coalesce(string_agg(regexp_replace(url, '^.*/functions/v1/', '') || coalesce(':' || (body ->> 'period_type'), ''), ',' order by id), '')
       from net._log where url like '%/functions/v1/%' $$;
create function pg_temp.reset_state() returns void language plpgsql as $$
begin
  truncate public.x_posts, public.tier_batches, public.digest_daily, public.post_scores restart identity;
  truncate net._log;
  delete from public.tuning_config where key in ('digest_last_attempt_at');
  update public.tuning_config set value = 'true'::jsonb where key in ('score_enabled', 'tier_assign_enabled', 'speech_enabled');
  update public.tuning_config set value = 'false'::jsonb where key = 'kill_switch';
end $$;
create function pg_temp.addp(u text, ts timestamptz, sc int, st text, ch int default 780, summ boolean default true,
                             rd boolean default false, man text default null, attempts int default 0, bk text default null)
returns void language sql as $$
  insert into public.x_posts(post_url, author_handle, content, fetched_at, posted_at, summary, score, score_state, is_read,
                             manual_action, summary_attempts, batch_key)
  values (u, 'a', repeat('あ', 10), ts, ts, case when summ then repeat('あ', ch) end, sc, st, rd, man, attempts, bk) $$;

insert into public.tuning_config(key, value) values ('tier_scope_from', '"2026-10-01T00:00:00Z"')
  on conflict (key) do update set value = excluded.value;
select public.set_secret('xd_anon_jwt', 'anon'); select public.set_secret('xd_pipeline_secret_cron', 'sec');

-- ============ F1: x_posts の権限 ============
insert into public.x_posts(post_url, author_handle, content) values ('f1', 'a', 'orig');
do $$
declare r_upd boolean; r_ok boolean; r_ins boolean; r_del boolean; r_rv boolean; r_sel boolean; r_trunc boolean; n int; v text;
begin
  set local role anon;
  begin update public.x_posts set content = 'hack' where post_url = 'f1'; r_upd := false; exception when insufficient_privilege then r_upd := true; end;
  begin update public.x_posts set read_via = 'user' where post_url = 'f1'; r_rv := false; exception when insufficient_privilege then r_rv := true; end;
  begin insert into public.x_posts(post_url) values ('f1x'); r_ins := false; exception when insufficient_privilege then r_ins := true; end;
  begin delete from public.x_posts where post_url = 'f1'; r_del := false; exception when insufficient_privilege then r_del := true; end;
  begin truncate public.x_posts; r_trunc := false; exception when insufficient_privilege then r_trunc := true; end;
  begin update public.x_posts set is_read = true, is_starred = true where post_url = 'f1'; get diagnostics n = row_count; r_ok := (n = 1);
        exception when others then r_ok := false; end;
  begin select count(*) into n from public.x_posts; r_sel := (n = 1); exception when others then r_sel := false; end;
  perform public.mark_read('f1', 'listen');
  reset role;
  perform pg_temp.chk('F1 anon: content更新は拒否', r_upd);
  perform pg_temp.chk('F1 anon: read_via直接更新は拒否', r_rv);
  perform pg_temp.chk('F1 anon: INSERT拒否', r_ins);
  perform pg_temp.chk('F1 anon: DELETE拒否', r_del);
  perform pg_temp.chk('F1 anon: TRUNCATE拒否', r_trunc);
  perform pg_temp.chk('F1 anon: is_read/is_starred更新は可', r_ok);
  perform pg_temp.chk('F1 anon: SELECT可', r_sel);
  select read_via into v from public.x_posts where post_url = 'f1';
  perform pg_temp.chk('F1 mark_read RPC は anon から動く(read_via=listen)', v = 'listen', v);
  perform pg_temp.chk('F1 content は改ざんされていない', (select content from public.x_posts where post_url = 'f1') = 'orig');
end $$;
select pg_temp.chk('F1 column_privileges(UPDATE)は anon/authenticated とも is_read,is_starred のみ',
  (select string_agg(grantee || '.' || column_name, ',' order by grantee, column_name) from information_schema.column_privileges
    where table_name = 'x_posts' and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE')
  = 'anon.is_read,anon.is_starred,authenticated.is_read,authenticated.is_starred',
  (select string_agg(grantee || '.' || column_name, ',' order by grantee, column_name) from information_schema.column_privileges
    where table_name = 'x_posts' and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE'));
select pg_temp.chk('F1 表権限は SELECT のみ',
  (select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'x_posts' and grantee in ('anon', 'authenticated')) = 'SELECT');
select pg_temp.chk('F1 RLSは有効のまま', (select relrowsecurity from pg_class where oid = 'public.x_posts'::regclass));
-- N2: fetch_runs / digest_summaries は anon / authenticated とも SELECT のみ
insert into public.fetch_runs default values; insert into public.digest_summaries(list_name, period_type) values ('l', 'p');
do $$
declare r1 boolean; r2 boolean; r3 boolean; r4 boolean; r5 boolean; r6 boolean; r7 boolean; r8 boolean; n1 int; n2 int; r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    execute format('set local role %I', r);
    begin insert into public.fetch_runs default values; r1 := false; exception when insufficient_privilege then r1 := true; end;
    begin update public.fetch_runs set ran_at = now(); r2 := false; exception when insufficient_privilege then r2 := true; end;
    begin delete from public.fetch_runs; r3 := false; exception when insufficient_privilege then r3 := true; end;
    begin truncate public.fetch_runs; r4 := false; exception when insufficient_privilege then r4 := true; end;
    begin insert into public.digest_summaries(list_name) values ('x'); r5 := false; exception when insufficient_privilege then r5 := true; end;
    begin update public.digest_summaries set list_name = 'x'; r6 := false; exception when insufficient_privilege then r6 := true; end;
    begin delete from public.digest_summaries; r7 := false; exception when insufficient_privilege then r7 := true; end;
    begin truncate public.digest_summaries; r8 := false; exception when insufficient_privilege then r8 := true; end;
    begin select count(*) into n1 from public.fetch_runs; select count(*) into n2 from public.digest_summaries; exception when others then n1 := -1; end;
    reset role;
    perform pg_temp.chk('N2 ' || r || ': fetch_runs の INSERT/UPDATE/DELETE/TRUNCATE は拒否', r1 and r2 and r3 and r4);
    perform pg_temp.chk('N2 ' || r || ': digest_summaries の INSERT/UPDATE/DELETE/TRUNCATE は拒否', r5 and r6 and r7 and r8);
    perform pg_temp.chk('N2 ' || r || ': 2表とも SELECT は可', n1 >= 1 and n2 >= 1, n1 || '/' || n2);
  end loop;
end $$;
select pg_temp.chk('N2 2表の表権限は SELECT のみ(anon/authenticated)',
  (select string_agg(distinct privilege_type, ',') from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('fetch_runs', 'digest_summaries') and grantee in ('anon', 'authenticated')) = 'SELECT');
select pg_temp.chk('N2 service_role は書ける(Edge Function用)',
  has_table_privilege('service_role', 'public.fetch_runs', 'INSERT') or (select rolbypassrls from pg_roles where rolname = 'service_role'));

-- ============ A: finalize_tiers ============
select pg_temp.reset_state();
-- 午前バッチ(2026-10-03 03:00 JST。枠=10分×60%=360秒。780字=100秒/件)
select pg_temp.addp('a' || i, timestamptz '2026-10-03 03:00:00+09' + i * interval '1 minute', 4, 'scored') from generate_series(1, 4) i;
select pg_temp.addp('dm', timestamptz '2026-10-03 03:10:00+09', 5, 'scored', man => 'demote');         -- 手動降格(score5でも hold)
select pg_temp.addp('pr', timestamptz '2026-10-03 03:11:00+09', 2, 'scored', man => 'promote');        -- 手動昇格(score2でも listen)
select pg_temp.addp('rd', timestamptz '2026-10-03 03:12:00+09', 5, 'scored', rd => true);              -- 既読(枠を消費しない)
select pg_temp.addp('un', timestamptz '2026-10-03 03:13:00+09', null, null, summ => false, attempts => 3); -- 要約不能(未採点だが待たない)
select pg_temp.addp('mid', timestamptz '2026-10-03 03:14:00+09', 3, 'scored');
select pg_temp.addp('lo', timestamptz '2026-10-03 03:15:00+09', 2, 'scored');
-- 本当に未採点の投稿だけのバッチ(1時間前=4時間未満)
select pg_temp.addp('pend', now() - interval '1 hour', null, null);
create temp table _fin as select public.finalize_tiers(false) as j;
select pg_temp.chk('A バッチAは確定(forced=false: 要約不能は待たない)',
  (select (j #>> '{batches,0,forced}')::boolean = false and jsonb_array_length(j -> 'batches') = 1 from _fin), (select j::text from _fin));
select pg_temp.chk('A 未採点待ち(4時間未満)のバッチは確定しない', (select batch_key is null from public.x_posts where post_url = 'pend'));
select pg_temp.chk('A 手動降格 -> hold/manual_demote', (select listen_tier = 'hold' and tier_reason = 'manual_demote' from public.x_posts where post_url = 'dm'));
select pg_temp.chk('A 手動昇格 -> listen/manual_promote', (select listen_tier = 'listen' and tier_reason = 'manual_promote' from public.x_posts where post_url = 'pr'));
select pg_temp.chk('A 既読 -> skim/already_read', (select listen_tier = 'skim' and tier_reason = 'already_read' from public.x_posts where post_url = 'rd'));
select pg_temp.chk('A 要約不能 -> skim/unscored', (select listen_tier = 'skim' and tier_reason = 'unscored' and batch_key is not null from public.x_posts where post_url = 'un'));
select pg_temp.chk('A 通常: 新しい順に3件が聴く(既読・昇格は枠を使わない)・残り1件は quota',
  (select string_agg(post_url || '=' || listen_tier || '/' || tier_reason, ',' order by post_url) from public.x_posts where post_url ~ '^a[0-9]$')
  = 'a1=skim/quota,a2=listen/score>=4,a3=listen/score>=4,a4=listen/score>=4',
  (select string_agg(post_url || '=' || listen_tier || '/' || tier_reason, ',' order by post_url) from public.x_posts where post_url ~ '^a[0-9]$'));
select pg_temp.chk('A 手動降格(score5): tier_initial はアルゴリズム判定(listen)、listen_tier だけ hold',
  (select tier_initial = 'listen' and listen_tier = 'hold' from public.x_posts where post_url = 'dm'),
  (select tier_initial || '/' || listen_tier from public.x_posts where post_url = 'dm'));
select pg_temp.chk('A 手動昇格(score2): tier_initial は hold、listen_tier だけ listen',
  (select tier_initial = 'hold' and listen_tier = 'listen' from public.x_posts where post_url = 'pr'),
  (select tier_initial || '/' || listen_tier from public.x_posts where post_url = 'pr'));
select pg_temp.chk('A 手動以外の投稿は tier_initial = listen_tier',
  not exists (select 1 from public.x_posts where manual_action is null and batch_key is not null and tier_initial <> listen_tier));
select pg_temp.chk('A 閾値未満: 3点=skim, 2点=hold',
  (select listen_tier = 'skim' and tier_reason = 'below_threshold' from public.x_posts where post_url = 'mid')
  and (select listen_tier = 'hold' and tier_reason = 'low_score' from public.x_posts where post_url = 'lo'));
select pg_temp.chk('A 枠の使用は3件分(300秒)のみ', (select used_sec = 300 and alloc_sec = 360 and n_listen = 4 from public.tier_batches order by first_at limit 1),
  (select used_sec || '/' || alloc_sec || '/' || n_listen from public.tier_batches order by first_at limit 1));
-- 未採点バッチが5時間前になれば forced で確定
update public.x_posts set fetched_at = now() - interval '5 hours', posted_at = now() - interval '5 hours' where post_url = 'pend';
create temp table _fin2 as select public.finalize_tiers(false) as j;
select pg_temp.chk('A 未採点ありは4時間経過で forced=true で確定',
  (select (j #>> '{batches,0,forced}')::boolean from _fin2) and (select batch_key is not null from public.x_posts where post_url = 'pend'));
-- score_enabled=false でも確定は走る / tier_assign_enabled=false なら走らない
select pg_temp.addp('sd1', timestamptz '2026-10-03 15:00:00+09', 4, 'scored');
update public.tuning_config set value = 'false'::jsonb where key = 'tier_assign_enabled';
select pg_temp.chk('A tier_assign_enabled=false は skipped', (select (public.finalize_tiers(true) ->> 'skipped')::boolean));
update public.tuning_config set value = 'true'::jsonb where key = 'tier_assign_enabled';
update public.tuning_config set value = 'false'::jsonb where key = 'score_enabled';
select public.finalize_tiers(false);
select pg_temp.chk('A score_enabled=false でも tier_assign_enabled=true なら確定する', (select listen_tier = 'listen' from public.x_posts where post_url = 'sd1'));
update public.tuning_config set value = 'true'::jsonb where key = 'score_enabled';

-- ============ B: author_scoreboard / weekly_report ============
select pg_temp.reset_state();
create function pg_temp.addps(h text, k int, sc int, st text, model text, pv int, ts timestamptz) returns void language sql as $$
  insert into public.post_scores(post_url, author_handle, author_name, posted_at, fetched_at, score, score_state, scored_model, profile_version)
  select h || '_' || md5(random()::text || i::text), h, h, ts - i * interval '1 minute', ts - i * interval '1 minute', sc, st, model, pv
  from generate_series(1, k) i $$;
select pg_temp.addps('rule_au', 6, 1, 'scored', 'm1', 1, now() - interval '3 days');
select pg_temp.addps('rule_au', 6, 1, 'rule', null, null, now() - interval '1 hour');       -- 最新行が rule でも基準のモデルは m1 になる
select pg_temp.addps('good', 12, 5, 'scored', 'm1', 1, now() - interval '2 hours');
select pg_temp.addps('oldmodel', 12, 1, 'scored', 'm0', 1, now() - interval '5 days');       -- 別モデル -> 除外
select pg_temp.addps('skip_au', 12, null, 'skipped', null, null, now() - interval '3 hours'); -- 短文日本語 -> score NULL で除外
select pg_temp.addps('few', 3, 1, 'rule', null, null, now() - interval '3 hours');
select pg_temp.chk('B rule行を母集団に含める: rule_au n=12, exclude_candidate',
  (select n = 12 and verdict = 'exclude_candidate' from public.author_scoreboard(4) where author_handle = 'rule_au'),
  (select n || '/' || verdict from public.author_scoreboard(4) where author_handle = 'rule_au'));
select pg_temp.chk('B 別モデル・skipped は母集団外',
  not exists (select 1 from public.author_scoreboard(4) where author_handle in ('oldmodel', 'skip_au')));
select pg_temp.chk('B good=keep, few(rule3件)=hold',
  (select verdict from public.author_scoreboard(4) where author_handle = 'good') = 'keep'
  and (select n = 3 and verdict = 'hold' from public.author_scoreboard(4) where author_handle = 'few'));

-- 週次レポート
insert into public.post_scores(post_url, author_handle, fetched_at, posted_at, score, score_state, tier_initial)
select 'w' || i, 'good', timestamptz '2026-09-22 12:00+09' + i * interval '1 minute', timestamptz '2026-09-22 12:00+09',
       case when i <= 2 then 4 else 2 end, 'scored', 'skim' from generate_series(1, 10) i;
select public.weekly_report(date '2026-09-21'), public.weekly_report(date '2026-09-14');
create temp table _wr as select (select text_ja from public.weekly_reports where week_start = '2026-09-21') as t,
  (select text_ja from public.weekly_reports where week_start = '2026-09-14') as t0;
select pg_temp.chk('B weekly(9/21週): 週ラベル「9月21日からの週」・割合(20%)', (select t like '9月21日からの週の投稿は10件%' and t like '%4点以上は2件(20%)%' from _wr), (select t from _wr));
select pg_temp.chk('B weekly(空の週): 「(-%)」を出さず・「先週」固定でない', (select t0 not like '%(-%)%' and t0 not like '%先週%' and t0 like '9月14日からの週%' from _wr), (select t0 from _wr));
select pg_temp.chk('B weekly: 除外候補は「現在の」と明記', (select t like '%現在の除外候補の投稿者(直近4週)が1人%' from _wr), (select t from _wr));

-- ============ C: digest_due(バックオフ) ============
select pg_temp.reset_state();
select pg_temp.addp('d' || i, now(), 3, 'scored', bk => 'bd') from generate_series(1, 5) i;
update public.x_posts set scored_at = now(), gist = 'g';
insert into public.tier_batches(batch_key, day_start, slot, first_at, last_at, n_posts) values ('bd', now(), 'am', now(), now(), 5);
create function pg_temp.iso(ts timestamptz) returns jsonb language sql as $$ select to_jsonb(to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) $$;
select pg_temp.chk('C digest_due: 条件が揃えば true(試行履歴なし)', public.digest_due());
insert into public.tuning_config(key, value) values ('digest_last_attempt_at', pg_temp.iso(now() - interval '10 minutes'))
  on conflict (key) do update set value = excluded.value;
select pg_temp.chk('C digest_due: 10分前の試行 -> false', not public.digest_due());
update public.tuning_config set value = pg_temp.iso(now() - interval '40 minutes') where key = 'digest_last_attempt_at';
select pg_temp.chk('C digest_due: 40分前の試行 -> true', public.digest_due());
update public.tuning_config set value = '"not a date"'::jsonb where key = 'digest_last_attempt_at';
select pg_temp.chk('C digest_due: 不正な値でも例外にならず true', public.digest_due());
delete from public.tuning_config where key = 'digest_last_attempt_at';
-- 古い failed/paused 行があっても(試行が30分より前なら)空振りしない
insert into public.digest_daily(day, generated_at, status) values ((public.jst_day2_start(now()) at time zone 'Asia/Tokyo')::date, now() - interval '3 hours', 'failed');
select pg_temp.chk('C digest_due: 古い failed 行があっても true(failed/paused の有無は見ない)', public.digest_due());
update public.digest_daily set generated_at = now() - interval '5 minutes', status = 'paused';
select pg_temp.chk('C digest_due: 直近の paused 行があっても試行記録が無ければ true', public.digest_due());
-- ok 行から digest_min_interval_hours(6)以内なら false
update public.digest_daily set generated_at = now() - interval '1 hour', status = 'ok';
update public.tier_batches set finalized_at = now();
select pg_temp.chk('C digest_due: ok 行から1時間(<6時間) -> false', not public.digest_due());
update public.digest_daily set generated_at = now() - interval '7 hours', status = 'empty';
update public.tier_batches set finalized_at = now();
update public.x_posts set scored_at = now();
select pg_temp.chk('C digest_due: empty 行から7時間(>=6時間)で新規が揃えば true', public.digest_due());
delete from public.digest_daily;

-- ============ C: x_tick の分岐(net.http_post をスタブし、呼ばれた関数名を記録) ============
select pg_temp.reset_state();
select pg_temp.chk('C x_tick: 何も無ければ呼ばない', (select public.x_tick() = '{}'::jsonb) and pg_temp.called() = '', pg_temp.called());

select pg_temp.addp('s1', now() - interval '5 minutes', null, 'skipped', summ => false, bk => 'x');   -- gist null・attempts 0
select public.x_tick();
select pg_temp.chk('C x_tick: 要約待ち -> summarize-x-post のみ', pg_temp.called() = 'summarize-x-post', pg_temp.called());
update public.x_posts set summary_attempts = 3; truncate net._log; select public.x_tick();
select pg_temp.chk('C x_tick: summary_attempts=3 は要約を起動しない', pg_temp.called() = '', pg_temp.called());
update public.tuning_config set value = 'true'::jsonb where key = 'kill_switch'; select public.x_tick();
select pg_temp.chk('C x_tick: kill_switch は何も呼ばない', pg_temp.called() = '');
update public.tuning_config set value = 'false'::jsonb where key = 'kill_switch';

select pg_temp.reset_state();
select pg_temp.addp('b1', now() - interval '5 hours', null, null, bk => null);  -- 要約済・未採点・batch_keyなし
update public.x_posts set gist = 'g';
update public.tuning_config set value = 'false'::jsonb where key = 'score_enabled'; select public.x_tick();
select pg_temp.chk('C x_tick: score_enabled=false でも確定のため score-x-posts を呼ぶ', pg_temp.called() = 'score-x-posts', pg_temp.called());
update public.tuning_config set value = 'false'::jsonb where key = 'tier_assign_enabled'; truncate net._log; select public.x_tick();
select pg_temp.chk('C x_tick: score/tier_assign とも false なら呼ばない', pg_temp.called() = '', pg_temp.called());
update public.tuning_config set value = 'true'::jsonb where key in ('tier_assign_enabled');
-- 未採点(batch_key済み): score_enabled に縛られる
update public.x_posts set batch_key = 'x', fetched_at = now() - interval '10 minutes'; truncate net._log; select public.x_tick();
select pg_temp.chk('C x_tick: score_enabled=false なら未採点だけでは呼ばない', pg_temp.called() = '', pg_temp.called());
update public.tuning_config set value = 'true'::jsonb where key = 'score_enabled'; select public.x_tick();
select pg_temp.chk('C x_tick: score_enabled=true なら未採点で score-x-posts', pg_temp.called() = 'score-x-posts', pg_temp.called());

select pg_temp.reset_state();
select pg_temp.addp('l1', now() - interval '10 minutes', 5, 'scored', bk => 'x');
update public.x_posts set gist = 'g', listen_tier = 'listen', tier_assigned_at = now();
select public.x_tick();
select pg_temp.chk('C x_tick: 読み下し待ち(speech_at is null) -> score-x-posts', pg_temp.called() = 'score-x-posts', pg_temp.called());
update public.x_posts set speech_at = now(); truncate net._log; select public.x_tick();
select pg_temp.chk('C x_tick: speech_at が入れば(失敗でも)再起動しない', pg_temp.called() = '', pg_temp.called());

select pg_temp.reset_state();
select pg_temp.addp('d' || i, now(), 3, 'scored', bk => 'bd') from generate_series(1, 5) i;
update public.x_posts set scored_at = now(), gist = 'g';
insert into public.tier_batches(batch_key, day_start, slot, first_at, last_at, n_posts) values ('bd', now(), 'am', now(), now(), 5);
select public.x_tick();
select pg_temp.chk('C x_tick: 今日の要点 -> generate-digest-summary(today)', pg_temp.called() = 'generate-digest-summary:today', pg_temp.called());
insert into public.tuning_config(key, value) values ('digest_last_attempt_at', pg_temp.iso(now() - interval '5 minutes'))
  on conflict (key) do update set value = excluded.value;
truncate net._log; select public.x_tick();
select pg_temp.chk('C x_tick: バックオフ中は要点を起動しない', pg_temp.called() = '', pg_temp.called());

-- x_daily / x_weekly / cron
truncate net._log; select public.x_daily();
select pg_temp.chk('C x_daily: model-health と 今週の流れ(week)を呼ぶ', pg_temp.called() = 'model-health,generate-digest-summary:week', pg_temp.called());
truncate net._log; select public.x_weekly();
select pg_temp.chk('C x_weekly: 週次レポートのみ(関数は呼ばない)', pg_temp.called() = ''
  and exists (select 1 from public.weekly_reports where week_start = (date_trunc('week', (now() at time zone 'Asia/Tokyo') - interval '2 hours'))::date - 7));
select pg_temp.chk('C 004: x_hourly は毎時3分、x_tickの分(*/5)と重ならない',
  (select schedule from cron.job where jobname = 'x_hourly') = '3 * * * *' and (select schedule from cron.job where jobname = 'x_tick') = '*/5 * * * *');

-- ============ C: x_hourly の警報(llm_error_rate / tier_stalled)と notify_ops のラベル ============
select pg_temp.reset_state();
truncate public.ops_events, public.llm_usage;
select pg_temp.chk('C x_hourly: 警報の条件が無ければ警告は出ない',
  (select public.x_hourly() is not null) and not exists (select 1 from public.ops_events where kind in ('llm_error_rate', 'tier_stalled')));
insert into public.llm_usage(fn, purpose, model, status) select 'f', 'score', 'm', 'error' from generate_series(1, 9);
select public.x_hourly();
select pg_temp.chk('C x_hourly: 呼び出し9回(<10)はエラー率100%でも警報なし', not exists (select 1 from public.ops_events where kind = 'llm_error_rate'));
insert into public.llm_usage(fn, purpose, model, status) values ('f', 'score', 'm', 'ok');
select public.x_hourly();
select pg_temp.chk('C x_hourly: 10回中9回エラー -> llm_error_rate(warn)', (select count(*) = 1 from public.ops_events where kind = 'llm_error_rate' and level = 'warn'));
select public.x_hourly();
select pg_temp.chk('C x_hourly: llm_error_rate は360分dedupeで増えない', (select count(*) = 1 from public.ops_events where kind = 'llm_error_rate'));
truncate public.llm_usage, public.ops_events;
insert into public.llm_usage(fn, purpose, model, status) select 'f', 'score', 'm', case when i <= 4 then 'error' else 'ok' end from generate_series(1, 10) i;
select public.x_hourly();
select pg_temp.chk('C x_hourly: 10回中4回エラー(40%)は警報なし', not exists (select 1 from public.ops_events where kind = 'llm_error_rate'));
insert into public.llm_usage(fn, purpose, model, status) select 'f', 'score', 'm', 'error' from generate_series(1, 2);
select public.x_hourly();
select pg_temp.chk('C x_hourly: 12回中6回エラー(50%)で警報', (select count(*) = 1 from public.ops_events where kind = 'llm_error_rate'));
insert into public.llm_usage(fn, purpose, model, status, called_at) select 'f', 'score', 'm', 'error', now() - interval '2 hours' from generate_series(1, 30);
-- tier_stalled
select pg_temp.addp('ts1', now() - interval '3 hours', 4, 'scored');
select public.x_hourly();
select pg_temp.chk('C x_hourly: 3時間前の未確定は tier_stalled にしない', not exists (select 1 from public.ops_events where kind = 'tier_stalled'));
-- 強制確定(4時間)の直後でも、x_tick の1周期(5分)分の余裕を過ぎるまでは警報しない
update public.x_posts set fetched_at = now() - interval '4 hours 2 minutes', posted_at = now() - interval '4 hours 2 minutes';
select public.x_hourly();
select pg_temp.chk('C x_hourly: 4時間2分前の未確定は tier_stalled にしない(5分の余裕)', not exists (select 1 from public.ops_events where kind = 'tier_stalled'));
update public.x_posts set fetched_at = now() - interval '4 hours 6 minutes', posted_at = now() - interval '4 hours 6 minutes';
select public.x_hourly();
select pg_temp.chk('C x_hourly: 4時間6分前の未確定 -> tier_stalled', exists (select 1 from public.ops_events where kind = 'tier_stalled'));
delete from public.ops_events where kind = 'tier_stalled';
update public.x_posts set fetched_at = now() - interval '5 hours', posted_at = now() - interval '5 hours';
update public.tuning_config set value = 'false'::jsonb where key = 'tier_assign_enabled';
select public.x_hourly();
select pg_temp.chk('C x_hourly: tier_assign_enabled=false の間は tier_stalled を出さない', not exists (select 1 from public.ops_events where kind = 'tier_stalled'));
update public.tuning_config set value = 'true'::jsonb where key = 'tier_assign_enabled';
select public.x_hourly();
select pg_temp.chk('C x_hourly: 5時間前から未確定 -> tier_stalled(warn)', (select count(*) = 1 from public.ops_events where kind = 'tier_stalled' and level = 'warn'));
select public.x_hourly();
select pg_temp.chk('C x_hourly: tier_stalled は360分dedupeで増えない', (select count(*) = 1 from public.ops_events where kind = 'tier_stalled'));
select public.finalize_tiers(true);
select pg_temp.chk('C x_hourly: 確定後(batch_key あり)は未確定が残らない=tier_stalled の対象外', not exists (select 1 from public.x_posts where batch_key is null));
truncate public.ops_events; select public.x_hourly();
select pg_temp.chk('C x_hourly: 確定後は tier_stalled を出さない', not exists (select 1 from public.ops_events where kind = 'tier_stalled'));
-- notify_ops のラベル(日本語)
truncate public.ops_events; truncate net._log;
select public.set_secret('xd_ntfy_topic', 't_label');
select public.ops_event('warn', k, 'x', '{}', 0) from unnest(array['llm_error_rate', 'tier_stalled', 'gemini_auth', 'digest_failed', 'score_stalled', 'model_probe_failed',
  'score_no_profile', 'secrets_missing', 'digest_dropped', 'digest_week_dropped', 'llm_env_error', 'usage_log_failed']) k;
select pg_temp.chk('C notify_ops: 12種の警報が12件送られる', public.notify_ops() = 12);
select pg_temp.chk('C notify_ops: 12種のラベルは日本語(kind名のまま送らない)',
  (select count(*) = 12 and bool_and(body ->> 'message' ~ '[ぁ-ん]') and bool_and(body ->> 'message' !~ '(llm_error_rate|tier_stalled|gemini_auth|digest_failed|score_stalled|model_probe_failed|score_no_profile|secrets_missing|digest_dropped|digest_week_dropped|llm_env_error|usage_log_failed)')
     from net._log where url = 'https://ntfy.sh'),
  (select string_agg(body ->> 'message', ' | ') from net._log where url = 'https://ntfy.sh'));
delete from vault.secrets where name = 'xd_ntfy_topic';

-- ============ 結果 ============
\o
select n, case when ok then 'PASS' else 'FAIL' end as result, name, case when ok then null else detail end as detail from _res order by n;
do $$ begin
  if exists (select 1 from _res where not ok) then raise exception 'FAILED: % 件', (select count(*) from _res where not ok); end if;
end $$;
select count(*) || ' 件 すべて PASS' as summary from _res;
