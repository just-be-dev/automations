import { expect, test } from "bun:test";
import { page } from "./page.ts";

test("served inline script is valid JavaScript and keeps message line breaks escaped", () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing inline script");
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain("'\\n\\nYou: '");
});
