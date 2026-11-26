"use client";

import { TrafficMap } from "@/components/map/traffic-map";
import { MapArea } from "@/components/shell/map-area";
import { shellView } from "@/components/shell/shell-view";
import {
	PanelPlaceholder,
	PanelSection,
	SidePanel,
} from "@/components/shell/side-panel";
import { TopBar } from "@/components/shell/top-bar";
import { useShellState } from "@/components/shell/use-shell-state";
import type { ShellPreview } from "@/lib/shell-preview";

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
}) {
	const state = useShellState(preview, socketUrl);
	const { wasm } = state;

	return (
		<div className="flex h-screen min-w-[64rem] flex-col overflow-hidden">
			<TopBar
				connection={state.connection}
				protocolVersion={
					wasm.status === "ready" ? wasm.wasm.protocolVersion : undefined
				}
				preview={preview !== null}
			/>
			<div className="flex min-h-0 flex-1">
				<MapArea
					view={shellView(wasm.status, state.connection)}
					wasmError={wasm.status === "failed" ? wasm.message : undefined}
					onRetryWasm={state.retryWasm}
					closedReason={state.closedReason}
					onReconnect={state.reconnect}
					replayRestarted={state.replayRestarted}
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
						<PanelPlaceholder>
							The flight list arrives in milestone 5.
						</PanelPlaceholder>
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
