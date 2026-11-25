import { describe, expect, test } from "bun:test";
import { parseEnv } from "./env";

const valid = {
	DATABASE_URL: "postgres://atc:atc@localhost:5432/atc",
	BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
	BETTER_AUTH_URL: "http://localhost:3000",
	ATC_WS_URL: "ws://localhost:8080/ws",
};

describe("parseEnv", () => {
	test("accepts the required variables alone", () => {
		const env = parseEnv(valid);

		expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
		expect(env.GITHUB_CLIENT_ID).toBeUndefined();
		expect(env.CONTROLLER_GITHUB_USERS).toEqual([]);
	});

	test("names a missing variable", () => {
		const { DATABASE_URL: _, ...rest } = valid;

		expect(() => parseEnv(rest)).toThrow("DATABASE_URL is not set");
	});

	test("names every problem at once", () => {
		expect(() => parseEnv({})).toThrow(
			/DATABASE_URL is not set[\s\S]*BETTER_AUTH_SECRET is not set[\s\S]*BETTER_AUTH_URL is not set[\s\S]*ATC_WS_URL is not set/,
		);
	});

	test("treats an empty string as unset", () => {
		expect(() => parseEnv({ ...valid, ATC_WS_URL: "" })).toThrow(
			"ATC_WS_URL is not set",
		);
		expect(
			parseEnv({ ...valid, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" })
				.GITHUB_CLIENT_ID,
		).toBeUndefined();
	});

	test("rejects a malformed value and says why", () => {
		expect(() => parseEnv({ ...valid, ATC_WS_URL: "http://x" })).toThrow(
			"ATC_WS_URL must be a ws:// or wss:// URL",
		);
		expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(
			"BETTER_AUTH_SECRET must be at least 32 characters",
		);
	});

	test("requires the GitHub id and secret together", () => {
		expect(() => parseEnv({ ...valid, GITHUB_CLIENT_ID: "id" })).toThrow(
			"GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together",
		);
		expect(() =>
			parseEnv({ ...valid, GITHUB_CLIENT_SECRET: "secret" }),
		).toThrow("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together");
		expect(
			parseEnv({
				...valid,
				GITHUB_CLIENT_ID: "id",
				GITHUB_CLIENT_SECRET: "secret",
			}).GITHUB_CLIENT_SECRET,
		).toBe("secret");
	});

	test("splits and normalises the controller list", () => {
		const env = parseEnv({
			...valid,
			CONTROLLER_GITHUB_USERS: " Alice, bob ,,",
		});

		expect(env.CONTROLLER_GITHUB_USERS).toEqual(["alice", "bob"]);
	});
});
