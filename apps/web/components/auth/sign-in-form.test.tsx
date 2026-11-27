import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignInForm } from "./sign-in-form";

// Rendered to a string, as the server would: the actions are never called.
const demoAccounts = [
	{
		role: "viewer",
		email: "viewer@example.com",
		passwordVariable: "DEMO_VIEWER_PASSWORD",
	},
	{
		role: "controller",
		email: "controller@example.com",
		passwordVariable: "DEMO_CONTROLLER_PASSWORD",
	},
];

function render(props: Partial<Parameters<typeof SignInForm>[0]> = {}) {
	return renderToStaticMarkup(
		<SignInForm
			next="/"
			demoAccounts={demoAccounts}
			githubEnabled={false}
			passwordAction={async (state) => state}
			githubAction={async () => {}}
			{...props}
		/>,
	);
}

describe("SignInForm", () => {
	test("has the email and password fields and a button for each demo account", () => {
		const html = render();
		expect(html).toContain('name="email"');
		expect(html).toContain('type="password"');
		expect(html).toContain('autoComplete="current-password"');
		expect(html).toContain('data-role="viewer"');
		expect(html).toContain('data-role="controller"');
	});

	test("never contains a password", () => {
		const html = render();
		expect(html).not.toContain("viewer-demo");
		expect(html).not.toContain("controller-demo");
	});

	test("offers GitHub only when it is configured", () => {
		expect(render()).not.toContain("GitHub");
		const html = render({ githubEnabled: true });
		expect(html).toContain('data-slot="github-sign-in"');
		expect(html).toContain("Sign in with GitHub");
	});

	test("carries where to return to in both forms", () => {
		const html = render({ next: "/?aircraft=hidden", githubEnabled: true });
		const fields = html.match(/name="next" value="\/\?aircraft=hidden"/g);
		expect(fields).toHaveLength(2);
	});

	test("shows a notice, and an error in its place", () => {
		const noticed = render({ notice: "Your session has ended." });
		expect(noticed).toContain('data-slot="sign-in-notice"');
		expect(noticed).toContain("Your session has ended.");

		const failed = render({
			notice: "Your session has ended.",
			error: "The GitHub sign-in did not complete.",
		});
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("The GitHub sign-in did not complete.");
		expect(failed).not.toContain('data-slot="sign-in-notice"');
	});
});
