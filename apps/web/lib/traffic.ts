// The page's live traffic: the WASM module, its one aircraft store and the
// socket client that fills it. Held here, outside React, so the render loop,
// the HUD and picking reach them without props or context:
//
//   const traffic = currentTraffic();
//   if (traffic) {
//     traffic.store.advance(frameTimeMs);            // the aircraft layer
//     new Float32Array(traffic.memory.buffer, ...);  // views over the store
//     traffic.store.id_at(pickedRow);                // picking
//   }
//
// The selection is kept told to the store and the server from here too
// (lib/selection.ts): `select` and `track` go out when the interface
// store's `selectedId` changes, so a caller selects with
// `interfaceStore.getState().select(id)` and sends nothing itself.
//
// `currentTraffic()` is null until the shell has started it and after it has
// stopped it, so read it where it is used, each frame or each event, and do
// not keep what it returns.

import type { AircraftStore } from "atc-wasm";
import { createFlightList, type FlightList } from "@/lib/flight-list";
import { interfaceStore } from "@/lib/interface-store";
import { signInPath } from "@/lib/next-path";
import { createSelectionSync, type SelectionSync } from "@/lib/selection";
import { createSocketClient, type SocketClient } from "@/lib/socket-client";
import { tokenUrlResolver } from "@/lib/socket-token";
import type { AtcWasm } from "@/lib/wasm";

export type Traffic = {
	wasm: AtcWasm;
	/** WASM linear memory, for typed-array views over the store's buffers. */
	memory: WebAssembly.Memory;
	/**
	 * The aircraft store. The socket client calls `ingest` with
	 * `performance.now()`; give `advance` the same clock, which an animation
	 * frame's timestamp is.
	 */
	store: AircraftStore;
	client: SocketClient;
	/** Tells the store and the server what is selected; the render loop calls its `afterAdvance`. */
	selection: SelectionSync;
};

let current: Traffic | null = null;

/**
 * The flight list's data, for the page's one list. It reads whatever
 * traffic is running when it refreshes, and works only while the list is
 * on screen.
 */
export const flightList: FlightList = createFlightList({
	source: () => current,
	interfaceStore,
});
// One store for the life of the page, however often the client is started:
// it is emptied, not freed, so a caller holding it never holds freed memory.
let store: AircraftStore | undefined;

/** What is running now, or null when nothing is. */
export function currentTraffic(): Traffic | null {
	return current;
}

/**
 * Makes the aircraft store if there is none yet and starts a socket client
 * for `url`, which fetches a token from the web app before each connection. Returns the way to stop it. Starting while one is running
 * stops that one first, so the page never has two sockets.
 */
export function startTraffic(wasm: AtcWasm, url: string): () => void {
	stop();
	store ??= new wasm.module.AircraftStore();
	const client = createSocketClient({
		// A fresh token for every attempt, in the query string.
		resolveUrl: tokenUrlResolver(url),
		// The session ended under the open page: nothing here can go on, so
		// go and sign in, and come back to this address.
		onSessionEnded: () => {
			const here = `${window.location.pathname}${window.location.search}`;
			window.location.assign(signInPath(here, "expired"));
		},
		protocolVersion: wasm.protocolVersion,
		store,
		interfaceStore,
	});
	const selection = createSelectionSync({ interfaceStore, store, client });
	const started: Traffic = {
		wasm,
		memory: wasm.memory,
		store,
		client,
		selection,
	};
	current = started;
	selection.start();
	client.start();
	return () => {
		if (current === started) stop();
	};
}

function stop() {
	if (!current) return;
	current.selection.stop();
	current.client.stop();
	current.store.reset();
	current = null;
}
