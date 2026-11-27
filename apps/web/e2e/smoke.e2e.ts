import { expect, test } from "@playwright/test";

// One test that the whole stack hangs together: route protection, the demo
// account the setup service made, sign-in, the socket token, atc-server
// verifying it, and frames reaching the page's WASM store and its HUD.

const password = process.env.DEMO_VIEWER_PASSWORD;

test("the demo viewer signs in and sees live aircraft", async ({ page }) => {
	test.skip(!password, "DEMO_VIEWER_PASSWORD is not set; is .env there?");

	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	const socketUrls: string[] = [];
	page.on("websocket", (socket) => socketUrls.push(socket.url()));

	// No session: the app sends the visit to sign-in.
	await page.goto("/");
	await expect(page).toHaveURL(/\/sign-in$/);
	expect(socketUrls).toEqual([]);

	// The button only works once the page's script has loaded, so it is
	// pressed until it has.
	const email = page.getByLabel("Email");
	await expect(async () => {
		await page
			.locator('[data-slot="demo-account"][data-role="viewer"]')
			.click();
		await expect(email).toHaveValue("viewer@example.com", { timeout: 1_000 });
	}).toPass();
	await page.getByLabel("Password").fill(password as string);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();

	// Signed in, on the app, as the viewer.
	await expect(page.locator('[data-slot="top-bar"]')).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
	const user = page.locator('[data-slot="user"]');
	await expect(user).toHaveAttribute("data-role", "viewer");
	await expect(user).toContainText("Demo Viewer");

	// Live: a frame has arrived, which takes a token atc-server accepted.
	await expect(
		page.locator('[data-slot="connection-indicator"]'),
	).toHaveAttribute("data-status", "open", { timeout: 30_000 });
	expect(socketUrls.length).toBeGreaterThan(0);
	expect(new URL(socketUrls[0]).searchParams.get("token")).toMatch(
		/^[\w-]+\.[\w-]+\.[\w-]+$/,
	);

	// The map is there, and the HUD counts the aircraft in the picture.
	await expect(page.locator('[data-slot="map"]')).toBeVisible();
	const aircraft = page.locator(
		'[data-slot="performance-hud"] [data-reading="aircraft"] dd',
	);
	await expect
		.poll(
			async () =>
				Number((await aircraft.first().innerText()).replaceAll(",", "")),
			{ timeout: 15_000 },
		)
		.toBeGreaterThan(0);

	// Signing out ends it: back to sign-in, and the app is closed again.
	await page.locator('[data-slot="sign-out"]').click();
	await expect(page).toHaveURL(/\/sign-in\?reason=signed-out$/);
	await page.goto("/");
	await expect(page).toHaveURL(/\/sign-in$/);

	expect(pageErrors).toEqual([]);
});
