/** Checks when a Worker's Init decides it runs under local development, at plan time and at runtime. */
import { afterEach, expect, test } from "bun:test";
import * as Alchemy from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { localDevelopment } from "./local-development.ts";

const decide = (env: Record<string, string>, stage?: string) => {
  const configured = Effect.provideService(
    localDevelopment,
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(env),
  );
  return Effect.runSync(
    stage === undefined
      ? (configured as Effect.Effect<boolean>)
      : Effect.provideService(configured, Alchemy.Stage, stage),
  );
};

afterEach(() => {
  globalThis.__ALCHEMY_RUNTIME__ = undefined;
});

test("at plan time, only alchemy dev on a dev_ stage is local development", () => {
  expect(decide({ ALCHEMY_DEV: "true" }, "dev_ada")).toBe(true);
  expect(decide({}, "dev_ada")).toBe(false);
  expect(decide({ ALCHEMY_DEV: "false" }, "dev_ada")).toBe(false);
  // `alchemy dev --stage prod`, or ALCHEMY_DEV left in the shell for a deploy.
  expect(decide({ ALCHEMY_DEV: "true" }, "prod")).toBe(false);
  expect(decide({ ALCHEMY_DEV: "true" }, "live_ada")).toBe(false);
});

test("at runtime, where the stage is unknown, only an ALCHEMY_DEV binding makes it local", () => {
  globalThis.__ALCHEMY_RUNTIME__ = true;
  expect(decide({ ALCHEMY_DEV: "true" })).toBe(true);
  // A deployed Worker: plan time bound nothing.
  expect(decide({})).toBe(false);
});
