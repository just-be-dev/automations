/** Checks the argument schemas models see, for a union of shapes in particular. */

import { expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { ChangeAction } from "../changes/model.ts";
import { toolParameters } from "./tool-parameters.ts";

test("an object's schema reaches the model as it is", () => {
  const Read = Schema.Struct({ kind: Schema.Literals(["catalog", "entity"]), id: Schema.String });
  expect(toolParameters(Read)).toEqual(Schema.toJsonSchemaDocument(Read).schema as never);
});

// Workers AI models saw a bare anyOf as no arguments at all, and guessed every kind.
test("a union of shapes becomes one object listing each shape's fields", () => {
  const parameters = toolParameters(ChangeAction);
  expect(parameters).toMatchObject({
    type: "object",
    required: ["kind"],
    properties: {
      kind: {
        type: "string",
        enum: [
          "putEntity",
          "deleteEntity",
          "putType",
          "deleteType",
          "putTemplate",
          "deleteTemplate",
        ],
      },
      template: { type: "object", required: ["name", "label", "description", "slots", "content"] },
      // An entity's type is its name; a type change carries the whole type.
      type: { anyOf: [{ type: "string" }, { type: "object" }] },
    },
  });
  expect(parameters["anyOf"]).toBeUndefined();
  expect(parameters["description"]).toContain('kind "putTemplate": template');
  expect(parameters["description"]).toContain('kind "putEntity": type, id, data');
});
