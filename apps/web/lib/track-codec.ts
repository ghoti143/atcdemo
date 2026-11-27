// Reads a `flight_tracks` row's samples: the seed file's difference
// encoding, for one flight and one stretch of time. atc-server writes it
// (crates/atc-server/src/recorder/codec.rs, which describes the bytes), and
// the two share a test vector.
//
// A row is eight columns one after another, each holding every sample of
// the batch: lat and lon in 1e-5 degrees as second differences; altitude in
// 25 ft, barometric altitude less the altitude in 25 ft, ground speed in
// knots, track in whole degrees and vertical rate in 64 ft/min, each as
// differences; then the on-ground bits, lowest first. The first seven are
// zigzag variable-length integers.

/** A track as arrays, one entry a sample, in the units the page shows. */
export type TrackColumns = {
	/** Degrees. */
	lat: number[];
	lon: number[];
	/** Feet above mean sea level. */
	altitudeFt: number[];
	/** Feet, as the altimeter reads at standard pressure. */
	barometricFt: number[];
	groundSpeedKt: number[];
	/** Degrees clockwise from north, 0 to 359. */
	trackDeg: number[];
	verticalRateFpm: number[];
	onGround: boolean[];
};

export function emptyTrack(): TrackColumns {
	return {
		lat: [],
		lon: [],
		altitudeFt: [],
		barometricFt: [],
		groundSpeedKt: [],
		trackDeg: [],
		verticalRateFpm: [],
		onGround: [],
	};
}

const ALTITUDE_STEP_FT = 25;
const VERTICAL_RATE_STEP_FPM = 64;
/** A row holds lat and lon in 1e-5 degrees. */
const UNITS_PER_DEGREE = 100_000;

/**
 * Decodes a row of `count` samples and appends them to `into`. Throws if
 * the bytes are not such a row: cut short, or with bytes left over.
 */
export function decodeTrackRow(
	bytes: Uint8Array,
	count: number,
	into: TrackColumns = emptyTrack(),
): TrackColumns {
	let at = 0;
	const varint = (): number => {
		// Values here are far inside 2^53, so plain numbers hold them; the
		// shifts are done by multiplying, since `<<` works on 32 bits.
		let value = 0;
		let scale = 1;
		for (;;) {
			if (at >= bytes.length) throw new Error("the track row is cut short");
			const byte = bytes[at++];
			value += (byte & 0x7f) * scale;
			if (byte < 0x80) break;
			scale *= 128;
			if (scale > 2 ** 56) throw new Error("the track row holds a bad number");
		}
		// Zigzag: even is positive, odd is negative.
		return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
	};
	/** One column: whole first, then differences, or changes in them. */
	const column = (
		secondDifferences: boolean,
		store: (value: number) => void,
	) => {
		let value = 0;
		let step = 0;
		for (let n = 0; n < count; n++) {
			const stored = varint();
			if (n === 0) {
				value = stored;
			} else if (secondDifferences) {
				step += stored;
				value += step;
			} else {
				value += stored;
			}
			store(value);
		}
	};
	// A division, which is correctly rounded: multiplying by 1e-5 is not.
	const degrees = (value: number) => value / UNITS_PER_DEGREE;

	const first = into.altitudeFt.length;
	column(true, (value) => into.lat.push(degrees(value)));
	column(true, (value) => into.lon.push(degrees(value)));
	column(false, (value) => into.altitudeFt.push(value * ALTITUDE_STEP_FT));
	let sample = first;
	column(false, (value) => {
		into.barometricFt.push(
			into.altitudeFt[sample++] + value * ALTITUDE_STEP_FT,
		);
	});
	column(false, (value) => into.groundSpeedKt.push(value));
	column(false, (value) => into.trackDeg.push(((value % 360) + 360) % 360));
	column(false, (value) =>
		into.verticalRateFpm.push(value * VERTICAL_RATE_STEP_FPM),
	);
	for (let n = 0; n < count; n += 8) {
		if (at >= bytes.length) throw new Error("the track row is cut short");
		const byte = bytes[at++];
		for (let bit = 0; bit < 8 && n + bit < count; bit++) {
			into.onGround.push((byte & (1 << bit)) !== 0);
		}
	}
	if (at !== bytes.length) {
		throw new Error("the track row is longer than its samples");
	}
	return into;
}
