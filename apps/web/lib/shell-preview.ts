import {
	CONNECTION_STATUSES,
	type ConnectionStatus,
} from "@/lib/connection-status";

/**
 * States the shell is told to show regardless of what is really happening,
 * so each one can be looked at without a server. Development only: the page
 * ignores the query parameter in a production build.
 */
export type ShellPreview = {
	/** Hold the WASM load open forever, or make it fail. */
	wasm?: "loading" | "failed";
	connection?: ConnectionStatus;
	replayRestarted?: true;
	/**
	 * Draw the map's depth test layers and tilt the camera to them
	 * (components/map/depth-test.ts).
	 */
	mapDepthTest?: true;
};

/** Every word `?preview=` accepts. Several may be joined with commas. */
export const PREVIEW_WORDS = [
	"wasm-loading",
	"wasm-failed",
	...CONNECTION_STATUSES,
	"replay-restarted",
	"map-depth-test",
] as const;

/**
 * Reads the `preview` query parameter, for example `open,replay-restarted`.
 * Unknown words are ignored. Returns null when nothing is asked for.
 */
export function parseShellPreview(
	value: string | string[] | undefined,
): ShellPreview | null {
	const words = (Array.isArray(value) ? value : [value ?? ""])
		.flatMap((part) => part.split(","))
		.map((word) => word.trim().toLowerCase());

	const preview: ShellPreview = {};
	for (const word of words) {
		if (word === "wasm-loading") {
			preview.wasm = "loading";
		} else if (word === "wasm-failed") {
			preview.wasm = "failed";
		} else if (word === "replay-restarted") {
			preview.replayRestarted = true;
		} else if (word === "map-depth-test") {
			preview.mapDepthTest = true;
		} else if (isConnectionStatus(word)) {
			preview.connection = word;
		}
	}
	return Object.keys(preview).length > 0 ? preview : null;
}

function isConnectionStatus(word: string): word is ConnectionStatus {
	return (CONNECTION_STATUSES as readonly string[]).includes(word);
}
