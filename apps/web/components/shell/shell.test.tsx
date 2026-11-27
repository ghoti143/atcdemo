import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CONNECTION_STATUSES } from "@/lib/connection-status";
import { AppShell } from "./app-shell";
import { ConnectionIndicator } from "./connection-indicator";
import { MapArea } from "./map-area";
import { ReplayNotice } from "./replay-notice";
import { type ShellView, shellView } from "./shell-view";
import { TopBar } from "./top-bar";
import { socketUrlToOpen } from "./use-shell-state";

// Rendered to a string, as the server would: no effects run and nothing
// needs a DOM.

describe("shellView", () => {
	test("the WASM module comes before the connection", () => {
		for (const status of CONNECTION_STATUSES) {
			expect(shellView("loading", status)).toBe("wasm-loading");
			expect(shellView("failed", status)).toBe("wasm-failed");
		}
	});

	test("follows the connection once the module is ready", () => {
		expect(shellView("ready", "connecting")).toBe("connecting");
		expect(shellView("ready", "open")).toBe("live");
		expect(shellView("ready", "reconnecting")).toBe("reconnecting");
		expect(shellView("ready", "closed")).toBe("disconnected");
	});
});

describe("ConnectionIndicator", () => {
	test("names each status", () => {
		const labels = {
			connecting: "Connecting",
			open: "Live",
			reconnecting: "Reconnecting",
			closed: "Offline",
		};
		for (const status of CONNECTION_STATUSES) {
			const html = renderToStaticMarkup(
				<ConnectionIndicator status={status} />,
			);
			expect(html).toContain(`data-status="${status}"`);
			expect(html).toContain(`Connection: ${labels[status]}`);
		}
	});
});

describe("ReplayNotice", () => {
	test("says so when visible", () => {
		const html = renderToStaticMarkup(<ReplayNotice visible />);
		expect(html).toContain("Replay restarted");
		expect(html).toContain('data-visible="true"');
	});

	test("keeps an empty live region when hidden", () => {
		const html = renderToStaticMarkup(<ReplayNotice visible={false} />);
		expect(html).toContain('role="status"');
		expect(html).not.toContain("Replay restarted");
	});
});

describe("MapArea", () => {
	const render = (view: ShellView, wasmError?: string) =>
		renderToStaticMarkup(
			<MapArea
				view={view}
				wasmError={wasmError}
				onRetryWasm={() => {}}
				replayRestarted={false}
			/>,
		);

	test("shows a message for every state but live", () => {
		const titles: Record<ShellView, string | null> = {
			"wasm-loading": "Loading the traffic engine",
			"wasm-failed": "The traffic engine failed to load",
			connecting: "Connecting to the traffic server",
			live: null,
			reconnecting: "reconnecting",
			disconnected: "Disconnected",
		};
		for (const [view, title] of Object.entries(titles)) {
			const html = render(view as ShellView);
			if (title === null) {
				expect(html).not.toContain("data-state=");
			} else {
				expect(html).toContain(`data-state="${view}"`);
				expect(html).toContain(title);
			}
		}
	});

	test("a WASM failure shows the error and a way to retry", () => {
		const html = render("wasm-failed", "CompileError: bad magic");
		expect(html).toContain("CompileError: bad magic");
		expect(html).toContain("Try again");
		expect(html).toContain('role="alert"');
	});

	test("a client that gave up offers to reconnect, without a reload", () => {
		let asked = 0;
		const html = renderToStaticMarkup(
			<MapArea
				view="disconnected"
				closedReason="unreachable"
				onReconnect={() => {
					asked += 1;
				}}
				onRetryWasm={() => {}}
				replayRestarted={false}
			/>,
		);
		expect(html).toContain('data-reason="unreachable"');
		expect(html).toContain("Reconnect now");
		expect(html).not.toContain("Reload");
		expect(asked).toBe(0);
	});

	test("a protocol mismatch offers a reload, not a reconnect", () => {
		const html = renderToStaticMarkup(
			<MapArea
				view="disconnected"
				closedReason="protocol-mismatch"
				onRetryWasm={() => {}}
				replayRestarted={false}
			/>,
		);
		expect(html).toContain('data-reason="protocol-mismatch"');
		expect(html).toContain("This page is out of date");
		expect(html).toContain("Reload");
		expect(html).not.toContain("Reconnect now");
	});

	test("an ended session says so and offers the sign-in page, not a retry", () => {
		const html = renderToStaticMarkup(
			<MapArea
				view="disconnected"
				closedReason="session-ended"
				onRetryWasm={() => {}}
				replayRestarted={false}
			/>,
		);
		expect(html).toContain('data-reason="session-ended"');
		expect(html).toContain("Your session has ended");
		expect(html).toContain('href="/sign-in?reason=expired"');
		expect(html).not.toContain("Reconnect now");
	});

	test("fills the map and HUD slots when given", () => {
		const html = renderToStaticMarkup(
			<MapArea
				view="live"
				onRetryWasm={() => {}}
				replayRestarted={false}
				map={<i>the-map</i>}
				hud={<i>the-hud</i>}
			/>,
		);
		expect(html).toContain("the-map");
		expect(html).toContain("the-hud");
		expect(html).not.toContain("Map placeholder");
	});
});

describe("the HUD slot", () => {
	const slot = (view: ShellView) => {
		const html = renderToStaticMarkup(
			<MapArea
				view={view}
				onRetryWasm={() => {}}
				replayRestarted={false}
				hud={<i>the-hud</i>}
			/>,
		);
		const match = html.match(/<div data-slot="hud" class="([^"]*)"/);
		if (!match) throw new Error("no HUD slot");
		return match[1].split(" ");
	};

	test("sits below the reconnecting strip while it is shown", () => {
		// The strip is h-8 (2rem) at the top; top-11 is 2.75rem.
		expect(slot("reconnecting")).toContain("top-11");
		expect(slot("reconnecting")).not.toContain("top-3");
	});

	test("lets the pointer through to the map", () => {
		for (const view of ["live", "reconnecting"] as const) {
			expect(slot(view)).toContain("pointer-events-none");
		}
	});

	test("sits in the corner otherwise", () => {
		for (const view of [
			"live",
			"connecting",
			"disconnected",
			"wasm-loading",
			"wasm-failed",
		] as const) {
			expect(slot(view)).toContain("top-3");
			expect(slot(view)).not.toContain("top-11");
		}
	});
});

describe("the HUD's button", () => {
	const render = (hudVisible: boolean) =>
		renderToStaticMarkup(
			<TopBar
				connection="open"
				hudVisible={hudVisible}
				onToggleHud={() => {}}
			/>,
		);

	test("says whether the HUD is shown, and names the shortcut", () => {
		const shown = render(true);
		expect(shown).toContain('data-slot="hud-toggle"');
		expect(shown).toContain('aria-pressed="true"');
		expect(shown).toContain('aria-keyshortcuts="H"');
		expect(shown).toContain("Hide the performance HUD (H)");

		const hidden = render(false);
		expect(hidden).toContain('aria-pressed="false"');
		expect(hidden).toContain("Show the performance HUD (H)");
	});

	test("is left out when there is nothing to toggle", () => {
		const html = renderToStaticMarkup(<TopBar connection="open" />);
		expect(html).not.toContain("hud-toggle");
	});
});

describe("the signed-in user", () => {
	const user = {
		name: "Demo Controller",
		email: "controller@example.com",
		role: "controller",
	};

	test("is named in the top bar with the role, beside a sign-out button", () => {
		const html = renderToStaticMarkup(
			<TopBar connection="open" user={user} onSignOut={async () => {}} />,
		);
		expect(html).toContain('data-slot="user"');
		expect(html).toContain('data-role="controller"');
		expect(html).toContain("Demo Controller");
		expect(html).toContain('title="controller@example.com"');
		expect(html).toMatch(/data-slot="user-role"[^>]*>controller</);
		expect(html).toMatch(/<button type="submit" data-slot="sign-out"/);
	});

	test("a viewer is marked as one", () => {
		const html = renderToStaticMarkup(
			<TopBar connection="open" user={{ ...user, role: "viewer" }} />,
		);
		expect(html).toMatch(/data-slot="user-role"[^>]*>viewer</);
	});

	test("nothing is drawn without a user or an action", () => {
		const html = renderToStaticMarkup(<TopBar connection="open" />);
		expect(html).not.toContain('data-slot="user"');
		expect(html).not.toContain('data-slot="sign-out"');
	});

	test("the shell passes both to the top bar", () => {
		// The search and the saved views a signed-in page has ask the API.
		const html = renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<AppShell user={user} onSignOut={async () => {}} />
			</QueryClientProvider>,
		);
		expect(html).toContain('data-slot="flight-search"');
		expect(html).toContain('data-slot="user"');
		expect(html).toContain('data-slot="sign-out"');
	});
});

describe("socketUrlToOpen", () => {
	const url = "ws://localhost:8080/ws";

	test("is the address when nothing pins the connection", () => {
		expect(socketUrlToOpen(null, url)).toBe(url);
		expect(socketUrlToOpen({ replayRestarted: true }, url)).toBe(url);
		expect(socketUrlToOpen({ mapDepthTest: true }, url)).toBe(url);
	});

	test("is null under a preview that pins the connection", () => {
		for (const connection of CONNECTION_STATUSES) {
			expect(socketUrlToOpen({ connection }, url)).toBeNull();
		}
	});

	test("is null without an address", () => {
		expect(socketUrlToOpen(null, undefined)).toBeNull();
		expect(socketUrlToOpen(null, "")).toBeNull();
	});
});

describe("AppShell", () => {
	// A render to a string reads the store's starting state, whatever it
	// holds now, so the hidden HUD is checked in a browser and not here.
	test("shows the HUD in its slot, and its button pressed", () => {
		const html = renderToStaticMarkup(<AppShell />);
		expect(html).toContain('data-slot="performance-hud"');
		expect(html).toContain('data-slot="hud-toggle"');
		expect(html).toContain('aria-pressed="true"');
	});

	test("renders the top bar, the map and the three placeholder panels", () => {
		const html = renderToStaticMarkup(<AppShell />);
		for (const slot of [
			"top-bar",
			"connection-indicator",
			"map",
			"hud",
			"replay-notice",
			"side-panel",
			"flight-list",
			"flight-detail",
			"alerts",
		]) {
			expect(html).toContain(`data-slot="${slot}"`);
		}
		// Before any effect has run the module is still loading.
		expect(html).toContain('data-state="wasm-loading"');
		// The connection status is the interface store's, which starts here.
		expect(html).toContain('data-status="connecting"');
		expect(html).not.toContain("Preview states");
	});

	test("a preview pins the connection and the notice, and says so", () => {
		const html = renderToStaticMarkup(
			<AppShell preview={{ connection: "closed", replayRestarted: true }} />,
		);
		expect(html).toContain('data-status="closed"');
		expect(html).toContain("Replay restarted");
		expect(html).toContain("Preview states");
	});
});
