/** Checks entity-store selection, form validation, saves, and confirmed deletion without server requests. */
import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { ada, employee, employeesOpen } from "./fixtures.ts";
import {
  DeleteEntity,
  LoadEntities,
  LoadTypes,
  Message,
  NavigateToEntities,
  SaveEntity,
  SaveType,
  init,
  reflectUrl,
  update,
} from "./index.ts";

const named = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> = []) =>
  commands.map(({ name, args }) => ({ name, args }));

test("opening a type loads it, and a reply for a type no longer open is ignored", () => {
  const opened = init(Option.some("employee"));
  expect(named(opened.commands)).toEqual(named([LoadTypes(), LoadEntities({ type: "employee" })]));
  const moved = reflectUrl(opened.model, Option.some("team"));
  expect(named(moved.commands)).toEqual(named([LoadEntities({ type: "team" })]));
  const stale = update(
    moved.model,
    Message.SucceededLoadEntities({ type: "employee", entities: [ada] }),
  ).model;
  expect(stale.records).toEqual(moved.model.records);
  expect(reflectUrl(moved.model, Option.some("team")).commands).toBeUndefined();
});

test("a new type needs a ref target, saves, and opens", () => {
  story(
    update,
    given(employeesOpen),
    message(Message.ClickedNewType()),
    message(Message.UpdatedTypeName({ value: "team" })),
    message(Message.ClickedAddField()),
    message(Message.UpdatedFieldName({ key: 1, value: "lead" })),
    message(Message.SelectedFieldType({ key: 1, value: "ref" })),
    message(Message.SubmittedType()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ _tag: "Failed", error: "Choose the type lead points to" }),
      ),
    ),
    message(Message.SelectedFieldTarget({ key: 1, value: "employee" })),
    message(Message.SubmittedType()),
    Command.expectExact(
      SaveType({
        type: {
          name: "team",
          label: "Team",
          title: "name",
          fields: [
            { name: "name", label: "Name", type: "text" },
            { name: "lead", label: "Lead", type: "ref", to: "employee" },
          ],
        },
        isNew: true,
      }),
    ),
    Command.resolve(
      SaveType,
      Message.SucceededSaveType({
        type: {
          name: "team",
          label: "Team",
          title: "name",
          fields: [{ name: "name", label: "Name", type: "text" }],
        },
        isNew: true,
      }),
    ),
    Command.expectExact(NavigateToEntities({ url: "/entities?type=team" })),
    Command.resolve(NavigateToEntities, Message.CompletedNavigateToEntities()),
    model((current) => {
      expect(current.typeEditor._tag).toBe("Closed");
      expect(current.types).toEqual(
        expect.objectContaining({
          types: [employee, expect.objectContaining({ name: "team" })],
        }),
      );
    }),
  );
});

test("renaming the title field keeps it the title", () => {
  story(
    update,
    given(employeesOpen),
    message(Message.ClickedEditType()),
    message(Message.UpdatedFieldName({ key: 0, value: "full_name" })),
    message(Message.ClickedRemoveField({ key: 1 })),
    message(Message.SubmittedType()),
    Command.expectExact(
      SaveType({
        type: {
          ...employee,
          title: "full_name",
          fields: [{ name: "full_name", label: "Name", type: "text" }, ...employee.fields.slice(2)],
        },
        isNew: false,
      }),
    ),
    Command.resolve(SaveType, Message.SucceededSaveType({ type: employee, isNew: false })),
    Command.expectExact(LoadEntities({ type: "employee" })),
    Command.resolve(
      LoadEntities,
      Message.SucceededLoadEntities({ type: "employee", entities: [ada] }),
    ),
  );
});

test("editing an entity sends every field, clearing the empty ones, and reports the runs", () => {
  story(
    update,
    given(employeesOpen),
    message(Message.ClickedEditEntity({ id: "ada" })),
    model((current) =>
      expect(current.entityEditor).toEqual(
        expect.objectContaining({
          _tag: "Editing",
          draft: {
            id: "ada",
            values: { name: "Ada Lovelace", level: "3", start_date: "", manager: "grace" },
          },
        }),
      ),
    ),
    message(Message.UpdatedEntityField({ field: "start_date", value: "2026-11-02" })),
    message(Message.UpdatedEntityField({ field: "manager", value: "" })),
    message(Message.SubmittedEntity()),
    Command.expectExact(
      SaveEntity({
        type: "employee",
        id: "ada",
        data: { name: "Ada Lovelace", level: 3, start_date: "2026-11-02", manager: null },
      }),
    ),
    Command.resolve(
      SaveEntity,
      Message.SucceededSaveEntity({
        entity: { type: "employee", id: "ada", data: {} },
        triggered: [
          { automation: "onboarding", runId: "run-1", error: null },
          { automation: "offboarding", runId: null, error: null },
        ],
      }),
    ),
    Command.expectExact(LoadEntities({ type: "employee" })),
    Command.resolve(
      LoadEntities,
      Message.SucceededLoadEntities({ type: "employee", entities: [ada] }),
    ),
    model((current) => {
      expect(current.entityEditor._tag).toBe("Closed");
      expect(current.activity).toEqual(
        expect.objectContaining({ _tag: "Ready", notice: "Saved ada; started 1 run" }),
      );
    }),
  );
});

test("a new entity needs a free, valid ID and values its fields accept", () => {
  story(
    update,
    given(employeesOpen),
    message(Message.ClickedNewEntity()),
    message(Message.UpdatedEntityId({ value: "ada" })),
    message(Message.SubmittedEntity()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ error: "There is already an employee with ID ada" }),
      ),
    ),
    message(Message.UpdatedEntityId({ value: "grace hopper" })),
    message(Message.SubmittedEntity()),
    Command.expectNone(),
    message(Message.UpdatedEntityId({ value: "grace" })),
    message(Message.UpdatedEntityField({ field: "level", value: "senior" })),
    message(Message.SubmittedEntity()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ error: "Level must be a number" }),
      ),
    ),
  );
});

test("deleting an entity waits for confirmation", () => {
  story(
    update,
    given(employeesOpen),
    message(Message.ClickedDeleteEntity({ id: "ada" })),
    Command.expectNone(),
    message(Message.ClickedCancelDelete()),
    message(Message.ClickedConfirmDelete()),
    Command.expectNone(),
    message(Message.ClickedDeleteEntity({ id: "ada" })),
    message(Message.ClickedConfirmDelete()),
    Command.expectExact(DeleteEntity({ type: "employee", id: "ada" })),
    Command.resolve(DeleteEntity, Message.SucceededDeleteEntity({ type: "employee", id: "ada" })),
    model((current) => {
      expect(current.records).toEqual(expect.objectContaining({ _tag: "Ready", entities: [] }));
      expect(current.confirmation._tag).toBe("None");
    }),
  );
});
