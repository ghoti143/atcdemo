import { env } from "./env";

/**
 * Stops the process with a readable message if the configuration is invalid,
 * so a missing variable fails at startup and not on the first request that
 * happens to need it.
 */
export function checkEnv(): void {
	try {
		env();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
