import { describe, expect, test } from "bun:test";
import { classBLayer } from "@/components/map/airspace-layer";

describe("the Class B layer", () => {
	test("does not write depth, so it hides no aircraft inside or under a shelf", () => {
		for (const raised of [false, true]) {
			const layer = classBLayer([], raised);
			expect(layer.props.parameters).toMatchObject({
				depthWriteEnabled: false,
			});
		}
	});

	test("is raised into prisms in 3D and lies flat in 2D", () => {
		expect(classBLayer([], true).props.extruded).toBe(true);
		expect(classBLayer([], false).props.extruded).toBe(false);
	});
});
