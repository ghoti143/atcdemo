"use client";

import { useEffect } from "react";
import { signInPath } from "@/lib/next-path";
import { startSessionWatch } from "@/lib/session-watch";

/**
 * While `enabled`, sends the browser to the sign-in page when the session
 * ends under the open page, keeping the address to come back to.
 */
export function useSessionWatch(enabled: boolean): void {
	useEffect(() => {
		if (!enabled) return;
		return startSessionWatch({
			onEnded: () => {
				const here = `${window.location.pathname}${window.location.search}`;
				window.location.assign(signInPath(here, "expired"));
			},
		});
	}, [enabled]);
}
