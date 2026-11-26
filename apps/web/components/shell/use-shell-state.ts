"use client";

import { useEffect, useState } from "react";
import type {
	ConnectionClosedReason,
	ConnectionStatus,
} from "@/lib/connection-status";
import { useInterfaceStore } from "@/lib/interface-store";
import type { ShellPreview } from "@/lib/shell-preview";
import { currentTraffic, startTraffic } from "@/lib/traffic";
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
	/** Why the client stopped trying. Null unless `connection` is `closed`. */
	closedReason: ConnectionClosedReason | null;
	/** Tells the socket client to try again after it has given up. */
	reconnect: () => void;
	/** True while the "replay restarted" notice should be on screen. */
	replayRestarted: boolean;
};

/**
 * Everything the shell shows that can change, in one place.
 *
 * Once the WASM module is ready it starts the page's traffic: the aircraft
 * store and the socket client (lib/traffic.ts). The connection status and
 * the replay notice come from the interface store, so whatever the socket
 * client writes there shows in the top bar and over the map. The
 * components below this hook take plain props.
 *
 * `socketUrl` is where `atc-server` is. Without one no socket is opened.
 *
 * `preview` pins states for looking at them without a server. It is null
 * outside development. A preview that pins the connection opens no socket.
 */
export function useShellState(
	preview: ShellPreview | null,
	socketUrl?: string,
): ShellState {
	const [wasm, setWasm] = useState<WasmState>({ status: "loading" });

	const connection = useInterfaceStore((state) => state.connectionStatus);
	const closedReason = useInterfaceStore(
		(state) => state.connectionClosedReason,
	);
	const replayRestarted = useInterfaceStore((state) => state.replayRestarted);

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

	const ready = wasm.status === "ready" ? wasm.wasm : null;
	const connectionPinned = preview?.connection !== undefined;
	const connectTo = socketUrlToOpen(preview, socketUrl);
	useEffect(() => {
		if (!ready || connectTo === null) return;
		// The cleanup stops the client, so React's development double mount
		// starts, stops and starts, and one socket is opened.
		return startTraffic(ready, connectTo);
	}, [ready, connectTo]);

	return {
		wasm,
		retryWasm: () => {
			setWasm({ status: "loading" });
			settle(load, setWasm);
		},
		connection: preview?.connection ?? connection,
		closedReason: connectionPinned ? null : closedReason,
		reconnect: () => currentTraffic()?.client.reconnectNow(),
		replayRestarted: preview?.replayRestarted ?? replayRestarted,
	};
}

/**
 * The address the shell connects to once the WASM module is ready, or null
 * when it must not connect: there is no address, or a preview pins the
 * connection status, which a real socket would then be working behind.
 */
export function socketUrlToOpen(
	preview: ShellPreview | null,
	socketUrl: string | undefined,
): string | null {
	if (!socketUrl || preview?.connection !== undefined) return null;
	return socketUrl;
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
