-- Convoy — blocking and reporting.
--
-- Convoy carries user-generated content in four places: convoy chat,
-- walkie-talkie voice, public rider profiles, and hazard reports. Until now the
-- only route for someone being harassed was an email address in the Terms.
-- Google Play's User Generated Content policy expects an in-app path to both
-- BLOCK and REPORT, and an email address is neither.
--
-- BLOCKING IS SYMMETRIC, and that is a deliberate safety decision rather than a
-- convention. Convoy broadcasts live location. A one-way block would hide the
-- harasser from their victim's map while leaving the victim's pin, heading and
-- speed streaming to the harasser — which is worse than not blocking at all.
-- So the row is directional (we record who blocked whom, for moderation) but
-- every visibility check reads it in both directions.

create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles(id) on delete cascade,
  blocked_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  -- Blocking yourself would make you invisible to yourself on every symmetric
  -- check below. Cheaper to refuse it here than to special-case it forever.
  constraint blocks_no_self check (blocker_id <> blocked_id)
);

-- The primary key already serves "who has X blocked". This is the other
-- direction — "who is blocking X" — which the symmetric visibility check needs
-- on the hot path at boot load.
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

-- Abuse reports, for a human to review.
--
-- Both account references are ON DELETE SET NULL, and the usernames are
-- denormalised alongside them, ON PURPOSE. With a cascade, someone could delete
-- their account and erase every report ever filed against them on the way out —
-- the reports that matter most would be exactly the ones that disappear. The
-- text copy keeps the moderation record intact after either party is gone.
create table if not exists public.reports (
  id                bigserial primary key,
  reporter_id       uuid references public.profiles(id) on delete set null,
  reporter_username text,                       -- kept if the reporter later deletes
  subject_id        uuid references public.profiles(id) on delete set null,
  subject_username  text,                       -- kept if the subject later deletes
  -- Guests have no account id at all. This is the display name they were riding
  -- under, which is all we can offer for an unauthenticated rider.
  subject_label     text,
  reason            text not null check (reason in (
                      'harassment', 'hate', 'sexual', 'threats',
                      'spam', 'impersonation', 'dangerous', 'false-reports', 'other')),
  detail            text,                       -- optional free text from the reporter
  -- Where it happened: 'chat', 'voice', 'profile', 'map'. Tells a reviewer which
  -- surface to look at.
  context           text,
  -- What the reporter had on screen — for chat, the quoted message. Snapshotted
  -- because convoy chat is never persisted and is gone the moment the convoy is.
  evidence          jsonb,
  status            text not null default 'open'
                      check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at        timestamptz not null default now()
);

-- The review queue: open reports, newest first.
create index if not exists reports_status_created_idx
  on public.reports (status, created_at desc);
-- "Everything filed against this account" — the question a reviewer asks second,
-- and what turns one complaint into a pattern.
create index if not exists reports_subject_idx
  on public.reports (subject_id, created_at desc);
-- Repeat-reporter checks, for the other kind of abuse: weaponised reporting.
create index if not exists reports_reporter_idx
  on public.reports (reporter_id, created_at desc);

-- RLS on, with NO policies, exactly like every other table here. Convoy's server
-- connects with a role that bypasses RLS, so this changes nothing for the app —
-- it is the guard for the day someone switches the Supabase Data API on. Without
-- it, the anon key would read every abuse report in the system: reporter
-- identities, what they said happened, and who they said it about. That is the
-- most sensitive table in this database and the only one where a leak would put
-- the people it is meant to protect at risk.
alter table public.blocks  enable row level security;
alter table public.reports enable row level security;
