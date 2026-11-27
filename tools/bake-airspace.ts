// Bakes the FAA's Class B and ARTCC airspace into the GeoJSON the map
// draws, under data/airspace/.
//
//   bun run bake:airspace                 fetch from the FAA and write
//   bun run bake:airspace --from <dir>    bake <dir>/class-b.geojson and
//                                         <dir>/artcc.geojson, saved as the
//                                         services returned them
//   bun run bake:airspace --keep <dir>    also save what was fetched there
//
// The same input always gives the same files. What the FAA serves changes
// every 56 days, so a fetch in a later cycle can give different ones;
// data/README.md records the cycle the committed files came from.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bakeArtcc,
	bakeClassB,
	COVERAGE_BOX,
	countVertices,
	type RawCollection,
	serialize,
} from "./airspace/bake";

const SERVICES =
	"https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services";
const OUT = join(import.meta.dir, "../data/airspace");
/** A query answers with at most this many rows; more would need paging. */
const ROW_LIMIT = 2_000;

async function query(
	service: string,
	where: string,
	order: string,
): Promise<RawCollection> {
	const params = new URLSearchParams({
		where,
		// Rows that touch the coverage box.
		geometry: COVERAGE_BOX.join(","),
		geometryType: "esriGeometryEnvelope",
		inSR: "4326",
		spatialRel: "esriSpatialRelIntersects",
		outFields: "*",
		orderByFields: order,
		outSR: "4326",
		geometryPrecision: "6",
		f: "geojson",
	});
	const url = `${SERVICES}/${service}/FeatureServer/0/query?${params}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${service} answered ${response.status}`);
	const body = (await response.json()) as RawCollection & {
		error?: { message: string };
		properties?: { exceededTransferLimit?: boolean };
	};
	if (body.error) throw new Error(`${service}: ${body.error.message}`);
	if (
		body.properties?.exceededTransferLimit ||
		body.features.length >= ROW_LIMIT
	) {
		throw new Error(`${service} has more rows than one query returns`);
	}
	return body;
}

const args = process.argv.slice(2);
const option = (name: string) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const from = option("--from");
const keep = option("--keep");

const read = (dir: string, file: string) =>
	JSON.parse(readFileSync(join(dir, file), "utf8")) as RawCollection;

const rawClassB = from
	? read(from, "class-b.geojson")
	: await query(
			"Class_Airspace",
			"LOCAL_TYPE='CLASS_B'",
			"IDENT,SECTOR,OBJECTID",
		);
const rawArtcc = from
	? read(from, "artcc.geojson")
	: await query(
			"Boundary_Airspace",
			"TYPE_CODE='ARTCC'",
			"IDENT,LOCAL_TYPE,OBJECTID",
		);

if (keep) {
	mkdirSync(keep, { recursive: true });
	writeFileSync(join(keep, "class-b.geojson"), JSON.stringify(rawClassB));
	writeFileSync(join(keep, "artcc.geojson"), JSON.stringify(rawArtcc));
}

const classB = bakeClassB(rawClassB);
const artcc = bakeArtcc(rawArtcc);
mkdirSync(OUT, { recursive: true });
for (const [file, raw, baked] of [
	["class-b.geojson", rawClassB, classB],
	["artcc.geojson", rawArtcc, artcc],
] as const) {
	const written = serialize(baked);
	writeFileSync(join(OUT, file), written);
	console.log(
		`${file}: ${baked.features.length} rows, ${countVertices(raw)} vertices thinned to ${countVertices(baked)}, ${(written.length / 1_000).toFixed(0)} kB`,
	);
}
const areas = new Set(classB.features.map((f) => f.properties.ident));
const centres = new Set(artcc.features.map((f) => f.properties.ident));
console.log(
	`${areas.size} Class B areas, ${classB.features.filter((f) => f.properties.exclusion).length} exclusion rows, ${centres.size} centres`,
);
