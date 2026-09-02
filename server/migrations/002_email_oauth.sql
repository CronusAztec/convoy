-- Convoy — email addresses, verified state and OAuth identities.
--
-- Convoy started username-only: every account got a synthetic, unroutable
-- address (<username>@users.convoy.local) purely to satisfy GoTrue, and a
-- one-shot recovery code was the ONLY password-reset path. This migration adds
-- real email as an OPTIONAL second identifier alongside that, so:
--   * existing username-only accounts keep working untouched (email stays null),
--   * new accounts may register with a real address,
--   * OAuth accounts (Google et al.) arrive with an address already verified by
--     the provider.
-- Recovery codes are NOT removed — they remain the reset path for accounts with
-- no verified email, which is still every legacy account.

alter table public.profiles
  add column if not exists email text,
  add column if not exists email_verified boolean not null default false,
  add column if not exists auth_provider text not null default 'password';

-- One account per address, case-insensitively. Partial so the null-email legacy
-- accounts don't collide with each other. GoTrue enforces the same uniqueness on
-- its side; this keeps our copy honest if a row is ever touched directly.
create unique index if not exists profiles_email_lower_idx
  on public.profiles (lower(email)) where email is not null;

-- Single-use, expiring links: verification, password reset, email change,
-- passwordless sign-in.
--
-- The PRIMARY KEY is the SHA-256 of the token, never the token itself — a leaked
-- database dump must not hand over working links. SHA-256 rather than the scrypt
-- used for recovery codes because these tokens are 32 random bytes: there is no
-- low-entropy secret to slow an attacker down over, and this lookup sits on a
-- request path.
create table if not exists public.email_tokens (
  token_hash  text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  purpose     text not null check (purpose in ('verify', 'reset', 'change', 'magic')),
  email       text not null,          -- the address the link was sent TO
  payload     text,                   -- 'change': the new address. 'magic': GoTrue's hashed_token.
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Issuing a new token of a purpose revokes the outstanding ones for that user,
-- which is a delete by (user_id, purpose).
create index if not exists email_tokens_user_purpose_idx
  on public.email_tokens (user_id, purpose);
-- The periodic sweep of expired rows.
create index if not exists email_tokens_expires_idx
  on public.email_tokens (expires_at);

-- Same posture as every other table here: RLS on with NO policies and no grants
-- to anon/authenticated, so the node server (connecting as the table owner) is
-- the only thing that can read them even if the Data API is switched on later.
alter table public.email_tokens enable row level security;
