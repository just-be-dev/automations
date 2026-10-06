/** Guards typed parsing and the distinct empty-field and whitespace policies of task and entity forms. */
import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { FieldValue, TaskAnswer } from "./index.ts";
import { laptopTask } from "../fixtures.ts";
import { entityDataFromDraft } from "../page/entities/draft.ts";
import { employee } from "../page/entities/fixtures.ts";

test("numbers reject blanks and non-finite values, and dates retain their typed representation", () => {
  expect(FieldValue.parsers.number(" -2.5 ")).toEqual(Option.some(-2.5));
  expect(FieldValue.parsers.number("0")).toEqual(Option.some(0));
  expect(FieldValue.parsers.number("   ")).toEqual(Option.none());
  expect(FieldValue.parsers.number("Infinity")).toEqual(Option.none());
  expect(FieldValue.parsers.number("2px")).toEqual(Option.none());
  expect(FieldValue.parsers.date("2026-11-02")).toEqual(Option.some("2026-11-02"));
  expect(FieldValue.parsers.date("11/02/2026")).toEqual(Option.none());
  expect(FieldValue.parsers.datetime("2026-11-02T09:30:00-05:00")).toEqual(
    Option.some("2026-11-02T14:30:00.000Z"),
  );
  expect(FieldValue.parsers.datetime("tomorrow")).toEqual(Option.none());
});

test("task forms require numbers, preserve defaults, and do not trim dates or booleans", () => {
  const fields = [
    { name: "budget", label: "Budget", type: "number" },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "remote", label: "Works remotely", type: "boolean" },
  ] as const;
  const edit = (field: string, value: string) => ({ step: "laptop", field, value });
  expect(TaskAnswer.fromForm([edit("budget", " ")], laptopTask, fields)).toEqual(
    Result.fail("Fill in Budget"),
  );
  expect(TaskAnswer.fromForm([edit("budget", "0")], laptopTask, fields)).toEqual(
    Result.succeed({ values: { budget: 0, start_date: "2026-11-02", remote: false } }),
  );
  expect(
    TaskAnswer.fromForm(
      [edit("budget", "17"), edit("start_date", " 2026-11-02 ")],
      laptopTask,
      fields,
    ),
  ).toEqual(Result.fail("Fill in Start date"));
  expect(
    TaskAnswer.fromForm([edit("budget", "17"), edit("remote", " true ")], laptopTask, fields),
  ).toEqual(Result.succeed({ values: { budget: 17, start_date: "2026-11-02", remote: false } }));
});

test("entity forms clear blanks and trim dates, booleans and refs without trimming text", () => {
  const type = {
    ...employee,
    fields: [...employee.fields, { name: "remote", label: "Remote", type: "boolean" } as const],
  };
  expect(
    entityDataFromDraft(type, {
      id: "ada",
      values: {
        name: " Ada ",
        level: " ",
        start_date: " 2026-11-02 ",
        manager: " grace ",
        remote: " true ",
      },
    }),
  ).toEqual(
    Result.succeed({
      name: " Ada ",
      level: null,
      start_date: "2026-11-02",
      manager: "grace",
      remote: true,
    }),
  );
});
