// The page's live traffic: the WASM module, its one aircraft store and the
// socket client that fills it. Held here, outside React, so the render loop,
// the HUD and picking reach them without props or context:
//
//   const traffic = currentTraffic();
//   if (traffic) {
//     traffic.store.advance(frameTimeMs);            // the aircraft layer
//     new Float32Array(traffic.memory.buffer, ...);  // views over the store
//     traffic.client.send({ type: "select", id });   // picking
//   }
//
// `currentTraffic()` is null until the shell has started it and after it has
// stopped it, so read it where it is used, each frame or each event, and do
// not keep what it returns.

import type { AircraftStore } from "atc-wasm";
import { interfaceStore } from "@/lib/interface-store";
import { createSocketClient, type SocketClient } from "@/lib/socket-client";
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
};

let current: Traffic | null = null;
// One store for the life of the page, however often the client is started:
// it is emptied, not freed, so a caller holding it never holds freed memory.
let store: AircraftStore | undefined;

/** What is running now, or null when nothing is. */
export function currentTraffic(): Traffic | null {
	return current;
}

/**
 * Makes the aircraft store if there is none yet and starts a socket client
 * for `url`. Returns the way to stop it. Starting while one is running
 * stops that one first, so the page never has two sockets.
 */
export function startTraffic(wasm: AtcWasm, url: string): () => void {
	stop();
	store ??= new wasm.module.AircraftStore();
	const client = createSocketClient({
		// Milestone 4 fetches a token here and adds it to the query string.
		resolveUrl: () => url,
		protocolVersion: wasm.protocolVersion,
		store,
		interfaceStore,
	});
	const started: Traffic = { wasm, memory: wasm.memory, store, client };
	current = started;
	client.start();
	return () => {
		if (current === started) stop();
	};
}

function stop() {
	if (!current) return;
	current.client.stop();
	current.store.reset();
	current = null;
}
