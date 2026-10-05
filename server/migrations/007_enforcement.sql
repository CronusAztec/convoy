-- Convoy — enforcement pack: police-sighting observations behind the
-- "usually here" hotspot layer (server/packs/enforcement/hotspots.js).
--
-- The pre-cut server kept these in server/data/hotspots.json, owned by the
-- server process. A feature pack may persist only through the core's
-- database (packs/README.md), so the observations live here instead. One row
-- per accepted sighting; the probability model is recomputed in memory from
-- the last HORIZON_DAYS (30) of rows, which the pack loads at boot and prunes
-- every few minutes. Nothing in a row identifies a rider: a sighting is a
-- place and a time, whoever reported it.
--
-- Apply after 004_feature_packs.sql. The pack boots without it (the model
-- then lives in memory for the process and logs that the load failed).

create table if not exists public.enforcement_sightings (
  id    bigserial primary key,
  lng   double precision not null check (lng >= -180 and lng <= 180),
  lat   double precision not null check (lat >= -90 and lat <= 90),
  -- Epoch milliseconds of the sighting (the client-facing model works in ms).
  ts    bigint not null,
  -- The ~50 m grid cell the sighting fell in, as hotspots.js keys it.
  cell  text not null
);

-- Boot loads "everything inside the horizon" and maintenance deletes
-- "everything outside it": both are a range on ts.
create index if not exists enforcement_sightings_ts_idx on public.enforcement_sightings (ts);

-- RLS on, no policies, like every other table: Convoy's server role bypasses
-- it, and the day the Data API is switched on the anon key sees nothing.
alter table public.enforcement_sightings enable row level security;
