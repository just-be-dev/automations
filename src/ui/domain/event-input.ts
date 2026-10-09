/** A visual JSON value tree with stable field identities and suggestions from saved workflows. */
import * as Array from "effect/Array";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import {
  conditionRefs,
  workflowRefs,
  type Condition,
  type Trigger,
  type Workflow,
} from "../../workflow.ts";
import type { EntityType } from "../../entities.ts";

export const Kind = Schema.Literals(["object", "array", "text", "number", "boolean", "null"]);
export type Kind = typeof Kind.Type;
export type Node = {
  readonly id: number;
  readonly name: string;
  readonly kind: Kind;
  readonly value: string;
  readonly children: ReadonlyArray<Node>;
};
export const Node: Schema.Codec<Node> = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  kind: Kind,
  value: Schema.String,
  children: Schema.Array(Schema.suspend(() => Node)),
});
export const Model = Schema.Struct({ root: Node, nextId: Schema.Int, revision: Schema.Int });
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  UpdatedValue: { id: Schema.Int, value: Schema.String },
  UpdatedName: { id: Schema.Int, name: Schema.String },
  SelectedKind: { id: Schema.Int, kind: Kind },
  ClickedAdd: { id: Schema.Int },
  ClickedRemove: { id: Schema.Int },
});
export type Message = typeof Message.Type;

const blank = (id: number, name: string, kind: Kind): Node => ({
  id,
  name,
  kind,
  value: "",
  children: [],
});
const modifyNode = (node: Node, id: number, f: (node: Node) => Node): Node =>
  node.id === id
    ? f(node)
    : modifyFields(node, {
        children: (children) => children.map((child) => modifyNode(child, id, f)),
      });

export const update = (model: Model, message: Message): Model => {
  const root = Message.match(message, {
    UpdatedValue: ({ id, value }) =>
      modifyNode(model.root, id, (node) => modifyFields(node, { value: () => value })),
    UpdatedName: ({ id, name }) =>
      modifyNode(model.root, id, (node) => modifyFields(node, { name: () => name })),
    SelectedKind: ({ id, kind }) =>
      modifyNode(model.root, id, (node) =>
        node.kind === kind ? node : blank(node.id, node.name, kind),
      ),
    ClickedAdd: ({ id }) =>
      modifyNode(model.root, id, (node) =>
        node.kind === "object" || node.kind === "array"
          ? modifyFields(node, {
              children: (children) => [...children, blank(model.nextId, "", "text")],
            })
          : node,
      ),
    ClickedRemove: ({ id }) => {
      const remove = (node: Node): Node =>
        modifyFields(node, {
          children: (children) => children.filter((child) => child.id !== id).map(remove),
        });
      return remove(model.root);
    },
  });
  return modifyFields(model, {
    root: () => root,
    nextId: (next) => (message._tag === "ClickedAdd" ? next + 1 : next),
    revision: (revision) => revision + 1,
  });
};

const terms = (condition: Condition): ReadonlyArray<Extract<Condition, { ref: string }>> =>
  "all" in condition
    ? condition.all.flatMap(terms)
    : "any" in condition
      ? condition.any.flatMap(terms)
      : "not" in condition
        ? terms(condition.not)
        : [condition];
const valueKind = (value: Schema.Json): Kind =>
  value === null
    ? "null"
    : typeof value === "string"
      ? "text"
      : typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : Array.isArray(value)
            ? "array"
            : "object";

const addPath = (model: Model, segments: ReadonlyArray<string>, kind: Kind): Model => {
  const insert = (
    node: Node,
    path: ReadonlyArray<string>,
    nextId: number,
  ): readonly [Node, number] => {
    if (Array.isReadonlyArrayEmpty(path)) {
      return [modifyFields(node, { kind: () => kind }), nextId];
    }
    const name = path[0] ?? "";
    const existing = node.children.find((child) => child.name === name);
    const child =
      existing ??
      blank(
        nextId,
        name,
        path.length > 1 ? (/^\d+$/.test(path[1] ?? "") ? "array" : "object") : kind,
      );
    const [inserted, next] = insert(
      child,
      path.slice(1),
      existing === undefined ? nextId + 1 : nextId,
    );
    return [
      modifyFields(node, {
        kind: () => "object",
        children: (children) =>
          existing === undefined
            ? [...children, inserted]
            : children.map((current) => (current.id === existing.id ? inserted : current)),
      }),
      next,
    ];
  };
  const [root, nextId] = insert(model.root, segments, model.nextId);
  return modifyFields(model, { root: () => root, nextId: () => nextId });
};

/** References suggest fields, not a complete schema. Conditions suggest types, never input values. */
export const initial = (
  trigger: Trigger,
  workflow?: Workflow,
  types: ReadonlyArray<EntityType> = [],
): Model => {
  const when = trigger.kind === "event" ? trigger.when : undefined;
  const tests = when === undefined ? [] : terms(when);
  const refs = workflow === undefined ? conditionRefs(when ?? { all: [] }) : workflowRefs(workflow);
  const paths = refs.filter((ref) => ref === "event.data" || ref.startsWith("event.data."));
  const rootTest = tests.find((term) => term.ref === "event.data" && term.op !== "exists");
  const rootKind =
    rootTest !== undefined && "value" in rootTest
      ? valueKind(rootTest.value)
      : paths.some((ref) => /^event\.data\.\d+(\.|$)/.test(ref))
        ? "array"
        : "object";
  const model: Model = { root: blank(0, "", rootKind), nextId: 1, revision: 0 };
  const suggested = paths
    .filter((ref) => ref.startsWith("event.data."))
    .sort((a, b) => a.split(".").length - b.split(".").length)
    .reduce((current, ref) => {
      const segments = ref.slice("event.data.".length).split(".");
      const index = segments.findIndex((segment) => /^\d+$/.test(segment));
      if (index >= 0) {
        return index === 0 ? current : addPath(current, segments.slice(0, index), "array");
      }
      const test = tests.find((term) => term.ref === ref && term.op !== "exists");
      return addPath(
        current,
        segments,
        test !== undefined && "value" in test && test.op !== "notEquals"
          ? valueKind(test.value)
          : "text",
      );
    }, model);
  if (
    trigger.kind !== "event" ||
    !["entity.created", "entity.updated", "entity.deleted"].includes(trigger.event)
  ) {
    return suggested;
  }
  const snapshots = ["before", "after"];
  const entityType = types.find((type) => type.name === trigger.subject);
  return snapshots.reduce((current, name) => {
    const isAbsent =
      (name === "before" && trigger.event === "entity.created") ||
      (name === "after" && trigger.event === "entity.deleted");
    const snapshot = addPath(current, [name], isAbsent ? "null" : "object");
    return isAbsent || entityType === undefined
      ? snapshot
      : entityType.fields.reduce(
          (fields, field) =>
            addPath(
              fields,
              [name, field.name],
              field.type === "number" || field.type === "boolean" ? field.type : "text",
            ),
          snapshot,
        );
  }, suggested);
};

export const data = (model: Model): Result.Result<Schema.Json, string> => {
  const read = (node: Node, path: string): Result.Result<Schema.Json, string> => {
    if (node.kind === "null") {
      return Result.succeed(null);
    }
    if (node.kind === "text") {
      return Result.succeed(node.value);
    }
    if (node.kind === "number") {
      const number = Number(node.value);
      return node.value.trim() !== "" && Number.isFinite(number)
        ? Result.succeed(number)
        : Result.fail(`Enter a number for ${path}`);
    }
    if (node.kind === "boolean") {
      return node.value === "true" || node.value === "false"
        ? Result.succeed(node.value === "true")
        : Result.fail(`Choose Yes or No for ${path}`);
    }
    const names = node.children.map((child) => child.name.trim());
    if (
      node.kind === "object" &&
      (names.some((name) => name === "") || new Set(names).size !== names.length)
    ) {
      return Result.fail(`Give each field in ${path} a different name`);
    }
    const values = Result.all(
      node.children.map((child, index) =>
        read(child, node.kind === "array" ? `${path} item ${index + 1}` : `${path}.${child.name}`),
      ),
    );
    return Result.map(values, (items): Schema.Json =>
      node.kind === "array"
        ? items
        : Object.fromEntries(items.map((value, index) => [names[index] ?? "", value])),
    );
  };
  return read(model.root, "Event data");
};
