"use client";

import { useEffect } from "react";
import { interfaceStore } from "@/lib/interface-store";

/**
 * The key that shows and hides the performance HUD: H, on its own. MapLibre
 * takes the arrow keys, plus, minus and equals for the map, and no letters.
 */
export const HUD_SHORTCUT_KEY = "h";

/** As much of a `KeyboardEvent` as the shortcut looks at. */
export type ShortcutEvent = {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	repeat: boolean;
	target: unknown;
};

/**
 * True for H or h pressed once, with no Control, Command or Alt, and not
 * while typing in a field.
 */
export function isHudShortcut(event: ShortcutEvent): boolean {
	if (event.key.toLowerCase() !== HUD_SHORTCUT_KEY) return false;
	if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
		return false;
	}
	return !isEditable(event.target);
}

function isEditable(target: unknown): boolean {
	if (typeof target !== "object" || target === null) return false;
	const { tagName, isContentEditable } = target as {
		tagName?: unknown;
		isContentEditable?: unknown;
	};
	return (
		isContentEditable === true ||
		tagName === "INPUT" ||
		tagName === "TEXTAREA" ||
		tagName === "SELECT"
	);
}

/** Shows the HUD if it is hidden and hides it if it is shown. */
export function toggleHud(store = interfaceStore) {
	const { hudVisible, setHudVisible } = store.getState();
	setHudVisible(!hudVisible);
}

/** Listens for the shortcut for as long as the component is mounted. */
export function useHudShortcut() {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (isHudShortcut(event)) toggleHud();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);
}
