import { z } from "zod";
import { parseControllerGithubUsers } from "./github-controllers";

// A variable set to an empty string counts as unset, so `.env` can list an
// optional variable with nothing after the equals sign.
const optional = <T extends z.ZodType>(schema: T) =>
	z.preprocess(
		(value) => (value === "" ? undefined : value),
		schema.optional(),
	);

const httpUrl = z.url({
	protocol: /^https?$/,
	error: "must be an http(s) URL",
});

const schema = z
	.object({
		DATABASE_URL: z.url({
			protocol: /^postgres(ql)?$/,
			error: "must be a postgres:// URL",
		}),
		BETTER_AUTH_SECRET: z
			.string({ error: "is required" })
			.min(32, "must be at least 32 characters"),
		BETTER_AUTH_URL: httpUrl,
		ATC_WS_URL: z.url({
			protocol: /^wss?$/,
			error: "must be a ws:// or wss:// URL",
		}),
		GITHUB_CLIENT_ID: optional(z.string()),
		GITHUB_CLIENT_SECRET: optional(z.string()),
		CONTROLLER_GITHUB_USERS: optional(z.string()).transform(
			parseControllerGithubUsers,
		),
	})
	.refine(
		(env) =>
			(env.GITHUB_CLIENT_ID === undefined) ===
			(env.GITHUB_CLIENT_SECRET === undefined),
		{
			path: ["GITHUB_CLIENT_ID"],
			error:
				"and GITHUB_CLIENT_SECRET must be set together, or both left empty",
		},
	);

export type Env = z.infer<typeof schema>;

/**
 * Validates the web app's configuration. Throws one error that names every
 * variable that is missing or malformed.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
	const result = schema.safeParse(source);
	if (result.success) {
		return result.data;
	}
	const problems = result.error.issues.map((issue) => {
		const name = issue.path.join(".");
		const missing =
			issue.code !== "custom" &&
			(source[name] === undefined || source[name] === "");
		return `  ${name} ${missing ? "is not set" : issue.message}`;
	});
	throw new Error(
		[
			"Invalid configuration:",
			...problems,
			"Copy .env.example to .env at the repo root, or set these in the environment.",
		].join("\n"),
	);
}

let cached: Env | undefined;

/** The validated configuration, read from `process.env` on first use. */
export function env(): Env {
	cached ??= parseEnv(process.env);
	return cached;
}
