-- 試験用スタブ(本番には適用しない): Supabase相当のロール・Vault・pg_net・pg_cron と、既存3表(x_posts/fetch_runs/digest_summaries)
-- x_posts は「F1の問題がある状態」(anonに表単位の全権限)を再現しておく。006がそれを列単位へ絞ることを試験する。
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

create schema if not exists vault;
create table if not exists vault.secrets(id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create or replace function vault.create_secret(p_secret text, p_name text default null, p_desc text default '') returns uuid
  language sql as $$ insert into vault.secrets(name, secret, description) values (p_name, p_secret, p_desc) returning id $$;
create or replace function vault.update_secret(p_id uuid, p_secret text, p_name text default null, p_desc text default '') returns void
  language sql as $$ update vault.secrets set secret = p_secret, name = coalesce(p_name, name) where id = p_id $$;

create schema if not exists net;
create table if not exists net._log(id bigint generated always as identity primary key, at timestamptz default now(), url text, body jsonb);
create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net._log(url, body) values (url, body) returning id $$;
create or replace function net.http_get(url text, timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net._log(url, body) values (url, null) returning id $$;

create schema if not exists cron;
create table if not exists cron.job(jobid serial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint
  language sql as $$ insert into cron.job(jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid::bigint $$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;

-- 既存表(契約書の「既存(変更しない)テーブル」)
create table if not exists public.x_posts(
  id bigint generated always as identity primary key, list_name text, author_handle text, author_name text, content text,
  post_url text unique, posted_at timestamptz, fetched_at timestamptz default now(), is_starred boolean default false,
  summary text, summarized_at timestamptz, tags text[], gist text, is_read boolean not null default false, image_urls text[]);
create table if not exists public.fetch_runs(id bigint generated always as identity primary key, ran_at timestamptz default now());
create table if not exists public.digest_summaries(id bigint generated always as identity primary key, list_name text, period_type text,
  body jsonb, generated_at timestamptz default now());
alter table public.x_posts enable row level security;
create policy x_posts_anon_all on public.x_posts for all to anon, authenticated using (true) with check (true);
grant all on public.x_posts, public.fetch_runs, public.digest_summaries to anon, authenticated;
