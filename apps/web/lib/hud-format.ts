// How the performance HUD writes its readings. A reading that is not a
// finite number has not been measured, and is shown as a dash.

/** Shown in place of a reading nothing has measured yet. */
export const NO_READING = "–";

/** One frame at 60 Hz, to the tenth of a millisecond the HUD shows. */
export const FRAME_BUDGET_MS = 16.7;

/** Two frames at 60 Hz: past this, more than one frame was dropped. */
export const FRAME_SLOW_MS = 33.3;

/**
 * How far past a threshold a frame time may read before it is marked. Frame
 * timestamps are rounded to 0.1 ms and arrive with a little jitter, so a
 * page that never misses a frame at 60 Hz reads 16.6 to 16.8 ms; a missed
 * frame reads a whole frame more.
 */
export const FRAME_JITTER_MS = 0.5;

export type FrameTimeLevel = "none" | "ok" | "over" | "slow";

/**
 * Where a frame-time percentile stands against the target of DESIGN.md
 * section 15: `ok` up to FRAME_BUDGET_MS, `over` up to FRAME_SLOW_MS,
 * `slow` beyond, each with FRAME_JITTER_MS allowed. So green is 17.2 ms or
 * less, amber up to 33.8 ms, and red past that.
 */
export function frameTimeLevel(ms: number): FrameTimeLevel {
	if (!Number.isFinite(ms)) return "none";
	const shown = Math.round(ms * 10) / 10;
	if (shown <= FRAME_BUDGET_MS + FRAME_JITTER_MS) return "ok";
	return shown <= FRAME_SLOW_MS + FRAME_JITTER_MS ? "over" : "slow";
}

export function formatFps(fps: number): string {
	return Number.isFinite(fps) ? fps.toFixed(0) : NO_READING;
}

/** A frame time: tenths of a millisecond. */
export function formatFrameMs(ms: number): string {
	return Number.isFinite(ms) ? ms.toFixed(1) : NO_READING;
}

/**
 * Time spent on one piece of work in a frame: hundredths of a millisecond
 * below ten, because the WASM advance takes about 0.15 ms, and tenths above.
 */
export function formatWorkMs(ms: number): string {
	if (!Number.isFinite(ms)) return NO_READING;
	return ms < 9.995 ? ms.toFixed(2) : ms.toFixed(1);
}

/** A whole number with thousands separators. */
export function formatCount(count: number): string {
	if (!Number.isFinite(count)) return NO_READING;
	return Math.round(count)
		.toString()
		.replace(/\B(?=(\d{3})+$)/g, ",");
}

/** A rate in decimal units: 1 kB is 1000 bytes. */
export function formatBytesPerSecond(bytesPerSecond: number): {
	value: string;
	unit: "B/s" | "kB/s" | "MB/s";
} {
	if (!Number.isFinite(bytesPerSecond)) {
		return { value: NO_READING, unit: "B/s" };
	}
	if (bytesPerSecond < 999.5) {
		return { value: bytesPerSecond.toFixed(0), unit: "B/s" };
	}
	if (bytesPerSecond < 999_950) {
		const kilobytes = bytesPerSecond / 1000;
		return {
			value: kilobytes < 99.95 ? kilobytes.toFixed(1) : kilobytes.toFixed(0),
			unit: "kB/s",
		};
	}
	return { value: (bytesPerSecond / 1_000_000).toFixed(2), unit: "MB/s" };
}
