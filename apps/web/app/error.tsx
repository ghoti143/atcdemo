"use client"; // Error boundaries must be Client Components

import { TriangleAlert } from "lucide-react";
import { StatePanel } from "@/components/shell/state-panel";
import { Button } from "@/components/ui/button";

/** Shown in place of the page when rendering it throws. */
export default function PageError({
	error,
	retry,
}: {
	error: Error & { digest?: string };
	retry: () => void;
}) {
	return (
		<main className="map-grid flex h-screen items-center justify-center p-6">
			<StatePanel
				tone="error"
				icon={TriangleAlert}
				title="Something went wrong"
				detail={
					error.digest ? `${error.message} (${error.digest})` : error.message
				}
				action={
					<Button size="sm" variant="outline" onClick={() => retry()}>
						Try again
					</Button>
				}
			>
				The page hit an error it could not recover from.
			</StatePanel>
		</main>
	);
}
