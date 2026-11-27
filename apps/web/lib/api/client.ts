// The browser's side of the API: one fetch wrapper that every query uses,
// and the queries themselves. See lib/api/respond.ts for what a route
// answers with.

import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import {
	type FlightDetail,
	type FlightSearch,
	flightDetailSchema,
	flightSearchSchema,
} from "@/lib/api/flights-shapes";
import type { ApiErrorBody, ApiErrorCode } from "@/lib/api/respond";

/** A route answered with an error, or with something that is not its shape. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode | "unexpected",
		message: string,
		readonly fields?: Record<string, string>,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/**
 * Fetches a route and checks the answer against `schema`. Rejects with an
 * `ApiError` for an error answer, and for a body that is not what the
 * route promises, so a caller never holds data of the wrong shape.
 */
export async function apiGet<T extends z.ZodType>(
	path: string,
	schema: T,
	options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<z.infer<T>> {
	const response = await (options.fetchImpl ?? fetch)(path, {
		credentials: "same-origin",
		headers: { accept: "application/json" },
		signal: options.signal,
	});
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new ApiError(
			response.status,
			"unexpected",
			`${path} did not answer with JSON.`,
		);
	}
	if (!response.ok) {
		const error = (body as Partial<ApiErrorBody> | null)?.error;
		throw new ApiError(
			response.status,
			error?.code ?? "unexpected",
			error?.message ?? `${path} answered ${response.status}.`,
			error?.fields,
		);
	}
	const result = schema.safeParse(body);
	if (!result.success) {
		throw new ApiError(
			response.status,
			"unexpected",
			`${path} answered with something else than it promises.`,
		);
	}
	return result.data;
}

/** One flight and its recorded track. */
export function flightQuery(id: number) {
	return queryOptions<FlightDetail, ApiError>({
		queryKey: ["flights", id],
		queryFn: ({ signal }) =>
			apiGet(`/api/flights/${id}`, flightDetailSchema, { signal }),
	});
}

/** Flights whose callsign starts with `search`. */
export function flightSearchQuery(search: string, limit?: number) {
	const params = new URLSearchParams({ search });
	if (limit !== undefined) params.set("limit", String(limit));
	return queryOptions<FlightSearch, ApiError>({
		queryKey: ["flights", "search", search.toUpperCase(), limit ?? null],
		queryFn: ({ signal }) =>
			apiGet(`/api/flights?${params}`, flightSearchSchema, { signal }),
	});
}
