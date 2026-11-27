"use client";

import { useSessionWatch } from "@/components/auth/use-session-watch";
import { FlightList } from "@/components/flight-list/flight-list";
import { useHudShortcut } from "@/components/hud/hud-shortcut";
import { PerformanceHud } from "@/components/hud/performance-hud";
import { TrafficMap } from "@/components/map/traffic-map";
import { MapArea } from "@/components/shell/map-area";
import { shellView } from "@/components/shell/shell-view";
import {
	PanelPlaceholder,
	PanelSection,
	SidePanel,
} from "@/components/shell/side-panel";
import { TopBar } from "@/components/shell/top-bar";
import { usePreferencesSync } from "@/components/shell/use-preferences-sync";
import { useShellState } from "@/components/shell/use-shell-state";
import { SavedViews } from "@/components/views/saved-views";
import type { ShellPreview } from "@/lib/shell-preview";
import { flightList } from "@/lib/traffic";

/**
 * The frame of the app: top bar, full-bleed map, side panels. It loads the
 * WASM module, starts the socket client, and shows the loading, failure and
 * connection states.
 *
 * All changing state comes from `useShellState`; everything below takes
 * plain props.
 */
export function AppShell({
	preview = null,
	socketUrl,
	aircraftHidden = false,
	user,
	onSignOut,
}: {
	preview?: ShellPreview | null;
	/**
	 * Where the browser reaches `atc-server`: `ATC_WS_URL`, read by the page
	 * on each request. Without it no socket is opened.
	 */
	socketUrl?: string;
	/**
	 * Run everything as usual and draw no aircraft: `/?aircraft=hidden`, a
	 * measuring aid for telling what drawing them costs.
	 */
	aircraftHidden?: boolean;
	/** The signed-in user, shown in the top bar. */
	user?: { name: string; email: string; role: string };
	/** The sign-out server action. */
	onSignOut?: () => Promise<void>;
}) {
	const state = useShellState(preview, socketUrl);
	const { wasm } = state;
	useHudShortcut();
	// Only a page with a user has a session to lose.
	useSessionWatch(user !== undefined);
	// And only a signed-in page has preferences to load and save.
	usePreferencesSync(user !== undefined);

	return (
		<div className="flex h-screen min-w-[64rem] flex-col overflow-hidden">
			<TopBar
				connection={state.connection}
				protocolVersion={
					wasm.status === "ready" ? wasm.wasm.protocolVersion : undefined
				}
				preview={preview !== null}
				hudVisible={state.hudVisible}
				onToggleHud={state.toggleHud}
				// A user's own, so only a signed-in page has them.
				views={user !== undefined ? <SavedViews /> : undefined}
				user={user}
				onSignOut={onSignOut}
			/>
			<div className="flex min-h-0 flex-1">
				<MapArea
					view={shellView(wasm.status, state.connection)}
					wasmError={wasm.status === "failed" ? wasm.message : undefined}
					onRetryWasm={state.retryWasm}
					closedReason={state.closedReason}
					onReconnect={state.reconnect}
					replayRestarted={state.replayRestarted}
					hud={<PerformanceHud sample={preview?.hudSample === true} />}
					// The map waits for the WASM module: until then the blank grid
					// stands in under the loading or failure card.
					map={
						wasm.status === "ready" ? (
							<TrafficMap
								depthTest={preview?.mapDepthTest === true}
								aircraftHidden={aircraftHidden}
							/>
						) : undefined
					}
				/>
				<SidePanel>
					<PanelSection slot="flight-list" title="Flights" className="flex-1">
						<FlightList list={flightList} />
					</PanelSection>
					<PanelSection slot="flight-detail" title="Detail" className="h-48">
						<PanelPlaceholder>
							Select an aircraft to see its detail. Arrives in milestone 5.
						</PanelPlaceholder>
					</PanelSection>
					<PanelSection slot="alerts" title="Alerts" className="h-40">
						<PanelPlaceholder>
							Conflict alerts arrive in milestone 7.
						</PanelPlaceholder>
					</PanelSection>
				</SidePanel>
			</div>
		</div>
	);
}
