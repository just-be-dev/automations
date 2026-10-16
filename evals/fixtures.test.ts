/** The evals call models; this checks, without them, that what they start from holds up. */

import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { templateProblems } from "../src/entities/templates.ts";
import { checkWorkflow } from "../src/workflow/catalog.ts";
import { catalog } from "./fixtures.ts";
import { datasetPath, readDataset } from "./framework/eval.ts";
import planner from "./planner.eval.ts";

test("templates fit the entity types", () => {
  expect(
    catalog.templates.flatMap((template) => templateProblems(catalog.types, template)),
  ).toEqual([]);
});

test("the drafts the planner edits check against its catalog", async () => {
  const dataset = await Effect.runPromise(
    readDataset(datasetPath("planner")).pipe(Effect.flatMap((raw) => planner.decode(raw))),
  );
  const drafts = Object.entries(dataset.cases).flatMap(([name, { input }]) =>
    input.draft === undefined
      ? []
      : [{ name, draft: input.draft, store: { ...catalog, ...input.catalog } }],
  );
  expect(drafts.length).toBeGreaterThan(0);
  for (const { draft, store } of drafts) {
    Effect.runSync(checkWorkflow(store, draft));
  }
});
