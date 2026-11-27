import { describe, expect, test } from "bun:test";
import { decodeTrackRow, emptyTrack } from "./track-codec";

const hex = (text: string) =>
	new Uint8Array(
		(text.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)),
	);

// The row `a_small_batch_encodes_to_known_bytes` checks in
// crates/atc-server/src/recorder/codec.rs: three samples, the last on the
// ground, turning through north.
const ROW = hex(
	"d8d9dd03860104e1c2b407d90b23ae010208170000f0060000aa0401ac0105000004",
);

describe("decodeTrackRow", () => {
	test("reads the row atc-server's encoder writes", () => {
		expect(decodeTrackRow(ROW, 3)).toEqual({
			lat: [39.13324, 39.13391, 39.1346],
			lon: [-77.70289, -77.71038, -77.71805],
			altitudeFt: [2_175, 2_200, 2_300],
			barometricFt: [1_875, 1_900, 2_000],
			groundSpeedKt: [440, 440, 440],
			trackDeg: [277, 276, 2],
			verticalRateFpm: [-192, -192, -192],
			onGround: [false, false, true],
		});
	});

	test("appends to a track, so a flight's rows read on into one", () => {
		const track = emptyTrack();
		decodeTrackRow(ROW, 3, track);
		decodeTrackRow(ROW, 3, track);
		expect(track.lat).toHaveLength(6);
		expect(track.barometricFt).toEqual([
			1_875, 1_900, 2_000, 1_875, 1_900, 2_000,
		]);
		expect(track.onGround).toEqual([false, false, true, false, false, true]);
	});

	test("an empty row is no samples", () => {
		expect(decodeTrackRow(new Uint8Array(0), 0)).toEqual(emptyTrack());
	});

	test("more than eight samples use a second byte of ground bits", () => {
		// Nine samples, all zero but for the ninth being on the ground.
		const row = new Uint8Array(7 * 9 + 2);
		row[7 * 9 + 1] = 1;
		const track = decodeTrackRow(row, 9);
		expect(track.onGround).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			true,
		]);
		expect(track.lat).toEqual(new Array(9).fill(0));
	});

	test("bytes that are not a row of that count are refused", () => {
		expect(() => decodeTrackRow(ROW, 4)).toThrow("cut short");
		expect(() => decodeTrackRow(ROW, 2)).toThrow("longer");
		expect(() => decodeTrackRow(ROW.subarray(0, ROW.length - 1), 3)).toThrow(
			"cut short",
		);
		expect(() => decodeTrackRow(new Uint8Array(12).fill(0xff), 1)).toThrow();
	});
});
