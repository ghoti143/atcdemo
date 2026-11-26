"use client";

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@/lib/connection-status";
import { useInterfaceStore } from "@/lib/interface-store";
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
 * The connection status comes from the interface store, so whatever the
 * socket client writes there shows in the top bar and over the map. The
 * replay notice is still a constant: nothing raises it until the socket
 * client exists. The components below this hook take plain props.
 *
 * `preview` pins states for looking at them without a server. It is null
 * outside development.
 */
export function useShellState(preview: ShellPreview | null): ShellState {
	const [wasm, setWasm] = useState<WasmState>({ status: "loading" });

	// Written by the socket client (#27); until it exists this stays at the
	// store's starting value, "connecting".
	const connection = useInterfaceStore((state) => state.connectionStatus);
	// The socket client will raise this on the first frame of a new pass.
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
