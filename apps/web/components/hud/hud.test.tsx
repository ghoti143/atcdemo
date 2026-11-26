import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	formatBytesPerSecond,
	formatCount,
	formatFps,
	formatFrameMs,
	formatWorkMs,
	frameTimeLevel,
	NO_READING,
} from "@/lib/hud-format";
import {
	createInterfaceStore,
	initialInterfaceState,
	type PerformanceReadings,
} from "@/lib/interface-store";
import { HudReadout } from "./hud-readout";
import { isHudShortcut, type ShortcutEvent, toggleHud } from "./hud-shortcut";
import { HUD_SAMPLE, PerformanceHud } from "./performance-hud";

describe("HUD formatting", () => {
	test("a reading nothing has measured is a dash", () => {
		for (const format of [formatFps, formatFrameMs, formatWorkMs]) {
			expect(format(Number.NaN)).toBe(NO_READING);
			expect(format(Number.POSITIVE_INFINITY)).toBe(NO_READING);
		}
		expect(formatCount(Number.NaN)).toBe(NO_READING);
		expect(formatBytesPerSecond(Number.NaN).value).toBe(NO_READING);
	});

	test("frames per second is a whole number", () => {
		expect(formatFps(59.94)).toBe("60");
		expect(formatFps(0)).toBe("0");
	});

	test("frame times are to a tenth of a millisecond", () => {
		expect(formatFrameMs(16.6667)).toBe("16.7");
		expect(formatFrameMs(8)).toBe("8.0");
		expect(formatFrameMs(120.04)).toBe("120.0");
	});

	test("work times are to a hundredth below ten milliseconds", () => {
		expect(formatWorkMs(0.144)).toBe("0.14");
		expect(formatWorkMs(0)).toBe("0.00");
		expect(formatWorkMs(9.994)).toBe("9.99");
		expect(formatWorkMs(9.996)).toBe("10.0");
		expect(formatWorkMs(12.34)).toBe("12.3");
	});

	test("counts have thousands separators", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(999)).toBe("999");
		expect(formatCount(7000)).toBe("7,000");
		expect(formatCount(60_583)).toBe("60,583");
		expect(formatCount(1_234_567)).toBe("1,234,567");
	});

	test("bytes per second picks a decimal unit", () => {
		expect(formatBytesPerSecond(0)).toEqual({ value: "0", unit: "B/s" });
		expect(formatBytesPerSecond(999)).toEqual({ value: "999", unit: "B/s" });
		expect(formatBytesPerSecond(1500)).toEqual({ value: "1.5", unit: "kB/s" });
		expect(formatBytesPerSecond(140_000)).toEqual({
			value: "140",
			unit: "kB/s",
		});
		expect(formatBytesPerSecond(999_960)).toEqual({
			value: "1.00",
			unit: "MB/s",
		});
		expect(formatBytesPerSecond(1_258_344)).toEqual({
			value: "1.26",
			unit: "MB/s",
		});
	});

	test("frame times are judged against 16.7 ms, with jitter allowed", () => {
		expect(frameTimeLevel(Number.NaN)).toBe("none");
		expect(frameTimeLevel(8.3)).toBe("ok");
		// A 60 Hz frame is 16.667 ms and reads 16.6 to 16.8 on a page that
		// misses none.
		expect(frameTimeLevel(16.667)).toBe("ok");
		expect(frameTimeLevel(16.8)).toBe("ok");
		expect(frameTimeLevel(17.2)).toBe("ok");
		expect(frameTimeLevel(17.3)).toBe("over");
		// One missed frame at 120 Hz is still inside the target.
		expect(frameTimeLevel(16.7)).toBe("ok");
		// One missed frame at 60 Hz.
		expect(frameTimeLevel(33.4)).toBe("over");
		expect(frameTimeLevel(33.8)).toBe("over");
		expect(frameTimeLevel(33.9)).toBe("slow");
		expect(frameTimeLevel(250)).toBe("slow");
	});
});

const READINGS: PerformanceReadings = {
	fps: 59.8,
	frameTimeP95Ms: 16.7,
	frameTimeP99Ms: 21.34,
	wasmAdvanceMs: 0.161,
	attributeUpdateMs: 0.85,
	mapRenderMs: 4.2,
	aircraftCount: 52_431,
	bytesPerSecond: 1_258_344,
	skippedFrames: 3,
};

/** The text of one row: label, figure and unit, without the markup. */
function row(html: string, name: string): string {
	const match = html.match(
		new RegExp(`<div data-reading="${name}"[^>]*>(.*?)</div>`),
	);
	if (!match) throw new Error(`no row "${name}" in ${html}`);
	return match[1]
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

describe("HudReadout", () => {
	test("shows every reading with its unit", () => {
		const html = renderToStaticMarkup(<HudReadout readings={READINGS} />);

		expect(row(html, "fps")).toBe("FPS 60");
		expect(row(html, "frame-p95")).toBe("Frame p95 16.7 ms");
		expect(row(html, "frame-p99")).toBe("Frame p99 21.3 ms");
		expect(row(html, "wasm-advance")).toBe("WASM 0.16 ms");
		expect(row(html, "attribute-update")).toBe("Attributes 0.85 ms");
		expect(row(html, "map-render")).toBe("Map 4.20 ms");
		expect(row(html, "aircraft")).toBe("Aircraft 52,431");
		expect(row(html, "bytes")).toBe("Network 1.26 MB/s");
		expect(row(html, "skipped-frames")).toBe("Skipped 3 frames");
	});

	test("marks a frame time past the target", () => {
		const html = renderToStaticMarkup(<HudReadout readings={READINGS} />);

		expect(html).toMatch(/data-reading="frame-p95" data-level="ok"/);
		expect(html).toMatch(/data-reading="frame-p99" data-level="over"/);
		expect(html).toContain("text-status-ok");
		expect(html).toContain("text-status-warn");
		expect(html).not.toContain("text-destructive");

		const slow = renderToStaticMarkup(
			<HudReadout readings={{ ...READINGS, frameTimeP99Ms: 48 }} />,
		);
		expect(slow).toMatch(/data-reading="frame-p99" data-level="slow"/);
		expect(slow).toContain("text-destructive");
	});

	test("before anything reports: dashes for times, zeros for counts", () => {
		const html = renderToStaticMarkup(
			<HudReadout readings={initialInterfaceState().performance} />,
		);

		expect(row(html, "fps")).toBe(`FPS ${NO_READING}`);
		expect(row(html, "frame-p95")).toBe(`Frame p95 ${NO_READING} ms`);
		expect(row(html, "wasm-advance")).toBe(`WASM ${NO_READING} ms`);
		expect(row(html, "attribute-update")).toBe(`Attributes ${NO_READING} ms`);
		expect(row(html, "map-render")).toBe(`Map ${NO_READING} ms`);
		expect(row(html, "aircraft")).toBe("Aircraft 0");
		expect(row(html, "bytes")).toBe("Network 0 B/s");
		expect(row(html, "skipped-frames")).toBe("Skipped 0 frames");
		expect(html).toMatch(/data-reading="frame-p95" data-level="none"/);
	});

	test("does not take the pointer from the map", () => {
		const html = renderToStaticMarkup(<HudReadout readings={READINGS} />);
		expect(html).toContain("pointer-events-none");
	});
});

describe("PerformanceHud", () => {
	test("draws the store's readings when the HUD is visible", () => {
		// Rendered to a string: no effect runs, so no frame meter starts.
		const html = renderToStaticMarkup(<PerformanceHud />);
		expect(html).toContain('data-slot="performance-hud"');
		expect(row(html, "fps")).toBe(`FPS ${NO_READING}`);
	});

	test("the sample covers what the frame meter does not measure", () => {
		const all = Object.keys(initialInterfaceState().performance);
		expect(
			[
				...Object.keys(HUD_SAMPLE),
				"fps",
				"frameTimeP95Ms",
				"frameTimeP99Ms",
			].sort(),
		).toEqual(all.sort());
	});
});

function key(event: Partial<ShortcutEvent>): ShortcutEvent {
	return {
		key: "h",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		repeat: false,
		target: { tagName: "BODY" },
		...event,
	};
}

describe("the HUD's shortcut", () => {
	test("is H on its own", () => {
		expect(isHudShortcut(key({}))).toBe(true);
		expect(isHudShortcut(key({ key: "H" }))).toBe(true);
		expect(isHudShortcut(key({ target: null }))).toBe(true);
		expect(isHudShortcut(key({ target: { tagName: "CANVAS" } }))).toBe(true);
	});

	test("is no other key, and not the map's", () => {
		for (const other of ["g", "ArrowLeft", "+", "-", "=", "Escape", " "]) {
			expect(isHudShortcut(key({ key: other }))).toBe(false);
		}
	});

	test("leaves the browser's and the system's shortcuts alone", () => {
		expect(isHudShortcut(key({ ctrlKey: true }))).toBe(false);
		expect(isHudShortcut(key({ metaKey: true }))).toBe(false);
		expect(isHudShortcut(key({ altKey: true }))).toBe(false);
	});

	test("does not fire again while the key is held", () => {
		expect(isHudShortcut(key({ repeat: true }))).toBe(false);
	});

	test("does not fire while typing", () => {
		for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
			expect(isHudShortcut(key({ target: { tagName } }))).toBe(false);
		}
		expect(
			isHudShortcut(
				key({ target: { tagName: "DIV", isContentEditable: true } }),
			),
		).toBe(false);
	});

	test("toggling flips the store's hudVisible", () => {
		const store = createInterfaceStore();
		expect(store.getState().hudVisible).toBe(true);

		toggleHud(store);
		expect(store.getState().hudVisible).toBe(false);

		toggleHud(store);
		expect(store.getState().hudVisible).toBe(true);
	});
});
