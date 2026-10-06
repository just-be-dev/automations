import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The namer agent: a fast model that titles a new automation from the description its first chat
 * message carries, so the sidebar can list it before the planner has drafted anything. The planner
 * renames it once it drafts the workflow.
 */

export class NamerError extends Schema.TaggedError<NamerError>()("NamerError", {
  message: Schema.String,
}) {}

export interface NameRequest {
  readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>;
  readonly max_tokens: number;
}

/** Sends a request to a fast text model and resolves with its reply. */
export class AutomationNamer extends Context.Service<
  AutomationNamer,
  { readonly complete: (request: NameRequest) => Effect.Effect<string, NamerError> }
>()("automations/AutomationNamer") {}

export const maxNameLength = 80;
// The opening of a description says what the automation is for; the rest is detail.
const descriptionWindow = 2_000;
const fallbackWords = 6;

const instructions = `You name workflow automations for a business team. Read the description and reply with only a short name for the automation: 2 to 5 words, sentence case, no quotes, no punctuation at the end. Examples: "Onboard new hires", "Summarize new orders", "Remind managers of reviews".`;

export const nameRequest = (description: string): NameRequest => ({
  messages: [
    { role: "system", content: instructions },
    { role: "user", content: description.slice(0, descriptionWindow) },
  ],
  max_tokens: 24,
});

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Cuts at the last whole word that fits. */
const fitted = (text: string) => {
  if (text.length <= maxNameLength) {
    return text;
  }
  const cut = text.slice(0, maxNameLength);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
};

/** The name in a model's reply, without the labels, quotes, and markup small models add. */
export const nameFromReply = (reply: string): Option.Option<string> => {
  const line =
    reply
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate !== "") ?? "";
  const name = line
    .replace(/^(automation\s+)?name\s*:\s*/i, "")
    .replace(/^["'*`_\s]+|["'*`_\s.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name === "" ? Option.none() : Option.some(capitalized(fitted(name)));
};

/** The description's opening words, for when the model can't answer. */
export const fallbackName = (description: string) => {
  const words = description.trim().split(/\s+/).slice(0, fallbackWords).join(" ");
  const name = words.replace(/[\s,.;:!?]+$/, "");
  return name === "" ? "New automation" : capitalized(fitted(name));
};

/** Never fails: a slow, failed, or empty answer falls back to the description's opening words. */
export const nameAutomation = Effect.fn("Namer.nameAutomation")(function* (description: string) {
  const namer = yield* AutomationNamer;
  return yield* namer.complete(nameRequest(description)).pipe(
    Effect.timeout("5 seconds"),
    Effect.map(nameFromReply),
    Effect.map(Option.getOrElse(() => fallbackName(description))),
    Effect.catch(() => Effect.succeed(fallbackName(description))),
  );
});
