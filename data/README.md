# Data sources and attribution

The code in this repository is under the MIT licence (see [LICENSE](../LICENSE)). The data and assets below come from other sources and keep their own terms. Each section is filled in by the issue that adds the data.

## Seed tracks

The seed file is not yet added. `data/seed/flights.bin.gz` will be baked from the same day as the sample below, and this section will record its window.

### Sample traces

`data/sample/adsb-2026-11-20/traces/` holds the trace files of 40 aircraft, unchanged, laid out as in the archive. They are for building and testing the bake script without the 3.6 GB download. Clipped to the continental United States between 17:00 and 21:00 UTC they make 42 flights: some aircraft fly two or more legs, and some start or end on the ground.

- Source: [adsb.lol](https://adsb.lol) historical data, release [`v2026.11.20-planes-readsb-prod-0`](https://github.com/adsblol/globe_history_2026/releases/tag/v2026.11.20-planes-readsb-prod-0) of `adsblol/globe_history_2026`, the whole of 2026-11-20 UTC.
- The files are gzip-compressed JSON despite the `.json` name. Their fields are described in [readsb's README-json](https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons).
- Chosen from aircraft seen in the north-eastern United States that have a callsign and a type, at least one flight of 20 minutes, and a trace file under 24 kB.

Contains information from adsb.lol, which is made available here under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). These files, and anything derived from them, stay under that licence and not under the MIT licence of the code.

## Airspace

Not yet added. Class B and ARTCC boundaries will be baked to GeoJSON under `data/airspace/` from FAA open data. This section will record the source and its terms.

## Map tiles

Not yet added. The base map will use OpenFreeMap vector tiles and the terrain will use Mapterhorn elevation tiles, both fetched by the browser at run time. This section will record their terms and the attribution each requires.

## Aircraft icon

Not yet added. This section will record where the icon came from and its licence.

## 3D model

Not yet added. This section will record where the aircraft model came from and its licence.
