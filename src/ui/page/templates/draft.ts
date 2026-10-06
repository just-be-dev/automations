/** Converts approved templates into editable slot and content rows and checks drafts before saving. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { labelFromName } from "@/lib/format";
import { operations } from "../../../connections.ts";
import { Template } from "../../../entities.ts";
import type { TemplateDraft } from "./model.ts";

export const newTemplateDraft: TemplateDraft = {
  name: "",
  label: "",
  description: "",
  slots: [],
  content: [{ key: 0, input: "", text: "" }],
  nextKey: 1,
};

export const templateDraftOf = (template: Template): TemplateDraft => {
  const slots = Array.map(template.slots, (slot, key) => ({
    key,
    name: slot.name,
    label: slot.label,
    type: slot.type,
    to: slot.to ?? "",
  }));
  const content = Array.map(Object.entries(template.content), ([input, text], index) => ({
    key: slots.length + index,
    input,
    text,
  }));
  return {
    name: template.name,
    label: template.label,
    description: template.description,
    slots,
    content,
    nextKey: slots.length + content.length,
  };
};

/** The action inputs a template can fill: every operation's `text` inputs. */
export const textInputs: ReadonlyArray<string> = Array.dedupe(
  Array.flatMap(operations, (operation) =>
    Array.flatMap(operation.inputs, (input) => (input.type === "text" ? [input.name] : [])),
  ),
);

/** The template a draft describes, or the first thing to fix. The server checks refs again. */
export const templateFromDraft = (draft: TemplateDraft): Result.Result<Template, string> => {
  const untargeted = Array.findFirst(draft.slots, (slot) => slot.type === "ref" && slot.to === "");
  if (Option.isSome(untargeted)) {
    return Result.fail(`Choose the type ${untargeted.value.name || "the ref slot"} points to`);
  }
  const inputs = Array.map(draft.content, (content) => content.input.trim());
  if (Array.some(inputs, (input) => input === "")) {
    return Result.fail("Name the input each piece of content fills");
  }
  const repeated = Array.findFirst(inputs, (input, index) => inputs.indexOf(input) !== index);
  if (Option.isSome(repeated)) {
    return Result.fail(`The template fills ${repeated.value} twice`);
  }
  const name = draft.name.trim();
  return Schema.decodeResult(Template)({
    name,
    label: draft.label.trim() || labelFromName(name),
    description: draft.description.trim(),
    slots: Array.map(draft.slots, (slot) => ({
      name: slot.name.trim(),
      label: slot.label.trim() || labelFromName(slot.name),
      type: slot.type,
      ...(slot.type === "ref" ? { to: slot.to } : {}),
    })),
    content: Object.fromEntries(
      Array.map(draft.content, (content) => [content.input.trim(), content.text]),
    ),
  }).pipe(Result.mapError((error) => error.message));
};
