/** The values a dataset expects, written as data, and the check that compares an output to one. */

import * as Schema from "effect/Schema";

/**
 * Datasets (`evals/datasets/`) are YAML, so they can't hold `expect` matchers. An `Expected` value
 * says what a part of an output must be:
 *
 * - A string, number, boolean, or null equals it.
 * - A list matches a list of the same length, item by item.
 * - A mapping matches an object with the same keys, each matching.
 * - `{ $includes: <mapping> }` matches an object with at least those keys, each matching.
 * - `{ $includes: <list> }` matches a list in which every listed item matches some item.
 * - `{ $includes: <text> }` matches text that contains it.
 * - `{ $matches: /source/flags }` matches text the regular expression finds a match in.
 * - `{ $oneOf: <list> }` matches what any of the listed values match.
 * - `{ $type: string | number | boolean | object | array }` matches any value of that type.
 *
 * Keys starting with `$` are only these operators, so they can't be confused with an output's keys.
 */

export type Expected =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Expected>
  | { readonly $includes: string | ReadonlyArray<Expected> | ExpectedObject }
  | { readonly $matches: string }
  | { readonly $oneOf: ReadonlyArray<Expected> }
  | { readonly $type: ValueType }
  | ExpectedObject;

export interface ExpectedObject {
  readonly [key: string]: Expected;
}

const valueTypes = ["string", "number", "boolean", "object", "array"] as const;
type ValueType = (typeof valueTypes)[number];

const patternSyntax = /^\/(.+)\/([dgimsuy]*)$/;

const compile = (pattern: string) => {
  const [, source = "", flags = ""] = patternSyntax.exec(pattern) ?? [];
  return new RegExp(source, flags);
};

const compiles = (pattern: string) => {
  try {
    compile(pattern);
    return true;
  } catch {
    return false;
  }
};

/** A regular expression written as `/source/flags`, as in JavaScript. */
export const Pattern = Schema.String.check(
  Schema.isPattern(patternSyntax),
  Schema.makeFilter(compiles, { expected: "a regular expression that compiles" }),
).annotate({
  identifier: "Pattern",
  description: "A regular expression written as /source/flags, such as /welcome/i.",
});

/** A key of an object an output must equal; `$` starts an operator instead. */
const Key = Schema.String.check(Schema.isPattern(/^[^$]/));

const ExpectedSchema: Schema.Codec<Expected> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.String,
  Schema.Array(Schema.suspend(() => ExpectedSchema)),
  Schema.Struct({
    $includes: Schema.Union([
      Schema.String,
      Schema.Array(Schema.suspend(() => ExpectedSchema)),
      Schema.Record(
        Key,
        Schema.suspend(() => ExpectedSchema),
      ),
    ]),
  }).annotate({ description: "At least these keys, these items, or this text." }),
  Schema.Struct({ $matches: Pattern }).annotate({
    description: "Text the regular expression finds a match in.",
  }),
  Schema.Struct({ $oneOf: Schema.Array(Schema.suspend(() => ExpectedSchema)) }).annotate({
    description: "Anything one of these values matches.",
  }),
  Schema.Struct({ $type: Schema.Literals(valueTypes) }).annotate({
    description: "Any value of this type.",
  }),
  Schema.Record(
    Key,
    Schema.suspend(() => ExpectedSchema),
  ),
]).annotate({
  identifier: "Expected",
  description:
    "What a value must be: a value it equals, or an operator ($includes, $matches, $oneOf, $type).",
});

export { ExpectedSchema as Expected };

/** Text the dataset expects: text the value contains, or a pattern it matches. */
export type ExpectedText = string | { readonly $matches: string };

export const ExpectedText: Schema.Codec<ExpectedText> = Schema.Union([
  Schema.String,
  Schema.Struct({ $matches: Pattern }),
]).annotate({ description: "Text the value contains, or { $matches: /source/flags }." });

const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value));

const typeOf = (value: unknown): ValueType | "null" | "other" => {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  return type === "object" || type === "string" || type === "number" || type === "boolean"
    ? type
    : "other";
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeOf(value) === "object";

const at = (path: string, key: string | number) =>
  typeof key === "number" ? `${path}[${key}]` : `${path}.${key}`;

/** The keys an object has a value for, as `toEqual` counts them. */
const definedKeys = (value: Readonly<Record<string, unknown>>) =>
  Object.keys(value).filter((key) => value[key] !== undefined);

const objectMismatches = (
  expected: ExpectedObject,
  actual: unknown,
  path: string,
  partial: boolean,
): ReadonlyArray<string> => {
  if (!isRecord(actual)) {
    return [`${path} is ${show(actual)}, not an object`];
  }
  const extra = partial ? [] : definedKeys(actual).filter((key) => !(key in expected));
  return [
    ...Object.entries(expected).flatMap(([key, value]) =>
      mismatches(value, actual[key], at(path, key)),
    ),
    ...extra.map((key) => `${at(path, key)} is ${show(actual[key])}, and shouldn't be there`),
  ];
};

/** `Array.isArray` doesn't narrow readonly arrays out of a union. */
const isList = (value: unknown): value is ReadonlyArray<Expected> => Array.isArray(value);

const includesMismatches = (
  expected: string | ReadonlyArray<Expected> | ExpectedObject,
  actual: unknown,
  path: string,
): ReadonlyArray<string> => {
  if (typeof expected === "string") {
    return typeof actual === "string" && actual.includes(expected)
      ? []
      : [`${path} is ${show(actual)}, which doesn't contain ${show(expected)}`];
  }
  if (isList(expected)) {
    if (!Array.isArray(actual)) {
      return [`${path} is ${show(actual)}, not a list`];
    }
    return expected.flatMap((item) =>
      actual.some((each) => mismatches(item, each, path).length === 0)
        ? []
        : [`${path} has nothing matching ${show(item)}: it is ${show(actual)}`],
    );
  }
  return objectMismatches(expected, actual, path, true);
};

const isOperator = (expected: object): expected is Record<`$${string}`, unknown> =>
  Object.keys(expected).some((key) => key.startsWith("$"));

/** How `actual` fails to match `expected`, one line per difference, or nothing when it matches. */
export const mismatches = (
  expected: Expected,
  actual: unknown,
  path = "it",
): ReadonlyArray<string> => {
  if (expected === null || typeof expected !== "object") {
    return Object.is(expected, actual) ? [] : [`${path} is ${show(actual)}, not ${show(expected)}`];
  }
  if (isList(expected)) {
    if (!Array.isArray(actual)) {
      return [`${path} is ${show(actual)}, not a list`];
    }
    if (actual.length !== expected.length) {
      return [`${path} has ${actual.length} items, not ${expected.length}: ${show(actual)}`];
    }
    return expected.flatMap((item, index) => mismatches(item, actual[index], at(path, index)));
  }
  if (!isOperator(expected)) {
    return objectMismatches(expected, actual, path, false);
  }
  if ("$includes" in expected) {
    return includesMismatches(
      expected.$includes as string | ReadonlyArray<Expected> | ExpectedObject,
      actual,
      path,
    );
  }
  if ("$matches" in expected) {
    const pattern = String(expected.$matches);
    return typeof actual === "string" && compile(pattern).test(actual)
      ? []
      : [`${path} is ${show(actual)}, which doesn't match ${pattern}`];
  }
  if ("$oneOf" in expected) {
    const options = expected.$oneOf as ReadonlyArray<Expected>;
    return options.some((option) => mismatches(option, actual, path).length === 0)
      ? []
      : [`${path} is ${show(actual)}, not one of ${show(options)}`];
  }
  const type = expected.$type as ValueType;
  return typeOf(actual) === type ? [] : [`${path} is ${show(actual)}, not a ${type}`];
};

/** A check's assertion: throws, naming every difference, unless `actual` matches `expected`. */
export const expectMatch = (actual: unknown, expected: Expected, path = "it") => {
  const found = mismatches(expected, actual, path);
  if (found.length > 0) {
    throw new Error(found.join("\n"));
  }
};

/** Throws unless `actual` contains the text, or matches the pattern, `expected` gives. */
export const expectText = (actual: string, expected: ExpectedText, path = "it") =>
  expectMatch(actual, typeof expected === "string" ? { $includes: expected } : expected, path);
