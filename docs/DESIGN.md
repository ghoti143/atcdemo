# ATC Demo: Design Document

Status: draft 5, 2026-11-25

## 1. Goals and non-goals

**Goals**

- A live traffic picture that stays at 60 fps from the real traffic of its coverage area up to 50,000+ aircraft. It covers the continental United States.
- Go beyond a flight tracker with decision-support features: trajectory prediction with a time scrubber, conflict detection, and airspace overlays.
- 2D and 3D modes.
- Authenticated access with two roles.
- One command (`docker compose up`) starts Postgres and the real-time server, replaying the recorded flights. The backend needs no external service at runtime. The browser still fetches map tiles from hosted services, and GitHub sign-in needs GitHub; the demo accounts do not. No account or token is needed to run it.
- Runs locally first, but stays deployable: all configuration comes from environment variables read at run time, and the images are self-contained.
- Only the simulator knows the recording. Everything else, the database and the browser included, sees a flight only as far as it has flown, as it would with a live feed.

**Non-goals (v1)**

- Live ADS-B ingestion. The feed interface leaves room for it.
- Operational accuracy. Separation rules and prediction are simplified.
- Instructing aircraft. The app is watch-only: aircraft always follow their recorded paths.
- Mobile layout, multi-region scaling.
- A public deployment. It is a later step, not part of v1.

## 2. Decisions

| Area | Decision | Reason |
|---|---|---|
| Data | Simulator replaying recorded real tracks | Authentic callsigns and flight paths, deterministic, works offline |
| Coverage | The continental United States: a box from 24.4°N to 49.4°N and 125°W to 66.9°W, over a 4 hour window | About 8,000 aircraft airborne at once, where the source's receivers are densest and where FAA airspace data applies. The download spike measured it against a north-eastern region and the whole sky; the numbers are in section 5 |
| Seed source | adsb.lol's daily archive, [`adsblol/globe_history`](https://github.com/adsblol/globe_history); recording OpenSky's live state vectors as the fallback | adsb.lol carries speed, track, vertical rate and aircraft type, needs no account, and is ODbL, so the baked data can be committed with attribution. OpenSky's track endpoint lacks speed and vertical rate and its redistribution terms are unconfirmed |
| Seed data | Tracks clipped to the coverage area, resampled to 10 s, committed as a gzip-compressed binary file under a 50 MB budget, and read by the simulator at startup | A fresh clone works offline. As CSV the chosen coverage is 130 MB; storing differences between samples brings it to about 41 MB. A `dump` command prints the file as text. The recording is the simulator's private input, so it is not loaded into Postgres |
| Flight history | `atc-server` writes each real flight to Postgres as it flies: one row when it appears, its track in batches | The database only ever holds the past, so the web API cannot give away the future, and nothing downstream of the simulator would change with a live feed |
| Real-time server | Rust (axum + tokio): simulator, conflict detector and the WebSocket, nothing else | The heavy, threaded work, and it shares a crate with the browser WASM module |
| API | Next.js route handlers on Bun: flight history, saved views, preferences, alert history | Ordinary database reads and writes in TypeScript, on the same origin as the pages, so the session cookie is enough |
| Transport | WebSocket, binary frames server to client | Compact, viewport-filtered push; the client sends viewport changes back |
| Auth | Better Auth in Next.js, database-backed, with its admin and JWT plugins | Actively developed successor to Auth.js. Roles, demo accounts and a token the Rust server can verify are all documented features |
| Rendering | deck.gl interleaved with MapLibre GL JS, through `@deck.gl/maplibre` | Picking, trails and 3D come built in; attributes come straight from WASM memory |
| Scale | The real traffic of the coverage area by default, stress multiplier to 50k+ | Realistic picture plus a provable performance story |
| Aircraft data in the browser | Held only in WASM memory | JavaScript never holds a per-aircraft object, at any scale |
| Interface state | Zustand | About a dozen fields; must be readable from the render loop and the socket client, outside React |
| Server data in the browser | TanStack Query | Caching and refetching for flight history, saved views, preferences and alert history |
| Map | MapLibre GL JS v6 | Open source, with terrain, sky and extrusions, and no account or token. Mapbox GL JS's licence requires an active Mapbox account |
| Map tiles | Hosted and free: OpenFreeMap vector tiles for the base map, Mapterhorn for terrain | Neither needs registration or a key. Serving tiles from local files is left for later |
| JS tooling | Bun for installs, workspaces, scripts, tests and as the Next.js runtime | Fast installs and one tool in place of Node + pnpm |
| Web scaffold | `apps/web` starts from [bun-templates/bun-nextjs-todo](https://github.com/bun-templates/bun-nextjs-todo) | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, Biome and Zod, already wired to run on Bun |
| Web settings | React Compiler on, `cacheComponents` off | The template installs the compiler plugin without enabling it, and turns `cacheComponents` on; this app is live data behind a sign-in with nothing worth caching |
| Database | One Postgres in compose, one schema, owned by Drizzle in the web app | One migration tool for the application tables and Better Auth's tables. The Rust server writes flight history and alert rows and reads nothing |
| Data layer | Drizzle with the `pg` driver | Typed queries and migrations; Better Auth has an adapter for it; `pg` also runs on Node |
| Offline tools | Bun scripts | Baking tracks and airspace is one-off file processing; it does not need Rust |
| Interaction | Watch-only | Keeps the simulator a pure replay, so the picture is repeatable from one pass to the next |
| Hosting | Local now, deployable later | Config in env vars, self-contained images |
| Web app in dev | Bare metal with `bun dev`; a production Dockerfile behind a compose profile | Fast reload and a simple WASM rebuild loop day to day, one-command start when wanted |

## 3. Architecture

```mermaid
flowchart LR
  subgraph offline["Offline, run once"]
    OS[("adsb.lol daily dump")] --> BAKE["Bake script (Bun)"]
    BAKE --> FILE[("data/seed/flights.bin.gz")]
  end

  subgraph docker["docker compose"]
    SETUP["Setup: migrate, demo accounts"]
    SETUP --> PG[("Postgres")]
    FILE -->|"read once at startup"| SIM["Sim engine, 1 Hz tick"]
    SIM --> WORLD["World state + spatial grid"]
    WORLD --> CD["Conflict detector"]
    WORLD --> WS["WebSocket hub"]
    CD --> WS
    CD -->|"alert rows"| PG
    WORLD --> REC["Flight recorder"]
    REC -->|"flights seen, tracks so far"| PG
  end

  subgraph next["Next.js on Bun"]
    PAGES["Pages, Better Auth"]
    API["API routes (Drizzle)"]
  end

  subgraph browser["Browser"]
    WASM["atc-wasm: decode, interpolate, predict, sort"]
    DECK["deck.gl layers"]
    MAP["MapLibre GL JS"]
    UI["Panels: list, detail, alerts, scrubber"]
    STORE["Zustand store: interface state"]
  end

  WS -->|"binary frames"| WASM
  WASM -->|"typed array views"| DECK
  DECK --> MAP
  WASM -->|"visible rows, alerts"| UI
  STORE <--> UI
  STORE --> DECK
  UI -->|"viewport, selection"| WS
  UI <-->|"TanStack Query"| API
  PAGES -->|"pages, socket token"| UI
  API <--> PG
  PAGES <--> PG
  PAGES -.->|"public signing keys"| WS
```

Two servers, with a clear line between them:

- **`atc-server` (Rust)** is the real-time engine. It runs the simulator and the conflict detector, records what has flown, and speaks to browsers over one WebSocket. It has no REST API beyond a health check.
- **The Next.js app** is everything else: pages, sign-in, and the API for flight history, saved views, preferences and alert history.

`atc-core` is the centre of the Rust side: one crate holding the wire format, kinematics, prediction and conflict maths. It compiles natively into the server and to WASM for the browser, so both sides encode, decode and predict with the same code.

## 4. Repository layout

```
atcdemo/
  Cargo.toml              # cargo workspace
  package.json            # Bun workspaces: apps/*, packages/*, tools
  bun.lock
  docker-compose.yml      # postgres, setup, atc-server; web behind the "full" profile
  .env.example            # every variable in the table below
  LICENSE
  crates/
    atc-cli/              # command-line client: prints a summary of the stream
    atc-core/             # wire format, kinematics, prediction, conflicts; no I/O
    atc-server/           # sim engine, conflict detector, WebSocket hub
    atc-wasm/             # wasm-bindgen wrapper around atc-core
  apps/
    web/                  # Next.js (App Router), TypeScript
      app/api/            # route handlers: auth, flights, views, preferences, alerts
      db/                 # Drizzle schema, migrations, setup script
  packages/
    atc-wasm/             # wasm-pack output, not committed
  tools/                  # Bun scripts: bake tracks, bake airspace
  data/
    README.md             # sources, dates, licences and attribution
    seed/                 # baked flights, committed
    airspace/             # Class B and ARTCC boundary GeoJSON
  docs/DESIGN.md
```

**Running it.**

- `docker compose up` starts Postgres, runs a one-shot `setup` service, then starts `atc-server`. Setup applies the Drizzle migrations and creates the demo accounts. The `atc-server` image carries the seed file. The web app runs alongside with `bun dev`, outside Docker, so hot reload and the WASM rebuild loop stay native.
- `docker compose --profile full up` also builds and runs the web app from `apps/web/Dockerfile`, for a hands-off demo or a deploy rehearsal. That image needs a Rust and `wasm-pack` build stage and the repo root as its build context.

**Bun.** Bun replaces Node and pnpm: `bun install` for workspaces, `bun run` for scripts, `bun test` for unit tests, and `bun --bun next dev` to run Next.js on the Bun runtime. `apps/web` is scaffolded from the `bun-nextjs-todo` template, whose scripts already use `bun --bun next`. Its todo actions, components and compose file are deleted. Drizzle, Zustand, TanStack Query, TanStack Virtual, MapLibre GL JS, deck.gl and Better Auth are added on top.

The template reaches Postgres through Bun's built-in SQL client. This app uses Drizzle over the `pg` driver instead, which also runs on Node. Next.js is built for Node first, so if a Next.js or Better Auth feature misbehaves under the Bun runtime, the fallback is to keep Bun as the package manager and run Next.js on Node. Nothing else in the design depends on which runtime serves the web app. The milestone 1 spike found one such problem, with a one-line fix, so the app stays on Bun; see section 11.

**React Compiler.** Enabled in `next.config.ts`. The components that own the map and the deck.gl overlay mutate imperative objects, so they opt out with `"use no memo"`.

**WASM package.** `bun run wasm:build` runs `wasm-pack build crates/atc-wasm --target web --no-pack` and writes to `packages/atc-wasm`. The output is not committed, so a fresh clone, CI and the web image all build it, and each needs a Rust toolchain and `wasm-pack`. The root `dev` and `build` scripts run it first. `bun run wasm:watch` rebuilds on every change under `crates/atc-core` and `crates/atc-wasm`, and `next dev` serves the rebuilt module on the next page load.

The milestone 1 spike settled how the web app loads it (wasm-pack 0.15.1, wasm-bindgen 0.2.130, Next.js 16.3.1):

- **No `package.json` in the output.** `--no-pack` leaves it out, so `packages/atc-wasm` is not a workspace package. `bun install` and `bun.lock` therefore do not depend on whether the WASM has been built. The web app finds the module through a `paths` entry in its `tsconfig.json`, which maps `atc-wasm` to the generated `atc_wasm.js`; Turbopack follows it, and the generated `.d.ts` gives the types.
- **Client-only import, explicit `init()`.** A client component calls `await import("atc-wasm")` inside an effect and then awaits the module's default export. The generated code locates the `.wasm` file with `new URL("atc_wasm_bg.wasm", import.meta.url)`, which Turbopack treats as an asset: it is emitted with a hashed name and fetched by the browser. Nothing WASM-related runs during prerendering.
- **Zero-copy views work.** `init()` returns the module's `memory`. Rust hands out a pointer and a count, and JavaScript wraps them in a typed array over `memory.buffer` with no copy.
- **`turbopack.root` is set to the repo root** in `next.config.ts`. Next.js already infers that root from `bun.lock`, so the setting is a safeguard: it keeps resolution working if the lockfile detection ever changes.
- It works the same under `next dev` and in a production build, and needed no loader configuration and no experimental flags.

**Configuration.** Everything is an environment variable read at run time. No value is baked into an image: the socket URL is read by the Next.js server on each request and passed to the page. Names may change during the build; `.env.example` is the authority.

| Variable | Read by | Purpose |
|---|---|---|
| `DATABASE_URL` | atc-server, web, setup | The one Postgres database |
| `ATC_STRESS_MULTIPLIER` | atc-server | Clone multiplier at startup, default 1 |
| `ATC_START_SECONDS` | atc-server | A development aid: the sim time, in seconds, that the clock starts from. Optional, default 0 |
| `ATC_LOG_LEVEL` | atc-server | The least serious level logged: `error`, `warn`, `info`, `debug` or `trace`. Optional, default `info` |
| `ATC_SEED_FILE` | atc-server | Path to the seed file. Optional; defaults to `data/seed/flights.bin.gz` under the working directory, which is the copy inside the image. The value `fixture` reads no file and replays the tests' small made-up recording, for the end-to-end test |
| `ATC_ALLOWED_ORIGIN` | atc-server | The web app's origin; socket connections from anywhere else are refused |
| `ATC_JWKS_URL` | atc-server | Where to fetch Better Auth's public signing keys |
| `ATC_TOKEN_ISSUER` | atc-server | Who a socket token must be issued by and for: the web app's public URL. Optional; defaults to `ATC_ALLOWED_ORIGIN` |
| `ATC_AUTH` | atc-server | Optional. `off` treats every connection as a fixed dev user, for running the server with no web app. Empty verifies tokens |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | web, setup | Session signing and the app's public URL. Setup needs them because it creates the demo accounts through Better Auth |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | web | Optional. GitHub sign-in is offered only when both are set |
| `CONTROLLER_GITHUB_USERS` | web | GitHub usernames that become `controller` when their account is created |
| `DEMO_VIEWER_PASSWORD`, `DEMO_CONTROLLER_PASSWORD` | setup | Passwords for the two demo accounts, at least 8 characters |
| `ATC_WS_URL` | web | Where the browser reaches `atc-server` |

## 5. Seed data and the simulator

**Baking (a Bun script in `tools/`, offline).** Download one day of adsb.lol's world dump, keep the aircraft that are inside the coverage area during the 4 hour window, split each aircraft's trace into flights, clip each flight to the coverage area plus a margin of about half a degree, and resample to a fixed 10 s interval. Write `data/seed/flights.bin.gz`. The dump has no origin or destination, so those are left empty in v1. Aircraft without an ICAO24 address are left out.

**The seed file** is one gzip stream. Inside it everything is little-endian. The bake tool has a `dump` command that prints a file's flights, or one flight's samples, as text, since the file cannot be read by eye. `tools/seed/format.ts` is the reference for the layout.

The header is 20 bytes:

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | magic | 4 bytes | `ATCS` |
| 4 | version | u8 | 1. A reader refuses a version it does not know |
| 5 | spacing | u8 | seconds between samples |
| 6 | reserved | u16 | 0 |
| 8 | window start | u32 | Unix time, seconds |
| 12 | window length | u32 | seconds |
| 16 | flight count | u32 | |

Then one 32-byte record per flight. A flight's position in this list is its flight id.

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | ICAO24 | u32 | |
| 4 | callsign | 8 bytes | space-padded ASCII, as are the next three |
| 12 | type | 4 bytes | |
| 16 | origin | 4 bytes | |
| 20 | destination | 4 bytes | |
| 24 | first sample | u32 | index on the window's grid: sample n was taken (first sample + n) × spacing seconds into the window |
| 28 | sample count | u32 | |

Then eight columns, each a u32 byte length followed by that many bytes. A column holds every flight's samples in turn, in flight order.

| Column | Unit | Stored as |
|---|---|---|
| lat | 1e-5 degrees | second differences |
| lon | 1e-5 degrees | second differences |
| altitude | 25 ft above mean sea level | differences |
| barometric | 25 ft: barometric altitude less the altitude above | differences |
| ground speed | knots | differences |
| track | whole degrees, 0 to 359 | differences, taken the short way round, so -180 to 179 |
| vertical rate | 64 ft/min | differences |
| on ground | one bit per sample | bytes, lowest bit first, each flight starting on a new byte |

- The first seven columns are signed variable-length integers: zigzag, so small negative numbers stay small, then seven bits to a byte with the low bits first and the top bit set on every byte but the last.
- "Differences" means a flight's first value is stored whole and each later one as the change from the one before.
- "Second differences" means the first value whole, the second as the change, and each later one as the change in the change. An aircraft flying straight at a steady speed becomes a run of zeros. Decoding adds the numbers back up and is exact.
- No sample is later than the window's length. A flight's last sample may sit exactly on it.

**The bake's rules.**

- Aircraft with no ICAO24 address are left out; adsb.lol names their files with a leading `~`.
- A trace gives two altitudes and the seed keeps both. Barometric is what the altimeter reads at standard pressure. Aircraft are separated by it, but it is not a height: on the day baked it read 200 to 300 ft low along the east coast, so aircraft touched down at Teterboro reading -300 ft, and at cruise it differs from true height by anything from -425 to +1,700 ft. Geometric is GPS height above the WGS84 ellipsoid. The seed's altitude is the geometric one less the height of the EGM96 geoid at that point, from a half-degree grid in `tools/seed/geoid-grid.json`: height above mean sea level, which is what the terrain and the airspace are measured from. The 1% of points with only a barometric altitude take it plus the difference between the two at the nearest point in time that has both.
- Checked against published field elevations at 16 airports, the median altitude of aircraft on the ground is within 31 ft at 14 of them. Denver reads 84 ft low, on a field that slopes by more than that, and Miami 41 ft high.
- Vertical rate is the rate the aircraft reported, which is barometric for most.
- A trace point takes its speed, track, vertical rate and altitude from the last point that had them. A reported speed over 1,000 knots or vertical rate over 20,000 ft/min is treated as missing.
- readsb reports no barometric altitude on the ground, and a GPS height on only some ground points. Within a flight, each unbroken stretch on the ground is at one height: the median GPS height of its own points where any has one, and otherwise the height of the airborne point nearest in time, the last before a landing or the first after a take-off. Its barometric altitude is that height plus the difference between the two altitudes at the nearest airborne point.
- The ground is then levelled across flights, because the last height seen in the air is a few hundred feet up wherever reception on final is poor; at Miami half the aircraft on the ground were 250 ft or more above the runway. In each square of 0.02 degrees that three or more flights were on the ground in, every on-ground sample is moved to the lower quartile of them all. Aircraft at one airport then stand at one height.
- A flight last seen in the air some way above the field still steps down to it between two samples: 178 take-offs and landings step by 500 ft or more. That is a gap in reception, not in the rule.
- A flight's callsign is the last one reported during that flight. One that reports none has none; the callsign before it belongs to another flight.
- An aircraft's day is split into flights where readsb marks a new leg and where the trace is silent for more than 10 minutes.
- A position the aircraft could not have reached at 900 knots is left out if the trace comes back within the next three points. If it does not, a new flight starts there.
- Each flight is interpolated onto the window's 10 s grid, then clipped. Each unbroken stretch inside the box plus half a degree is a flight of its own, so one that leaves and returns is two. A stretch that only touches the margin is dropped.
- A clipped flight under a minute long, or one that never leaves the ground, is dropped.
- Flights are ordered by first sample, then ICAO24, so the same dump always gives the same file.

**The file as baked.** 39,716 flights and 12.6 million samples in 43.1 MB, of which the barometric column is about 2.5 MB. Between 7,415 and 8,324 aircraft are airborne at any moment, 7,978 on average; 478 flights have no callsign and 2,143 no type. The bake takes 75 s in 8 processes.

The script fails if the output exceeds 50 MB. If the real file is too large, shorten the window.

**What the spike measured.** The day is 2026-11-20, a Friday, from `readsb-prod-0`. The measuring scripts were in `tools/spike/` until the bake script replaced them.

| Measure | Result |
|---|---|
| Download | 3.8 GB (3.5 GiB) in two parts; 28 minutes at about 2 MB/s |
| Unpacked | 2.8 GB of traces in 74,764 files, one per aircraft, and 0.85 GB of heatmap; 65 s to unpack |
| As JSON | 18.4 GB and 104 million points for the day |
| One pass over every trace | 2.5 minutes with Bun in 8 processes on an M-series laptop |
| Time between points | Median 4 s, 90th percentile 20 s, so a 10 s grid invents little |
| Position source | 94% ADS-B, 3% ADS-R, under 1% MLAT |
| Missing fields | Callsign on 1-4% of flights, aircraft type on 5-8% |
| Addresses that are not ICAO24 | 8,463 files, named with a leading `~`: TIS-B and other targets with no airframe identity |

The three candidate coverages, over windows starting at 17:00 UTC, which is noon on the US east coast. The file sizes are of real files in the first format considered, a gzipped CSV at 10 s spacing.

| | North-east US | Continental US | Whole sky |
|---|---|---|---|
| Box | 38°N to 43.5°N, 78°W to 69.5°W | 24.4°N to 49.4°N, 125°W to 66.9°W | none |
| Flights in 4 / 5 / 6 h | 7,074 / 8,377 / 9,383 | 41,708 / 49,988 / 56,480 | 62,039 / 73,861 / 83,689 |
| Peak airborne | 1,069 | 8,379 | 11,825 |
| Mean airborne over 5 h | 938 | 7,992 | 11,414 |
| CSV in 4 / 5 / 6 h | 16 / 20 / 23 MB | 130 / 162 / 192 MB | 189 / 234 / 275 MB |

- Flights are counted after clipping, so a flight that leaves the area and returns counts twice. A flight that never leaves the ground, or lasts under a minute, is not counted.
- adsb.lol's receivers are concentrated in North America and Europe. The whole sky holds only 40% more aircraft than the continental US box, so elsewhere the picture would be patchy.
- Only the north-east fits 50 MB as CSV. What decides the size is the encoding more than the container. For the continental US:

| Format, gzipped | 2 h | 3 h | 4 h | 5 h |
|---|---|---|---|---|
| CSV | 64 MB | 97 MB | 130 MB | 162 MB |
| CSV at 20 s spacing | 35 MB | 53 MB | 72 MB | 89 MB |
| Binary, fixed-width fields | 50 MB | 76 MB | 102 MB | 127 MB |
| Binary, each value as the difference from the last | 26 MB | 39 MB | 53 MB | 65 MB |
| The same, with positions as second differences | 20 MB | 30 MB | 41 MB | 50 MB |

- zstd in place of gzip saves a further 6%, which does not earn a new dependency on both sides.

**The choice.** The continental United States, a 4 hour window from 17:00 to 21:00 UTC, 10 s spacing, in the last format of the table, committed to the repository at about 41 MB. The spike counted 41,708 flights, with about 8,000 airborne at any moment, so multiplier 7 gives 50,000+. The bake's own rules give slightly fewer; its figures are above. The simulator holds the recording in memory as fixed-width samples, about 250 MB.

**The source archive.** adsb.lol publishes its history at [`adsblol/globe_history`](https://github.com/adsblol/globe_history), described in its [historical data documentation](https://www.adsb.lol/docs/open-data/historical). At the time of writing that link serves the 2026 archive, `globe_history_2026`.

- One GitHub release holds one day of the whole sky. There is one release per server instance (`readsb-prod-0`, `readsb-prod-1`, `readsb-staging-0`); use prod, and staging for a day when prod looks short.
- A day is a tar archive split into parts, for example `v2025.05.18-planes-readsb-prod-0.tar.aa` and `.tar.ab`. Join the parts before unpacking.
- Inside, `traces/` has one gzip-compressed JSON file per aircraft per day, written by readsb, and `heatmap/` has the point cloud behind adsb.lol's own replay. The trace fields are documented in [readsb's README-json](https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons).
- It is a download only. There is no query API, no filter by region and no per-flight access, so the bake script filters a whole day itself.
- The licence is ODbL 1.0.
- The archive also holds `acas/`, `LICENSE-ODbL.txt`, `LICENSE-cc0.txt` and a `README.txt` naming the day and the release.

**Loading.** `atc-server` reads the seed file once at startup and runs from memory after that. The file is copied into the server's image, and `ATC_SEED_FILE` can point at another one. If the file is missing, cannot be decoded, is of a format version the server does not know, or holds no flights, the server stops with a message naming the file and the reason. Reading the committed file takes about half a second and the server then holds about 250 MB: 12.6 million samples of 20 bytes. The recording is not loaded into Postgres, and no other part of the system reads it.

**Recording what has flown.** As the simulator runs, `atc-server` writes each real flight to Postgres, so the database holds what has happened and nothing else.

- When an aircraft first appears, the server inserts a `flights` row with its identity and the time. When it leaves, or the pass ends, the server sets the end time.
- Every five minutes the server appends, for each aircraft in the air, the 10 s samples it has flown since the last write, as one `flight_tracks` row. When an aircraft leaves, what it flew since the last write is written with its end time. The writes run off the simulation loop, in one batch.
- A row holds its samples as one `bytea` value in the seed file's difference encoding: the same columns, each sample stored as the change from the one before. Every row starts with whole values, so it can be decoded alone. The web API decodes it; the database never looks inside.
- Stress-mode clones are not recorded, so the write load does not grow with the multiplier. It is set by the real picture, about 8,000 aircraft airborne.
- **Measured** (milestone 5) by flying one whole pass of the committed recording into Postgres 16, as fast as it would go: 39,716 `flights` rows and 440,599 `flight_tracks` rows holding 12.3 million samples. The samples come to 7.71 bytes each, 216 bytes a row, 95 MB in all, which is what was estimated. With the rows' own overhead and the index, `flight_tracks` is 139 MB and `flights` 9 MB. A day is six passes: **2.6 million track rows and about 0.9 GB**, against an estimate of 2.3 million and 0.7 GB. The estimate left out that a flight's last batch is short, and counted a row's overhead low. `cargo test --release -p atc-server --test recorder -- --ignored --nocapture` repeats it.
- A row costs twice the seed file's 3.4 bytes a sample because the file is gzipped as a whole and a row is not: before gzip most columns cost a full byte a sample, and a row is too small for Postgres to compress. Deflating each row would bring it to an estimated 5.4 bytes a sample; that is left out, as one more step in every reader for a quarter of the size. One row a minute as array columns, the first design, was an estimated 3 to 5 GB a day, too much for a database started by `docker compose up` on a laptop; see open question 8.
- `flight_tracks` has no id of its own. Its primary key is the flight and the sim time of the row's first sample, which is the order it is read in; a second index was a tenth of the table again.
- Rows older than 24 hours are deleted, as for alerts. Every pass flies the same flights again, so a day is six copies of the recording.
- Rows left open by an earlier run are closed at startup.
- If the database is unreachable the simulator carries on. Samples wait in memory, up to a limit, and are written when it comes back; past the limit the oldest are dropped and the gap is logged.

As built (`crates/atc-server/src/recorder.rs` and the three modules under it):

- **Two halves.** `Recorder::observe` is called from the simulation loop with every tick. It notes which real aircraft have come and gone and keeps each one's samples, and puts what there is to write on a channel. It does no I/O and no encoding. The writer is a task of its own that takes those events and writes them in the order they were sent, a run of one kind as one statement of up to 2,000 rows.
- **What a tick costs.** Measured over a whole pass of the committed recording: `observe` took a mean of 0.27 ms a tick and 6 ms at the longest, on the tick that hands over five minutes of every aircraft's samples. At multiplier 7, with 52,000 clones to pass over, 0.42 ms and 9 ms. That is on a 4-core cloud machine, not the M1 Pro, against a target of 100 ms.
- **When samples are taken.** On every tenth second of sim time, from the tick's own positions, so a recorded sample is one the socket sent. A server started off that grid by `ATC_START_SECONDS` takes its first at the next one.
- **Batches.** Every 300 s of sim time each aircraft's samples up to ten seconds before go to the writer, so a batch is 30 samples. An aircraft that leaves has what it flew since written with its end.
- **A flight cut by the end of the window** has its last sample exactly there, which is the first second of the next pass. The replay never shows it, so the flight's last second is the one before and that sample is not recorded.
- **The database away.** A statement that fails leaves its events waiting; the writer tries again every five seconds and logs once when it starts failing and once when it is through. Up to 3 million samples wait, about an hour of the real picture and 60 MB. Past that the oldest track batches are dropped and the log says how many; flights starting and ending are always kept.
- **At startup** the recorder checks that the columns it writes exist and closes flights an earlier run left open, at the end of each one's recorded track. Tables that are there and wrong stop the server with the missing columns named. A database that cannot be reached does not: the server starts, and the writer makes the same checks when it first gets through.
- **Retention.** Every ten minutes, flights last seen more than 24 hours ago are deleted, and their tracks with them.
- **The row's bytes** are described in `recorder/codec.rs`: the seed file's eight columns one after another for the batch's samples, with no lengths between them, since the row's `sample_count` says how many values each holds.

The 1 Hz positions on the socket are not written anywhere.

**Fixture.** Rust tests and early milestone 2 work use a small generated set of a few dozen synthetic flights, so they need neither the download nor a database.

**Replay.** The sim engine advances a clock at 1 Hz and interpolates each active flight along its recorded waypoints.

- Sim time only moves forward for as long as the server runs. The position in the recording is sim time modulo the window length.
- Sim time starts at 0, or at `ATC_START_SECONDS`, a development aid for watching a moment far into the recording, such as a pass boundary, without waiting for it. The server then starts as if it had already run that long, except that nothing has a past: every aircraft flying at that moment appears in the first tick, with ids from 1, and the first tick is not marked as a new pass. The value may be longer than the window, up to 1,000,000,000.
- The engine ticks once a second. A tick that would start late is skipped, not run in a burst afterwards, so under load sim time runs a little slow and clients never get a batch of stale frames.
- Each trip through the recording is a pass. A flight coming round again is a new aircraft with a new id, so trails, selection and alerts never carry over from one pass to the next.
- Flights cut by the window edges appear and vanish mid-air at the start and end of the recording. That is accepted.
- A flight that crosses the edge of the coverage area appears or disappears there, as it would at the edge of a facility's coverage.
- At multiplier 1 the whole picture empties and refills when the window ends. The server marks the first frame of a new pass and the client shows a brief "replay restarted" notice.

**Stress mode.** A multiplier clones flights with a time shift, a small sideways offset and the synthetic flag set. Time shifts are spread across the whole window, so clones wrap at different moments and the picture never visibly restarts at high multipliers. At multiplier n each flight has n copies. The first is the real one. Copy k is between k and k + 1 nths of the window ahead in the recording, the exact amount depending on the flight, and up to 20 km to the east or west and to the north or south. The shifts come from the flight's number and the copy's alone, so every run makes the same clones. A clone starts a new pass, and becomes a new aircraft, when its own place in the recording wraps; only the real picture's wrap sets the new-pass flag. Multiplier 1 is the real picture; multiplier 7 gives about 55,000 aircraft airborne and 60,000 in the picture, and advancing the simulation one tick at that size takes about 3 ms. The multiplier is set at startup from `ATC_STRESS_MULTIPLIER` from milestone 2, so every later milestone can be run at 50k as it is built. Changing it at run time comes in milestone 8.

**Feed interface.** The engine sits behind a `Feed` trait so a live adapter can replace it later.

## 6. Wire protocol

`atc-server` exposes one WebSocket and `GET /healthz`. Everything else the browser needs comes from the Next.js API in section 7.

**Client to server** messages are small JSON text frames. Each is an object with a `type` that names it and its fields beside it, for example `{"type":"hello","protocol":2}`. A message may be at most 16 KiB.

- `hello {protocol}`: the protocol version the client speaks, and always the first message. The server closes the socket with a distinct code on a mismatch.
- `viewport {bbox, zoom}`: sent when the map moves. The map paces it: the first value at once, then at most one every 250 ms while it moves, and always the place it comes to rest. The socket client sends each of those as it is. `bbox` is `[west, south, east, north]` in degrees, the order MapLibre and GeoJSON use. Longitudes beyond ±180, which a map dragged round the world gives, are brought back into range, and a box 360 degrees wide or more is the whole world. `zoom` must be a number; the server does nothing with it in v1. Until a client has sent one it is sent the whole picture.
- `select {id}`: the selected aircraft, or null. A selected aircraft keeps streaming after it leaves the viewport. Selecting an aircraft that is not in the picture is not an error; nothing is added for it.
- `track {id}`: asks for the track an aircraft has flown so far. Sent when an aircraft is selected, and when one has been hovered for a moment. The answer is a track frame, or an `error` with the code `unknown_aircraft` if the aircraft is not in the picture, because it never was or because it has left.
- As built in the browser (`apps/web/lib/selection.ts`): `select` goes out whenever the selected aircraft changes, with null when nothing is selected, and `track` straight after it for an aircraft. Both are sent again whenever a new connection's first frame has arrived, since a new connection knows nothing; a null selection is not, since that is what a new connection starts with. `track` for a hovered aircraft is sent once the pointer has rested on it for 150 ms, so a pointer crossing the map asks for nothing; not for the selected aircraft, whose track is already held, and again after a reconnect if it is still hovered.
- `set_multiplier {value}`: changes the stress multiplier. Refused unless the connection's role is `controller`.

**Server to client** traffic is binary. The server also sends two small JSON text messages: `sim {multiplier, windowSeconds}` on connect and whenever the multiplier changes, and `error {code, message}` when it refuses a request. They have the same shape as the client's: `{"type":"sim","multiplier":1,"windowSeconds":14400}` and `{"type":"error","code":"unsupported","message":"..."}`.

**Connecting.** The socket is `GET /ws`.

- A request the server will not serve is refused before the upgrade, with an HTTP status: 403 for an origin other than `ATC_ALLOWED_ORIGIN`, 401 for a token that is missing or does not verify, and 503 when the server cannot fetch the keys to verify with. The origin is checked first. With `ATC_AUTH=off` no token is asked for.
- A request with no `Origin` header is let through. Browsers always send one, and the check is there to stop pages on other sites; the command-line client sends none.
- The client's first message must be `hello`, within 10 seconds. The server answers with `sim` and then starts sending frames, beginning with the picture as it stands, not the next tick. `sim` is therefore sent after `hello`, not on the bare connection.
- After `hello`, a message the server cannot read is answered with `error` and the code `bad_message`, and one it does not act on yet with the code `unsupported`. The connection stays open.
- A `viewport` or a `select` is not answered. It takes effect in the next positions frame, which is at most a second away; the frame before is not sent again.
- The server sends no pings. It writes to every client each second, so a dead connection fails on a write. It answers a client's pings.

| Close code | Meaning |
|---|---|
| 4000 | The first message was not a `hello`, or none came within 10 seconds |
| 4001 | The `hello` named a protocol version the server does not speak |
| 1001 | The simulator has stopped |

Binary frames are little-endian with a 24-byte header. Every field sits on its natural alignment, so the client can read frames through typed-array views.

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | version | u8 | 2; it went from 1 when barometric altitude joined the position and track records |
| 1 | kind | u8 | 1 positions, 2 metadata, 3 alerts, 4 track |
| 2 | record size | u16 | bytes per record; lets a client skip fields it does not know |
| 4 | seq | u32 | per connection; see below |
| 8 | sim time | f64 | milliseconds, never decreases |
| 16 | count | u32 | |
| 20 | flags | u32 | bit 0: first frame of a new pass |
| 24 | records | count × record size | |

`seq` numbers the ticks a connection could have been sent, from 0 at the first. Every frame built from one tick carries that tick's `seq`, and its metadata frame is sent before its positions frame, so a client knows an aircraft by the time it has a position for it. A skipped tick leaves a gap.

Position record, 24 bytes:

| Offset | Field | Type | Unit |
|---|---|---|---|
| 0 | id | u32 | aircraft id |
| 4 | lat, lon | i32 × 2 | 1e-7 degrees |
| 12 | altitude | i16 | 25 ft above mean sea level; signed, since some airports are below it |
| 14 | ground speed | u16 | knots |
| 16 | track | u16 | 360/65536 degrees |
| 18 | vertical rate | i8 | 64 ft/min, the resolution ADS-B itself reports; clamped to ±8,128 |
| 19 | flags | u8 | bit 0 on ground, bit 1 synthetic |
| 20 | barometric altitude | i16 | 25 ft; signed, since an altimeter at standard pressure can read below zero on the ground |
| 22 | reserved | 2 bytes | zero; they keep the record a multiple of 4 bytes, so every field of every record stays on its natural alignment |

A position or track record carries two altitudes. The altitude is above mean sea level, the same reference as the terrain and the airspace, so aircraft land on the runway and sit correctly in the airspace volumes in 3D. It is not the barometric altitude aircraft are separated by: an aircraft cruising at flight level 350 shows as its true height, anywhere from about 34,600 to 36,700 ft on the day baked. The barometric altitude is beside it for the detail panel and the flight list to show flight levels. The simulator holds both for every sample and interpolates each the same way; a clone has its source's.

Metadata record, 40 bytes: aircraft id (u32), flight id (u32), ICAO24 (u32), time shift in seconds (u32), sideways offset east and north in metres (i16 × 2), then space-padded ASCII for callsign (8), type (4), origin (4) and destination (4).

Alert record, 36 bytes: both aircraft ids (u32 × 2), both positions (i32 × 4), both altitudes (i16 × 2), seconds to closest approach (u16), predicted lateral distance in 0.01 nm (u16), predicted vertical separation in 25 ft (u16), flags (u16).

Track record, 28 bytes: aircraft id (u32), the sample's sim time in seconds (u32), then the position record's fields from lat and lon onwards, so barometric altitude is at offset 24 and the two reserved bytes end it. A track frame holds one aircraft's samples at 10 s spacing from the moment it appeared up to now, oldest first, and never a sample from the future.

- The samples are the recording's own, so they fall on the recording's 10 s grid. For a real aircraft that is sim times that are multiples of 10. For a clone it is those times moved by its time shift.
- The last record is always the aircraft's position in the positions frame with the same `seq`, at that frame's sim time. It is under 10 s after the record before it, and it is the only record if the aircraft has just appeared. A track frame is therefore never empty and always names its aircraft.
- An aircraft appears when it enters the picture in the current pass. A flight that was already flying when the pass began has a track that starts at the start of the pass, and a clone that was mid-flight when the server started has one that starts at the sim time the server started at, which is 0 unless `ATC_START_SECONDS` says otherwise. So does a real flight that was mid-flight then. No track has a sample from before the server's clock began.

**Two kinds of id.**

- The **flight id** is the flight's number in the seed file: one recorded flight. Only the simulator can turn it into a track. The browser uses it to tell which clones share a source, and the conflict detector uses it to skip them.
- The **aircraft id** is allocated by the simulator for one flight, one clone and one pass, and is unique for the life of the server process. Position and alert records use it.
- A row in the `flights` table has its own id and stores the aircraft id. The web API is keyed by the row id.
- The metadata record links the first two. It also carries the aircraft's time shift and sideways offset, which describe how a clone differs from its source.
- ICAO24 identifies an airframe, which can fly several legs in the window, so it is descriptive data and not a key.

**Frames are snapshots, so a skipped frame loses nothing.**

- A positions frame lists every aircraft in the client's viewport plus a margin, found through the spatial grid, plus the selected aircraft. The client drops any aircraft absent from the newest frame; there is no removals message.
- The margin is a quarter of the viewport's longer side, and at least a tenth of a degree, added on every side. How far a client pans before its next `viewport` arrives is in proportion to what it can see, so the margin is too.
- An alerts frame lists every active alert with either aircraft in the viewport. It carries both positions, so the link can be drawn when one end is off screen. It is capped at 500 records, soonest closest approach first.
- A metadata frame lists aircraft the client has not yet been told about. An aircraft counts as told only once its frame has been written to the socket, so a frame that is replaced before sending leaves its aircraft pending for the next one. Only aircraft in the positions frame are listed, so a client with a viewport is told of an aircraft when it first comes into view, however long ago it appeared.
- A track frame answers one `track` request. It is built from the simulator's memory, so it works the same for a real aircraft and a clone, and it is complete from the first minute after startup. A request is never lost to a skipped frame: it waits until its answer has been written to the socket.
- How the track is built: nothing is remembered as the simulator runs. The aircraft's metadata names its flight, its time shift and its sideways offset, and the world state keeps the second it appeared, so its past is read back out of the recording up to the sim time of the frame and no further.
- When the track is sent: a request waits in a slot of its own, which holds the newest request only, and counts as answered once its frame, or its `error`, has been written to the socket. It is answered as soon as the socket is free, from the last positions frame the client was sent, and carries that frame's `seq` and sim time. A request that arrives before the first positions frame is answered straight after it. Like every other frame, the track frame is built only at the moment it is written, from the newest picture the client has, so none is built and then replaced.
- A gap in `seq` therefore needs no resync. The client counts gaps for the performance HUD.

**Frame size.** At 24 bytes per aircraft a whole-picture frame at 50k is 1.2 MB per second. That is accepted in v1; there is no zoom-based thinning. Viewport filtering helps only when zoomed in.

**Slow clients.** Each connection gets a latest-wins slot, not a queue. A client that falls behind skips frames and never builds a backlog. A client that is connected but takes nothing at all is dropped once a single write to it has been stuck for 10 seconds; it would otherwise hold a connection and a picture for as long as TCP allows.

- The slot holds the newest tick, not frames. A connection builds its frames from it when its socket has finished writing the ones before, so the server holds at most one tick's frames for a client, and no frame is built and then thrown away.
- A client that skips the first frame of a new pass still gets the flag: it is set on the first positions frame the client receives from that pass.
- The whole-picture positions frame is encoded once a tick and copied to each connection, which writes in its own `seq` and flags. It goes to every client that has sent no viewport, and to every client whose viewport and margin take in every aircraft. Any other client's frame is encoded for it alone.

## 7. Web API

Next.js route handlers, on the same origin as the pages. Every route requires a signed-in session, read from the cookie; there are no bearer tokens and no cross-origin rules. Inputs are validated with Zod, queries go through Drizzle, and the browser calls them through TanStack Query.

| Route | Purpose |
|---|---|
| `/api/auth/*` | Better Auth: sign-in, sign-out, session, the socket token and the public signing keys |
| `GET /api/flights?search=` | Find flights by callsign among those flying now and those seen in the last 24 hours |
| `GET /api/flights/:id` | One flight's details and its track as far as it has been recorded |
| `GET`, `POST /api/views`; `PUT`, `DELETE /api/views/:id` | Saved views, visible only to their owner |
| `GET`, `PUT /api/preferences` | The signed-in user's preferences |
| `GET /api/alerts` | Alert history, paged by wall-clock time |

**Tracks and "now".** The web API reads only what `atc-server` has written, so it can return nothing from the future. `GET /api/flights/:id` returns a finished flight's whole track, and a current flight's track up to the last batch, which is at most five minutes old. It also returns the aircraft id and whether the flight is still in the air, so the browser can select it on the map.

**As built (milestone 5): the shared helpers and the flights routes.**

- **A route handler** asks for the user, then reads its input, then answers (`apps/web/lib/api/respond.ts`): `requireUser(request)` gives the user or the 401; `readQuery`, `readParams` and `readBody` check the input against a Zod schema and give the value or the 400; `json` answers with `cache-control: no-store`. The session is checked first, so a request with none learns nothing about what input is valid.
- **Errors are one shape**: `{ error: { code, message, fields? } }`, with `fields` naming each input that is wrong. The codes are `unauthorized`, `forbidden`, `not_found` and `invalid_request`.
- **A route's shapes are Zod schemas in a file with no database import** (`lib/api/flights-shapes.ts`), so the route, its tests and the browser share them.
- **In the browser** (`lib/api/client.ts`): `apiGet(path, schema)` fetches and checks the answer against the schema, and rejects with an `ApiError` carrying the status and code. Queries are TanStack Query `queryOptions`, `flightQuery(id)` and `flightSearchQuery(text)`. The query client does not retry a 4xx, and a 401 from any query sends the browser to sign-in, as an ended session does everywhere else.
- **`GET /api/flights/:id`** returns `{ flight, track }`. The track is arrays, one entry a sample: `timesS` and the eight columns in the units the page shows. The rows are decoded by `lib/track-codec.ts`, which is tested against the same bytes as the encoder in `atc-server`. `flight.flying` is true while the row has no end, and `flight.aircraftId` is the id to select on the map.
- **`GET /api/flights?search=&limit=`** matches the start of a callsign whatever its case, among flights with no end and those last seen within 24 hours, flying first, then the most recently seen. `search` is 1 to 8 letters and digits; `limit` is 1 to 50, by default 20. Each pass through the recording is its own flight, so one callsign can be found several times.

**As built (milestone 5): preferences.**

- **One row a user** in `preferences`, keyed by the user's id, with the settings as one JSON value: units for altitude, speed and vertical rate; which overlays are shown; the vertical exaggeration. Deleting the user deletes the row.
- **`GET /api/preferences`** answers with the signed-in user's, or the defaults if they have saved none. **`PUT`** takes all of them and replaces the row. The user's id comes from the session and from nowhere else, so nobody reads or writes another's.
- **`/api/views`** holds what a user saves from the *Views* menu in the top bar: a name, and under it the camera, 2D or 3D, and the list's filter. `GET` lists the user's, oldest first. `POST` saves one and answers `201`; a user keeps at most 50. `PUT /api/views/:id` takes a new name, a new view or both, and `DELETE` removes one. Every query carries the user's id from the session in its `WHERE` clause, so a view that belongs to someone else is answered exactly as an id nobody has: `404`. A body with a part the schema does not know is refused. What is stored is read tolerantly, so a row an earlier version wrote still opens. Going back to a view eases the map to its camera over 0.6 s.
- **The search box** in the top bar asks `GET /api/flights?search=` for what is typed, cleaned to a callsign's letters and digits, once typing has paused for 250 ms. Choosing a flight that is flying selects it by its aircraft id at once, then eases the map to where it was last recorded. Choosing one that has finished fetches `/api/flights/:id`, draws its recorded track as a third trail on the aircraft layer and fits the map to it; a chip beside the box names it and puts it away. Selecting an aircraft puts it away too, so one thing is looked at at a time.
- **The display menu** in the top bar holds the layer toggles and the unit choices. Each writes to the interface store, so it shows at once, and the store's preferences go to `PUT /api/preferences` as before, so it is kept. Values stay in feet, knots and feet a minute everywhere but where they are written: `lib/units.ts` converts for the flight list, the detail panel and the altitude profile. The **altitude legend** over the map's bottom left corner lists the bands the aircraft are coloured by, in the chosen unit; its table is a copy of the store's in `atc-core`, and a test reads the Rust source to hold the two together. Of the layers, only trails are drawn so far; the other toggles are kept for the milestone that draws them.
- **Strict in, tolerant out.** A `PUT` holding a field or a value this version does not know is refused, so nothing unreadable is stored. A stored row is read through `readStoredPreferences`, which gives a default for whatever is missing or unknown and drops the rest, so a setting added later needs no migration.
- **In the page** (`lib/preferences-sync.ts`): loaded when the shell starts and put into the interface store; saved 600 ms after a change, once for changes in quick succession. Nothing is saved until the load has succeeded, so a page that could not load cannot write its defaults over what was stored.

The trail of an aircraft on the map does not come from here. It comes over the socket in a track frame, which is current to the second and also covers clones, and the browser then extends it from each new positions frame. The web API serves flights found by search and flights named in the alert history.

## 8. Client data path

```mermaid
flowchart LR
  A["WS frame, ArrayBuffer"] --> B["wasm.ingest: decode into struct-of-arrays store"]
  B --> C["wasm.advance per animation frame: interpolate to render time"]
  C --> D["Typed-array views over WASM memory"]
  D --> E["deck.gl binary attributes"]
  B --> F["Sorted, filtered row indices"]
  F --> G["Flight list: visible rows only"]
```

- **The WASM store** is a block of memory inside the browser tab, owned by the Rust code. It holds the last two samples of each aircraft the server has sent this client, plus its metadata. It is rebuilt from the socket on every page load and is a few megabytes at 50k.
- The store also holds the track of the selected aircraft and of the hovered one, from their track frames, and appends a sample every 10 seconds from the positions frames.
- The store's logic is `atc_core::store`, plain Rust that `cargo test` runs natively. `atc-wasm` wraps it as `AircraftStore`, handing JavaScript pointers where the core has slices.
- As built: the store keeps the barometric altitude of each aircraft's newest sample beside its other fields, and `barometric_ft(id)` reads it as `altitude_ft(id)` reads the altitude above sea level: as the server last sent it, not as drawn. It is in none of the output buffers and `advance` does not touch it, so there is no older sample of it. A held track keeps positions and times only, so the barometric altitude in a track record is read past.
- JavaScript never holds per-aircraft objects. The flight list asks WASM for the rows on screen (about 30), WASM does the sorting and filtering and returns row indices, and callsigns become JavaScript strings only for visible rows. A counter bumped once a second tells React to re-read, through `useSyncExternalStore`.
- **Interface state** lives in a Zustand store: selected and hovered aircraft, filters and sort order, 2D or 3D, vertical exaggeration, layer toggles, scrubber position, connection status, performance readings, and the current alerts (bounded by the 500-record cap). The render loop and the socket client read it directly.
- **Server data** (flight history, saved views, preferences, alert history) goes through TanStack Query to the web API.
- Rendering runs about one update behind the newest frame and interpolates between the last two samples, so motion is smooth at a 1 Hz feed. If a frame is late it extrapolates by dead reckoning. When a hidden tab becomes visible again it snaps to the newest frame.
- As built: `ingest` and `advance` are both given the caller's clock, and the store keeps the difference between it and sim time. It draws one second behind the newest frame. A frame cannot arrive before it was sent, so the two directions are treated differently. A frame that arrives late moves that difference by a tenth of its lateness, so uneven arrival does not put the picture back; one more than two seconds late resets it. A frame that arrives early shows the clock was behind and sets it at once. That matters on connecting: the first frame is the picture as it stood, up to a second old, and every later frame is early against a clock set from it. Dead reckoning stops after five seconds, so a dead connection does not fly the picture away. A hidden tab needs no special case: `ingest` keeps the clock while nothing is drawn, so the first `advance` afterwards draws the picture as it then is, one update behind the newest frame, with nothing to catch up. An aircraft new to the picture is given an older sample by flying it back a second, so it moves from its first frame.
- **Socket client.** Fetches a token, connects, sends `hello` and viewport changes, hands frames to `wasm.ingest`, and reconnects with backoff. Each reconnect fetches a fresh token; if the session has ended it redirects to sign-in.
- As built (`apps/web/lib/socket-client.ts`):
  - **Status.** `connecting` until the first frame of the page load, through retries too; `open` from a connection's first frame, not from the socket opening; `reconnecting` after a drop, with the last picture left on screen until the new socket opens and the store is reset; `closed` when it has stopped trying.
  - **Backoff.** A retry waits 1 s, then twice as long each time up to 30 s, less a random part of up to half. A frame starts the schedule again. After 8 retries in a row with no frame, between one and two minutes, it stops, and the Disconnected card offers "Reconnect now". It also starts again by itself when the tab is shown again or the browser comes back online, and a retry that is waiting then is made at once.
  - **Token.** The client asks for its address before every attempt, and on the page that fetches a fresh token from `/api/auth/token` and puts it in the query string (`lib/socket-token.ts`). A token request that fails is a failed attempt and is retried. One answered 401 means the session has ended: the client stops with the reason `session-ended`, nothing is retried, and the page goes to sign-in.
  - **Close codes.** 4001 is not retried: the page's WASM module is not the server's version, so the card says the page is out of date and offers a reload. 4000 and 1001 are retried like any other drop.
  - **A dead connection.** The server writes every second, so a socket that has been silent for 10 s is dropped and replaced without waiting for the browser to notice.
  - **A hidden tab** is not treated differently. The browser still delivers frames and they are still ingested, so the store's clock stays right.
  - **Readings.** Skipped frames are the gaps in the positions frames' `seq`, counted from 0 on each connection and added up over the page load. Bytes per second is the mean over the last three ticks, measured from one positions frame to the next; positions frames less than half a second apart count as one tick, so a backlog that arrives at once after a stall is not read as a rate. The aircraft count is the store's `aircraft_count()`, the aircraft in the newest positions frame, and not `len()`, which is the rows the last `advance` drew. All three are reported once a second.
  - **Where it lives.** `apps/web/lib/traffic.ts` holds the page's one `AircraftStore`, the WASM memory and the client, for the render loop, the HUD and picking to reach outside React.
- deck.gl reads its attributes as typed-array views directly over WASM memory. There is no per-frame JavaScript allocation and no garbage; deck.gl still uploads the buffers to the GPU once per frame, about 1 MB at 50k.

| Attribute | Layout | Notes |
|---|---|---|
| position | f32 × 3 | lon, lat, altitude. Float32 resolves to under a metre at this longitude, which is enough for icons |
| angle | f32 | degrees counter-clockwise, so the negative of track |
| colour | u8 × 4 | altitude band |
| icon | none | one icon for every aircraft in v1, so no per-aircraft accessor runs |

- As built (`apps/web/components/map/aircraft-layer.ts`, `apps/web/lib/aircraft-frame.ts`), with deck.gl 9.4.2 and MapLibre 6.19:
  - **No accessor runs per aircraft.** Position, angle and colour are buffers. Size, icon and pixel offset are constants, which deck.gl sets once as constant vertex attributes. `getIcon` is the icon's name and not a function returning it: a function is called once per aircraft every time the layer's data changes. Counted in Chrome at 60,000 aircraft over 30 seconds: no function in the page ran more than 715 times a frame, and the one that looks up the icon ran 30 times in all, once each time the layer was replaced.
  - **The buffers are the page's, not deck.gl's.** deck.gl uploads a typed array it is given only when the object is not the one it was given last, and looks only when the layer is updated. A new layer every frame through `MapLibreOverlay.setProps` would work, and in interleaved mode would also resolve the map's layer groups and make a new view each time. So the page makes three GPU buffers on deck.gl's device, gives them to the layer as its binary attributes, and each frame writes the views into them: one copy, from WASM memory to the GPU. The buffers are as long as the store's capacity and are made again when it grows.
  - **The layer is replaced only when the count changes**, which is at most once a second, when a positions frame arrives. Every other frame deck.gl is told nothing, and draws the layer from the buffers as they then are.
  - **The render loop** runs once per animation frame while the tab is shown: `advance` to the frame's timestamp, the generation check, the three writes, then `map.redraw()`, which has MapLibre draw at once with deck.gl's layers inside it. The map is drawn in the loop's own turn and not by `map.triggerRepaint()`, which asks for a frame of the map's own: called from inside an animation frame that is the next one, and the map then drew every second frame, at 30 a second, while the loop ran at 60. `redraw` also takes the place of any frame the map has asked for itself, so the map is drawn once per animation frame whoever asked. With no aircraft the loop leaves the map alone.
  - **Readings.** The loop reports three main-thread times to the interface store, through one object it keeps: the WASM advance, the attribute update (the generation check, the buffer writes and, when the count has changed, the new layer), and the map's render, which is the time `map.redraw()` takes: MapLibre's draw calls and deck.gl's, as issued. What the GPU then does with them is not in it. The aircraft count on the HUD is the socket client's. The frame meter keeps its own animation-frame loop, which runs only while the HUD is shown; the render loop does not depend on it.
  - **What is allocated per frame**, from a sampling allocation profile at 60,000 aircraft: by the page's own code, the four numbers `performance.now()` returns, about 50 bytes; by luma.gl under the three buffer writes, 2.6 kB, in the wrapper it puts around `gl.bindBuffer` to track state; by deck.gl drawing the layer inside the map's render, 49 kB, and in its own animation loop 6 kB; by MapLibre drawing the base map, 124 kB. That is 182 kB a frame, or 11 MB a second, nearly all of it the two libraries drawing a frame. It is short-lived garbage: over a minute no long task was seen and no frame was late. Four times a second the readings are published, and once a second the layer is replaced; those allocate a few kilobytes each.
- Views are checked every frame and recreated when WASM memory grows, because a detached view reports length zero without raising an error.
- As built: each buffer is as long as the store's capacity, which grows by doubling, and the count of aircraft is passed beside it, so a view stays good while the count changes. `view_generation()` changes when a buffer has moved or WASM memory has grown, and that one comparison each frame says when to build the views again.
- Rows and colours change only when a frame arrives; `rows_version()` says when. The buffers and the row-to-id lookup describe the picture as of the last `advance`, so a pick made after a frame has arrived and before the next `advance` still names the aircraft that was drawn.
- The altitude in the position buffer is feet times a scale the page sets: 0 for 2D, so icons lie flat, and 0.3048 times the vertical exaggeration for 3D.
- Picking returns a row index, which WASM maps to an aircraft id. Selection is always by id.
- As built (`apps/web/components/map/create-map.ts`, `aircraft-layer.ts`, `apps/web/lib/selection.ts`), with deck.gl 9.4.2:
  - **How a pick works.** The aircraft layer is pickable. deck.gl draws it once more into a framebuffer of its own, each instance in a colour that encodes its index, and reads back the pixels round the pointer with `gl.readPixels`. The colours are an attribute deck.gl makes from the instance count alone, so the page's own buffers do not get in the way. The index is a row of the store's buffers as last written, which is as of the last `advance`. `store.id_at(index)` is called in the same turn as the pick and only the id is kept.
  - **Hover.** deck.gl listens on the map's canvas itself and picks at most once per animation frame, at the pointer's newest position, however often the pointer moved; not while a button is down, so not during a drag. The result goes to the interface store's `hoveredId`, null when the pointer is over no aircraft or has left the map. The cursor is a pointing hand over an aircraft and MapLibre's own otherwise. A still pointer picks nothing, so an aircraft that flies under it is not hovered until the pointer moves.
  - **Click.** A click on an aircraft selects it and a click on the empty map selects nothing. MapLibre says what a click is, so the end of a drag is not one. The pick is made at the click, with `overlay.pickObject`, and not taken from deck.gl's own click event, which reports the pick it made when the button went down: a positions frame can arrive between down and up, and that row would then be another aircraft's.
  - **The pick radius is 6 CSS pixels.** deck.gl reads a square that far each way from the pointer and takes the nearest aircraft in it. Icons are 6 to 10 px across with the whole country in view, so the target is about 18 to 22 px across.
  - **The marks.** A white ring round the selected aircraft and a fainter one round the hovered, in a second layer of two instances drawn over the icons. Its positions are a GPU buffer of two rows. Every frame, after `advance`, the render loop asks `store.row_of(id)` for each of the two, and the layer copies those rows' positions out of the view and writes the 24 bytes. The row is never kept: it is asked for again every frame, so a ring stays on its aircraft as it moves and when a positions frame puts it in another row. `row_of` names a row of the newest positions frame, which is a row of the output buffers only once `advance` has run after that frame, so it is asked straight after `advance` and nowhere else. deck.gl is given no new layer for a mark, and the page's code allocates nothing for one.
  - **Telling the server and the store.** `lib/selection.ts` listens to the interface store outside React: `selectedId` goes to `store.set_selected` and to the server as section 6 describes, and `hoveredId` to `store.set_hovered`, so the store holds both tracks when their frames arrive. Nothing draws a track yet.
  - **When the selected aircraft leaves the picture**, because it landed or the pass ended, the selection is cleared and the server told, once three positions frames in a row have come without it. One is not enough: a `select` takes effect in the next frame the server builds, so the frame after a reconnect, or after selecting an aircraft outside the viewport, can be one built before the server had read it. Nothing is counted while no connection is open. After the server has been restarted the ids are the new process's; the selection is sent to it as it stands and is cleared by the same rule if that id is not in its picture.
- WASM runs on the main thread in v1. Moving it to a worker needs SharedArrayBuffer and cross-origin isolation headers; do that only if profiling calls for it.
- A performance HUD shows fps, frame-time percentiles, WASM advance time, attribute update time, aircraft count, bytes per second and skipped frames. A toggle switches to a plain-JavaScript implementation of the same path for a side-by-side comparison.
- As built: the HUD sits top left over the map, on an opaque panel so the traffic behind it does not compete with the figures, and is shown and hidden with the top bar's button or the H key. A frame meter times animation frames while the HUD is shown and not otherwise: frames per second over the last second, and the 95th and 99th percentile frame time over the last 256 frames, with the gap across a hidden tab left out. The percentiles turn amber past 17.2 ms, which is the 16.7 ms target plus half a millisecond of timestamp jitter, and red past 33.8 ms. The readings change at most four times a second. Times nothing has measured yet show a dash. A ninth reading, the map's render time, is there for the split of main-thread time in section 15; the render loop reports it with the WASM and attribute times.

## 9. Rendering and 3D

deck.gl's `MapLibreOverlay` in interleaved mode on MapLibre GL JS v6, so layers depth-sort with the map's own scene. Interleaving needs WebGL2. The base map is OpenFreeMap's "dark" vector style, with a few small changes made once it has loaded (listed in `apps/web/components/map/base-map.ts`); terrain comes from Mapterhorn's elevation tiles.

| Layer | Purpose |
|---|---|
| IconLayer | Aircraft, rotated by track, coloured by altitude band |
| ScatterplotLayer | Rings round the selected and the hovered aircraft |
| LineLayer | Trail for selected and hovered aircraft, one stretch between each two points |
| LineLayer | Prediction vectors; conflict pair links |
| ScenegraphLayer | 3D aircraft models at close zoom in 3D mode |
| LineLayer (3D) | Stems dropping from each aircraft |
| Extruded polygons | Class B shelves with floor and ceiling |
| MapLibre line layer | ARTCC boundaries |

**Trails, as built** (milestone 5; `crates/atc-core/src/store.rs`, `apps/web/components/map/aircraft-layer.ts`):

- **One request, then none.** The track frame that answers `track` holds the past. The store extends a held track from the positions frames, a kept sample every ten seconds, so a trail grows for as long as its aircraft stays selected or hovered. Clones are the same: the server builds a clone's track frame, and the browser does not know the difference.
- **The trail ends at the icon.** The page draws a second behind the newest frame, so the newest samples of a track are ahead of where the icon is drawn. `advance` writes a trail for each held track: the samples the aircraft had flown by the time being drawn, then the position it has just given the icon. The line stops on the aircraft and never runs past it. The buffer is reserved when the track grows, so `advance` still allocates nothing.
- **Drawn as the icons are.** The trail's points go into a GPU buffer every frame. A LineLayer reads each stretch's start and end from that one buffer, twelve bytes apart, so deck.gl is given a new layer only when a trail gains a point or changes aircraft. The design named a PathLayer; it works a path out on the CPU whenever the path changes, which here would be every frame, since the last point is the moving aircraft. At two pixels wide the missing joins do not show.
- **Two trails.** The selected aircraft's is white; the hovered one's is the same at half the strength. Hovering the selected aircraft draws one.

Rules that follow from how deck.gl and MapLibre interact:

- The map stays on the mercator projection. deck.gl's support for MapLibre's globe is experimental and does not draw flat icons.
- deck.gl layers are placed in the map's layer stack with the `beforeId` property. The traffic layers go before `place_other`, the style's first place-name layer: over land, water, roads and borders, and under every place name.
- As built, the aircraft icons lie flat on the map and are not turned to face the camera, so an icon's nose points along its track whatever the map's bearing or pitch. An icon is 3.4 km across on the ground, drawn no smaller than a size that depends on how many aircraft there are (10 px for the real picture, 6 px from about 22,000 aircraft up) and no larger than 28 px. So the whole-country view shows the smallest size, and icons grow from about zoom 7.5. At 60,000 the busiest terminal areas are still solid; the country as a whole is not.
- As built, a ring is a size on the ground like the icon it goes round, 2 px wide, and held 4 px clear of the icon at the icon's smallest and largest sizes. The selected aircraft's is opaque white and the hovered one's the same white at a little over half strength; an aircraft that is both shows the selected ring only. The pointer picks through a ring.
- The altitude bands are coloured warm to cool with height: grey on the ground, then vermilion, amber, yellow, mint, sky blue and magenta, with ceilings at 5,000, 10,000, 18,000, 30,000 and 40,000 ft. The colours are `ALTITUDE_BANDS` in `atc_core::store`. They were chosen against the map's blue-black so that every pair stays apart with protanopia, deuteranopia or tritanopia simulated, by differing in lightness as well as hue.
- The map is created with antialiasing on; MapLibre turns it off by default, and path and line layers look jagged in interleaved mode without it.
- deck.gl layers are not draped over terrain: data at height zero renders at sea level. Stems therefore end at sea level and disappear into high ground. That is accepted.
- Vertical exaggeration is one value in the interface store. Terrain, aircraft height and airspace floors and ceilings all read it, so they stay in step.

3D mode pitches the camera, turns on terrain and sky, and places aircraft at altitude with an adjustable vertical exaggeration. Altitude is in feet above mean sea level, the same reference as the terrain and the airspace floors and ceilings, so the browser only converts feet to metres (the picture is about 4,500 km across and cruise is about 11 km high, so true scale looks flat).

**3D mode, as built** (milestone 6; `apps/web/lib/view-mode.ts`, `apps/web/components/map/create-map.ts`):

- **The switch** is the 2D and 3D pair in the top bar. Turning 3D on tips the camera to 55° over 0.8 s and turning it off stands it up again. A saved view sets the mode before it asks for its camera, so the view's own pitch is where the map ends.
- **Terrain** is a `raster-dem` source on Mapterhorn's tiles (terrarium encoding, 512 px), added the first time 3D is turned on, with Mapterhorn's credit in the attribution control from then. In 2D the terrain is off.
- **A hillshade layer** is drawn in 3D, from a second source on the same tiles, under the style's first line layer. The base style is nearly black, and without it the ground rises and nothing shows it.
- **One exaggeration.** The store's `verticalExaggeration` is the terrain's exaggeration, and the frame code asks every frame for the altitude scale, 0.3048 times it in 3D and 0 in 2D, and sets it on the WASM store when it changes. So terrain and aircraft move together. The slider is in the display menu, from 1 to 20.
- **The sky** is set once, when the style loads, and is seen only when the map is pitched far enough to show the horizon.
- **Stems** are a LineLayer over the icons' own position buffer, read twice: the top of a stem is the aircraft, and its foot reads only the longitude and latitude of the same row, which leaves its height at 0, sea level. So stems cost the main thread nothing. They are drawn in 3D, with the stems layer on, for at most 25,000 aircraft (`STEMS_MAX_AIRCRAFT`). That limit is provisional: it has not been measured on a GPU.

## 10. Decision-support features

**Trajectory prediction.** `atc-core` projects each aircraft forward from its current state only (position, track, speed, vertical rate, levelling off at a plausible cruise or field altitude). It runs in WASM so the scrubber is instant.

**Prediction error.** Nothing outside the simulator knows the future, so the predictor is checked against the past, as it would be on a live feed. For the selected aircraft, WASM takes the sample from 1, 2 and 5 minutes ago in its track, predicts forward from that sample alone, and compares the result with where the aircraft is now. The detail panel shows the three errors. An aircraft that has been in the picture for less than a minute shows none yet.

**Time scrubber.** Dragging the timeline shows the predicted picture up to 20 minutes ahead.

- Prediction is taken from the moment scrubbing starts and is not re-anchored as new frames arrive, so the predicted picture does not jitter.
- Live aircraft are hidden. The list and the detail panel show predicted values.
- Conflict links are drawn between the predicted positions at the scrubbed time.
- A banner states that the picture is a prediction, and a "Return to live" button leaves the mode.

**Conflict detection.** The server runs it every 5 seconds on a snapshot of world state, off the main loop: a grid broad phase banded by altitude, then closest point of approach on predicted paths. Pairs predicted to come within 5 nm laterally and 1,000 ft vertically inside a 5-minute look-ahead produce an alert.

Vertical separation is measured in barometric altitude, which the simulator has for every aircraft beside its height above sea level. It is not measured in that height: of crossings in the recording that are exactly 1,000 ft apart by altimeter, a third are under 1,000 ft apart by true height, and would raise an alert on correctly separated traffic. The world state therefore carries barometric altitude, as the position record has since milestone 3, for the detector to use from milestone 7.

- En-route traffic only. Aircraft on the ground or below 10,000 ft are skipped, which removes taxiing aircraft and parallel approaches.
- Pairs cloned from the same recorded flight are skipped; they fly in trail by construction.
- An alert is keyed by its ordered pair of aircraft ids. It is raised on first detection, updated on each pass of the detector, and cleared after two passes without detection.
- Alerts involving a synthetic aircraft are shown but not saved.
- Open alerts are closed when a replay pass ends and when the server starts.

The map links the pair and the alerts panel lists them by time to closest approach.

**Airspace overlays.** Class B shelves inside the coverage area as extruded volumes, and the boundaries of its ARTCCs as lines, from FAA open data baked to GeoJSON by a Bun script. FAA data covers the United States only, so any coverage beyond it has no airspace layer. Class C is left out. Sector boundaries inside each ARTCC are left out too: the spike found no open source for them.

The airspace spike (issue #23) read the source on 2026-11-25, in the cycle effective 2026-10-29 to 2026-12-24. What it found:

- **Source.** The FAA's Aeronautical Data Delivery Service (ADDS), an ArcGIS open-data site at `adds-faa.opendata.arcgis.com`, published by Aeronautical Information Services. Two of its datasets are used, each one polygon layer that can be queried over HTTP with no key and returns GeoJSON:
  - Class B: `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0` (ADDS title "Class_Airspace").
  - ARTCC: `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Boundary_Airspace/FeatureServer/0` (ADDS title "Airspace_Boundary").
  - Both descriptions say the data is published every eight weeks, the 56 day charting cycle, and give the effective dates. The ADDS data dictionary says the next cycle is posted about 20 days early in the `Pending_Class_Airspace` and `Pending_Boundary_Airspace` services. A query returns at most 2,000 rows; the two queries below return 359 and 41, so neither needs paging.
  - The 28 day NASR subscription on faa.gov carries the same two things in other forms: a Class B, C, D and E shapefile (a 150 MB zip), and the ARTCC boundaries as lists of points (`ARB`). Its README says the ARTCC file changes only on the 56 day cycle. The ArcGIS services are used because they return GeoJSON for a chosen area.
- **Class B rows.** One row is one polygon with one floor and one ceiling. The filter is `LOCAL_TYPE = 'CLASS_B'`, not `CLASS = 'B'`: the second also returns 53 rows that are not United States Class B areas, mostly Canadian control areas. `NAME` is the area ("BOSTON CLASS B"), `IDENT` its main airport ("BOS") and `SECTOR` the shelf ("AREA A"). A shelf can be more than one row with the same `NAME` and `SECTOR`, so the pair is not a key; `GLOBAL_ID` is.
- **Floor and ceiling.** `LOWER_VAL` and `UPPER_VAL` are numbers, `LOWER_UOM` and `UPPER_UOM` the unit, `LOWER_CODE` and `UPPER_CODE` the reference. In all 369 Class B rows:
  - The unit is `FT` at both ends. No Class B row uses flight levels (`FL` with code `STD`); other rows in the layer do.
  - Every ceiling is feet above mean sea level (`MSL`), from 1,000 to 12,500.
  - A floor is either the surface, written as `LOWER_VAL` 0 with `LOWER_CODE` `SFC` (40 rows), or feet `MSL` from 300 to 11,000 (329 rows). There is no `AGL` code in the layer. Height above ground is written as a non-zero value with code `SFC`. Nearly all the rows that have it are Class E, and none of the 369 does.
  - `UPPER_DESC` is `TI` (to and including) on every row. `LOWER_DESC` is null, or `ANI` (above but not including) on 10 rows. The bake script can ignore both.
  - No value is missing and every floor is below its ceiling. The sentinel for "not given" is -9998 with a null unit and code. It appears on other rows of the layer (Class E ceilings marked `AA`, and above) and on every ARTCC row, but on no Class B row. The bake script should still reject -9998 and null.
  - Four rows of San Diego have `EXCLUSION` 1 and `SECTOR` "VFR CORRIDOR EXCLUSION". The data dictionary says only that the polygon "is an exclusion area". Whether to draw them is left to the bake script's issue, which should check them against the chart.
- **Count.** The United States has 30 Class B areas in 369 rows. 29 areas in 359 rows lie inside the coverage box; the one outside is Honolulu. The areas range from 4 rows (Boston, Kansas City) to 28 (San Diego). An area is named for its city, so New York covers JFK, LaGuardia and Newark, "WASHINGTON-TRI AREA" covers the three Washington airports, and "COVINGTON" is Cincinnati.
- **Size.** Arcs are stored as many short segments. The 359 rows have about 249,000 vertices and make 6 MB of GeoJSON with coordinates rounded to six decimal places, 9.5 MB as served. The bake script will have to thin the arcs or round further before the file goes to a browser.
- **ARTCC rows.** `TYPE_CODE = 'ARTCC'` gives 43 rows for 21 centres, named by `IDENT` ("ZBW") and `NAME`. Each centre has a high-altitude boundary (`LOCAL_TYPE` `ARTCC_H`) and a low one (`ARTCC_L`). New York's high boundary is two rows. The altitude fields are all -9998 and `SECTOR` is null. The 20 centres of the contiguous United States intersect the coverage box, in 41 rows; Anchorage is the one that does not.
  - High and low boundaries are the same shape for 4 of the 20 (ZAB, ZLA, ZLC, ZOA) and differ for the rest, by a point or two in some and by a visible area in others, such as ZTL, ZME, ZNY and ZJX.
  - The bake script keeps both sets, marked high or low. The map draws the high set, since the conflict detector and most of the traffic are en route.
  - Oceanic airspace is not in these rows. The New York, Miami, Houston and Oakland oceanic control areas and flight information regions are separate rows (`TYPE_CODE` `CTA` and `FIR`), as are Honolulu, Guam and San Juan, and all are left out. The ARTCC polygons themselves run past the coast and past the edge of the box. They are not clipped.
- **Sectors.** Not published as open data, as far as the spike could find. What was checked:
  - The `Boundary_Airspace` layer: no ARTCC row has a `SECTOR`. The field is filled only for other kinds of airspace, such as the shelves of a terminal radar service area, and for parts of foreign control areas (Mexico, Cuba, the Bahamas, Canada and others).
  - The ADDS catalogue: all 73 items were listed and none is a sector dataset.
  - The NASR subscription for 2026-10-29: its file list, its README, and the layouts of the ARTCC boundary and ARTCC facility files. The boundary file has high, low and unlimited boundaries per centre and nothing finer.
  - The FAA's other aeronautical data pages: "Center Surface Boundaries" is one ground-level boundary per centre, and "ATCAA Boundaries" is a different kind of airspace.
  - SWIM: the flight data service (SFDPS) lists an "En Route Airspace Data" service that goes to "authorized consumers" over a SWIM subscription. That is not an open download. Whether it carries sector shapes could not be confirmed; its technical documents were not read.
- **Terms.** Both datasets carry the same licence text, which begins "The data provided is for public use." The rest of it is a caution about non-US airport records. The credit line is "Federal Aviation Administration, Air Traffic Organization, Mission Support Services, Aeronautical Information Services." The ADDS site says that using its data is agreeing to the "FAA Data Disclaimer", which disclaims liability and makes no warranty once the data "has been modified in any way by a third party". It sets no condition on copying or redistribution. Neither it nor the dataset pages has a "not for navigation" statement; this project adds its own. As a work of the United States government the data has no copyright in the United States (17 U.S.C. § 105); the FAA pages read do not say this themselves.

**Flight list and detail.** A virtualised, sortable, filterable table of the aircraft in view, synced with map selection in both directions. The detail card shows route, speed, and the altitude profile as far as the aircraft has flown, taken from its track. The trail is requested over the socket for the selected aircraft, and for a hovered one after a short delay.

The detail panel, as built (milestone 5; `apps/web/lib/flight-detail.ts`, `apps/web/components/flight-detail/`):

- **Everything comes from the WASM store**: who the aircraft is from its metadata, where it is from its newest sample, and its altitude profile from the track the store already holds for whatever is selected. No web API is asked, so a stress-mode clone is shown like any other, with a "Clone" mark.
- **Once a second** the panel's data is read again, and at once when the selection changes. The profile's times and altitudes are copied out of WASM memory, a few kilobytes at most.
- **Altitude is feet above mean sea level** and is labelled "Altitude", with its unit. It is never written as a flight level, which is a barometric reading.
- **The altitude profile** is one line of altitude against time, from the first sample of the track to now. Its axis runs from the ground to a round number of thousands of feet that leaves the top quarter clear, where the axis's label sits. The newest point is marked and read out above the chart; the pointer reads out any other.
- **An aircraft that has left the picture** keeps its name and its profile, and the panel says it has gone, for the three seconds before the selection is cleared.

The flight list, as built (milestone 5; `crates/atc-core/src/store.rs`, `apps/web/lib/flight-list.ts`, `apps/web/components/flight-list/`):

- **WASM sorts and filters.** `list_refresh(sort, descending, filter)` goes through every aircraft in the newest positions frame, keeps those whose callsign, type, origin or destination contains the filter text whatever its case, and sorts them by one of seven keys. Text is compared by its bytes, packed into one integer; an aircraft with nothing to sort by comes last either way, and equal ones are in order of id. It leaves aircraft ids in a buffer, not rows: a row means an aircraft only until the next frame, and the list is read for longer than that.
- **The page holds ids and nothing else.** Once a second, and at once when the sort or the filter changes, it calls `list_refresh` and copies the ids out of WASM memory, 240 kB at 60,000 aircraft. A view over the memory would be detached when it next grew.
- **Strings only for the rows on screen.** The table is virtualised with TanStack Virtual at a fixed 24 px a row. Each row it renders asks the store for that one aircraft's fields, which is where its strings are made. About 26 rows exist in the DOM however long the list is.
- **`useSyncExternalStore`** reads a snapshot that is a new object after each refresh, so the rows' numbers follow the picture once a second. The timer runs only while the list is on screen.
- **Selection goes both ways.** A click on a row selects that aircraft, and a second click lets go of it; resting the pointer on a row hovers it, so its ring and trail show on the map. An aircraft selected on the map is scrolled into view here, once, and marked.
- **Measured at multiplier 7**, 60,650 aircraft, in headless Chromium on a 4-core cloud machine with no GPU, with `/?aircraft=hidden` so that software rendering of 60,000 icons did not drown the reading: the once-a-second refresh took 5 to 8 ms (7 to 9 ms sorted by callsign); a click on a heading took 8 to 10 ms of main-thread time from the click through React's render; a scroll of 40,000 px took under 3 ms; 26 to 34 rows were in the DOM, at the top and 50,000 rows down. Outside a browser the sort alone takes 3 ms at 60,583 (`bun tools/bench-store.ts`). These are not the M1 Pro's figures, which should be lower.

**Flight search.** A search box finds flights by callsign among those flying now and those seen in the last 24 hours. Choosing a flight that is still in the air selects it on the map. Choosing one that has finished draws its recorded track. Clones are not searchable; they carry their source's callsign.

## 11. Authentication

```mermaid
sequenceDiagram
  participant B as Browser
  participant N as Next.js (Better Auth)
  participant S as atc-server
  B->>N: Sign in (demo account or GitHub)
  N-->>B: Session cookie
  B->>N: API calls, with the cookie
  B->>N: GET /api/auth/token
  N-->>B: Signed JWT with role
  S->>N: Fetch public signing keys, cached
  B->>S: WebSocket connect ?token=...
  S->>S: Verify signature, expiry, issuer
  S-->>B: Binary frames
```

Better Auth runs in the Next.js server and keeps accounts and sessions in Postgres, through its Drizzle adapter.

- **Sign-in.** Email and password for two demo accounts created by the setup service, one per role, so the app works without any OAuth setup. GitHub sign-in is offered when its client id and secret are configured.
- **Roles.** `viewer`, and `controller`, which may change simulator settings. The admin plugin stores the role on the user record. GitHub users start as `viewer`, except usernames listed in `CONTROLLER_GITHUB_USERS`, which are created as `controller`.
- **The web API uses the session cookie.** Pages and API routes share an origin, so nothing else is needed.
- **The socket uses a token.** Browsers cannot set headers on a WebSocket, and `atc-server` has no access to the session. The JWT plugin issues a short-lived token carrying the user id and role, which the browser fetches just before connecting and sends in the query string. `atc-server` redacts it from its logs.
- **Verification.** The JWT plugin publishes the public keys it signs with. `atc-server` fetches them from `ATC_JWKS_URL`, caches them, and refetches when it sees an unknown key id. There is no shared secret. The token's role claim is the only authority on the Rust side.
- **Checked at connect only.** A sign-out or role change takes effect at the next connection.
- **Origin check.** `atc-server` refuses socket connections whose origin is not `ATC_ALLOWED_ORIGIN`.
- **Route protection.** Unauthenticated visits redirect to the sign-in page, through Next.js 16's `proxy.ts`.
- **Development.** With `ATC_AUTH=off` the server skips verification and treats every connection as a fixed dev user. It logs a warning at startup when the switch is set.

In the default setup `atc-server` runs in Docker and the web app on the host, so `ATC_JWKS_URL` points at the host; under the `full` profile it points at the web container.

**Spike findings (milestone 1).** The design above was built and run end to end before milestone 4 depends on it. Decision: **Better Auth, on the Bun runtime.** Neither fallback was needed.

Versions: Bun 1.4.5, Next.js 16.3.1, `better-auth` 1.7.28, `drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11, `pg` 8.23.1, `jose` 6.2.18 (tests and `tools/verify-token.ts` only).

- **Drizzle adapter and `pg` under Bun: works, with one setting.** Next.js keeps `pg` out of the server bundle and loads it at run time through a hashed alias under `.next/node_modules`. Under `next dev` on Bun that alias does not resolve, and every database call fails with "Cannot find package 'pg-<hash>'". `transpilePackages: ["pg"]` in `next.config.ts` bundles it instead, and dev then works. A production build (`next build` and `next start`) on Bun worked with the setting and, in the reviewer's run, without it, so the failure was seen in dev only. On Node, dev works without the setting. Anyone removing the setting should test `next dev` on Bun first.
- **Tables.** Better Auth needs `user`, `session`, `account` and `verification`; the admin plugin adds `role` and the ban columns to `user` and `impersonated_by` to `session`; the JWT plugin adds `jwks`. They are written by hand in `apps/web/db/auth-schema.ts` and created by migration `0001`. A test compares that file with the fields the configured plugins ask for, so a plugin change that needs a new column fails the test and not a request.
- **Email and password.** Sign-in works for an account created on the server with `auth.api.createUser`, which also sets the role and needs no session. Public registration is switched off (`disableSignUp`), so the only accounts are the ones the setup service creates, plus GitHub users in milestone 4.
- **Roles.** The admin plugin takes custom roles through its access-control option: `viewer` and `controller`, with `viewer` as the default. No role is an admin role, so the plugin's management endpoints refuse everyone, which matches "no admin screen in v1".
- **Token.** `GET /api/auth/token` with the session cookie returns a JWT; without a session it returns 401. It is signed with EdDSA (Ed25519), carries `sub` (the user id), `role`, `iat`, `exp`, and both `iss` and `aud` set to `BETTER_AUTH_URL`. The lifetime is set to 5 minutes.
- **Public keys.** `GET /api/auth/jwks` needs no session and returns a standard JWK set with a `kid` per key. `tools/verify-token.ts` verifies a token from outside Next.js using only that URL, and rejects a tampered token and a wrong issuer.
- **Route protection.** `proxy.ts` runs on the Node.js runtime in Next.js 16, so it can call `auth.api.getSession` and check the session against the database. It redirected a request with no cookie and one with a forged cookie, and let a signed-in request through, in dev and in a production build on Bun. The spike's `proxy.ts` and placeholder sign-in page are not kept, because milestones 2 and 3 run without sign-in; milestone 4 adds them.

**As built (milestone 4): sign-in methods, roles and demo accounts.**

- **Demo accounts.** `viewer@example.com` and `controller@example.com`, named in `apps/web/lib/demo-accounts.ts`. The setup service creates them after the migrations, through `auth.api.createUser`, so the setup image carries `lib/auth.ts` and needs `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` as well as the two passwords. It checks all of them before it changes anything. Running it again leaves a correct account alone, and puts back a password or a role that differs from the configuration, so a password changed in `.env` takes effect at the next `docker compose up`.
- **GitHub.** The provider is configured only when both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set; without them a request to start a GitHub sign-in is answered 404. Anyone with a GitHub account may sign in, and the first sign-in creates the account.
- **`CONTROLLER_GITHUB_USERS`** is applied in a `user.create.before` database hook, once, when the account is created. Usernames are compared without regard to case. Listing a user later does not promote an account that already exists, and removing one does not demote it.
- **How the hook learns the username.** Better Auth strips `role` from what a provider's profile may set (the admin plugin marks it `input: false`), and does not show the hook the profile. So the provider's `mapProfileToUser` notes the username in an `AsyncLocalStorage` that `handleAuthRequest` opens around each request, and the hook reads it there. The route serves `handleAuthRequest`, not `auth.handler`; a sign-up handled outside it has no note and is a viewer, which is the safe way to fail.
- **No account linking.** `account.accountLinking.enabled` is false, so a GitHub sign-in whose email matches an existing account is refused and does not join it. GitHub is no way into a demo account.
- **Tested** against Postgres with GitHub played by a stub of `fetch` (the token exchange and the two profile calls): a listed user is created as `controller` and the socket token carries that role, another user is a `viewer`, the list is applied at creation only, and a matching email is not linked. Not seen: a sign-in against GitHub itself, which needs an OAuth app.

**As built (milestone 4): the sign-in page, sign-out and route protection.**

- **Route protection** is `apps/web/proxy.ts`. It checks the session against the database, sends a visit to any page without one to `/sign-in`, and sends a signed-in visit to `/sign-in` on to the app. It covers every path except `/api/`, Next.js's own files and the two files in `public/`. API routes are left out on purpose: they answer 401 themselves and must not redirect.
- **The page checks again.** `app/page.tsx` reads the session itself, through `currentUser()` in `lib/session.ts`, and redirects without one. It needs the user anyway, and a matcher is easy to get wrong.
- **Where to return to** travels as `?next=`, and is checked wherever it is read (`safeNextPath` in `lib/next-path.ts`): only a path on this origin, never the sign-in page or the API. Anything else gives the front page. The check is made on the path it returns, not only on the text it is given, because parsing removes dot segments and `/.//host` becomes `//host`; `proxy.ts` also refuses to redirect off its own origin whatever it is handed.
- **The sign-in page** has the email and password form, a button for each demo account that fills in its address, and the GitHub button when GitHub is configured. The page never contains a password: choosing a demo account says which `.env` variable holds it. A wrong address and a wrong password get the same message.
- **Signing in and out are server actions** (`app/sign-in/actions.ts`) that call Better Auth on the server; its `nextCookies` plugin sets and clears the cookie. There is no Better Auth client in the browser.
- **A session that ends under the open page.** The app is one long-lived page with no navigation, so `useSessionWatch` asks `/api/auth/get-session` every five minutes and whenever the page becomes visible again, and goes to `/sign-in?reason=expired` when the answer is that there is none. A request that fails, or a server error, is not treated as an ended session.
- **The shell** shows the user's name and role in the top bar, beside the sign-out button.

**As built (milestone 4): the socket token in the browser.**

- **Claims.** `sub` (the user id), `role`, `iat`, `exp`, and `iss` and `aud` both `BETTER_AUTH_URL`, signed with EdDSA, good for five minutes. `role` is always `viewer` or `controller`: a user with no role, or one this version does not know, gets a viewer's token.
- **A fresh token for every attempt.** The first connection, each retry, and a reconnect asked for by hand all fetch their own; none is kept or reused, and the request is made with `cache: "no-store"`.
- **An ended session.** Only a 401 from the token route counts. The socket client stops, the status becomes `closed` with the reason `session-ended`, and `lib/traffic.ts` sends the browser to `/sign-in?reason=expired` with the address to come back to. Coming back to the tab does not retry. The card that shows meanwhile offers the sign-in page, not "Reconnect now".
- **Logging.** The page's own code never logs the address, which carries the token. Chrome itself names the full address in its console line for a connection that fails; that is the user's own console and their own token.

**As built (milestone 4): verification in `atc-server`** (`crates/atc-server/src/auth.rs`).

- **What is checked,** at the upgrade request and nowhere after: the `Origin` header, then the token in `?token=`. The token must be signed with EdDSA by a key the web app publishes, be unexpired, carry `iss` and `aud` equal to `ATC_TOKEN_ISSUER` (by default `ATC_ALLOWED_ORIGIN`), a non-empty `sub`, and a `role` of exactly `viewer` or `controller`. Any other algorithm, `none` included, is refused before the signature is looked at. An unknown role is refused, not taken for a viewer.
- **Clocks.** Thirty seconds of leeway on the expiry, for a container whose clock has drifted from the host's.
- **Keys.** Fetched from `ATC_JWKS_URL` when the first token arrives, not at startup, so the server starts and answers `/healthz` with no web app. They are kept in memory by key id. A token naming an id that is not held makes the server fetch again, at most once in ten seconds, because anyone can send such a token. A fetch that fails keeps the keys already held. A burst of connections makes one request.
- **Answers.** 403 for the origin, 401 for a missing or bad token, 503 when the keys cannot be had: that one is not the client's fault, and the browser retries any refusal anyway. The response body and the server's log give the reason in words ("the token has expired", "the token's signature is wrong") and never anything from the token.
- **The token is not logged.** The server logs no request line. In the code the token is a type whose `Debug` prints `<redacted>` and that has no `Display`.
- **The role is kept on the connection.** Nothing is refused by role yet; `set_multiplier` in milestone 8 is the first thing that will be.
- **`ATC_AUTH=off`** skips all of it and makes every connection the dev user, a controller, with a warning at startup. `.env.example` now leaves it empty, so `docker compose up` verifies tokens.
- **The command-line client** takes `--token` or `ATC_TOKEN` and puts it in the query string as the browser does. `bun tools/socket-token.ts [viewer|controller]` prints one, by signing in to the running web app as a demo account.
- **HTTPS.** The keys URL may be `https://`. The client is built on rustls with the `ring` provider that `sqlx` already brings, and trusts the certificate authorities compiled into the binary (`webpki-roots`), not the machine's: the server image carries no certificates, and a client that reads the system's will not even build without them. The default setups use `http://` on the machine or the compose network.
- **Reaching the web app from the container.** `host.docker.internal` is mapped to the host in `docker-compose.yml`. On Linux the web app must then listen on an address the container can reach, which `bun dev` and `next start` do by default.
- **Tested** with tokens signed in the tests against a stand-in for the keys URL: every refusal above through the verifier, and missing, expired, forged, altered and foreign tokens and a wrong origin through a real socket. Also run against Better Auth itself; see the pull request.

Consequences for later work:

- `atc-server` must verify EdDSA signatures, and must check `iss` and `aud`. Both equal the web app's public URL, which in the default setup is also `ATC_ALLOWED_ORIGIN`.
- The private signing key is stored in `jwks` encrypted with `BETTER_AUTH_SECRET`. Changing the secret makes the stored key unreadable and token requests fail until the `jwks` rows are deleted.
- `next build` succeeds with no configuration, but Better Auth logs a "default secret" error while Next.js collects page data. It is noise at build time; the startup check stops a server that really has no secret.


## 12. Persistence

One Postgres runs as a compose service, with one schema. Drizzle, in the web app, owns every table and every migration.

| Table | Written by | Contents |
|---|---|---|
| Better Auth's tables | Next.js | Users with their role, accounts, sessions, signing keys |
| `flights` | atc-server | One row per real flight per pass, written when it appears: aircraft id, ICAO24, callsign, type, origin and destination where known, pass number, sim time and wall-clock time first and last seen |
| `flight_tracks` | atc-server | The track so far, appended in batches of up to five minutes: the flight, the sim time of the first sample, the sample count, and the samples at 10 s spacing as `bytea` in the seed file's difference encoding. Keyed by the flight and that sim time |
| `saved_views` | Next.js | Per-user named camera positions, 2D/3D mode, filters |
| `preferences` | Next.js | Per-user units, vertical exaggeration, layer visibility: one row a user, the settings as one `jsonb` value |
| `alerts` | atc-server | Conflict history: the two `flights` rows, predicted time and distance of closest approach, wall-clock times raised and cleared, sim time, pass number |

`atc-server` writes three tables, `flights`, `flight_tracks` and `alerts`, and reads none. It uses sqlx with queries checked at run time. At startup it verifies that the columns it needs exist and stops with a clear message if they do not, because a schema change on the TypeScript side cannot fail the Rust build.

The same flights and the same conflicts recur on every pass, so `atc-server` deletes rows older than 24 hours from all three tables. The three share one retention because an alert names two `flights` rows.

## 13. Testing

- **Unit tests** live beside the code: `cargo test` for the crates, `bun test` for the web app and tools.
- **Wire format.** Encode and decode round-trip tests in `atc-core`, covering every frame kind.
- **Parity.** One test runs decode and prediction natively and in WASM on the same input and compares the results, since "the same code on both sides" is the central claim.
  - Until prediction exists it covers the store. `crates/atc-wasm/examples/parity.rs` plays two minutes of the fixture into the store natively, with late and missing frames, a narrower viewport and a stalled render loop, and writes down every call it made and every buffer it read. `tools/store-parity.test.ts` makes the same calls on the WASM package and requires the same bytes. It runs with `bun run test`, after `bun run wasm:build`.
- **Server integration.** A test starts the hub in process on the fixture feed and connects a real WebSocket client. It asserts viewport filtering, metadata delivery, that a track frame stops at the current sim time, latest-wins behaviour, token rejection and the `controller` check on `set_multiplier`.
- **Database.** Tests for the API routes, and the server's flight and alert writes run against a real Postgres in CI. One test shows a user cannot read another user's views.
- **End to end.** One Playwright smoke test from milestone 4: sign in with a demo account and see aircraft on the map.
  - As built (`apps/web/e2e/smoke.e2e.ts`, run with `bun run e2e` after `bun run build`). Playwright starts `atc-server` and the production web app itself. The server replays its built-in fixture (`ATC_SEED_FILE=fixture`, eleven aircraft, no file read) and verifies tokens for real against the web app's keys. The web app's command first runs the setup step, as compose's `setup` service does.
  - The test: a visit with no session lands on sign-in; the demo viewer signs in; the top bar names the viewer; the connection status reaches "Live", which takes a token the server accepted; the socket's address carries a token; the HUD's aircraft count is above zero; signing out closes the app again; and the page raised no error. It does not look at the map's pixels, and passes whether or not the hosted tiles load.
  - No retries. In CI it is the "End to end" job, on the runner with a Postgres service container.
- **Logging and metrics.** `atc-server` logs through `tracing`, at the level `ATC_LOG_LEVEL` sets. It counts its own work without locking, and at `info` logs one summary line every 30 seconds: the number of ticks and their mean and longest duration (advancing the simulation and updating the world state), the same for building the shared whole-picture frame, the aircraft in the picture, the clients connected, the frames sent, the pictures clients skipped because they were still being written an earlier one, and the bytes a second per client. The conflict pass's duration joins the line when the detector exists. The benchmark reads the same counters.
- **Performance.** Benchmarks for encode, grid filtering and the conflict pass, and a fixed-camera benchmark page for the browser targets in section 15.
- **CI** runs formatting, linting and all of the above on pull requests, and builds the WASM package, the web app and the Docker images.

## 14. Licences and attribution

- **Code.** MIT; see `LICENSE` at the repo root. The data and assets below keep their own terms.
- **Seed tracks.** adsb.lol data is under the ODbL 1.0. The seed file and the sample traces are derivative databases, so they stay under the ODbL, whatever the licence of the code around them. The licence asks three things of this repository:
  - A notice with the data naming the source and the licence, with the licence's address (section 4.2). `data/README.md` carries it, with the day and window baked.
  - A notice wherever the picture is shown publicly, that it contains information from adsb.lol made available under the ODbL (section 4.3). The app's attribution control carries it from milestone 3, beside the map's.
  - The derived database itself, or the method that made it (section 4.6). The repository has both: the committed file, and the bake script with the release it was run on.
- **Airspace.** FAA open data from the Aeronautical Data Delivery Service, stated by the FAA to be "for public use". No licence has to be reproduced. Using the data means accepting the FAA Data Disclaimer, which is a disclaimer of liability and warranty, not a limit on redistribution. `data/README.md` names the source, the cycle and the date fetched, gives the FAA's credit line, and says that the files have been changed from the FAA's originals and are not for navigation. The app's attribution control credits the FAA when the airspace layer is added. The findings are in section 10.
- **Map.** MapLibre GL JS is BSD-licensed. The base map needs on-screen attribution to OpenFreeMap, OpenMapTiles and OpenStreetMap, which MapLibre adds automatically from the tile source, and the terrain needs attribution to Mapterhorn's sources: Mapterhorn asks for a link to its list of them, `https://mapterhorn.com/attribution`, and does not require a credit for itself. The attribution control is kept open at every width, not folded behind a button.
- **Aircraft icon and 3D model.** Drawn for the project or taken from sources whose licences allow redistribution, and recorded in the same file. The icon, `apps/web/public/aircraft.svg`, was drawn for the project and is under the MIT licence with the code.

## 15. Milestones

Each milestone ends with a condition that can be checked.

1. **Scaffold.** Bun and cargo workspaces, compose file with Postgres and the setup service, Drizzle, configuration, CI, and two spikes: Better Auth on Next.js 16 and Bun, and a WASM module loaded in the Next.js page.
   *Done when:* from a fresh clone with `.env` copied from `.env.example`, `docker compose up` gives a migrated Postgres and `GET /healthz` returns 200; `bun install && bun dev` serves a page that calls into WASM; CI passes on a pull request; both spike outcomes are written into this document.
2. **Seed, sim and socket.** Bake script, the seed file and its reader, sim engine with the startup multiplier, WebSocket hub, a CLI client, and the airspace data spike.
   *Done when:* using only committed files, `docker compose up` starts the replay and the CLI client shows 1 Hz frames with about 8,000 aircraft for the whole picture, fewer after a narrower viewport, metadata for every aircraft, and a clean pass boundary; at multiplier 7 it shows 50,000+ and the server tick meets its target; the integration test passes in CI.
3. **Map and WASM path.** Socket client, WASM store and interpolation, map, 2D aircraft layer with picking, performance HUD, app shell.
   *Done when:* the browser shows smoothly moving aircraft at multiplier 1; panning changes which aircraft arrive; a HUD reading at 50k is recorded; CI builds the WASM package and the web app.
4. **Auth.** Sign-in, roles, route protection, and token verification on the socket.
   *Done when:* an unauthenticated visit redirects to sign-in; a socket connection with a missing, expired or forged token is refused (tested); demo sign-in works with no GitHub configuration; the CLI client still works; the smoke test passes.
5. **Lists, detail and persistence.** Flight list, the flight recorder, flights API and search, detail panel, trails, saved views, preferences, layer and unit controls.
   *Done when:* selecting in the list highlights on the map and the reverse; the list stays responsive at 50k; a trail and detail load for a real aircraft and for a clone; a finished flight is found by search with its whole track, and a flight still in the air has no recorded sample later than the current sim time; a saved view and preferences survive a restart; a test shows one user cannot read another's views.
6. **3D and airspace.** 3D mode, stems, aircraft models, Class B volumes, ARTCC boundaries.
   *Done when:* a toggle switches between 2D and 3D; aircraft sit at altitude and stay in step with the airspace volumes as exaggeration changes; every Class B area in the coverage area renders with the right floors and ceilings; mode and exaggeration persist.
7. **Prediction and conflicts.** Prediction, time scrubber, prediction error, conflict detector, alerts panel and alert history.
   *Done when:* scrubbing to +20 minutes holds 60 fps at multiplier 1; a known conflict in the fixture raises an alert, shows in the panel with a pair link, clears, and leaves a row with both times; the conflict pass meets its target at 50k; the parity test passes.
8. **Stress mode.** Changing the multiplier at run time with a `controller`-only control, the plain-JavaScript path, and the measured results.
   *Done when:* a `controller` can change the multiplier from the UI and a `viewer` is refused; a results table is committed covering every target below, for both the WASM and JavaScript paths, naming the hardware and browser.
9. **Web container.** Web app Dockerfile and the `full` compose profile.
   *Done when:* on a machine with only Docker, a fresh clone plus `.env` and `docker compose --profile full up` leads to a demo sign-in and the live map; the README's run instructions are no longer marked as planned.

**Performance targets**, measured on an M-series laptop in Chrome with a fixed whole-picture camera in 2D, all 50,000 aircraft in view and picking on:

| Measure | Target |
|---|---|
| Frame time, 95th percentile | 16.7 ms or less (60 fps) |
| WASM advance per frame | under 2 ms |
| Server tick: advance the sim and build one whole-picture frame | under 100 ms: every tick when run natively, and the 99th percentile under Docker |
| Conflict pass | under 1 s |

Measured for the server tick in milestone 2, on the committed recording at multiplier 7 (60,583 aircraft, a 1.5 MB frame of 24-byte records), on an M1 Pro, over five runs of 300 ticks: a median of 10.3 to 11.5 ms, 11.1 to 15.0 ms at the 95th percentile, and 30.4 ms at the longest tick of them all. The laptop was busy with other builds throughout. Advancing the simulation and updating the world state take about half each; building the frame takes 0.4 ms. The 20-byte record, run in turn with it on the same day, gave medians of 10.8 to 12.8 ms and a 1.2 MB frame: the four bytes added cost 0.05 ms in building the frame and nothing that shows in the tick. `cargo bench -p atc-server --bench tick` repeats it and fails if any tick passes 100 ms.

Under Docker Desktop on the same laptop, which is how `docker compose up` runs the server, the reviewer read the tick from the server's own summary lines at multiplier 7: a mean of 16 to 20 ms with no client or one, and 26 to 29 ms with two. That is about twice the native figure and well inside the target. Single ticks are another matter: the longest in each half minute ran from 20 to 95 ms, and one reached 131 ms. Those figures leave out the frame build, about 1 ms, and were read with the 20-byte record.

So every tick meets the target natively, and under Docker the mean does but an occasional tick reaches or passes it. That is accepted, and the target is worded to match: under Docker it is the 99th percentile that must stay under 100 ms. The server's summary line gives a mean and a longest tick, not a percentile, so the Docker figure has not been measured as one; the longest tick in a half minute, which is the longest of about 30, passed 100 ms once in the reviewer's run. A late tick costs little. Ticks are a second apart, so one that takes 130 ms does not delay or skip the next; its frame arrives that much late, and the browser, which draws one update behind and dead-reckons past a late frame, covers it. The time to look again is milestone 7, when the conflict pass starts competing for the same cores.

Measured for the WASM advance in milestone 3, outside a browser, on the same M1 Pro with made-up aircraft flying straight: at 50,000 aircraft a median of 0.14 ms under Bun 1.4.5 (JavaScriptCore) and 0.16 ms under Node 24 (V8, the engine Chrome uses), and at 60,583 a median of 0.16 and 0.19 ms. The native build takes 0.06 ms. The first `advance` after a frame also takes up the new rows and colours and takes 0.6 to 0.8 ms; ingesting the frame itself, once a second, takes 3 to 4 ms in WASM. `bun tools/bench-store.ts` and `cargo bench -p atc-core --bench store` repeat it, and fail if the median passes 2 ms. The reading in Chrome with the map drawn is the HUD's, below.

Measured for the frame time in milestone 3, in headless Chrome and so indicative only: the reading the milestone asks for is the HUD's in the owner's own Chrome, which follows the two tables' notes. Chrome 158 run with `--headless=new` on the same M1 Pro, WebGL renderer "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)", a production build, a 1600 by 1000 window at device pixel ratio 2, the map 1248 by 873 CSS pixels, the camera as the page opens, on the whole picture, in 2D. The first four rows were taken before picking was built and the three "picking on" rows after. The first three columns are the HUD's own lines, read once a second; the rest were taken from outside the page's code over the DevTools protocol, and the two agree where they overlap.

| | Aircraft | HUD: FPS, Frame p95, Frame p99 | Frames over 17.5 ms | HUD: WASM, Attributes, Map (median of the readings; highest) | WASM advance, every frame: median, 95th, 99th, longest | Main thread per frame | Long tasks |
|---|---|---|---|---|---|---|---|
| Multiplier 7 | 60,400 | 60, 16.8 ms, 16.8 ms | 0 of 3,612 | 0.9, 0.2, 1.9 ms; 2.1, 0.5, 3.4 ms | 0.6, 1.7, 2.1, 3.3 ms | 3.7 ms | 0 |
| Multiplier 7, aircraft not drawn | 60,450 | 60, 16.8 ms, 16.8 ms | 0 of 3,613 | 1.3, 0.2, 2.0 ms; 2.0, 0.4, 3.8 ms | 0.6, 1.8, 2.1, 3.3 ms | 3.4 ms | 0 |
| Multiplier 1 | 8,400 | 60, 16.8 ms, 16.8 ms | 0 of 2,409 | 0.2, 0.1, 2.4 ms; 0.3, 0.6, 4.8 ms | 0.1, 0.3, 0.5, 1.0 ms | 3.1 ms | 0 |
| Multiplier 1, aircraft not drawn | 8,430 | 60, 16.7 ms, 16.8 ms | 0 of 2,408 | 0.1, 0.1, 2.1 ms; 0.3, 0.3, 4.1 ms | 0.1, 0.3, 0.4, 0.7 ms | 3.2 ms | 0 |
| Multiplier 7, picking on, pointer still | 60,390 | 60, 16.7 ms, 16.8 ms | 0 of 3,606 | 0.2, 0.1, 0.8 ms; 0.3, 0.2, 1.1 ms | 0.2, 0.3, 0.9, 6.6 ms | 1.6 ms | 0 |
| Multiplier 7, picking on, pointer moving | 60,470 | 60, 16.7 ms, 16.8 ms | 0 of 3,611 | 0.2, 0.1, 0.8 ms; 0.3, 0.2, 1.1 ms | 0.2, 0.3, 0.7, 0.9 ms | 9.8 ms | 0 |
| Multiplier 7, picking on, one selected, pointer moving | 60,530 | 60, 16.7 ms, 16.8 ms | 0 of 3,615 | 0.2, 0.1, 0.9 ms; 0.3, 0.1, 1.1 ms | 0.2, 0.3, 0.8, 1.6 ms | 10.9 ms | 0 |

The multiplier 7 rows are 60 seconds each and the others 40. "Aircraft not drawn" is `/?aircraft=hidden`, which runs the loop and the writes and leaves the layer out of the drawing. The same at multiplier 7 in a 2560 by 1440 window, where MapLibre holds the canvas to 4096 by 2436, also dropped no frame in 30 seconds. So in headless Chrome the frame-time target is met at 60,000, and on this evidence the GPU-interpolation alternative (below) is not needed.

The "picking on" rows are 60 seconds each, one after another on one page load. "Pointer moving" is a pointer event about every 17 ms along a path that covers the map, 3,600 in the minute, each of which made one hover pick. The laptop was busy when they were taken: a one-minute load average of 6 at the start and 12 at the end, part of it the server at multiplier 7 and Chrome themselves. The four rows above them were taken on another day under another load, and the difference between the two sets in the WASM, Map and main-thread columns is the machine and the day, not picking. Compare the picking rows with each other.

**The owner's reading**, in a Chrome window and not headless, taken on 26 November 2026 from a screenshot of the page: the production build against the server under Docker at multiplier 7, the whole picture in 2D with the camera as the page opens, picking on.

| HUD line | Reading |
|---|---|
| FPS | 75 |
| Frame p95, Frame p99 | 14.1 ms, 14.3 ms |
| WASM, Attributes, Map | 0.80 ms, 0.20 ms, 3.00 ms |
| Aircraft | 60,492 |
| Network | 1.45 MB/s |
| Skipped | 0 frames |

- **The target is met**: 14.1 ms at the 95th percentile against 16.7 ms, with 60,492 aircraft drawn, and the WASM advance at 0.8 ms against 2 ms.
- **75 frames a second, not 60.** The laptop's main display is a 2560 by 1440 monitor at 75 Hz, so this is most likely the page drawing on every refresh of that display, a frame every 13.3 ms. Headless Chrome draws at 60. The target was written for 60 Hz; at 75 Hz there is 13.3 ms to a refresh, and a 95th percentile of 14.1 ms says most frames keep to it and some run a little over.
- **What the reading is and is not.** It is one moment of the HUD, not ten seconds watched. The screenshot does not show where the pointer was, so it is taken as the pointer-still reading. The window was about 1,300 by 975 CSS pixels by the screenshot. Chrome 158.0.8127.88 is the version installed on the laptop; the version and the renderer were not read from `chrome://version` and `chrome://gpu`, and the device pixel ratio was not noted.
- **Not taken:** the reading with the pointer sweeping over the aircraft, where each hover pick holds the main thread for about 9 ms, and the reading at `/?aircraft=hidden`. Headless, the sweep dropped no frame at 60 Hz. At 75 Hz a 9 ms pick leaves about 4 ms of a frame, so the sweep is the reading most likely to show a late frame, and it is the first thing to take if hover ever feels slow. The steps below still describe it.

**The cost of picking**, in headless Chrome and so indicative only:

- **No frame was late** with the pointer moving all the time at 60,000 aircraft, and the HUD read the same as with it still. So the frame-time target is met with picking on, in headless Chrome.
- **A hover pick holds the main thread for about 9 ms at 60,000 aircraft.** `gl.readPixels`, which only picking calls, took a median of 8.5 ms, 9.9 ms at the 95th percentile and 11.5 ms at the longest of 3,601, and the animation-frame callback the pick is made in 8.8 ms. Main-thread time per frame went from 1.6 ms with the pointer still to 9.8 ms with it moving. At 8,000 aircraft the same read took a median of 4.1 ms, and the main thread 7.4 ms a frame against 2.7.
- **Most of that looks like waiting, not work.** `readPixels` is synchronous: it returns when the GPU has finished what it was given before it. deck.gl makes the hover pick in its own animation-frame callback, which here ran after the render loop's, so the read comes straight after the frame's draw calls. Picks made by clicks arrive at any point in a frame, and of 154 of them 60 took under 3 ms, with a median of 2.0 ms, 28 took 3 to 6 ms and 66 longer, up to 13.8 ms. The reading that fits is that a pick by itself costs about 2 ms and the rest is the GPU finishing the frame, which nothing else here measures. That reading was not tested by moving the pick.
- **The HUD does not show it.** The pick is in none of the WASM, Attributes and Map lines, which is why those columns do not move between the still and the moving rows. With the pointer moving there are about 7 ms of the 16.7 left on the main thread at 60,000, against 15 with it still.
- **A click** is two picks, deck.gl's when the button goes down and the page's at the click. In a minute of two clicks a second no frame was late; in a second run of 40 seconds, on a busier laptop, one frame of 2,405 was a tick late.
- **The marks** cost nothing that shows: 24 bytes written a frame, and the row with an aircraft selected reads like the one without.

What these figures do and do not show:

- Every frame arrives on the display's tick or a whole tick late, so the frame time says only that none was late, not how much room there was. The room is in the main-thread time: about 3.5 ms of the 16.7 at multiplier 7, from Chrome's own task accounting. It is much the same at multiplier 1 and with the aircraft not drawn, because most of it is MapLibre drawing the base map, which costs the same however many aircraft there are.
- The map's render time is the main thread's share only. The GPU's time to draw 60,000 icons is not measured here, beyond that it fitted in a frame.
- Timings inside the page are in steps of 0.1 ms, which is Chrome's clock.
- The WASM advance takes longer in the page than in the benchmark above: a median of 0.6 ms against 0.16 ms, with 1.7 to 2.2 ms at the 95th percentile over five runs, against a target of 2 ms. The benchmark calls `advance` in a tight loop; in the page it runs once every 16.7 ms, after the map has drawn a frame and used the processor's caches for something else. The median meets the target comfortably; the 95th percentile is at it. If the owner's reading agrees, the store's memory layout is the place to look, not the map.

**Taking the HUD reading.** On the M1 Pro, in Chrome, with nothing else heavy running:

1. In `.env`: `ATC_STRESS_MULTIPLIER=7`, and the ports as they are used on this machine: `POSTGRES_PORT=55432`, `ATC_SERVER_PORT=18080`, `DATABASE_URL=postgres://atc:atc@localhost:55432/atc`, `ATC_WS_URL=ws://localhost:18080/ws`, `ATC_ALLOWED_ORIGIN=http://localhost:3230`.
2. `docker compose -p atcdemo-dev build --no-cache && docker compose -p atcdemo-dev up -d`, and check that `docker compose -p atcdemo-dev logs atc-server` says "protocol v2" and "at multiplier 7".
3. `bun install && bun run build`, then `bun --filter web start -- -p 3230`. A development build is not representative.
4. Open `http://localhost:3230/` in a Chrome window and leave the camera where it opens. The HUD is top left (`H` shows and hides it). Wait for its "Aircraft" line to pass 50,000, then let it run for a minute.
5. Picking is on, so there are two readings to take. First with the pointer still, resting on the map. Copy these HUD lines: FPS, Frame p95, Frame p99, WASM, Attributes, Map, Aircraft. The last three times change four times a second; watch for ten seconds and note the usual value and the highest. Note the window's size and `window.devicePixelRatio`.
6. Then with the pointer moving: sweep it back and forth over the aircraft for a good ten seconds without pressing a button, and copy FPS, Frame p95 and Frame p99 while it is still moving. Every frame in which the pointer has moved makes one hover pick. The percentiles are over the last 256 frames, about four seconds, so they show a late frame only for that long. Then click an aircraft and sweep again, so the reading is also taken with a ring drawn.
7. Open `http://localhost:3230/?aircraft=hidden`, leave the pointer still, and copy the lines of step 5.
8. Add the readings as rows under the table above, marked as Chrome and not headless, with the Chrome version from `chrome://version` and the renderer from `chrome://gpu`, and resolve the frame-time half of open question 5.
9. Stop the web server, and `docker compose -p atcdemo-dev down -v`.

**If frames are late only while the pointer moves**, the hover pick is what to change, and the aircraft layer is not. In order of how little they give up:

1. Pick before the frame is drawn and not after it. If the wait in `readPixels` is for the frame just drawn, then at the top of the render loop's frame, before `advance`, the GPU has had the whole of the last frame's time to finish, and the click figures above suggest a pick then costs about 2 ms. deck.gl has no public way to move its own hover pick, so the page would take hover on itself: note the pointer's position from MapLibre's `mousemove`, call `overlay.pickObject` at the top of the next frame, and stop deck.gl's own, for which the only switch found is its experimental `_pickable` prop, turned on round the page's own picks. This is reasoned from the measurements; it was not built or measured.
2. Pick only when the pointer comes to rest, a twentieth of a second after its last move. Hover then lags a moving pointer and costs nothing while it moves.
3. Pick on every second or third frame.
4. Above some count of aircraft, do not pick on hover at all, and pick on click only.

The last three also need deck.gl's own hover pick stopped, the same way. None is built, because no frame was late.

**If the target is missed** in the owner's Chrome, the alternative is to interpolate on the GPU. The store already holds each aircraft's last two samples. Upload both, as two position attributes and two angles, once a second when a frame arrives, in place of one interpolated position every frame; pass the render time as a uniform; and mix the two in the vertex shader, in a subclass of IconLayer or a layer extension that adds the attributes and injects the mix where `instancePositions` is read. The per-frame cost on the main thread falls to setting one uniform: no `advance` over every aircraft and no buffer upload. It would take about 1 ms a frame off the main thread at 60,000, and nothing off the 2 to 3 ms the map costs, so it helps only if the advance or the upload turns out to be what is late. The cost is that dead reckoning past the newest sample, the clock that follows late frames, and the positions that picking and the flight list read all have to agree with what the shader draws, so the shader's arithmetic must match the store's. It is not built.

The HUD also reports the split of main-thread time between WASM, deck.gl attribute updates and map rendering, because the base map is often the real limit. If the plain-JavaScript path turns out to be as fast as WASM, the results table says so.

## 16. Open questions

The design decisions are made. These need checking during the build, and each is owned by a spike or an issue in the milestone named:

1. **Better Auth on Next.js 16 and Bun** (milestone 1). Resolved: Better Auth on the Bun runtime, with `pg` bundled through `transpilePackages`. The findings and versions are in section 11.
2. **WASM under Turbopack** (milestone 1). Resolved: the approach in section 4 works with `wasm-pack` as it stands, in dev and in a production build. `wasm-bindgen`'s own CLI was not needed.
3. **adsb.lol download and coverage** (milestone 2). Resolved: the continental United States over a 4 hour window, in a binary seed file of about 41 MB. The measurements for all three candidates are in section 5.
4. **Airspace data** (milestone 2). Resolved: two FAA ArcGIS services, published for public use on a 56 day cycle, give the 29 Class B areas and 20 ARTCCs inside the coverage area. Sector boundaries were not found as open data and are left out. The findings are in section 10.
5. **deck.gl binary attributes at 50k** (milestone 3). Confirm that a single shared icon avoids per-aircraft accessor calls and that the frame-time target is reachable with picking on.
   - **Accessor calls.** Resolved: none run. A constant icon name is set once as a constant vertex attribute, and position, angle and colour are buffers. Read from deck.gl 9.4.2's source and counted in Chrome at 60,000 aircraft; section 8 has how.
   - **Frame time.** Resolved: reachable, with picking on. In the owner's Chrome on the M1 Pro, on 26 November 2026, the HUD read 75 fps with 14.1 ms at the 95th percentile and 14.3 ms at the 99th, at 60,492 aircraft, against a target of 16.7 ms. Headless Chrome on the same laptop agrees: at 60,000 aircraft no frame was late over a minute, with the pointer still or moving all the time, though each hover pick holds the main thread for about 9 ms. One reading was not taken in a window: the pointer sweeping over the aircraft, which on a 75 Hz display leaves the least room. The figures, the cost of picking, and the steps for taking the reading, are in section 15.
6. **Hosted tile terms** (milestone 3). Resolved: nothing in either provider's terms stands in the way, and the style is OpenFreeMap's "dark". Both sites were read on 25 November 2026.
   - **OpenFreeMap.** The terms of service (last updated 24 November 2026) offer the public instance free and "as-is", with no warranty, and say it may be discontinued at any time without notice. They forbid collecting data from it "in automated ways", apart from offline downloads within stated limits (3,000 tiles and 50 MB a download, 4 parallel requests, a User-Agent naming the app); a browser drawing a map is neither. The site's own page says there are no limits on map views or requests, no registration and no key, that commercial use is allowed, and that attribution is required, which MapLibre adds by itself.
   - **Mapterhorn.** It publishes no terms of service and states no usage limits. Its FAQ says the `tiles.mapterhorn.com` endpoint "currently" has no rate limiting, may be used commercially, and may be cached; bulk downloads should use the PMTiles archives instead. Many of its sources require attribution; see section 14.
   - **Style.** OpenFreeMap publishes Positron, Bright, Liberty, Dark and Fiord. Dark is near-black and grey with nothing coloured, so the colour is left to the traffic; Fiord is dark too, but blue and with bright place names. The changes made to Dark are in section 9.
   - Neither service promises to stay up, so the fallback in section 2, serving tiles from local files, stays open.
7. **Airspace volumes over terrain** (milestone 6). MapLibre's fill-extrusion against a deck.gl polygon layer: whichever keeps floors and ceilings correct over high ground and follows the shared exaggeration. MapLibre's docs do not say how fill-extrusion behaves with terrain on.
8. **Flight recorder storage** (milestone 5). Resolved on 2026-11-25, before the recorder is built: all three of the options together. Each batch is stored as `bytea` in the seed file's difference encoding, a batch is five minutes, not one, and rows are kept for 24 hours, not three days. One row a minute as array columns was an estimated 3 to 5 GB a day; this was an estimated 0.7 GB and measured at about 0.9 GB when the recorder was built (#77). The cost is that the web API's track of a flight still in the air is up to five minutes behind; the trail on the map comes over the socket and is not affected. Section 5 has the details.
9. **Barometric altitude on the wire** (milestone 7). Resolved in milestone 3 for positions and tracks: both records carry it, in section 6, so the detail panel and the flight list can show flight levels. Still open for the alert record: whether its two altitudes are barometric, so that an alert's vertical separation reads as a controller would read it, is decided with the conflict detector in milestone 7.

## 17. Possible later work

- What-if instructions: try a heading or altitude change on one aircraft and see the predicted picture and conflicts update, on the user's own screen only.
- Real instructions that change the shared simulation, which needs a flight model in the simulator.
- A live ADS-B feed adapter behind the `Feed` trait.
- Origin and destination for each flight, from a second dataset.
- Sector boundaries, if no open source is found for v1.
- Conflict detection in terminal airspace, with tighter separation below 10,000 ft.
- An admin screen for changing roles.
- Map and terrain tiles served from local files, so the demo runs with no network.
- MapLibre's WebGPU renderer, once it ships and deck.gl can share it.
- A public deployment.
