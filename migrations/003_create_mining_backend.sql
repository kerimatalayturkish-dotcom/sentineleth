-- SentinelETH mining backend schema.
-- Run this on the Postgres database referenced by MINING_DATABASE_URL.

create extension if not exists pgcrypto;

create table if not exists mining_accounts (
  wallet text primary key check (wallet ~* '^0x[0-9a-f]{40}$'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_session_started_at timestamptz,
  last_session_ended_at timestamptz,
  last_session_end_reason text,
  challenge_failure_streak integer not null default 0 check (challenge_failure_streak >= 0),
  challenge_fail_count integer not null default 0 check (challenge_fail_count >= 0),
  challenge_expire_count integer not null default 0 check (challenge_expire_count >= 0),
  challenge_pass_count integer not null default 0 check (challenge_pass_count >= 0),
  last_challenge_failed_at timestamptz,
  last_challenge_expired_at timestamptz,
  last_challenge_passed_at timestamptz,
  mining_locked_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists mining_accounts_locked_idx on mining_accounts (mining_locked_until desc);

create table if not exists mining_sessions (
  id uuid primary key default gen_random_uuid(),
  wallet text not null check (wallet ~* '^0x[0-9a-f]{40}$'),
  session_token_hash char(64) not null unique,
  connected_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  warmup_until timestamptz not null,
  active boolean not null default true,
  status text not null default 'active' check (status in ('active', 'challenge_pending', 'stopped')),
  stop_reason text check (stop_reason in ('manual_stop', 'challenge_failed', 'challenge_expired', 'heartbeat_timeout', 'blacklisted', 'replaced', 'mining_locked', 'mining_not_started')),
  stopped_at timestamptz,
  next_challenge_at timestamptz,
  last_ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mining_sessions_wallet_idx on mining_sessions (lower(wallet));
create index if not exists mining_sessions_active_idx on mining_sessions (active, last_heartbeat_at desc);
create index if not exists mining_sessions_status_idx on mining_sessions (status, updated_at desc);
create index if not exists mining_sessions_next_challenge_idx on mining_sessions (next_challenge_at) where active = true;

create table if not exists mining_challenges (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references mining_sessions(id) on delete cascade,
  wallet text not null check (wallet ~* '^0x[0-9a-f]{40}$'),
  challenge_type text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz,
  status text not null default 'issued' check (status in ('issued', 'passed', 'failed', 'expired')),
  answer_salt char(32),
  expected_answer_hash char(64),
  attempts integer not null default 0 check (attempts >= 0),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists mining_challenges_session_idx on mining_challenges (session_id, issued_at desc);
create index if not exists mining_challenges_wallet_idx on mining_challenges (lower(wallet), issued_at desc);
create index if not exists mining_challenges_issued_expiry_idx on mining_challenges (expires_at) where status = 'issued';

create table if not exists mining_power_cache (
  wallet text primary key check (wallet ~* '^0x[0-9a-f]{40}$'),
  wallet_power numeric(78, 0) not null default 0,
  nft_count integer not null default 0,
  eligible_nft_count integer not null default 0,
  rules_commitment char(66),
  status text not null default 'not_computed' check (status in ('ready', 'not_computed', 'stale', 'error')),
  computed_at timestamptz,
  expires_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists mining_power_cache_status_idx on mining_power_cache (status, expires_at desc);

create table if not exists mining_block_winners (
  block_number bigint primary key,
  block_hash char(66) not null,
  winner_wallet text not null check (winner_wallet ~* '^0x[0-9a-f]{40}$'),
  winner_power numeric(78, 0) not null,
  signature text not null,
  claim_payload jsonb not null,
  claimed boolean not null default false,
  claimed_tx_hash char(66),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mining_block_winners_wallet_idx on mining_block_winners (lower(winner_wallet), block_number desc);
create index if not exists mining_block_winners_claimed_idx on mining_block_winners (claimed, block_number desc);

create table if not exists mining_blacklist (
  wallet text primary key check (wallet ~* '^0x[0-9a-f]{40}$'),
  reason text not null,
  source text not null default 'admin' check (source in ('admin', 'system')),
  banned_at timestamptz not null default now(),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists mining_blacklist_expires_idx on mining_blacklist (expires_at);

alter table mining_sessions add column if not exists status text not null default 'active';
alter table mining_sessions add column if not exists stop_reason text;
alter table mining_sessions add column if not exists stopped_at timestamptz;
alter table mining_sessions add column if not exists next_challenge_at timestamptz;

alter table mining_sessions drop constraint if exists mining_sessions_stop_reason_check;
alter table mining_sessions add constraint mining_sessions_stop_reason_check
  check (stop_reason in ('manual_stop', 'challenge_failed', 'challenge_expired', 'heartbeat_timeout', 'blacklisted', 'replaced', 'mining_locked', 'mining_not_started'));

alter table mining_challenges add column if not exists answer_salt char(32);
alter table mining_challenges add column if not exists expected_answer_hash char(64);
alter table mining_challenges add column if not exists attempts integer not null default 0;
alter table mining_challenges add column if not exists updated_at timestamptz not null default now();

alter table mining_blacklist add column if not exists source text not null default 'admin';
alter table mining_blacklist add column if not exists expires_at timestamptz;