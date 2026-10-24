/** Checks which hub stage the studio trusts and what it names for each of its stages. */
import { expect, test } from "bun:test";
import { hubAudience, hubFramePrefix, trustedHubStage } from "./hub-frame.ts";

test("every stage, previews included, trusts hub prod", () => {
  expect(trustedHubStage("prod")).toBe("prod");
  expect(trustedHubStage("b-preview-123456")).toBe("prod");
});

test("identity tokens are scoped to this stage under the hub's registry id", () => {
  expect(hubAudience("prod")).toBe("automations@prod");
  expect(hubAudience("b-preview-123456")).toBe("automations@b-preview-123456");
});

test("each stage lives at its own path on the hub", () => {
  expect(hubFramePrefix("prod")).toBe("/automations");
  expect(hubFramePrefix("b-preview-123456")).toBe("/automations@b-preview-123456");
});
