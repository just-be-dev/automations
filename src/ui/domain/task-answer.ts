import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { HumanField, HumanTask, ValueType } from "../../workflow.ts";

export const TaskFieldEdit = Schema.Struct({
  step: Schema.String,
  field: Schema.String,
  value: Schema.String,
});
export type TaskFieldEdit = typeof TaskFieldEdit.Type;

export const TaskAnswer = Schema.Struct({
  approved: Schema.optionalKey(Schema.Boolean),
  values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type TaskAnswer = typeof TaskAnswer.Type;

export const fieldText = (edits: ReadonlyArray<TaskFieldEdit>, task: HumanTask, field: string) =>
  Option.match(
    Array.findFirst(edits, (edit) => edit.step === task.step && edit.field === field),
    {
      onNone: () => task.defaults[field] ?? "",
      onSome: (edit) => edit.value,
    },
  );

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const answerParsers: Record<ValueType, (text: string) => Option.Option<Schema.Json>> = {
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

export const fromForm = (
  edits: ReadonlyArray<TaskFieldEdit>,
  task: HumanTask,
  fields: ReadonlyArray<HumanField>,
): Result.Result<TaskAnswer, string> => {
  const parsed = Array.map(fields, (field) => ({
    field,
    maybeValue: answerParsers[field.type](fieldText(edits, task, field.name)),
  }));
  return Array.match(
    Array.filter(parsed, ({ maybeValue }) => Option.isNone(maybeValue)),
    {
      onEmpty: () =>
        Result.succeed({
          values: Object.fromEntries(
            Array.getSomes(
              Array.map(parsed, ({ field, maybeValue }) =>
                Option.map(maybeValue, (value): readonly [string, Schema.Json] => [
                  field.name,
                  value,
                ]),
              ),
            ),
          ),
        }),
      onNonEmpty: (missing) =>
        Result.fail(`Fill in ${Array.map(missing, ({ field }) => field.label).join(", ")}`),
    },
  );
};

export const approval =
  (approved: boolean) =>
  (task: HumanTask): Result.Result<TaskAnswer, string> =>
    task.response === "approval"
      ? Result.succeed({ approved })
      : Result.fail("Fill in the form to answer this task");
