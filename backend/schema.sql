-- Linkly schema.
--
-- Every statement is idempotent, so this file doubles as the migration path
-- for databases created before accounts existed. Re-running it is safe.

create table if not exists users (
  id bigserial primary key,
  email text not null unique,
  -- Format: scrypt$N$r$p$<salt-b64url>$<hash-b64url>
  password_hash text not null,
  -- Set once the address is confirmed. NULL means unverified.
  email_verified_at timestamptz,
  created_at timestamptz not null default now()
);

alter table users add column if not exists email_verified_at timestamptz;

-- Sessions are bearer credentials, so only a SHA-256 digest is stored: a
-- database dump must not yield usable session tokens.
create table if not exists sessions (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- No sessions_token_hash_idx: `token_hash text unique` already creates
-- sessions_token_hash_key. Declaring both meant every session INSERT — the
-- hottest write in the app — maintained two identical b-trees. Dropped here so
-- re-running the migration also fixes databases that already had it.
drop index if exists sessions_token_hash_idx;

create index if not exists sessions_user_id_idx on sessions (user_id);
-- The hourly sweep deletes on expires_at. Without this it was a full table
-- scan: EXPLAIN over 20k sessions planned a Seq Scan touching 10941 rows to
-- find the expired ones, and the cost grows linearly with retained logins.
create index if not exists sessions_expires_at_idx on sessions (expires_at);
-- No users_email_idx: `email text unique` already creates one.

-- Single-use password reset tokens. Only the SHA-256 digest is stored, and a
-- successful reset revokes every session for that account.
create table if not exists password_resets (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  token_hash text not null unique,
  purpose text not null default 'password_reset',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_resets_user_id_idx on password_resets (user_id);
create index if not exists password_resets_expires_at_idx on password_resets (expires_at);

create table if not exists email_verifications (
  id bigserial primary key,
  user_id bigint not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_verifications_user_id_idx on email_verifications (user_id);

create table if not exists links (
  id bigserial primary key,
  code text unique,
  destination_url text not null,
  clicks integer not null default 0,
  -- Set when the link was created by a signed-in user.
  user_id bigint references users (id) on delete set null,
  -- Guest ownership. Returned once at creation and required to delete a link
  -- made without an account. Nullable so pre-account rows survive.
  owner_token text,
  created_at timestamptz not null default now()
);

alter table links add column if not exists owner_token text;
alter table links add column if not exists user_id bigint;

create index if not exists links_created_at_idx on links (created_at desc);
create index if not exists links_user_id_idx on links (user_id, created_at desc);

-- No links_code_idx here: `code text unique` already creates a unique
-- btree index on that column, so a second index is pure write overhead.