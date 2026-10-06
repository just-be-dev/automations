/** Parses typed form values; callers decide whether to trim inputs or clear empty fields. */
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type { ValueType } from "../../workflow.ts";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export const parsers: Record<ValueType, (text: string) => Option.Option<Schema.Json>> = {
  text: (text) => Option.some(text),
  number: (text) => {
    const value = Number(text.trim());
    return text.trim() !== "" && Number.isFinite(value) ? Option.some(value) : Option.none();
  },
  boolean: (text) => Option.some(text === "true"),
  date: (text) => (isoDate.test(text) ? Option.some(text) : Option.none()),
  datetime: (text) =>
    Number.isNaN(Date.parse(text)) ? Option.none() : Option.some(new Date(text).toISOString()),
};
