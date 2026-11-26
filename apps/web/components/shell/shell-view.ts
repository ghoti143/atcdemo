import type { ConnectionStatus } from "@/lib/connection-status";

/**
 * The one thing the map area is showing. The WASM module comes first:
 * without it no frame can be decoded, so the connection does not matter yet.
 */
export type ShellView =
	| "wasm-loading"
	| "wasm-failed"
	| "connecting"
	| "live"
	| "reconnecting"
	| "disconnected";

export function shellView(
	wasmStatus: "loading" | "ready" | "failed",
	connection: ConnectionStatus,
): ShellView {
	if (wasmStatus === "loading") return "wasm-loading";
	if (wasmStatus === "failed") return "wasm-failed";
	switch (connection) {
		case "connecting":
			return "connecting";
		case "open":
			return "live";
		case "reconnecting":
			return "reconnecting";
		case "closed":
			return "disconnected";
	}
}
