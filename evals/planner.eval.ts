/** The planner turns one chat message into a draft, and answers the person. */

import { expect } from "bun:test";
import * as Schema from "effect/Schema";
import { conditionRefs, type Step } from "../src/workflow/model.ts";
import {
  exchange,
  planner,
  said,
  steps,
  templates,
  type PlannerInput,
  type PlannerOutput,
} from "./calls/planner.ts";
import { defineEval, judged } from "./framework/eval.ts";
import { Expected, ExpectedText, expectMatch, expectText } from "./framework/expected.ts";

const StepKind = Schema.Literals([
  "action",
  "agent",
  "wait",
  "human",
  "stop",
  "parallel",
  "if",
  "decide",
]);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const StepQuery = Schema.Struct({
  kind: Schema.optionalKey(StepKind).annotate({ description: "Only steps of this kind." }),
  use: Schema.optionalKey(Schema.String).annotate({
    description: "Only action steps that perform this operation, such as email.send.",
  }),
  count: Schema.optionalKey(Count).annotate({ description: "Exactly this many steps." }),
  atLeast: Schema.optionalKey(Count).annotate({
    description: "At least this many steps; 1 when the query asks for nothing else.",
  }),
  ids: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Steps with these IDs are among them.",
  }),
  some: Schema.optionalKey(Expected).annotate({ description: "One of the steps matches this." }),
  mentions: Schema.optionalKey(ExpectedText).annotate({
    description: "The steps, written as JSON, contain this text or match this pattern.",
  }),
});
type StepQuery = typeof StepQuery.Type;

const fail = (message: string): never => {
  throw new Error(message);
};

/** Checks the steps of the draft that a query selects, nested ones included. */
const checkSteps = (query: StepQuery) => (output: PlannerOutput) => {
  const selected = steps(output).filter(
    (step) =>
      (query.kind === undefined || step.kind === query.kind) &&
      (query.use === undefined || (step.kind === "action" && step.use === query.use)),
  );
  const label = `${query.use ?? query.kind ?? "all"} steps`;
  const asksNothing = [query.count, query.ids, query.some, query.mentions].every(
    (each) => each === undefined,
  );
  const atLeast = query.atLeast ?? (asksNothing ? 1 : undefined);
  if (query.count !== undefined && selected.length !== query.count) {
    fail(`There are ${selected.length} ${label}, not ${query.count}`);
  }
  if (atLeast !== undefined && selected.length < atLeast) {
    fail(`There are ${selected.length} ${label}, fewer than ${atLeast}`);
  }
  if (query.ids !== undefined) {
    expectMatch(
      selected.map((step) => step.id),
      { $includes: query.ids },
      `IDs of ${label}`,
    );
  }
  if (query.some !== undefined) {
    expectMatch(selected, { $includes: [query.some] }, label);
  }
  if (query.mentions !== undefined) {
    expectText(JSON.stringify(selected), query.mentions, label);
  }
};

/** Some `if` step's condition reads the record of a step of this kind. */
const branchesOn = (kind: Step["kind"]) => (output: PlannerOutput) => {
  const read = steps(output)
    .filter((step) => step.kind === kind)
    .map((step) => `steps.${step.id}`);
  const refs = steps(output).flatMap((step) =>
    step.kind === "if" ? step.cases.flatMap((branch) => conditionRefs(branch.when)) : [],
  );
  if (!refs.some((ref) => read.some((record) => ref.startsWith(record)))) {
    fail(`No if step reads a ${kind} step: they read ${JSON.stringify(refs)}`);
  }
};

/** What the judge reads. */
const material = {
  reply: (output: PlannerOutput) => output.reply,
  said,
  exchange,
} satisfies Record<string, (output: PlannerOutput, input: PlannerInput) => string>;

export default defineEval({
  call: planner,
  minimum: 0.75,
  every: {
    "replies in prose, not code": (output) =>
      expect(output.reply).not.toMatch(/```|^\s*[{[]|^\s*name:/m),
    "replies in plain words": judged(
      "The reply is written for someone who doesn't build software. It says what changed or asks a question in plain words, and doesn't mention tools, JSON, YAML, step IDs, refs, or internal checks.",
      (output) => output.reply,
    ),
  },
  checks: {
    /** True: the planner changed the draft. False: it left the draft as it was. */
    drafts: {
      value: Schema.Boolean,
      check: (drafts) => (output) =>
        drafts ? expect(output.workflow).toBeDefined() : expect(output.workflow).toBeUndefined(),
    },
    /** Whether its first answer had problems it had to fix. */
    retried: {
      value: Schema.Boolean,
      check: (retried) => (output) => expect(output.retried).toBe(retried),
    },
    /** The draft's trigger. */
    trigger: {
      value: Expected,
      check: (expected) => (output) => expectMatch(output.workflow?.trigger, expected, "trigger"),
    },
    /** The draft's steps, nested ones included, that a query selects. */
    steps: { value: StepQuery, check: checkSteps },
    /** The templates the actions performing `use` include these, their match cases included. */
    templates: {
      value: Schema.Struct({ use: Schema.String, include: Schema.Array(Schema.String) }),
      check:
        ({ use, include }) =>
        (output) =>
          expectMatch(templates(output, use), { $includes: include }, `${use} templates`),
    },
    /** The draft's permissions, by operation. */
    permissions: {
      value: Expected,
      check: (expected) => (output) =>
        expectMatch(output.workflow?.permissions, expected, "permissions"),
    },
    /** Some `if` step branches on the record of a step of this kind. */
    branchesOn: { value: StepKind, check: branchesOn },
    /** A criterion the judge grades on the reply, everything it said, or the whole exchange. */
    judge: {
      value: Schema.Struct({
        reads: Schema.Literals(["reply", "said", "exchange"]),
        criterion: Schema.String,
      }),
      check: ({ reads, criterion }) => judged(criterion, material[reads]),
    },
  },
});
