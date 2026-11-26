"use client";

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@/lib/connection-status";
import type { ShellPreview } from "@/lib/shell-preview";
import { type AtcWasm, loadAtcWasm, type WasmLoader } from "@/lib/wasm";

export type WasmState =
	| { status: "loading" }
	| { status: "ready"; wasm: AtcWasm }
	| { status: "failed"; message: string };

export type ShellState = {
	wasm: WasmState;
	/** Starts the WASM load again after it failed. */
	retryWasm: () => void;
	connection: ConnectionStatus;
	/** True while the "replay restarted" notice should be on screen. */
	replayRestarted: boolean;
};

/**
 * Everything the shell shows that can change, in one place.
 *
 * The connection status and the replay notice are local constants for now:
 * nothing sets them until the socket client exists. The interface store
 * (issue #26) replaces those two lines; the components below this hook take
 * plain props and do not change.
 *
 * `preview` pins states for looking at them without a server. It is null
 * outside development.
 */
export function useShellState(preview: ShellPreview | null): ShellState {
	const [wasm, setWasm] = useState<WasmState>({ status: "loading" });

	// Swap for the interface store (#26), fed by the socket client (#27).
	const connection: ConnectionStatus = "connecting";
	const replayRestarted = false;

	const load = preview?.wasm ? PREVIEW_LOADERS[preview.wasm] : loadAtcWasm;

	useEffect(() => {
		let cancelled = false;
		settle(load, (next) => {
			if (!cancelled) setWasm(next);
		});
		return () => {
			cancelled = true;
		};
	}, [load]);

	return {
		wasm,
		retryWasm: () => {
			setWasm({ status: "loading" });
			settle(load, setWasm);
		},
		connection: preview?.connection ?? connection,
		replayRestarted: preview?.replayRestarted ?? replayRestarted,
	};
}

function settle(load: WasmLoader, done: (state: WasmState) => void) {
	load().then(
		(wasm) => done({ status: "ready", wasm }),
		(cause: unknown) =>
			done({
				status: "failed",
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	);
}

// The previews go through the same path as a real load: one never settles,
// the other rejects.
const PREVIEW_LOADERS: Record<"loading" | "failed", WasmLoader> = {
	loading: () => new Promise(() => {}),
	failed: () =>
		Promise.reject(new Error("Simulated failure (?preview=wasm-failed)")),
};
