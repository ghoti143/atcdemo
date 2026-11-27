import { describe, expect, test } from "bun:test";
import { SessionEndedError } from "./socket-client";
import {
	fetchSocketToken,
	socketUrlWithToken,
	tokenUrlResolver,
} from "./socket-token";

const answering = (response: () => Response) => {
	const calls: [unknown, RequestInit | undefined][] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		calls.push([input, init]);
		return response();
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
};

describe("fetchSocketToken", () => {
	test("asks the token route with the cookie and no cache, and returns the token", async () => {
		const { fetchImpl, calls } = answering(() =>
			Response.json({ token: "aaa.bbb.ccc" }),
		);
		expect(await fetchSocketToken(fetchImpl)).toBe("aaa.bbb.ccc");
		expect(calls).toEqual([
			["/api/auth/token", { credentials: "same-origin", cache: "no-store" }],
		]);
	});

	test("401 is an ended session", async () => {
		const { fetchImpl } = answering(() => new Response("", { status: 401 }));
		await expect(fetchSocketToken(fetchImpl)).rejects.toBeInstanceOf(
			SessionEndedError,
		);
	});

	test("any other failure is an error that may pass, not an ended session", async () => {
		for (const response of [
			() => new Response("", { status: 500 }),
			() => new Response("", { status: 403 }),
			() => Response.json({}),
			() => Response.json({ token: "" }),
			() => Response.json({ token: 7 }),
			() => Response.json(null),
		]) {
			const { fetchImpl } = answering(response);
			const error = await fetchSocketToken(fetchImpl).catch((cause) => cause);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(SessionEndedError);
		}
		const failing = (async () => {
			throw new TypeError("network");
		}) as unknown as typeof fetch;
		const error = await fetchSocketToken(failing).catch((cause) => cause);
		expect(error).toBeInstanceOf(TypeError);
	});
});

describe("socketUrlWithToken", () => {
	test("puts the token in the query string", () => {
		expect(socketUrlWithToken("ws://localhost:8080/ws", "a.b.c")).toBe(
			"ws://localhost:8080/ws?token=a.b.c",
		);
	});

	test("keeps a query the address already has, and replaces a token in it", () => {
		expect(socketUrlWithToken("wss://atc.example/ws?x=1", "a.b.c")).toBe(
			"wss://atc.example/ws?x=1&token=a.b.c",
		);
		expect(socketUrlWithToken("ws://h/ws?token=old", "new")).toBe(
			"ws://h/ws?token=new",
		);
	});
});

describe("tokenUrlResolver", () => {
	test("fetches a token every time it is asked", async () => {
		let issued = 0;
		const { fetchImpl, calls } = answering(() =>
			Response.json({ token: `token-${++issued}` }),
		);
		const resolve = tokenUrlResolver("ws://h/ws", fetchImpl);
		expect(await resolve()).toBe("ws://h/ws?token=token-1");
		expect(await resolve()).toBe("ws://h/ws?token=token-2");
		expect(calls).toHaveLength(2);
	});
});
