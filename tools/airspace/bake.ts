// Turns what the FAA's two airspace services return into the GeoJSON the
// map draws. Pure functions: bake-airspace.ts does the fetching and the
// writing. docs/DESIGN.md section 10 has the fields and what the spike
// found in them.

/** The coverage area, as tools/seed/tracks.ts has it: west, south, east, north. */
export const COVERAGE_BOX = [-125, 24.4, -66.9, 49.4] as const;

/** The FAA's value for "not given". */
const NOT_GIVEN = -9998;

/**
 * How far a vertex may be from the thinned line and still be dropped, in
 * degrees: about 30 m north to south. The FAA stores an arc as many short
 * segments, a few metres apart; at this tolerance an arc keeps its shape
 * at any zoom the app reaches and loses nine vertices in ten.
 */
export const THIN_TOLERANCE_DEG = 0.0003;
/** Decimal places kept: about a metre. */
export const DECIMALS = 5;

type Position = [number, number];
type Ring = Position[];
type Geometry =
	| { type: "Polygon"; coordinates: Ring[] }
	| { type: "MultiPolygon"; coordinates: Ring[][] };

export type RawFeature = {
	type: "Feature";
	properties: Record<string, unknown>;
	geometry: Geometry;
};
export type RawCollection = {
	type: "FeatureCollection";
	features: RawFeature[];
};

export type ShelfProperties = {
	/** The FAA's `GLOBAL_ID`: the only key a row has. */
	id: string;
	/** The area's main airport, "BOS". */
	ident: string;
	/** The area, "BOSTON CLASS B". */
	name: string;
	/** The shelf, "AREA A". More than one row can share it. */
	sector: string;
	/** Feet. Above mean sea level, or 0 for a floor at the surface. */
	floorFt: number;
	/** What the floor is measured from. */
	floorRef: "SFC" | "MSL";
	/** Feet above mean sea level. */
	ceilingFt: number;
	/**
	 * True for the four rows of San Diego the FAA marks `EXCLUSION` and
	 * names "VFR CORRIDOR EXCLUSION". They are kept as shelves like any
	 * other: read with their heights they are the Class B below and above
	 * the corridor, not the corridor. data/README.md says why, and what
	 * the map still gets wrong there.
	 */
	exclusion: boolean;
};

export type CentreProperties = {
	id: string;
	/** "ZBW". */
	ident: string;
	/** "BOSTON". */
	name: string;
	/** Which of a centre's two boundaries this is. The map draws the high. */
	level: "high" | "low";
};

export type Baked<P> = {
	type: "FeatureCollection";
	features: { type: "Feature"; properties: P; geometry: Geometry }[];
};

/** The distance from `p` to the segment `a`–`b`, squared, in degrees. */
function fromSegmentSquared(p: Position, a: Position, b: Position): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const length = dx * dx + dy * dy;
	let t = length === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length;
	t = Math.max(0, Math.min(1, t));
	const x = a[0] + t * dx - p[0];
	const y = a[1] + t * dy - p[1];
	return x * x + y * y;
}

/**
 * Thins a line with the Douglas-Peucker rule: a vertex is kept if dropping
 * it would move the line by more than `tolerance`. The ends are kept.
 */
export function thinLine(line: Position[], tolerance: number): Position[] {
	if (line.length <= 2) return line.slice();
	const keep = new Uint8Array(line.length);
	keep[0] = 1;
	keep[line.length - 1] = 1;
	const limit = tolerance * tolerance;
	// A stack, not recursion: a ring can have tens of thousands of points.
	const spans: [number, number][] = [[0, line.length - 1]];
	for (let span = spans.pop(); span !== undefined; span = spans.pop()) {
		const [first, last] = span;
		let farthest = -1;
		let distance = limit;
		for (let i = first + 1; i < last; i++) {
			const d = fromSegmentSquared(line[i], line[first], line[last]);
			if (d > distance) {
				distance = d;
				farthest = i;
			}
		}
		if (farthest !== -1) {
			keep[farthest] = 1;
			spans.push([first, farthest], [farthest, last]);
		}
	}
	return line.filter((_, i) => keep[i] === 1);
}

/**
 * Thins a closed ring and rounds it. The ring is cut at the vertex
 * farthest from its first, so that neither half is a line from a point to
 * itself, which the rule cannot thin. A ring is never left with fewer
 * than four positions, the least GeoJSON allows.
 */
export function thinRing(
	ring: Ring,
	tolerance = THIN_TOLERANCE_DEG,
	decimals = DECIMALS,
): Ring {
	const scale = 10 ** decimals;
	const round = ([x, y]: Position): Position => [
		Math.round(x * scale) / scale,
		Math.round(y * scale) / scale,
	];
	const open = ring.slice(0, -1);
	let far = 0;
	let distance = -1;
	for (let i = 1; i < open.length; i++) {
		const dx = open[i][0] - open[0][0];
		const dy = open[i][1] - open[0][1];
		if (dx * dx + dy * dy > distance) {
			distance = dx * dx + dy * dy;
			far = i;
		}
	}
	const there = thinLine(open.slice(0, far + 1), tolerance);
	const back = thinLine([...open.slice(far), open[0]], tolerance);
	const thinned = [...there, ...back.slice(1)];
	// A triangle and its closing point at the least.
	const result = thinned.length >= 4 ? thinned : [...open, open[0]];
	const rounded = result.map(round);
	rounded[rounded.length - 1] = rounded[0];
	return rounded;
}

function thinGeometry(geometry: Geometry): Geometry {
	if (geometry.type === "Polygon") {
		return {
			type: "Polygon",
			coordinates: geometry.coordinates.map((ring) => thinRing(ring)),
		};
	}
	return {
		type: "MultiPolygon",
		coordinates: geometry.coordinates.map((polygon) =>
			polygon.map((ring) => thinRing(ring)),
		),
	};
}

/** How many positions a baked or raw collection holds. */
export function countVertices(collection: {
	features: { geometry: Geometry }[];
}): number {
	let count = 0;
	for (const { geometry } of collection.features) {
		const polygons =
			geometry.type === "Polygon"
				? [geometry.coordinates]
				: geometry.coordinates;
		for (const polygon of polygons) {
			for (const ring of polygon) count += ring.length;
		}
	}
	return count;
}

const text = (row: Record<string, unknown>, field: string): string => {
	const value = row[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`a row has no ${field}: ${JSON.stringify(row.GLOBAL_ID)}`);
	}
	return value.trim();
};

/** One end of a shelf, checked: feet, given, and from a reference we know. */
function height(
	row: Record<string, unknown>,
	end: "LOWER" | "UPPER",
): { feet: number; ref: "SFC" | "MSL" } {
	const value = row[`${end}_VAL`];
	const unit = row[`${end}_UOM`];
	const code = row[`${end}_CODE`];
	const where = `${row.NAME} ${row.SECTOR} (${row.GLOBAL_ID})`;
	if (
		typeof value !== "number" ||
		value === NOT_GIVEN ||
		!Number.isFinite(value)
	) {
		throw new Error(`${where}: ${end}_VAL is not given`);
	}
	if (unit !== "FT") throw new Error(`${where}: ${end}_UOM is ${unit}, not FT`);
	if (code === "MSL") return { feet: value, ref: "MSL" };
	// Height above ground is written as a value above 0 with code SFC. No
	// Class B row has one, and the map could not draw it as a flat floor.
	if (code === "SFC" && value === 0) return { feet: 0, ref: "SFC" };
	throw new Error(`${where}: ${end}_CODE ${code} with ${value} is not handled`);
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The Class B rows as shelves, thinned, in a fixed order. */
export function bakeClassB(raw: RawCollection): Baked<ShelfProperties> {
	const features = raw.features.map(({ properties: row, geometry }) => {
		if (row.LOCAL_TYPE !== "CLASS_B") {
			throw new Error(`not a Class B row: ${row.GLOBAL_ID}`);
		}
		const floor = height(row, "LOWER");
		const ceiling = height(row, "UPPER");
		if (ceiling.ref !== "MSL") {
			throw new Error(`${row.NAME} ${row.SECTOR}: the ceiling is not MSL`);
		}
		if (floor.feet >= ceiling.feet) {
			throw new Error(
				`${row.NAME} ${row.SECTOR}: floor ${floor.feet} is not below ceiling ${ceiling.feet}`,
			);
		}
		const properties: ShelfProperties = {
			id: text(row, "GLOBAL_ID"),
			ident: text(row, "IDENT"),
			name: text(row, "NAME"),
			sector: text(row, "SECTOR"),
			floorFt: floor.feet,
			floorRef: floor.ref,
			ceilingFt: ceiling.feet,
			exclusion: String(row.EXCLUSION) === "1",
		};
		return {
			type: "Feature" as const,
			properties,
			geometry: thinGeometry(geometry),
		};
	});
	features.sort(
		(a, b) =>
			byText(a.properties.ident, b.properties.ident) ||
			a.properties.floorFt - b.properties.floorFt ||
			byText(a.properties.sector, b.properties.sector) ||
			byText(a.properties.id, b.properties.id),
	);
	return { type: "FeatureCollection", features };
}

/** The ARTCC rows as boundaries, thinned, in a fixed order. */
export function bakeArtcc(raw: RawCollection): Baked<CentreProperties> {
	const features = raw.features.map(({ properties: row, geometry }) => {
		const kind = row.LOCAL_TYPE;
		if (kind !== "ARTCC_H" && kind !== "ARTCC_L") {
			throw new Error(`not an ARTCC boundary: ${row.GLOBAL_ID} is ${kind}`);
		}
		const properties: CentreProperties = {
			id: text(row, "GLOBAL_ID"),
			ident: text(row, "IDENT"),
			name: text(row, "NAME"),
			level: kind === "ARTCC_H" ? "high" : "low",
		};
		return {
			type: "Feature" as const,
			properties,
			geometry: thinGeometry(geometry),
		};
	});
	features.sort(
		(a, b) =>
			byText(a.properties.ident, b.properties.ident) ||
			byText(a.properties.level, b.properties.level) ||
			byText(a.properties.id, b.properties.id),
	);
	return { type: "FeatureCollection", features };
}

/** The file as written: one feature a line, so a change shows as its rows. */
export function serialize(baked: Baked<unknown>): string {
	const lines = baked.features.map((feature) => JSON.stringify(feature));
	return `{"type":"FeatureCollection","features":[\n${lines.join(",\n")}\n]}\n`;
}
