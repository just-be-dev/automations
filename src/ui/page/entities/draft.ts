import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { labelFromName } from "@/lib/format";
import {
  type EntityData,
  type EntityField,
  type EntityRecord,
  EntityType,
  type FieldType,
} from "../../../entities.ts";
import type { EntityDraft, TypeDraft } from "./model.ts";

export const newTypeDraft: TypeDraft = {
  name: "",
  label: "",
  titleKey: 0,
  fields: [{ key: 0, name: "name", label: "Name", type: "text", to: "" }],
  nextKey: 1,
};

export const typeDraftOf = (type: EntityType): TypeDraft => {
  const fields = Array.map(type.fields, (field, key) => ({
    key,
    name: field.name,
    label: field.label,
    type: field.type,
    to: field.to ?? "",
  }));
  return {
    name: type.name,
    label: type.label,
    titleKey: Option.match(
      Array.findFirst(fields, (field) => field.name === type.title),
      { onNone: () => 0, onSome: (field) => field.key },
    ),
    fields,
    nextKey: fields.length,
  };
};

/** The type a draft describes, or the first thing to fix. The server checks refs again. */
export const typeFromDraft = (draft: TypeDraft): Result.Result<EntityType, string> => {
  const untargeted = Array.findFirst(
    draft.fields,
    (field) => field.type === "ref" && field.to === "",
  );
  if (Option.isSome(untargeted)) {
    return Result.fail(`Choose the type ${untargeted.value.name || "the ref field"} points to`);
  }
  const maybeTitle = Array.findFirst(draft.fields, (field) => field.key === draft.titleKey);
  if (Option.isNone(maybeTitle)) {
    return Result.fail("Choose the field that titles each entity");
  }
  const name = draft.name.trim();
  return Schema.decodeResult(EntityType)({
    name,
    label: draft.label.trim() || labelFromName(name),
    title: maybeTitle.value.name.trim(),
    fields: Array.map(draft.fields, (field) => ({
      name: field.name.trim(),
      label: field.label.trim() || labelFromName(field.name),
      type: field.type,
      ...(field.type === "ref" ? { to: field.to } : {}),
    })),
  }).pipe(Result.mapError((error) => error.message));
};

const fieldText = (value: Schema.Json | undefined): string => {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
};

export const entityDraftOf = (type: EntityType, entity: EntityRecord): EntityDraft => ({
  id: entity.id,
  values: Object.fromEntries(
    Array.map(type.fields, (field) => [field.name, fieldText(entity.data[field.name])]),
  ),
});

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const fieldTypeArticle: Record<FieldType, string> = {
  text: "text",
  number: "a number",
  boolean: "yes or no",
  date: "a date (YYYY-MM-DD)",
  datetime: "a date and time",
  ref: "an entity ID",
};

const fieldParsers: Record<FieldType, (text: string) => Option.Option<Schema.Json>> = {
  text: (text) => Option.some(text),
  ref: (text) => Option.some(text.trim()),
  number: (text) => {
    const value = Number(text.trim());
    return Number.isFinite(value) ? Option.some(value) : Option.none();
  },
  boolean: (text) => Option.some(text.trim() === "true"),
  date: (text) => (isoDate.test(text.trim()) ? Option.some(text.trim()) : Option.none()),
  datetime: (text) =>
    Number.isNaN(Date.parse(text)) ? Option.none() : Option.some(new Date(text).toISOString()),
};

const fieldValue = (field: EntityField, text: string): Result.Result<Schema.Json, string> =>
  text.trim() === ""
    ? Result.succeed(null)
    : Option.match(fieldParsers[field.type](text), {
        onNone: () => Result.fail(`${field.label} must be ${fieldTypeArticle[field.type]}`),
        onSome: (value) => Result.succeed(value),
      });

/** Every field of the type, with empty inputs sent as `null` so they clear the stored value. */
export const entityDataFromDraft = (
  type: EntityType,
  draft: EntityDraft,
): Result.Result<EntityData, string> =>
  Result.all(
    Array.map(type.fields, (field) =>
      Result.map(
        fieldValue(field, draft.values[field.name] ?? ""),
        (value): readonly [string, Schema.Json] => [field.name, value],
      ),
    ),
  ).pipe(Result.map((entries) => Object.fromEntries(entries)));
