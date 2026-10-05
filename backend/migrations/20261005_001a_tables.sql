-- 001a foundation: tables (spec v11 Phase 0)
-- 加算のみ(既存テーブルは変更しない)。新テーブルはRLS有効・anon/authenticatedは一切不可(サービスロールのみ)。
-- 秘密(ntfyトピック・共有シークレット・署名鍵)はVaultに置き、このスキーマには置かない。

create table if not exists public.tuning_config (
  key        text primary key,
  value      jsonb not null,
  note       text,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'system'
);

create table if not exists public.tuning_config_history (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  key       text not null,
  old_value jsonb,
  new_value jsonb,
  source    text not null default 'system'      -- admin | proposal:<id> | undo:<id> | system
);
create index if not exists tuning_config_history_at_idx on public.tuning_config_history (at desc);

-- 管理者認証: パスフレーズのPBKDF2ハッシュのみ保持(署名鍵はVault)。セットアップコードは一回限り。
create table if not exists public.admin_auth (
  id                     int primary key default 1 check (id = 1),
  salt                   text,
  hash                   text,
  iterations             int,
  key_version            int not null default 1,
  failed_count           int not null default 0,
  last_failed_at         timestamptz,
  setup_done             boolean not null default false,
  setup_code_hash        text,
  setup_code_expires_at  timestamptz,
  set_at                 timestamptz
);

create table if not exists public.ops_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  level       text not null default 'info' check (level in ('info','warn','error')),
  kind        text not null,
  message     text not null,
  data        jsonb not null default '{}'::jsonb,
  notified    boolean not null default false,
  notified_at timestamptz,
  suppressed  boolean not null default false
);
create index if not exists ops_events_at_idx on public.ops_events (at desc);
create index if not exists ops_events_unnotified_idx on public.ops_events (id) where notified = false;

-- 同時実行を避ける簡易リース
create table if not exists public.pipeline_lock (
  name         text primary key,
  locked_until timestamptz not null,
  owner        text
);

create table if not exists public.model_state (
  id                 int primary key default 1 check (id = 1),
  current_model      text not null,
  candidates         jsonb not null default '["gemini-2.5-flash-lite","gemini-3.5-flash-lite","gemini-3.1-flash-lite"]'::jsonb,
  gone_streak        int not null default 0,
  last_switch_at     timestamptz,
  last_switch_reason text,
  last_health_at     timestamptz,
  last_health        jsonb,
  updated_at         timestamptz not null default now()
);

-- 切替先として使えるのは enabled=true のモデルだけ(予行演習で検証済みのもののみtrueにする)
create table if not exists public.model_config (
  model      text primary key,
  gen_config jsonb not null default '{}'::jsonb,   -- generationConfigに混ぜる設定(思考の指定など)
  enabled    boolean not null default false,
  note       text,
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.llm_prices (
  model          text not null,
  effective_from date not null,
  in_usd         numeric not null,                  -- USD / 100万トークン
  out_usd        numeric not null,
  primary key (model, effective_from)
);

create table if not exists public.llm_usage (
  id              bigint generated always as identity primary key,
  called_at       timestamptz not null default now(),
  batch_id        text,
  fn              text not null,
  purpose         text not null,
  grp             text not null default 'x' check (grp in ('x','ti')),
  model           text not null,
  prompt_tokens   int,
  output_tokens   int,
  thoughts_tokens int,
  cost_usd        numeric(14,8),
  in_price        numeric,
  out_price       numeric,
  status          text not null default 'ok',       -- ok | error | unpriced | no_usage
  http_status     int,
  latency_ms      int,
  attempt         int not null default 1,
  error           text,
  post_url        text
);
create index if not exists llm_usage_called_at_idx on public.llm_usage (called_at desc);
create index if not exists llm_usage_grp_called_idx on public.llm_usage (grp, called_at desc);

create table if not exists public.llm_cost_monthly (
  month           date not null,                    -- JSTの月初
  grp             text not null,
  fn              text not null,
  purpose         text not null,
  model           text not null,
  calls           int not null default 0,
  errors          int not null default 0,
  prompt_tokens   bigint not null default 0,
  output_tokens   bigint not null default 0,
  thoughts_tokens bigint not null default 0,
  cost_usd        numeric(14,6) not null default 0,
  cost_jpy        numeric(14,2) not null default 0,
  usd_jpy         numeric not null default 160,
  finalized       boolean not null default false,
  updated_at      timestamptz not null default now(),
  primary key (month, grp, fn, purpose, model)
);

do $$
declare t text;
begin
  foreach t in array array['tuning_config','tuning_config_history','admin_auth','ops_events','pipeline_lock',
                           'model_state','model_config','llm_prices','llm_usage','llm_cost_monthly']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
