import { describe, expect, test } from "bun:test";
import { CONNECTION_STATUSES } from "./connection-status";
import { PREVIEW_WORDS, parseShellPreview } from "./shell-preview";

describe("parseShellPreview", () => {
	test("is null when nothing is asked for", () => {
		expect(parseShellPreview(undefined)).toBeNull();
		expect(parseShellPreview("")).toBeNull();
		expect(parseShellPreview("nonsense")).toBeNull();
	});

	test("reads each connection status", () => {
		for (const status of CONNECTION_STATUSES) {
			expect(parseShellPreview(status)).toEqual({ connection: status });
		}
	});

	test("reads the two WASM states", () => {
		expect(parseShellPreview("wasm-loading")).toEqual({ wasm: "loading" });
		expect(parseShellPreview("wasm-failed")).toEqual({ wasm: "failed" });
	});

	test("reads the map's depth test", () => {
		expect(parseShellPreview("open,map-depth-test")).toEqual({
			connection: "open",
			mapDepthTest: true,
		});
	});

	test("reads the HUD's sample readings", () => {
		expect(parseShellPreview("open,hud-sample")).toEqual({
			connection: "open",
			hudSample: true,
		});
	});

	test("combines words joined with commas", () => {
		expect(parseShellPreview("open, Replay-Restarted")).toEqual({
			connection: "open",
			replayRestarted: true,
		});
	});

	test("combines a repeated parameter and skips unknown words", () => {
		expect(parseShellPreview(["reconnecting", "bogus"])).toEqual({
			connection: "reconnecting",
		});
	});

	test("accepts every word it advertises", () => {
		for (const word of PREVIEW_WORDS) {
			expect(parseShellPreview(word)).not.toBeNull();
		}
	});
});
