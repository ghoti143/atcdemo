"use client";

import {
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { signInPath } from "@/lib/next-path";

/** Whether a failed query is worth another try: not when the answer was "no". */
export function shouldRetry(failures: number, error: unknown): boolean {
	if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
		return false;
	}
	return failures < 2;
}

/**
 * The page's one query client. A route that answers 401 means the session
 * has ended under the open page, so the browser goes to sign-in, as it does
 * when the socket's token is refused.
 */
export function makeQueryClient(
	onSessionEnded: () => void = () => {
		const here = `${window.location.pathname}${window.location.search}`;
		window.location.assign(signInPath(here, "expired"));
	},
): QueryClient {
	return new QueryClient({
		queryCache: new QueryCache({
			onError: (error) => {
				if (error instanceof ApiError && error.status === 401) onSessionEnded();
			},
		}),
		defaultOptions: {
			queries: {
				retry: shouldRetry,
				// What a route returns is recorded history; it does not go stale
				// by the window being looked at again.
				refetchOnWindowFocus: false,
				staleTime: 30_000,
			},
		},
	});
}

/** Everything the app's client components expect to be wrapped in. */
export function Providers({ children }: { children: ReactNode }) {
	// One client for the life of the page, made on first render.
	const [client] = useState(() => makeQueryClient());
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
