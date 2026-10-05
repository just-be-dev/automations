import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { InvalidWorkflow, Workflow } from "../workflow/model.ts";

export const Draft = Schema.Struct({
  reply: Schema.String.check(
    Schema.makeFilter((value: string) => value.trim().length > 0 && value.length <= 8000, {
      message: "Agent did not provide a reply",
    }),
  ),
  workflow: Workflow,
});
export interface Draft extends Schema.Schema.Type<typeof Draft> {}

type Closer = "}" | "]";

/** What a scan of a reply's brackets found, outside strings. */
export interface BracketScan {
  /** The reply with mismatched closers dropped and missing closers appended. */
  readonly balanced: string;
  /** The first closer that doesn't close the innermost open bracket, and the closer that would. */
  readonly mismatch?: { readonly at: number; readonly found: Closer; readonly expected?: Closer };
  /** The closers still missing at the end, innermost first. */
  readonly missing: string;
  readonly endsInString: boolean;
}

/** Repairs bracket slips outside strings; the repaired reply still has to decode and check. */
export const scanBrackets = (json: string): BracketScan => {
  const open: Array<Closer> = [];
  let balanced = "";
  let mismatch: BracketScan["mismatch"];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index++) {
    const char = json.charAt(index);
    if (inString) {
      inString = escaped || char !== '"';
      escaped = !escaped && char === "\\";
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      open.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      const expected = open.at(-1);
      if (expected !== char) {
        mismatch ??= { at: index, found: char, ...(expected === undefined ? {} : { expected }) };
        continue;
      }
      open.pop();
    }
    balanced += char;
  }
  const missing = open.reverse().join("");
  return {
    balanced: balanced + missing,
    ...(mismatch === undefined ? {} : { mismatch }),
    missing,
    endsInString: inString,
  };
};

const parseJson = (json: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(json),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

/** Quotes the text at the problem so the designer can fix the JSON on its one retry. */
const invalidJson = (error: string, json: string, scan: BracketScan) => {
  const { mismatch } = scan;
  const problem = scan.endsInString
    ? "It ends inside a string: a closing quote is missing or the reply was cut off."
    : mismatch !== undefined
      ? `The "${mismatch.found}" at the end of "…${json.slice(Math.max(0, mismatch.at - 60), mismatch.at + 1)}" ${
          mismatch.expected === undefined
            ? "has no open bracket left to close."
            : `is wrong: the innermost open bracket there needs "${mismatch.expected}".`
        }`
      : scan.missing !== ""
        ? `It ends with brackets still open: it needs "${scan.missing}" at the end.`
        : undefined;
  return new InvalidWorkflow({
    message: `The reply is not valid JSON: ${error}.${problem === undefined ? "" : ` ${problem}`}`,
  });
};

/** Decodes the designer's reply, tolerating a code fence and repairable closing-bracket slips. */
export const decodeDraft = (text: string) => {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return parseJson(json).pipe(
    Effect.catch((error) => {
      const scan = scanBrackets(json);
      const repairable = !scan.endsInString && (scan.mismatch !== undefined || scan.missing !== "");
      return repairable
        ? parseJson(scan.balanced).pipe(Effect.mapError(() => invalidJson(error, json, scan)))
        : Effect.fail(invalidJson(error, json, scan));
    }),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(Draft)(value).pipe(
        Effect.mapError((error) => new InvalidWorkflow({ message: error.message })),
      ),
    ),
  );
};
