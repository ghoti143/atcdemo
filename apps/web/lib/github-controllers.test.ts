import { expect, test } from "bun:test";
import {
	parseControllerGithubUsers,
	roleForGithubUser,
} from "./github-controllers";

test("the list is split on commas, trimmed and lower-cased", () => {
	expect(parseControllerGithubUsers(" Octocat, hubot ,,Mona-Lisa ")).toEqual([
		"octocat",
		"hubot",
		"mona-lisa",
	]);
});

test("an empty or missing list names nobody", () => {
	expect(parseControllerGithubUsers(undefined)).toEqual([]);
	expect(parseControllerGithubUsers("")).toEqual([]);
	expect(parseControllerGithubUsers(" , ")).toEqual([]);
});

test("a listed user is a controller whatever the case of the username", () => {
	const controllers = parseControllerGithubUsers("Octocat");
	expect(roleForGithubUser("octocat", controllers)).toBe("controller");
	expect(roleForGithubUser("OCTOCAT", controllers)).toBe("controller");
});

test("anyone else is a viewer, including a name that only contains a listed one", () => {
	const controllers = parseControllerGithubUsers("octocat");
	expect(roleForGithubUser("hubot", controllers)).toBe("viewer");
	expect(roleForGithubUser("octocat2", controllers)).toBe("viewer");
	expect(roleForGithubUser("octo", controllers)).toBe("viewer");
	expect(roleForGithubUser("octocat", [])).toBe("viewer");
});
