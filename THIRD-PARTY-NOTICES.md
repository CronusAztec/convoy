# Third-party notices

Convoy uses the software, data, and services listed below. Each is used under
its own licence and terms, which govern that component and override Convoy's
own [LICENSE](LICENSE) for it. Attribution required by any of these is
displayed in the app (map attribution control, Settings → About) and reproduced
here in full.

Last reviewed: 2026-08-25.

---

## Bundled / linked software

> This page covers **licences and attribution**. For what each of these
> *collects* — the list the store privacy labels are filled from — see
> [SDK-INVENTORY.md](SDK-INVENTORY.md).

| Component | Version | Licence | Notes |
|---|---|---|---|
| [MapLibre GL JS](https://maplibre.org/) | 5.24.0 | BSD-3-Clause | Loaded from jsDelivr. Map renderer. |
| [Capacitor](https://capacitorjs.com/) (`@capacitor/core`, `/android`, `/geolocation`, CLI) | 8.x | MIT | Android shell + geolocation bridge. |
| [TensorFlow.js](https://www.tensorflow.org/js) | 4.22.0 | Apache-2.0 | Loaded from jsDelivr **only when a rider picks a profile photo**. Runs on-device. |
| [NSFWJS](https://github.com/infinitered/nsfwjs) + MobileNet v2 model | 4.2.1 | Apache-2.0 (model: Apache-2.0) | Same. Screens the photo locally; nothing is uploaded to screen it. |
| **Google Play Services** — `play-services-location` (+ `-base`, `-basement`, `-tasks`, `auth-api-signin`) | — | [Google APIs Terms of Service](https://developers.google.com/terms) — **not open source** | Linked into the APK transitively by `@capacitor/geolocation`. The fused location provider behind every GPS fix. |
| `io.ionic.libs:iongeolocation-android` | 2.2.0 | MIT | Transitive of `@capacitor/geolocation`. |
| AndroidX — `appcompat`, `coordinatorlayout`, `core-splashscreen`, `browser` (Custom Tabs) | — | Apache-2.0 | UI + the Custom Tab that carries social sign-in. |
| [Gson](https://github.com/google/gson) | 2.13.2 | Apache-2.0 | Transitive of `@capacitor/geolocation`. |
| `org.jetbrains.kotlinx:kotlinx-coroutines-play-services` | — | Apache-2.0 | Transitive of `@capacitor/geolocation`. |
| [ws](https://github.com/websockets/ws) | 8.x | MIT | WebSocket server. |
| [node-postgres (`pg`)](https://node-postgres.com/) | 8.x | MIT | Postgres client. |
| [Chakra Petch](https://fonts.google.com/specimen/Chakra+Petch), [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono) | — | SIL Open Font License 1.1 | Served by Google Fonts. |
| [Piper](https://github.com/rhasspy/piper) neural TTS (optional, self-hosted) | — | MIT (voice models vary — check the model card) | Only present if the operator installs it. |

**BSD-3-Clause (MapLibre GL JS)** — redistribution in binary form must reproduce
the copyright notice, this list of conditions, and the disclaimer. Neither the
name of the copyright holder nor its contributors may be used to endorse
products derived from this software without specific prior written permission.
Full text: <https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt>

---

## Map, geocoding, and routing data

| Source | Used for | Licence / terms | Attribution shown |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Basemap geometry, POIs via Overpass, geocoding via Nominatim | **ODbL 1.0** — © OpenStreetMap contributors | Map attribution control + Settings → About |
| [CARTO basemaps](https://carto.com/attributions) | Dark / light / voyager tile styles | CARTO attribution required | Map attribution control + Settings → About |
| [OpenFreeMap](https://openfreemap.org/) | Alternate tile host | ODbL (OSM data), free public tiles | Map attribution control |
| [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | Destination search | OSMF usage policy — **max 1 req/s, no heavy use, User-Agent required** | Map attribution control |
| [OSRM demo server](https://routing.openstreetmap.de/) | Keyless routing fallback | Demo server, **no SLA, not for production volume** | Settings → About |
| [Overpass API](https://overpass-api.de/) | Police stations, cameras, road furniture | OSMF/instance fair-use policy | Map attribution control |
| [TomTom](https://developer.tomtom.com/) | Traffic-aware routing + traffic flow tiles (operator key) | TomTom Developer Terms — **attribution required**, no scraping, no permanent storage of results | Map attribution control when the layer is on |

> **Operator obligation.** The Nominatim, OSRM, and Overpass public endpoints are
> shared community infrastructure offered for development, not production
> traffic. Running Convoy at scale against them breaches their usage policies.
> Self-host or buy capacity before public launch.

---

## Live data feeds

| Source | Used for | Terms |
|---|---|---|
| [OpenSky Network](https://opensky-network.org/) | Live aircraft in Ghost Mode radar | Free for **non-commercial** use; commercial use requires a licence agreement |
| [airplanes.live / ADS-B Exchange](https://airplanes.live/) | Aircraft fallback feed | Attribution required; non-commercial terms |
| [RainViewer](https://www.rainviewer.com/api.html) | Precipitation radar overlay | Free tier requires attribution; commercial tiers separate |
| [OpenMHz](https://openmhz.com/) | Public-safety scanner feed directory | Public feeds; **listening is subject to local law — see the Terms of Service** |
| [Open-Meteo](https://open-meteo.com/) | Weather conditions | CC-BY 4.0, attribution required |
| [NWS / weather.gov](https://www.weather.gov/) | US weather alerts | US Government work, public domain |
| [PulsePoint](https://www.pulsepoint.org/) | Public incident feed (US) | Public agency feed |
| [Waze](https://www.waze.com/), [Citizen](https://citizen.com/) | Public incident reports | **Publicly available data only.** Not an official partnership or endorsement. Convoy is not affiliated with Waze/Google or Citizen. |
| City open-data portals (Austin, Calgary, Honolulu) | Enforcement / incident datasets | Each portal's open-data licence |

---

## Infrastructure and processors

| Service | Role |
|---|---|
| [Supabase](https://supabase.com/privacy) | Authentication (GoTrue) + Postgres database — stores your account |
| [Resend](https://resend.com/legal/privacy-policy) | Outbound email (confirmation, reset, sign-in links) |
| [jsDelivr](https://www.jsdelivr.com/terms) | CDN for MapLibre |
| [Google Fonts](https://developers.google.com/fonts/faq/privacy) | Web fonts |
| OAuth providers (Google, Apple, GitHub, Discord, Microsoft — whichever the operator enables) | Social sign-in |

These are Convoy's sub-processors. See the [Privacy Policy](legal/privacy.html).

---

## Trademarks

Vehicle makes, models, and trims listed in the garage are trademarks of their
respective owners and are used nominatively to let riders describe their own
car. Convoy is not affiliated with, endorsed by, or sponsored by any vehicle
manufacturer. The same applies to Escort, Bel, and SABRE (radar-detector
interoperability), Waze, Citizen, Google, and Apple.
