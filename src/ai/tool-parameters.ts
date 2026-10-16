/** The JSON Schema a model sees for a tool's arguments. */

import * as Schema from "effect/Schema";

type JsonObject = Schema.JsonObject;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const objectMembers = (schema: JsonObject) => {
  const members = schema["anyOf"] ?? schema["oneOf"];
  return Array.isArray(members) &&
    members.length > 0 &&
    members.every((member) => isObject(member) && isObject(member["properties"]))
    ? (members as ReadonlyArray<JsonObject & { readonly properties: JsonObject }>)
    : undefined;
};

/** The single value a property allows, such as `kind`'s in one shape of a union. */
const constant = (schema: unknown) =>
  isObject(schema) && Array.isArray(schema["enum"]) && schema["enum"].length === 1
    ? schema["enum"][0]
    : undefined;

const isStringEnum = (schema: JsonObject) =>
  schema["type"] === "string" && Array.isArray(schema["enum"]) && Object.keys(schema).length === 2;

/** One schema for a property the shapes describe differently: their string values, or any of them. */
const merged = (variants: ReadonlyArray<JsonObject>): JsonObject => {
  if (variants.length === 1) {
    return variants[0] ?? {};
  }
  if (variants.every(isStringEnum)) {
    return {
      type: "string",
      enum: variants.flatMap((variant) => variant["enum"] as Array<string>),
    };
  }
  return { anyOf: [...variants] };
};

/** `kind "putTemplate": template`: the shape's constant, and what else it requires. */
const shapeOf = (member: JsonObject & { readonly properties: JsonObject }) => {
  const tags = Object.entries(member.properties).flatMap(([name, schema]) => {
    const value = constant(schema);
    return value === undefined ? [] : [`${name} ${JSON.stringify(value)}`];
  });
  const required = Array.isArray(member["required"]) ? (member["required"] as Array<string>) : [];
  const fields = required.filter((name) => constant(member.properties[name]) === undefined);
  return `${tags.join(", ") || "a shape"}: ${fields.join(", ") || "nothing else"}`;
};

/**
 * The JSON Schema of a tool's arguments, as the model sees it. Models on Workers AI only see
 * arguments described as one object with `properties`: a bare `anyOf`, such as one shape per kind
 * of change, reaches them as nothing, and they guess. So a union of object shapes becomes one
 * object with every shape's properties, and a description of which shape needs which. The tool
 * still decodes its arguments with the union, so a wrong combination fails there, with a reason.
 */
export const toolParameters = (schema: Schema.Top): JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema);
  // A shape that refers to a definition needs the definitions with it.
  const definitions: JsonObject =
    Object.keys(document.definitions).length === 0
      ? {}
      : { $defs: document.definitions as JsonObject };
  const root = document.schema as JsonObject;
  const members = objectMembers(root);
  if (members === undefined) {
    return { ...root, ...definitions };
  }
  const variants = new Map<string, Array<JsonObject>>();
  for (const member of members) {
    for (const [name, property] of Object.entries(member.properties)) {
      const seen = variants.get(name) ?? [];
      if (
        isObject(property) &&
        !seen.some((other) => JSON.stringify(other) === JSON.stringify(property))
      ) {
        variants.set(name, [...seen, property]);
      }
    }
  }
  const required = [...variants.keys()].filter((name) =>
    members.every(
      (member) => Array.isArray(member["required"]) && member["required"].includes(name),
    ),
  );
  return {
    type: "object",
    description: `One of these shapes, each with the fields it needs: ${members.map(shapeOf).join("; ")}.`,
    properties: Object.fromEntries([...variants].map(([name, schemas]) => [name, merged(schemas)])),
    required,
    ...definitions,
  };
};
