import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkWorkflow } from "./catalog.ts";
import { EntityType } from "./entities.ts";
import { decodeWorkflow } from "./workflow.ts";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const jsonBlocks = (markdown: string) =>
  [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].flatMap(([, body]) => {
    try {
      return [JSON.parse(body ?? "") as unknown];
    } catch {
      return [];
    }
  });

test("the DSL reference's example checks against its employee type, which the migration seeds", async () => {
  const blocks = jsonBlocks(await read("../docs/workflow-dsl.md"));
  const [example] = blocks;
  const employee = Schema.decodeUnknownSync(EntityType)(
    blocks.find((block) => typeof block === "object" && block !== null && "title" in block),
  );
  const workflow = await Effect.runPromise(
    decodeWorkflow(example).pipe(
      Effect.flatMap((decoded) => checkWorkflow({ types: [employee] }, decoded)),
    ),
  );
  expect(workflow.trigger).toMatchObject({ kind: "entity", entity: "employee" });
  expect(await read("../migrations/0002_entities.sql")).toContain(`'${JSON.stringify(employee)}'`);
});
