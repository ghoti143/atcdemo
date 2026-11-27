// The airspace the map draws, as data: what the baked files hold
// (tools/airspace/bake.ts writes them; data/README.md describes them) and
// the shelves as volumes at the picture's altitude scale. No import of the
// map libraries, so `bun test` runs it.

/** The files `GET /api/airspace/:name` serves, by name. */
export const AIRSPACE_FILES = {
	"class-b": "class-b.geojson",
	artcc: "artcc.geojson",
} as const;
export type AirspaceName = keyof typeof AIRSPACE_FILES;

export type Shelf = {
	type: "Feature";
	properties: {
		id: string;
		ident: string;
		name: string;
		sector: string;
		floorFt: number;
		floorRef: "SFC" | "MSL";
		ceilingFt: number;
		exclusion: boolean;
	};
	geometry:
		| { type: "Polygon"; coordinates: number[][][] }
		| { type: "MultiPolygon"; coordinates: number[][][][] };
};
export type ShelfCollection = { type: "FeatureCollection"; features: Shelf[] };

/** A shelf as deck.gl draws it. */
export type ShelfVolume = {
	id: string;
	/**
	 * The outline, then any holes: lon, lat and the height of the floor,
	 * which is feet times the altitude scale, as an aircraft's height is.
	 */
	polygon: number[][][];
	/** How far the ceiling is above the floor, at the same scale. */
	thickness: number;
};

/**
 * The shelves as volumes at `altitudeScale`: 0 in 2D, where every shelf
 * lies flat on the map, and metres a foot times the vertical exaggeration
 * in 3D (`altitudeScaleFor`). Floors and ceilings are feet above mean sea
 * level, the aircraft's own reference, so a shelf and an aircraft at the
 * same height are drawn at the same height whatever the exaggeration.
 *
 * A floor at the surface is drawn at sea level: deck.gl layers are not
 * draped over terrain, so over high ground the foot of such a shelf is
 * under the ground. The stems have the same limit.
 */
export function shelfVolumes(
	collection: ShelfCollection,
	altitudeScale: number,
): ShelfVolume[] {
	const volumes: ShelfVolume[] = [];
	for (const { properties, geometry } of collection.features) {
		const floor = properties.floorFt * altitudeScale;
		const thickness =
			(properties.ceilingFt - properties.floorFt) * altitudeScale;
		const polygons =
			geometry.type === "Polygon"
				? [geometry.coordinates]
				: geometry.coordinates;
		polygons.forEach((rings, part) => {
			volumes.push({
				id: polygons.length === 1 ? properties.id : `${properties.id}-${part}`,
				polygon: rings.map((ring) => ring.map(([x, y]) => [x, y, floor])),
				thickness,
			});
		});
	}
	return volumes;
}

/** The FAA's credit, shown in the map's attribution control. */
export const FAA_ATTRIBUTION =
	'Airspace: <a href="https://adds-faa.opendata.arcgis.com/" target="_blank" rel="noopener">FAA</a>, changed, not for navigation';

export const ARTCC_SOURCE_ID = "artcc";
export const ARTCC_LAYER_ID = "artcc-boundaries";
