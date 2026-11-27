import { describe, expect, test } from "bun:test";
import {
	checkSession,
	type SessionCheck,
	startSessionWatch,
} from "./session-watch";

describe("checkSession", () => {
	const answering = (response: () => Response | Promise<Response>) =>
		(async () => response()) as unknown as typeof fetch;

	test("a session in the answer is active", async () => {
		const fetchImpl = answering(() =>
			Response.json({ session: { id: "s" }, user: { id: "u" } }),
		);
		expect(await checkSession(fetchImpl)).toBe("active");
	});

	test("an answer of null is ended, and so is 401", async () => {
		expect(await checkSession(answering(() => Response.json(null)))).toBe(
			"ended",
		);
		expect(
			await checkSession(answering(() => new Response("", { status: 401 }))),
		).toBe("ended");
	});

	test("a failure to ask is unknown, never ended", async () => {
		expect(
			await checkSession(
				answering(() => {
					throw new TypeError("network");
				}),
			),
		).toBe("unknown");
		expect(
			await checkSession(answering(() => new Response("", { status: 500 }))),
		).toBe("unknown");
		expect(
			await checkSession(
				answering(() => new Response("<html>", { status: 200 })),
			),
		).toBe("unknown");
	});

	test("asks Better Auth's session route with the cookie and no cache", async () => {
		let seen: [unknown, RequestInit | undefined] | undefined;
		const fetchImpl = (async (input: unknown, init?: RequestInit) => {
			seen = [input, init];
			return Response.json(null);
		}) as unknown as typeof fetch;
		await checkSession(fetchImpl);
		expect(seen?.[0]).toBe("/api/auth/get-session");
		expect(seen?.[1]).toEqual({
			credentials: "same-origin",
			cache: "no-store",
		});
	});
});

describe("startSessionWatch", () => {
	function harness(results: SessionCheck[]) {
		const listeners = new Set<() => void>();
		const target = {
			visibilityState: "visible" as DocumentVisibilityState,
			addEventListener: (_type: string, listener: unknown) => {
				listeners.add(listener as () => void);
			},
			removeEventListener: (_type: string, listener: unknown) => {
				listeners.delete(listener as () => void);
			},
		};
		let tick: (() => void) | undefined;
		let cleared = false;
		let checks = 0;
		let ended = 0;
		const stop = startSessionWatch({
			onEnded: () => {
				ended++;
			},
			check: async () => {
				checks++;
				return results.shift() ?? "active";
			},
			target: target as never,
			setTimer: (callback) => {
				tick = callback;
				return 1;
			},
			clearTimer: () => {
				cleared = true;
			},
		});
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		return {
			target,
			stop,
			settle,
			tick: async () => {
				tick?.();
				await settle();
			},
			show: async () => {
				for (const listener of [...listeners]) listener();
				await settle();
			},
			get checks() {
				return checks;
			},
			get ended() {
				return ended;
			},
			get cleared() {
				return cleared;
			},
			get listening() {
				return listeners.size;
			},
		};
	}

	test("does not check until the timer fires or the page is shown", async () => {
		const watch = harness([]);
		await watch.settle();
		expect(watch.checks).toBe(0);
		await watch.tick();
		expect(watch.checks).toBe(1);
		await watch.show();
		expect(watch.checks).toBe(2);
		expect(watch.ended).toBe(0);
	});

	test("an ended session is reported once, and the watch stops", async () => {
		const watch = harness(["active", "ended", "ended"]);
		await watch.tick();
		expect(watch.ended).toBe(0);
		await watch.tick();
		expect(watch.ended).toBe(1);
		expect(watch.cleared).toBe(true);
		expect(watch.listening).toBe(0);
		await watch.tick();
		expect(watch.checks).toBe(2);
		expect(watch.ended).toBe(1);
	});

	test("an unknown answer ends nothing", async () => {
		const watch = harness(["unknown", "unknown"]);
		await watch.tick();
		await watch.tick();
		expect(watch.ended).toBe(0);
		expect(watch.cleared).toBe(false);
	});

	test("a hidden page is not checked until it is shown", async () => {
		const watch = harness(["ended"]);
		watch.target.visibilityState = "hidden";
		await watch.tick();
		expect(watch.checks).toBe(0);
		watch.target.visibilityState = "visible";
		await watch.show();
		expect(watch.checks).toBe(1);
		expect(watch.ended).toBe(1);
	});

	test("stopping it removes the timer and the listener", async () => {
		const watch = harness(["ended"]);
		watch.stop();
		expect(watch.cleared).toBe(true);
		expect(watch.listening).toBe(0);
		await watch.tick();
		expect(watch.checks).toBe(0);
	});
});
