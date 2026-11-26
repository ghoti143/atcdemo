import { describe, expect, test } from "bun:test";
import {
	beforeMapLayer,
	styleAdjustments,
	TRAFFIC_ATTRIBUTION,
	TRAFFIC_BEFORE_ID,
} from "./base-map";

describe("beforeMapLayer", () => {
	test("places a layer under the place names unless told otherwise", () => {
		expect<object>(beforeMapLayer({ id: "aircraft" })).toEqual({
			id: "aircraft",
			beforeId: TRAFFIC_BEFORE_ID,
		});
		expect<object>(beforeMapLayer({ id: "aircraft" }, "water")).toEqual({
			id: "aircraft",
			beforeId: "water",
		});
	});
});

describe("TRAFFIC_ATTRIBUTION", () => {
	test("names the source and the licence, with links to both", () => {
		expect(TRAFFIC_ATTRIBUTION).toContain("Contains information from");
		expect(TRAFFIC_ATTRIBUTION).toContain('href="https://adsb.lol"');
		expect(TRAFFIC_ATTRIBUTION).toContain(
			'href="https://opendatacommons.org/licenses/odbl/1-0/"',
		);
	});
});

describe("styleAdjustments", () => {
	test("changes only layers the style has", () => {
		const changes = styleAdjustments([
			{ id: "background", type: "background" },
			{ id: "water", type: "fill" },
		]);

		expect(changes.map((change) => change.layerId)).toEqual([
			"background",
			"water",
		]);
		expect(styleAdjustments([])).toEqual([]);
	});
});
