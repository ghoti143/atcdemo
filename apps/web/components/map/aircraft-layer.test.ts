import { expect, test } from "bun:test";
import { smallestIconPixels } from "@/components/map/aircraft-layer";

test("the real picture is drawn at full size", () => {
	expect(smallestIconPixels(0)).toBe(10);
	expect(smallestIconPixels(7_948)).toBe(10);
	expect(smallestIconPixels(8_000)).toBe(10);
});

test("icons shrink as the picture fills, and no further than 6 pixels", () => {
	expect(smallestIconPixels(16_000)).toBe(7);
	expect(smallestIconPixels(30_000)).toBe(6);
	expect(smallestIconPixels(60_583)).toBe(6);
	expect(smallestIconPixels(1_000_000)).toBe(6);
});

test("the size never grows with the count", () => {
	let last = smallestIconPixels(0);
	for (let count = 0; count <= 70_000; count += 500) {
		const size = smallestIconPixels(count);
		expect(size).toBeLessThanOrEqual(last);
		last = size;
	}
});
