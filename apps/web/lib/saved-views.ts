// What a saved view takes from the page and gives back to it. No import of
// React or the DOM, so `bun test` runs it.

import type { ViewData } from "@/lib/api/views-shapes";
import type { InterfaceStoreLike } from "@/lib/socket-client";

/**
 * The view the page is showing now, or null before the map has reported
 * where its camera is.
 */
export function captureView(store: InterfaceStoreLike): ViewData | null {
	const { camera, viewMode, filters } = store.getState();
	if (camera === null) return null;
	return {
		camera: { ...camera },
		viewMode,
		filters: { text: filters.text },
	};
}

/** Puts a saved view back: moves the map, and sets the mode and the filter. */
export function applyView(store: InterfaceStoreLike, view: ViewData): void {
	const state = store.getState();
	state.moveCameraTo(view.camera);
	state.setViewMode(view.viewMode);
	state.setFilters({ text: view.filters.text });
}
