"use client";

import { useEffect } from "react";
import { apiGet, apiPut } from "@/lib/api/client";
import { preferencesAnswerSchema } from "@/lib/api/preferences-shapes";
import { interfaceStore } from "@/lib/interface-store";
import { signInPath } from "@/lib/next-path";
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
			// As a query answered 401 does (components/providers.tsx).
			onSessionEnded: () => {
				const here = `${window.location.pathname}${window.location.search}`;
				window.location.assign(signInPath(here, "expired"));
			},
		});
		sync.start();
		return () => sync.stop();
	}, [enabled]);
}
