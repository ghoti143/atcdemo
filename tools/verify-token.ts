// Verifies a socket token the way atc-server will: with only the public keys
// served by the web app, and no access to the session or the secret.
//
//   bun tools/verify-token.ts <token> [jwks-url] [issuer]
//
// Get a token from a signed-in browser at /api/auth/token.

import { createRemoteJWKSet, jwtVerify } from "jose";

const [token, jwksUrl = "http://localhost:3000/api/auth/jwks", issuerArg] =
	process.argv.slice(2);

if (!token) {
	console.error("usage: bun tools/verify-token.ts <token> [jwks-url] [issuer]");
	process.exit(2);
}

// Better Auth sets both the issuer and the audience to BETTER_AUTH_URL.
const issuer = issuerArg ?? new URL(jwksUrl).origin;

try {
	const { payload, protectedHeader } = await jwtVerify(
		token,
		createRemoteJWKSet(new URL(jwksUrl)),
		{ issuer, audience: issuer },
	);
	console.log("valid");
	console.log(`  alg   ${protectedHeader.alg}`);
	console.log(`  kid   ${protectedHeader.kid}`);
	console.log(`  sub   ${payload.sub}`);
	console.log(`  role  ${payload.role}`);
	console.log(`  exp   ${new Date((payload.exp ?? 0) * 1000).toISOString()}`);
} catch (error) {
	console.error(`invalid: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}
