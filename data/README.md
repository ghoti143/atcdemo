# Data sources and attribution

The code in this repository is under the MIT licence (see [LICENSE](../LICENSE)). The data and assets below come from other sources and keep their own terms. Each section is filled in by the issue that adds the data.

## Seed tracks

`data/seed/flights.bin.gz` is the recording the simulator replays: 39,716 flights over the continental United States (24.4°N to 49.4°N, 125°W to 66.9°W, plus half a degree) between 17:00 and 21:00 UTC on 2026-11-20, sampled every 10 seconds.

- Source: [adsb.lol](https://adsb.lol) historical data, release [`v2026.11.20-planes-readsb-prod-0`](https://github.com/adsblol/globe_history_2026/releases/tag/v2026.11.20-planes-readsb-prod-0) of `adsblol/globe_history_2026`.
- Made by `bun run bake:tracks <dump dir>` from that release, joined and unpacked. The rules it applies and the file's format are in section 5 of the [design document](../docs/DESIGN.md).
- `bun run bake:tracks dump data/seed/flights.bin.gz` lists the flights, and adding a flight's number prints its samples.
- Each sample has two altitudes. One is feet above mean sea level: the point's geometric altitude less the height of the geoid there. The other is the barometric altitude from the source.
- Each re-bake adds about 40 MB to the repository's history, so the file is not re-baked casually.

### Geoid grid

`tools/seed/geoid-grid.json` is the height of the EGM96 geoid above the WGS84 ellipsoid, every half degree from 23°N to 51°N and 127°W to 65°W, in decimetres. The bake uses it to turn GPS heights into heights above sea level.

- Source: the EGM96 geoid model of the US National Geospatial-Intelligence Agency, a US government work, sampled with the [`egm96-universal`](https://github.com/nicolas-van/egm96-universal) package, version 1.1.1 (MIT), which carries the NGA's 15-minute grid.
- The package is not a dependency of this repository; the grid was sampled once and committed.

Contains information from adsb.lol, which is made available here under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The file, and anything derived from it, stays under that licence and not under the MIT licence of the code.

### Sample traces

`data/sample/adsb-2026-11-20/traces/` holds the trace files of 40 aircraft, unchanged, laid out as in the archive. They are for testing the bake script without the 3.8 GB download. `data/sample/flights.bin.gz` is the seed file the bake makes of them, 39 flights, for testing the seed file's readers: some aircraft fly two or more legs, and some start or end on the ground.

- Source: [adsb.lol](https://adsb.lol) historical data, release [`v2026.11.20-planes-readsb-prod-0`](https://github.com/adsblol/globe_history_2026/releases/tag/v2026.11.20-planes-readsb-prod-0) of `adsblol/globe_history_2026`, the whole of 2026-11-20 UTC.
- The files are gzip-compressed JSON despite the `.json` name. Their fields are described in [readsb's README-json](https://github.com/wiedehopf/readsb/blob/dev/README-json.md#trace-jsons).
- Chosen from aircraft seen in the north-eastern United States that have a callsign and a type, at least one flight of 20 minutes, and a trace file under 24 kB.

Contains information from adsb.lol, which is made available here under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). These files, and anything derived from them, stay under that licence and not under the MIT licence of the code.

## Airspace

`data/airspace/` holds the airspace the map draws, baked from the FAA's services by `bun run bake:airspace` (`tools/bake-airspace.ts`). **These files have been changed from the FAA's originals and are not for navigation.**

| File | What it holds | Size |
|---|---|---|
| `class-b.geojson` | The 29 Class B areas that touch the coverage area, as 359 shelves. Each is one polygon with `ident` ("BOS"), `name`, `sector` ("AREA A"), `floorFt`, `floorRef` (`SFC` for a floor at the surface, else `MSL`), `ceilingFt` (always above mean sea level), `exclusion` and the FAA's `GLOBAL_ID` as `id` | 446 kB, 16,903 vertices |
| `artcc.geojson` | The 20 centres that touch the coverage area, as 41 boundaries: a `high` and a `low` one each, New York's high in two rows. `ident` ("ZBW"), `name`, `level`, `id` | 55 kB, 2,304 vertices |

Baked on 2026-11-27 from the cycle effective 0901Z 29 Oct 2026 to 0901Z 24 Dec 2026. A bake in a later cycle may give different files.

What the bake changes:

- **Rows.** Only rows that touch the coverage box (24.4°N to 49.4°N, 125°W to 66.9°W) are asked for, so Honolulu's Class B and the Anchorage centre are left out. Shapes that run past the box are not clipped.
- **Fields.** The FAA's 40 or so fields become the few above. A row whose height is not given, is not in feet, or is measured from something other than mean sea level or the surface stops the bake; so does a floor that is not below its ceiling. None of the 359 rows does.
- **Vertices.** The FAA stores an arc as many short segments: 249,191 vertices for Class B and 34,761 for the centres. Each ring is thinned with the Douglas-Peucker rule at 0.0003° (about 30 m), which keeps 7% of them, and coordinates are rounded to five decimal places (about 1 m). Rings are thinned one at a time, so two shelves that share an edge can differ along it by up to that 30 m.
- **Order.** Rows are sorted, and written one a line, so the same input gives the same bytes.

**San Diego's VFR corridor.** Four rows of San Diego have `EXCLUSION` 1 and the sector "VFR CORRIDOR EXCLUSION". They cover two patches of ground. Over each, one row runs from below (the surface or 2,800 ft) up to 3,300 ft and another from 4,700 ft to 10,000 ft. Read that way they are not the corridor: they are the Class B under and over it, and the corridor is the gap from 3,300 to 4,700 ft between them. So the bake keeps them as shelves, with `exclusion: true` so they can be told apart. This reading comes from the heights alone; **it has not been checked against the San Diego terminal area chart.**

One thing is left wrong. The northern patch lies mostly inside "AREA L", which the FAA gives as one shelf from the surface to 10,000 ft with no hole in it. Drawn as given, AREA L fills the corridor's gap over that patch. Putting it right means cutting the patch out of AREA L, which the bake does not do: the patch is not wholly inside AREA L, so it is a polygon difference and not a hole. The southern patch has no such overlap and its gap shows.

FAA credit: "Federal Aviation Administration, Air Traffic Organization, Mission Support Services, Aeronautical Information Services." The data is published for public use under the [FAA Data Disclaimer](https://adds-faa.opendata.arcgis.com/), which disclaims liability and warranty.

### Sample airspace

`data/sample/airspace/` holds two GeoJSON files, saved as the FAA's services returned them. They are for building and testing the bake script and the map layers without a network call.

- `class-b.geojson`: the Class B areas of Boston (4 rows), New York (16), Philadelphia (12) and Washington (15). Each row is one polygon with a floor (`LOWER_VAL`, `LOWER_UOM`, `LOWER_CODE`) and a ceiling (`UPPER_VAL`, `UPPER_UOM`, `UPPER_CODE`).
- `artcc.geojson`: the high and low boundaries of the Boston, New York, Washington and Cleveland centres, 9 rows. New York's high boundary is two rows. These rows carry no altitudes; the value -9998 means "not given".

Source: the FAA's [Aeronautical Data Delivery Service](https://adds-faa.opendata.arcgis.com/), datasets "Class_Airspace" and "Airspace_Boundary", in the cycle effective 0901Z 29 Oct 2026 to 0901Z 24 Dec 2026. The FAA publishes both every eight weeks. Fetched on 2026-11-25 with these two queries:

```sh
B=https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services

curl -s -G "$B/Class_Airspace/FeatureServer/0/query" \
  --data-urlencode "where=LOCAL_TYPE='CLASS_B' AND IDENT IN ('BOS','JFK','PHL','DCA')" \
  --data-urlencode "outFields=*" --data-urlencode "orderByFields=IDENT,SECTOR,OBJECTID" \
  -d outSR=4326 -d geometryPrecision=6 -d f=geojson -o class-b.geojson

curl -s -G "$B/Boundary_Airspace/FeatureServer/0/query" \
  --data-urlencode "where=TYPE_CODE='ARTCC' AND IDENT IN ('ZBW','ZNY','ZDC','ZOB')" \
  --data-urlencode "outFields=*" --data-urlencode "orderByFields=IDENT,LOCAL_TYPE,OBJECTID" \
  -d outSR=4326 -d geometryPrecision=6 -d f=geojson -o artcc.geojson
```

`geometryPrecision=6` asks the service to round coordinates to six decimal places, about 0.1 m. No vertices are removed. `outSR=4326` asks for WGS 84; the services store NAD 83.

The FAA's licence text for both datasets begins "The data provided is for public use." Using data from the service means accepting the [FAA Data Disclaimer](https://adds-faa.opendata.arcgis.com/pages/adds-data-disclaimer), under which the FAA accepts no liability for use of the data and makes no warranty for data a third party has changed. These files are a subset with rounded coordinates, so they are changed from the FAA's originals. They are not for navigation.

Credit: Federal Aviation Administration, Air Traffic Organization, Mission Support Services, Aeronautical Information Services.

## Map tiles

Not yet added. The base map will use OpenFreeMap vector tiles and the terrain will use Mapterhorn elevation tiles, both fetched by the browser at run time. This section will record their terms and the attribution each requires.

## Aircraft icon

`apps/web/public/aircraft.svg` is the icon every aircraft is drawn with on the map: a swept-wing airliner seen from above, nose up, in white so that the map layer can tint it by altitude band.

- Source: drawn by hand for this project, as one SVG path. It is not traced or adapted from any other icon set.
- Licence: MIT, with the code (see [LICENSE](../LICENSE)).

## 3D model

Not yet added. This section will record where the aircraft model came from and its licence.
