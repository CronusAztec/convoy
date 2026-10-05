-- Convoy — feature packs: unlock codes and per-account grants.
--
-- The store builds of Convoy ship ONLY the core product (live riders, proximity
-- voice, convoys, routes, profiles). Everything that was withdrawn for store
-- review — enforcement awareness, scanner audio, the performance timers, map
-- overlays, the instrument HUD — lives on the server under packs/ and is sent
-- to an app ONLY after the account holding it has redeemed a code. Nothing
-- dormant ships in the binary, so there is no hidden feature to switch on
-- (Apple guideline 2.3.1); the app downloads interpreted JavaScript from our own
-- origin, which both stores allow (Apple 2.5.2, Play's WebView rules).
--
-- Two tables. A CODE is a thing an operator mints (reviewer access, a beta
-- cohort, a club) and hands out; it names the packs it unlocks, how many
-- accounts may use it and until when. A GRANT is the durable per-account
-- result of redeeming one — once granted, revoking or exhausting the code does
-- not take the pack away from accounts that already have it. Grants cascade
-- with the account (right to erasure); codes outlive the operator who made them
-- because they are the audit trail of who was let in.
--
-- The code itself is never stored. It is random (80 bits, see server/packs/
-- index.js mintCode) so a plain SHA-256 of the normalised text is the lookup
-- key; brute force is rate-limited at the API, and an operator who loses the
-- plaintext mints a new one.

create table if not exists public.pack_codes (
  id          bigserial primary key,
  code_hash   text not null unique,
  label       text not null default '',
  -- Which packs this code unlocks (pack ids as named in packs/<id>/pack.json).
  packs       text[] not null,
  max_uses    integer not null default 1 check (max_uses > 0),
  uses        integer not null default 0 check (uses >= 0),
  expires_at  timestamptz,
  revoked     boolean not null default false,
  created_by  text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.pack_grants (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  pack        text not null,
  -- Where it came from: 'code:<id>' or 'admin:<actor>'.
  source      text not null default '',
  granted_at  timestamptz not null default now(),
  primary key (user_id, pack)
);

-- "Who holds pack X" — the question behind a kill or a recall.
create index if not exists pack_grants_pack_idx on public.pack_grants (pack);

-- RLS on, no policies, like every other table: Convoy's server role bypasses
-- it, and the day the Data API is switched on the anon key sees nothing.
alter table public.pack_codes  enable row level security;
alter table public.pack_grants enable row level security;
