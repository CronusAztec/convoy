-- Convoy — Performance timers pack: dragy personal bests and race counters.
--
-- The pre-cut server kept these in public.user_stats and public.dragy_pbs
-- (server/db.js loadAll, queuePB, queueRunIncrement, queueWinIncrement) and
-- the deletion cascade in DEPLOY.md names both tables, but no migration in
-- this repository created them: they were made by hand with the first schema.
-- The "perf" feature pack (server/packs/perf.js) is now the only reader and
-- writer, and a fresh deployment needs them to exist before an account that
-- holds the pack sets a time, so here they are — `if not exists` throughout,
-- so applying this on a database that already has them is a no-op.
--
-- A row in user_stats is one account's race tally (runs entered, races won);
-- the pack increments it in SQL (on conflict … + 1), so a replayed write
-- cannot double-count. A row in dragy_pbs is one account's best time for one
-- timer preset (mode_id as named in packs/perf/dragy.js MODES: '0-60',
-- '0-100k', '0-30', '0-100', '60-130', '100-200k', 'eighth', 'quarter');
-- time_s is seconds, trap the trap speed in m/s for the distance presets
-- (null for an acceleration preset). The pack only ever lowers a time.
-- Both cascade with the account (right to erasure).

create table if not exists public.user_stats (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  runs        integer not null default 0 check (runs >= 0),
  wins        integer not null default 0 check (wins >= 0),
  updated_at  timestamptz not null default now()
);

create table if not exists public.dragy_pbs (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  mode_id     text not null check (char_length(mode_id) <= 16),
  time_s      double precision not null check (time_s > 0),
  trap        double precision check (trap is null or trap >= 0),
  achieved_at timestamptz not null default now(),
  primary key (user_id, mode_id)
);

-- RLS on, no policies, like every other table: Convoy's server role bypasses
-- it, and the day the Data API is switched on the anon key sees nothing.
alter table public.user_stats enable row level security;
alter table public.dragy_pbs  enable row level security;
