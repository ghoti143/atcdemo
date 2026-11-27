import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYER_CONTROLS, UNIT_CONTROLS } from "@/lib/display-controls";
import {
	formatAltitude,
	formatSpeed,
	formatVerticalRate,
} from "@/lib/flight-list";
import { LAYER_IDS, UNIT_CHOICES } from "@/lib/interface-store";
import {
	ALTITUDE_BANDS,
	altitudeIn,
	altitudeLegend,
	formatVerticalRateIn,
	GROUND_COLOR,
	speedIn,
	UNIT_LABELS,
	verticalRateIn,
} from "@/lib/units";

describe("converting for display", () => {
	test("the wire's own units are left as they are", () => {
		expect(altitudeIn(35_000, "ft")).toBe(35_000);
		expect(speedIn(450, "kt")).toBe(450);
		expect(verticalRateIn(-640, "fpm")).toBe(-640);
	});

	test("feet to metres, knots to km/h and mph, feet a minute to metres a second", () => {
		expect(altitudeIn(10_000, "m")).toBeCloseTo(3_048, 6);
		expect(speedIn(100, "kmh")).toBeCloseTo(185.2, 6);
		expect(speedIn(100, "mph")).toBeCloseTo(115.078, 3);
		expect(verticalRateIn(1_968.5, "ms")).toBeCloseTo(10, 3);
	});

	test("the list's formatters take the unit and default to the wire's", () => {
		const row = { altitudeFt: 35_000, onGround: false };
		expect(formatAltitude(row)).toBe("35,000");
		expect(formatAltitude(row, "m")).toBe("10,668");
		expect(formatAltitude({ altitudeFt: 0, onGround: true }, "m")).toBe("GND");
		expect(formatAltitude({ altitudeFt: null, onGround: false }, "m")).toBe(
			"—",
		);
		expect(formatSpeed(450)).toBe("450");
		expect(formatSpeed(450, "kmh")).toBe("833");
		expect(formatSpeed(450, "mph")).toBe("518");
		expect(formatSpeed(null, "mph")).toBe("—");
		expect(formatVerticalRate(1_920)).toBe("+1,920");
		expect(formatVerticalRate(-640)).toBe("−640");
		expect(formatVerticalRate(0, "ms")).toBe("0");
		expect(formatVerticalRate(null, "ms")).toBe("—");
	});

	test("metres a second has one place, a sign, and no signed zero", () => {
		expect(formatVerticalRateIn(1_920, "ms")).toBe("+9.8");
		expect(formatVerticalRateIn(-640, "ms")).toBe("−3.3");
		// 5 ft/min is 0.025 m/s, which is written as nothing.
		expect(formatVerticalRateIn(-5, "ms")).toBe("0");
		expect(formatVerticalRateIn(64, "ms")).toBe("+0.3");
	});
});

describe("the altitude legend", () => {
	test("in feet: highest first, the ground last", () => {
		expect(altitudeLegend("ft").map((entry) => entry.label)).toEqual([
			"40,000 and above",
			"30,000 – 40,000",
			"18,000 – 30,000",
			"10,000 – 18,000",
			"5,000 – 10,000",
			"Below 5,000",
			"On the ground",
		]);
	});

	test("in metres: the same bands, their edges to the hundred", () => {
		expect(altitudeLegend("m").map((entry) => entry.label)).toEqual([
			"12,200 and above",
			"9,100 – 12,200",
			"5,500 – 9,100",
			"3,000 – 5,500",
			"1,500 – 3,000",
			"Below 1,500",
			"On the ground",
		]);
	});

	test("its colours are the ones the store paints the aircraft", () => {
		// The store is Rust; its table is read out of the source so the two
		// cannot drift apart unseen.
		const source = readFileSync(
			join(import.meta.dirname, "../../../crates/atc-core/src/store.rs"),
			"utf8",
		);
		const table = source.slice(
			source.indexOf("pub const ALTITUDE_BANDS"),
			source.indexOf("];", source.indexOf("pub const ALTITUDE_BANDS")),
		);
		const rows = [
			...table.matchAll(/\(([\w.:]+), \[(\d+), (\d+), (\d+), 255\]\)/g),
		];
		expect(rows).toHaveLength(ALTITUDE_BANDS.length);
		rows.forEach((row, index) => {
			const ceiling =
				row[1] === "f64::INFINITY"
					? Number.POSITIVE_INFINITY
					: Number(row[1].replace(/_/g, ""));
			expect(ALTITUDE_BANDS[index].ceilingFt).toBe(ceiling);
			expect([...ALTITUDE_BANDS[index].color]).toEqual([
				Number(row[2]),
				Number(row[3]),
				Number(row[4]),
			]);
		});
		const ground = source.match(
			/pub const GROUND_COLOR: \[u8; 4\] = \[(\d+), (\d+), (\d+), 255\]/,
		);
		expect(ground?.slice(1).map(Number)).toEqual([...GROUND_COLOR]);
		expect(altitudeLegend("ft")[0].color).toBe("rgb(238 26 209)");
	});
});

describe("the display menu's controls", () => {
	test("there is one for every layer and every unit the store knows", () => {
		expect(LAYER_CONTROLS.map((layer) => layer.id).sort()).toEqual(
			[...LAYER_IDS].sort(),
		);
		for (const control of UNIT_CONTROLS) {
			expect(control.choices.map((choice) => choice.value)).toEqual([
				...UNIT_CHOICES[control.kind],
			]);
			for (const choice of control.choices) {
				expect(choice.label).toBe(UNIT_LABELS[choice.value]);
			}
		}
		expect(UNIT_CONTROLS.map((control): string => control.kind).sort()).toEqual(
			Object.keys(UNIT_CHOICES).sort(),
		);
	});
});
