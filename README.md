# atcdemo

A real-time air traffic picture of the Boston / New York / Philadelphia / DC corridor, built to stay at 60 fps from a few hundred aircraft up to 50,000+.

> **Status: design stage.** There is no code yet. The full design is in [docs/DESIGN.md](docs/DESIGN.md).

## What it will do

- Show live-looking traffic on a Mapbox map, in 2D and 3D, by replaying recorded real ADS-B tracks.
- Predict each aircraft's path up to 20 minutes ahead, with a timeline to scrub through the predicted picture.
- Detect and flag predicted conflicts between en-route aircraft (pairs coming within 5 nm laterally and 1,000 ft vertically).
- Draw airspace: Class B shelves as 3D volumes, and ARTCC boundaries.
- Provide a sortable flight list, flight search and a detail panel synced with the map.
- Multiply traffic in a stress mode, with an on-screen readout of frame rate and decode time.
- Require sign-in.

The app is watch-only: aircraft always follow their recorded paths.

## How it is built

| Part | Technology |
|---|---|
| Real-time server | Rust (axum, tokio): a simulator that replays recorded tracks, conflict detection, and the WebSocket |
| Transport | WebSocket with binary frames, filtered to each client's viewport |
| Shared core | One Rust crate for the wire format, prediction and conflict maths, compiled natively for the server and to WASM for the browser |
| Web app and API | Next.js, React, TypeScript, Drizzle, Zustand, TanStack Query, Tailwind CSS, shadcn/ui, running on Bun |
| Map and rendering | Mapbox GL JS with deck.gl layers reading typed arrays straight from WASM memory |
| Auth | Better Auth, with a short-lived signed token the Rust server verifies |
| Database | Postgres for recorded tracks, accounts, saved views, preferences and alert history |

```mermaid
flowchart LR
  SEED[("Baked seed tracks")] -->|"loaded once"| PG[("Postgres")]
  PG <--> SERVER["Rust server: simulator, conflict detection"]
  SERVER -->|"binary frames over WebSocket"| WASM["WASM: decode, smooth, predict"]
  WASM --> MAP["deck.gl on Mapbox"]
  WEB["Next.js on Bun: pages, sign-in, API"] --> MAP
  WEB <--> PG
```

## Running it (planned)

None of this works yet; it is the intended workflow once the scaffold lands.

```bash
# Backend and Postgres
docker compose up

# Web app, in a second terminal
bun install
bun dev
```

`docker compose --profile full up` will run the web app in a container too, so one command starts everything.

You will need Docker, [Bun](https://bun.com), a Rust toolchain for building the WASM module, and a Mapbox access token.

## Roadmap

1. Scaffold the Bun and cargo workspaces and the compose file.
2. Seed tool, simulator and WebSocket hub.
3. Map, WASM decode and smoothing, 2D aircraft layer, performance readout.
4. Sign-in, roles and token verification.
5. Flight list, detail panel, trails, saved views.
6. 3D mode and airspace overlays.
7. Prediction, time scrubber, conflict alerts.
8. Stress mode and a WASM versus JavaScript comparison.
9. Web app Dockerfile and the `full` compose profile.
