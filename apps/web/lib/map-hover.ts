// The map's share of the hover. The store holds one hovered aircraft and
// two places set it: the map, from deck.gl's picks, and the flight list,
// from its rows. No import of React or the DOM, so `bun test` runs it.

import type { InterfaceStoreLike } from "@/lib/socket-client";

/**
 * Returns what the map calls with each pick: an aircraft id, or null when
 * the pick found none.
 *
 * A pick that finds none clears the hover only if the hover is still the
 * one the map set. deck.gl picks once per animation frame, so its "the
 * pointer has left" arrives a frame after the pointer has entered a row of
 * the list, and would otherwise clear the hover the row had just set.
 */
export function createMapHover(
	store: InterfaceStoreLike,
): (id: number | null) => void {
	let mine: number | null = null;
	return (id) => {
		const state = store.getState();
		if (id !== null) {
			mine = id;
			state.hover(id);
			return;
		}
		if (mine !== null && state.hoveredId === mine) state.hover(null);
		mine = null;
	};
}
