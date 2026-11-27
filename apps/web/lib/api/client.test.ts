import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { makeQueryClient, shouldRetry } from "@/components/providers";
import { ApiError, apiGet, flightQuery, flightSearchQuery } from "./client";

const shape = z.object({ count: z.number() });
const answering = (response: () => Response) => {
	const calls: [unknown, RequestInit | undefined][] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		calls.push([input, init]);
		return response();
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
};
const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(error: unknown) => error as ApiError,
	);

describe("apiGet", () => {
	test("returns the body when it is what the route promises", async () => {
		const { fetchImpl, calls } = answering(() => Response.json({ count: 3 }));
		expect(await apiGet("/api/x", shape, { fetchImpl })).toEqual({ count: 3 });
		expect(calls[0][0]).toBe("/api/x");
		expect(calls[0][1]).toMatchObject({ credentials: "same-origin" });
	});

	test("an error answer rejects with its status, code, message and fields", async () => {
		const { fetchImpl } = answering(() =>
			Response.json(
				{
					error: {
						code: "invalid_request",
						message: "The request is not valid.",
						fields: { search: "is required" },
					},
				},
				{ status: 400 },
			),
		);
		const error = await failure(apiGet("/api/x", shape, { fetchImpl }));
		expect(error).toBeInstanceOf(ApiError);
		expect(error.status).toBe(400);
		expect(error.code).toBe("invalid_request");
		expect(error.message).toBe("The request is not valid.");
		expect(error.fields).toEqual({ search: "is required" });
	});

	test("an error with no body of the API's shape is still an ApiError", async () => {
		for (const response of [
			() => new Response("<html>bad gateway</html>", { status: 502 }),
			() => Response.json({ oops: true }, { status: 500 }),
			() => Response.json(null, { status: 500 }),
		]) {
			const { fetchImpl } = answering(response);
			const error = await failure(apiGet("/api/x", shape, { fetchImpl }));
			expect(error).toBeInstanceOf(ApiError);
			expect(error.code).toBe("unexpected");
			expect(error.status).toBeGreaterThanOrEqual(500);
		}
	});

	test("a 200 that is not the promised shape rejects, and is not handed on", async () => {
		const { fetchImpl } = answering(() => Response.json({ count: "three" }));
		const error = await failure(apiGet("/api/x", shape, { fetchImpl }));
		expect(error.code).toBe("unexpected");
		expect(error.status).toBe(200);
	});
});

describe("the flights queries", () => {
	test("name their routes and are keyed by what they ask for", () => {
		expect([...flightQuery(42).queryKey]).toEqual(["flights", 42]);
		// A search is keyed without regard to case, as the route matches.
		expect([...flightSearchQuery("ual").queryKey]).toEqual([
			...flightSearchQuery("UAL").queryKey,
		]);
		expect([...flightSearchQuery("ual", 5).queryKey]).not.toEqual([
			...flightSearchQuery("ual").queryKey,
		]);
	});
});

describe("the query client", () => {
	test("does not try again when the answer was no", () => {
		expect(shouldRetry(0, new ApiError(404, "not_found", "no"))).toBe(false);
		expect(shouldRetry(0, new ApiError(401, "unauthorized", "no"))).toBe(false);
		expect(shouldRetry(0, new ApiError(400, "invalid_request", "no"))).toBe(
			false,
		);
	});

	test("tries twice more when the server or the network failed", () => {
		const failed = new ApiError(503, "unexpected", "down");
		expect(shouldRetry(0, failed)).toBe(true);
		expect(shouldRetry(1, failed)).toBe(true);
		expect(shouldRetry(2, failed)).toBe(false);
		expect(shouldRetry(0, new TypeError("network"))).toBe(true);
	});

	test("a 401 from any query means the session has ended", async () => {
		let ended = 0;
		const client = makeQueryClient(() => {
			ended += 1;
		});
		const { fetchImpl } = answering(() =>
			Response.json(
				{ error: { code: "unauthorized", message: "Sign in to use this." } },
				{ status: 401 },
			),
		);
		await client
			.fetchQuery({
				queryKey: ["x"],
				queryFn: () => apiGet("/api/x", shape, { fetchImpl }),
				retry: false,
			})
			.catch(() => {});
		expect(ended).toBe(1);

		// A 404 is not that.
		const missing = answering(() =>
			Response.json(
				{ error: { code: "not_found", message: "none" } },
				{ status: 404 },
			),
		);
		await client
			.fetchQuery({
				queryKey: ["y"],
				queryFn: () =>
					apiGet("/api/y", shape, { fetchImpl: missing.fetchImpl }),
				retry: false,
			})
			.catch(() => {});
		expect(ended).toBe(1);
	});
});
