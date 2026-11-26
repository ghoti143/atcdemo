import { LoaderCircle, TriangleAlert, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { ReplayNotice } from "@/components/shell/replay-notice";
import type { ShellView } from "@/components/shell/shell-view";
import { StatePanel } from "@/components/shell/state-panel";
import { Button } from "@/components/ui/button";
import type { ConnectionClosedReason } from "@/lib/connection-status";
import { cn } from "@/lib/utils";

/**
 * The full-bleed map region and everything that floats over it.
 *
 * Slots, bottom to top:
 * - `map`: the MapLibre map and deck.gl overlay. A blank grid stands in
 *   when none is given, which is while the WASM module is not ready.
 * - `hud`: the performance HUD, top left. It moves down by the height of
 *   the reconnecting strip while that is shown, so the strip never covers
 *   it.
 * - the "replay restarted" notice, top centre.
 * - the state overlay: loading, failure, connecting, reconnecting,
 *   disconnected.
 */
export function MapArea({
	view,
	wasmError,
	onRetryWasm,
	closedReason = null,
	onReconnect,
	replayRestarted,
	map,
	hud,
}: {
	view: ShellView;
	/** The error text when `view` is `wasm-failed`. */
	wasmError?: string;
	onRetryWasm: () => void;
	/** Why, when `view` is `disconnected`. */
	closedReason?: ConnectionClosedReason | null;
	/** Tells the socket client to try again. */
	onReconnect?: () => void;
	replayRestarted: boolean;
	map?: ReactNode;
	hud?: ReactNode;
}) {
	return (
		<section
			aria-label="Map"
			data-view={view}
			className="relative min-w-0 flex-1 overflow-hidden"
		>
			<div data-slot="map" className="absolute inset-0">
				{map ?? <MapPlaceholder />}
			</div>
			<div
				data-slot="hud"
				className={cn(
					// The pointer goes through to the map. A control in the HUD
					// that needs it turns it back on for itself.
					"pointer-events-none absolute left-3 z-10 transition-[top] duration-150",
					// The strip is 2rem tall; the HUD keeps its 0.75rem below it.
					view === "reconnecting" ? "top-11" : "top-3",
				)}
			>
				{hud}
			</div>
			<ReplayNotice visible={replayRestarted} />
			<StateOverlay
				view={view}
				wasmError={wasmError}
				onRetryWasm={onRetryWasm}
				closedReason={closedReason}
				onReconnect={onReconnect}
			/>
		</section>
	);
}

function MapPlaceholder() {
	return (
		<div className="map-grid flex size-full items-end justify-start p-3">
			<p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
				Map placeholder · 24.4°N–49.4°N, 125°W–66.9°W
			</p>
		</div>
	);
}

function StateOverlay({
	view,
	wasmError,
	onRetryWasm,
	closedReason,
	onReconnect,
}: {
	view: ShellView;
	wasmError?: string;
	onRetryWasm: () => void;
	closedReason: ConnectionClosedReason | null;
	onReconnect?: () => void;
}) {
	if (view === "live") return null;

	if (view === "reconnecting") {
		// A strip, not a scrim: the last picture stays readable underneath.
		return (
			<div
				role="status"
				data-slot="state-banner"
				data-state={view}
				className="absolute inset-x-0 top-0 z-30 flex h-8 items-center justify-center gap-2 border-b border-status-warn/50 bg-status-warn/15 font-mono text-xs uppercase tracking-wider text-status-warn backdrop-blur-sm"
			>
				<LoaderCircle aria-hidden className="size-3.5 animate-spin" />
				Connection lost · reconnecting
				<span className="normal-case tracking-normal text-foreground/70">
					Showing the last picture received.
				</span>
			</div>
		);
	}

	return (
		<div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 p-6 backdrop-blur-[2px]">
			{view === "wasm-loading" && (
				<StatePanel
					data-state={view}
					icon={LoaderCircle}
					spin
					title="Loading the traffic engine"
				>
					Fetching and starting the WebAssembly module that holds the aircraft
					picture.
				</StatePanel>
			)}
			{view === "wasm-failed" && (
				<StatePanel
					data-state={view}
					tone="error"
					icon={TriangleAlert}
					title="The traffic engine failed to load"
					detail={wasmError}
					action={
						<Button size="sm" variant="outline" onClick={onRetryWasm}>
							Try again
						</Button>
					}
				>
					The WebAssembly module that holds the aircraft picture could not be
					fetched or started, so there is nothing to show.
				</StatePanel>
			)}
			{view === "connecting" && (
				<StatePanel
					data-state={view}
					icon={LoaderCircle}
					spin
					title="Connecting to the traffic server"
				>
					Aircraft appear as soon as the first frame arrives.
				</StatePanel>
			)}
			{view === "disconnected" && closedReason === "protocol-mismatch" && (
				// Trying again cannot work: the page's module has to be replaced.
				<StatePanel
					data-state={view}
					data-reason={closedReason}
					tone="warn"
					icon={Unplug}
					title="This page is out of date"
					action={
						<Button
							size="sm"
							variant="outline"
							onClick={() => window.location.reload()}
						>
							Reload
						</Button>
					}
				>
					The traffic server and this page's traffic engine speak different
					versions of the protocol, so the server closed the connection. Reload
					the page to fetch the current engine.
				</StatePanel>
			)}
			{view === "disconnected" && closedReason !== "protocol-mismatch" && (
				<StatePanel
					data-state={view}
					data-reason={closedReason ?? undefined}
					tone="warn"
					icon={Unplug}
					title="Disconnected"
					action={
						<Button size="sm" variant="outline" onClick={onReconnect}>
							Reconnect now
						</Button>
					}
				>
					The traffic server could not be reached and the page has stopped
					trying. It tries again when you come back to this tab, or now.
				</StatePanel>
			)}
		</div>
	);
}
