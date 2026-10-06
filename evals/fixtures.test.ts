/** The evals call models; this checks, without them, that what they start from holds up. */

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { templateProblems } from "../src/entities/templates.ts";
import { checkWorkflow } from "../src/workflow/catalog.ts";
import { Workflow } from "../src/workflow/model.ts";
import { loadEvals } from "./framework/eval.ts";
import { catalog, headsUpDraft, welcomeDraft } from "./fixtures.ts";

test("templates fit the entity types", () => {
  expect(
    catalog.templates.flatMap((template) => templateProblems(catalog.types, template)),
  ).toEqual([]);
});

test("the drafts the planner edits check against the catalog", () => {
  for (const draft of [welcomeDraft, headsUpDraft]) {
    Effect.runSync(checkWorkflow(catalog, Schema.decodeSync(Workflow)(draft)));
  }
});

test("every eval loads and has cases", async () => {
  const evals = await Effect.runPromise(loadEvals);
  expect(evals.map((each) => each.name)).toEqual([
    "agent",
    "decide",
    "namer",
    "planner",
    "progress",
  ]);
  for (const each of evals) {
    expect(each.eval.caseNames.length).toBeGreaterThan(0);
  }
});
