import { expect, test } from "bun:test";

test("deliberately fails, to prove CI catches it", () => {
	expect(1).toBe(2);
});
