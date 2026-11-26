import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CONNECTION_STATUSES } from "@/lib/connection-status";
import { AppShell } from "./app-shell";
import { ConnectionIndicator } from "./connection-indicator";
import { MapArea } from "./map-area";
import { ReplayNotice } from "./replay-notice";
import { type ShellView, shellView } from "./shell-view";

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

describe("AppShell", () => {
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
