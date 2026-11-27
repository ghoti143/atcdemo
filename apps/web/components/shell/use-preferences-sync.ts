"use client";

import { useEffect } from "react";
import { apiGet, apiPut } from "@/lib/api/client";
import { preferencesAnswerSchema } from "@/lib/api/preferences-shapes";
import { interfaceStore } from "@/lib/interface-store";
import { createPreferencesSync } from "@/lib/preferences-sync";

/**
 * While `enabled`, loads the signed-in user's preferences into the
 * interface store and saves them when they change.
 */
export function usePreferencesSync(enabled: boolean): void {
	useEffect(() => {
		if (!enabled) return;
		const sync = createPreferencesSync({
			interfaceStore,
			load: async () =>
				(await apiGet("/api/preferences", preferencesAnswerSchema)).preferences,
			save: (preferences) =>
				apiPut("/api/preferences", preferences, preferencesAnswerSchema),
		});
		sync.start();
		return () => sync.stop();
	}, [enabled]);
}
