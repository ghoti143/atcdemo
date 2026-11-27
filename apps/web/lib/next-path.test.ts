import { describe, expect, test } from "bun:test";
import { routeDecision, safeNextPath, signInPath } from "./next-path";

describe("safeNextPath", () => {
	test("keeps a path on this app, with its query", () => {
		expect(safeNextPath("/")).toBe("/");
		expect(safeNextPath("/?aircraft=hidden")).toBe("/?aircraft=hidden");
		expect(safeNextPath("/views/3?x=1&y=2")).toBe("/views/3?x=1&y=2");
	});

	test("anything that could leave the origin gives the front page", () => {
		for (const next of [
			"https://evil.example/",
			"//evil.example/",
			"/\\evil.example/",
			"/\\/evil.example",
			"\\\\evil.example",
			"/\t/evil.example",
			"/\n/evil.example",
			"javascript:alert(1)",
			"evil.example",
			"",
			" /",
		]) {
			expect(safeNextPath(next)).toBe("/");
		}
	});

	test("a missing or repeated value gives the front page", () => {
		expect(safeNextPath(undefined)).toBe("/");
		expect(safeNextPath(["/a", "/b"])).toBe("/");
	});

	test("never returns to the sign-in page or to the API", () => {
		for (const next of [
			"/sign-in",
			"/sign-in?next=/sign-in",
			"/sign-in/",
			"/api",
			"/api/auth/sign-out",
			"/x/../api/auth/token",
		]) {
			expect(safeNextPath(next)).toBe("/");
		}
		// Only those two: a page that merely starts the same way is kept.
		expect(safeNextPath("/sign-in-help")).toBe("/sign-in-help");
		expect(safeNextPath("/apiary")).toBe("/apiary");
	});

	test("drops a fragment", () => {
		expect(safeNextPath("/a?b=1#c")).toBe("/a?b=1");
	});
});

describe("signInPath", () => {
	test("is bare for the front page", () => {
		expect(signInPath("/")).toBe("/sign-in");
	});

	test("carries where to return to, encoded", () => {
		expect(signInPath("/?aircraft=hidden")).toBe(
			"/sign-in?next=%2F%3Faircraft%3Dhidden",
		);
	});

	test("carries the reason", () => {
		expect(signInPath("/", "expired")).toBe("/sign-in?reason=expired");
		expect(signInPath("/a", "signed-out")).toBe(
			"/sign-in?next=%2Fa&reason=signed-out",
		);
	});

	test("does not carry an unsafe target", () => {
		expect(signInPath("//evil.example")).toBe("/sign-in");
	});
});

describe("routeDecision", () => {
	test("a visit without a session goes to sign-in, remembering the page", () => {
		expect(
			routeDecision({ pathname: "/", search: "", signedIn: false }),
		).toEqual({ redirect: "/sign-in" });
		expect(
			routeDecision({
				pathname: "/",
				search: "?aircraft=hidden",
				signedIn: false,
			}),
		).toEqual({ redirect: "/sign-in?next=%2F%3Faircraft%3Dhidden" });
		expect(
			routeDecision({
				pathname: "/anything/else",
				search: "",
				signedIn: false,
			}),
		).toEqual({ redirect: "/sign-in?next=%2Fanything%2Felse" });
	});

	test("the sign-in page itself is let through without a session", () => {
		expect(
			routeDecision({ pathname: "/sign-in", search: "", signedIn: false }),
		).toBeNull();
		expect(
			routeDecision({
				pathname: "/sign-in",
				search: "?next=%2Fa&reason=expired",
				signedIn: false,
			}),
		).toBeNull();
	});

	test("a signed-in visit is let through", () => {
		expect(
			routeDecision({ pathname: "/", search: "?a=1", signedIn: true }),
		).toBeNull();
	});

	test("a signed-in visit to sign-in goes on to the app", () => {
		expect(
			routeDecision({ pathname: "/sign-in", search: "", signedIn: true }),
		).toEqual({ redirect: "/" });
		expect(
			routeDecision({
				pathname: "/sign-in",
				search: "?next=%2F%3Faircraft%3Dhidden",
				signedIn: true,
			}),
		).toEqual({ redirect: "/?aircraft=hidden" });
		expect(
			routeDecision({
				pathname: "/sign-in",
				search: "?next=https%3A%2F%2Fevil.example",
				signedIn: true,
			}),
		).toEqual({ redirect: "/" });
	});
});
