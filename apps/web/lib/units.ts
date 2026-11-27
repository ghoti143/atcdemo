// The units a value can be shown in, and the altitude bands' legend. The
// wire and the store carry feet, knots and feet a minute; this converts for
// display only. No import of React or the DOM, so `bun test` runs it.

import type { Units } from "@/lib/interface-store";

type Unit = Units[keyof Units];

/** A unit as it is written beside a value. */
export const UNIT_LABELS: Record<Unit, string> = {
	ft: "ft",
	m: "m",
	kt: "kt",
	kmh: "km/h",
	mph: "mph",
	fpm: "ft/min",
	ms: "m/s",
};

/** A unit in words, for a title or a screen reader. */
export const UNIT_NAMES: Record<Unit, string> = {
	ft: "feet",
	m: "metres",
	kt: "knots",
	kmh: "kilometres an hour",
	mph: "miles an hour",
	fpm: "feet a minute",
	ms: "metres a second",
};

const METRES_PER_FOOT = 0.3048;
const KMH_PER_KNOT = 1.852;
const MPH_PER_KNOT = 1.852 / 1.609344;

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ONE_PLACE = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

export function altitudeIn(feet: number, unit: Units["altitude"]): number {
	return unit === "m" ? feet * METRES_PER_FOOT : feet;
}

export function speedIn(knots: number, unit: Units["speed"]): number {
	if (unit === "kmh") return knots * KMH_PER_KNOT;
	if (unit === "mph") return knots * MPH_PER_KNOT;
	return knots;
}

export function verticalRateIn(
	feetPerMinute: number,
	unit: Units["verticalRate"],
): number {
	return unit === "ms" ? (feetPerMinute * METRES_PER_FOOT) / 60 : feetPerMinute;
}

/** An altitude given in feet, in `unit`, whole: "35,000", "10,668". */
export function formatAltitudeIn(
	feet: number,
	unit: Units["altitude"],
): string {
	return WHOLE.format(altitudeIn(feet, unit));
}

/** A speed given in knots, in `unit`, whole. */
export function formatSpeedIn(knots: number, unit: Units["speed"]): string {
	return WHOLE.format(speedIn(knots, unit));
}

/**
 * A vertical rate given in feet a minute, in `unit`, with its sign and a
 * true minus: "+1,920", "−640", "0"; in metres a second to one place,
 * "+9.8". A rate that rounds to nothing is "0", without a sign.
 */
export function formatVerticalRateIn(
	feetPerMinute: number,
	unit: Units["verticalRate"],
): string {
	const value = verticalRateIn(feetPerMinute, unit);
	const text = (unit === "ms" ? ONE_PLACE : WHOLE).format(Math.abs(value));
	if (Number(text.replace(/,/g, "")) === 0) return "0";
	return `${value > 0 ? "+" : "−"}${text}`;
}

/**
 * The altitude bands the aircraft are coloured by, lowest first: where each
 * ends in feet above mean sea level, and its colour. The last has no
 * ceiling. A copy of `ALTITUDE_BANDS` and `GROUND_COLOR` in
 * crates/atc-core/src/store.rs, which colours the aircraft; a test holds
 * the two together.
 */
export const ALTITUDE_BANDS: readonly {
	ceilingFt: number;
	color: readonly [number, number, number];
}[] = [
	{ ceilingFt: 5_000, color: [245, 62, 6] },
	{ ceilingFt: 10_000, color: [239, 167, 29] },
	{ ceilingFt: 18_000, color: [253, 252, 59] },
	{ ceilingFt: 30_000, color: [101, 246, 184] },
	{ ceilingFt: 40_000, color: [134, 193, 254] },
	{ ceilingFt: Number.POSITIVE_INFINITY, color: [238, 26, 209] },
];
export const GROUND_COLOR: readonly [number, number, number] = [112, 120, 132];

export type LegendEntry = {
	/** "Ground", "Below 5,000", "5,000 – 10,000", "40,000 and above". */
	label: string;
	/** A CSS colour. */
	color: string;
};

/**
 * The legend's rows, highest first as the sky is, the ground last, with
 * the bands' edges in `unit` and rounded to the hundred: nobody reads
 * "1,524 m" off a colour.
 */
export function altitudeLegend(unit: Units["altitude"]): LegendEntry[] {
	const edge = (feet: number) =>
		WHOLE.format(Math.round(altitudeIn(feet, unit) / 100) * 100);
	const css = ([r, g, b]: readonly [number, number, number]) =>
		`rgb(${r} ${g} ${b})`;
	const entries: LegendEntry[] = ALTITUDE_BANDS.map((band, index) => {
		const floor = index === 0 ? null : ALTITUDE_BANDS[index - 1].ceilingFt;
		const label =
			floor === null
				? `Below ${edge(band.ceilingFt)}`
				: Number.isFinite(band.ceilingFt)
					? `${edge(floor)} – ${edge(band.ceilingFt)}`
					: `${edge(floor)} and above`;
		return { label, color: css(band.color) };
	});
	entries.reverse();
	entries.push({ label: "On the ground", color: css(GROUND_COLOR) });
	return entries;
}
