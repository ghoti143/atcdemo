// How every API route answers and reads its input, so that they all do it
// the same way (docs/DESIGN.md section 7).
//
// A route handler is written as:
//
//   export async function GET(request: Request) {
//     const user = await requireUser(request);
//     if (user instanceof Response) return user;         // 401
//     const query = readQuery(request, querySchema);
//     if (query instanceof Response) return query;       // 400
//     return json({ ... });
//   }
//
// Errors are JSON too, always this shape, so the browser's fetch wrapper
// reads one thing: { error: { code, message, fields? } }.

import type { z } from "zod";
import { auth, type Role } from "@/lib/auth";

export type ApiErrorCode =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "invalid_request";

export type ApiErrorBody = {
	error: {
		code: ApiErrorCode;
		message: string;
		/** For `invalid_request`: what is wrong with each input, by name. */
		fields?: Record<string, string>;
	};
};

/** A JSON answer that no cache may keep: every route is per-user or live. */
export function json(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

export function problem(
	status: number,
	code: ApiErrorCode,
	message: string,
	fields?: Record<string, string>,
): Response {
	const body: ApiErrorBody = { error: { code, message, fields } };
	return json(body, status);
}

/** The signed-in user, as a route sees it. */
export type ApiUser = { id: string; role: Role };

/**
 * The user behind the request's session cookie, checked against the
 * database, or the 401 to answer with. Every route calls this first:
 * proxy.ts does not cover `/api`, and a route answers 401, not a redirect.
 */
export async function requireUser(
	request: Request,
): Promise<ApiUser | Response> {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return problem(401, "unauthorized", "Sign in to use this.");
	}
	return {
		id: session.user.id,
		role: session.user.role === "controller" ? "controller" : "viewer",
	};
}

function invalid(error: z.ZodError): Response {
	const fields: Record<string, string> = {};
	for (const issue of error.issues) {
		const name = issue.path.join(".") || "request";
		fields[name] ??= issue.message;
	}
	return problem(400, "invalid_request", "The request is not valid.", fields);
}

/**
 * The request's query string, checked against `schema`, or the 400 to
 * answer with. A parameter given twice is read once, the first time.
 */
export function readQuery<T extends z.ZodType>(
	request: Request,
	schema: T,
): z.infer<T> | Response {
	const { searchParams } = new URL(request.url);
	const values: Record<string, string> = {};
	for (const [name, value] of searchParams) {
		values[name] ??= value;
	}
	const result = schema.safeParse(values);
	return result.success ? result.data : invalid(result.error);
}

/** Route parameters, checked against `schema`, or the 400 to answer with. */
export function readParams<T extends z.ZodType>(
	params: Record<string, string | string[] | undefined>,
	schema: T,
): z.infer<T> | Response {
	const result = schema.safeParse(params);
	return result.success ? result.data : invalid(result.error);
}

/** A request's JSON body, checked against `schema`, or the 400. */
export async function readBody<T extends z.ZodType>(
	request: Request,
	schema: T,
): Promise<z.infer<T> | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return problem(400, "invalid_request", "The body is not JSON.");
	}
	const result = schema.safeParse(body);
	return result.success ? result.data : invalid(result.error);
}
