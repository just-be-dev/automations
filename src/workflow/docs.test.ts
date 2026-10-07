/** Keeps the documented DSL examples valid against their entity types, roles, and migration-seeded templates. */
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkWorkflow } from "./catalog.ts";
import { EntityType, Role } from "../entities/model.ts";
import { checkTemplate, Template } from "../entities/templates.ts";
import { decodeWorkflow } from "./model.ts";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

const jsonBlocks = (markdown: string) =>
  [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].flatMap(([, body]) => {
    try {
      return [JSON.parse(body ?? "") as unknown];
    } catch {
      return [];
    }
  });

const hasKey = (key: string) => (block: unknown) =>
  typeof block === "object" && block !== null && key in block;

const documented = async () => {
  const blocks = jsonBlocks(await read("../../docs/workflow-dsl.md"));
  const employee = Schema.decodeUnknownSync(EntityType)(blocks.find(hasKey("title")));
  const role = Schema.decodeUnknownSync(Role)(blocks.find(hasKey("members")));
  return { blocks, employee, role };
};

/** The templates a migration seeds, read back from its SQL string literals. */
const seededTemplates = (sql: string) =>
  [...sql.matchAll(/'(\{.*?\})', 0\)/g)].map(([, literal]) =>
    Schema.decodeUnknownSync(Template)(JSON.parse((literal ?? "").replaceAll("''", "'"))),
  );

test("the DSL reference's example checks against its employee type and role, which the migrations seed", async () => {
  const { blocks, employee, role } = await documented();
  const workflow = await Effect.runPromise(
    decodeWorkflow(blocks[0]).pipe(
      Effect.flatMap((decoded) =>
        checkWorkflow({ types: [employee], templates: [], roles: [role] }, decoded),
      ),
    ),
  );
  expect(workflow.trigger).toMatchObject({ kind: "entity", entity: "employee" });
  expect(await read("../../migrations/0002_entities.sql")).toContain(
    `'${JSON.stringify(employee)}'`,
  );
  expect(await read("../../migrations/0004_roles.sql")).toContain(`'${JSON.stringify(role)}'`);
});

test("the documented template is seeded, and the match example checks against the seeds", async () => {
  const { blocks, employee } = await documented();
  const templates = seededTemplates(await read("../../migrations/0003_templates.sql"));
  for (const template of templates) {
    await Effect.runPromise(checkTemplate([employee], template));
  }
  const template = Schema.decodeUnknownSync(Template)(blocks.find(hasKey("slots")));
  expect(templates).toContainEqual(template);
  const workflow = await Effect.runPromise(
    decodeWorkflow({
      name: "Welcome",
      trigger: { kind: "entity", entity: "employee" },
      steps: [blocks.find(hasKey("match"))],
      permissions: { "email.send": "auto" },
    }).pipe(
      Effect.flatMap((decoded) =>
        checkWorkflow({ types: [employee], templates, roles: [] }, decoded),
      ),
    ),
  );
  expect(workflow.steps[0]).toMatchObject({ kind: "action", use: "email.send" });
});

test("the README's first-week workflow checks against the seeded catalog", async () => {
  const { employee, role } = await documented();
  const templates = seededTemplates(await read("../../migrations/0003_templates.sql"));
  const workflow = await Effect.runPromise(
    decodeWorkflow(JSON.parse(await read("../../docs/examples/first-week.json"))).pipe(
      Effect.flatMap((decoded) =>
        checkWorkflow({ types: [employee], templates, roles: [role] }, decoded),
      ),
    ),
  );
  expect(workflow.permissions?.["email.send"]).toEqual({ ask: "people_ops" });
});

test("the documented timed triggers decode and check against the employee type", async () => {
  const { blocks, employee } = await documented();
  const isKind = (kind: string) => (block: unknown) =>
    typeof block === "object" && block !== null && "kind" in block && block.kind === kind;
  const schedules = blocks.filter((block) => isKind("schedule")(block) || isKind("date")(block));
  expect(schedules).toHaveLength(3);
  for (const trigger of schedules) {
    await Effect.runPromise(
      decodeWorkflow({
        name: "Scheduled",
        trigger,
        steps: [{ id: "a", title: "A", kind: "agent", instruction: "Do it" }],
      }).pipe(
        Effect.flatMap((decoded) =>
          checkWorkflow({ types: [employee], templates: [], roles: [] }, decoded),
        ),
      ),
    );
  }
});
