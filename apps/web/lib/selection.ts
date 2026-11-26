// Which aircraft is selected and which is hovered, told to the two places
// that need to know beside the interface store: the server, which keeps a
// selected aircraft streaming after it leaves the viewport, and the WASM
// store, which holds the selected and the hovered aircraft's tracks. No
// import of React, the map or the DOM, so `bun test` runs it. See
// docs/DESIGN.md sections 6 and 8.
//
// An aircraft is named by its id everywhere here. A pick gives a row of the
// store's buffers, and rows are reused from one positions frame to the
// next, so `pickedId` turns the row into an id in the same turn as the pick
// and nothing keeps the row.
//
// What is sent, and when:
//
// - `select {id}` whenever the interface store's `selectedId` changes, with
//   null for nothing selected, and `track {id}` after it when an aircraft
//   is selected. The store takes in the track frame that answers; nothing
//   draws it until milestone 5.
// - Both again whenever the connection status becomes `open`: a new
//   connection knows nothing the last one was told, and the socket client
//   resends only the viewport. A null selection is not resent, since that
//   is what a new connection starts with.
// - Nothing for hover. `track` for an aircraft hovered for a moment is
//   milestone 5, with the trail it is for.
//
// When the selected aircraft leaves the picture, because it landed or the
// pass ended, the selection is cleared, which also tells the server. It
// counts as gone once ABSENT_FRAMES_BEFORE_CLEARING positions frames in a
// row have come without it. One frame is not enough: a `select` takes
// effect in the next positions frame the server builds, so the frame after
// a reconnect, or after selecting an aircraft that is outside the viewport,
// can be one built before the server had read it.

import type { ClientMessage, InterfaceStoreLike } from "@/lib/socket-client";

/**
 * Positions frames in a row that must lack the selected aircraft before
 * the selection is cleared: about that many seconds.
 */
export const ABSENT_FRAMES_BEFORE_CLEARING = 3;

/** The part of the WASM `AircraftStore` a pick reads. */
export type PickStore = {
	id_at(row: number): number | undefined;
};

/**
 * The aircraft a pick landed on, or null for none. `index` is what deck.gl
 * reports: a row of the aircraft layer as last drawn, or -1 for nothing.
 * Call it in the same turn as the pick, before the next `advance`: the row
 * means this aircraft only until then.
 */
export function pickedId(store: PickStore, index: number): number | null {
	if (!Number.isInteger(index) || index < 0) return null;
	return store.id_at(index) ?? null;
}

/** The part of the WASM `AircraftStore` the selection uses. */
export type SelectionStore = {
	set_selected(id?: number | null): void;
	set_hovered(id?: number | null): void;
	row_of(id: number): number | undefined;
	rows_version(): number;
};

/** The part of the socket client the selection uses. */
export type SelectionClient = {
	send(message: ClientMessage): boolean;
};

export type SelectionSyncOptions = {
	interfaceStore: InterfaceStoreLike;
	store: SelectionStore;
	client: SelectionClient;
};

export type SelectionSync = {
	/**
	 * Tells the store and the server what is selected now, and keeps them
	 * told. Does nothing if it is already started.
	 */
	start(): void;
	stop(): void;
	/**
	 * Clears the selection once the selected aircraft has left the picture.
	 * The render loop calls it every frame, after `advance`. It allocates
	 * nothing, and does no more than read `rows_version` unless a positions
	 * frame has been taken up since the last call.
	 */
	afterAdvance(): void;
};

export function createSelectionSync({
	interfaceStore,
	store,
	client,
}: SelectionSyncOptions): SelectionSync {
	let stopListening: (() => void)[] | null = null;
	// Kept here so `afterAdvance` reads no state on most frames.
	let selectedId: number | null = null;
	let open = false;
	// `rows_version` when the selected aircraft was last looked for.
	let lookedAtVersion = -1;
	// Positions frames in a row without the selected aircraft.
	let absentFrames = 0;

	/** `select`, and `track` for an aircraft. Not written unless a connection is open. */
	function send(id: number | null) {
		// The count starts again from what the server now knows.
		absentFrames = 0;
		lookedAtVersion = store.rows_version();
		if (!client.send({ type: "select", id })) return;
		if (id !== null) client.send({ type: "track", id });
	}

	return {
		start() {
			if (stopListening !== null) return;
			const state = interfaceStore.getState();
			selectedId = state.selectedId;
			open = state.connectionStatus === "open";
			store.set_selected(selectedId);
			store.set_hovered(state.hoveredId);
			// A connection already open has been told nothing by this object.
			if (selectedId !== null) send(selectedId);

			stopListening = [
				interfaceStore.subscribe(
					(s) => s.selectedId,
					(id) => {
						selectedId = id;
						store.set_selected(id);
						send(id);
					},
				),
				interfaceStore.subscribe(
					(s) => s.hoveredId,
					(id) => store.set_hovered(id),
				),
				interfaceStore.subscribe(
					(s) => s.connectionStatus,
					(status) => {
						open = status === "open";
						if (open && selectedId !== null) send(selectedId);
					},
				),
			];
		},

		stop() {
			if (stopListening === null) return;
			for (const stop of stopListening) stop();
			stopListening = null;
		},

		afterAdvance() {
			// While no connection is open the picture is the last one's, or
			// empty and about to be filled; neither says the aircraft has gone.
			if (selectedId === null || !open || stopListening === null) return;
			const version = store.rows_version();
			if (version === lookedAtVersion) return;
			lookedAtVersion = version;
			if (store.row_of(selectedId) !== undefined) {
				absentFrames = 0;
				return;
			}
			absentFrames += 1;
			if (absentFrames >= ABSENT_FRAMES_BEFORE_CLEARING) {
				// Through the interface store, so the listener above tells the
				// WASM store and the server like any other deselect.
				interfaceStore.getState().select(null);
			}
		},
	};
}
