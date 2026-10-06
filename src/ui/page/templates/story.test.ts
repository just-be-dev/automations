import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, model, story } from "foldkit/story";
import { employee, welcome, welcomeOpen, welcomeUsage } from "./fixtures.ts";
import {
  DeleteTemplate,
  LoadCatalog,
  LoadUsage,
  Message,
  NavigateToTemplates,
  SaveTemplate,
  init,
  reflectUrl,
  update,
} from "./index.ts";

const named = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> = []) =>
  commands.map(({ name, args }) => ({ name, args }));

test("opening a template loads who uses it, and a reply for one no longer open is ignored", () => {
  const opened = init(Option.some("welcome_email"));
  expect(named(opened.commands)).toEqual(
    named([LoadCatalog(), LoadUsage({ name: "welcome_email" })]),
  );
  const moved = reflectUrl(opened.model, Option.some("farewell"));
  expect(named(moved.commands)).toEqual(named([LoadUsage({ name: "farewell" })]));
  const stale = update(
    moved.model,
    Message.SucceededLoadUsage({ name: "welcome_email", usage: welcomeUsage }),
  ).model;
  expect(stale.usage).toEqual(moved.model.usage);
  expect(reflectUrl(moved.model, Option.some("farewell")).commands).toBeUndefined();
});

test("a new template needs a slot target and named, distinct inputs, then saves and opens", () => {
  story(
    update,
    given(welcomeOpen),
    message(Message.ClickedNewTemplate()),
    message(Message.UpdatedTemplateName({ value: "farewell" })),
    message(Message.UpdatedTemplateDescription({ value: "Says goodbye to a leaver." })),
    message(Message.ClickedAddSlot()),
    message(Message.UpdatedSlotName({ key: 1, value: "leaver" })),
    message(Message.UpdatedContentText({ key: 0, value: "Goodbye, {{leaver.name}}" })),
    message(Message.SubmittedTemplate()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ _tag: "Failed", error: "Choose the type leaver points to" }),
      ),
    ),
    message(Message.SelectedSlotTarget({ key: 1, value: "employee" })),
    message(Message.SubmittedTemplate()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ error: "Name the input each piece of content fills" }),
      ),
    ),
    message(Message.UpdatedContentInput({ key: 0, value: "subject" })),
    message(Message.ClickedAddContent()),
    message(Message.UpdatedContentInput({ key: 2, value: "subject" })),
    message(Message.SubmittedTemplate()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ error: "The template fills subject twice" }),
      ),
    ),
    message(Message.UpdatedContentInput({ key: 2, value: "body" })),
    message(Message.UpdatedContentText({ key: 2, value: "Thanks for everything." })),
    message(Message.SubmittedTemplate()),
    Command.expectExact(
      SaveTemplate({
        template: {
          name: "farewell",
          label: "Farewell",
          description: "Says goodbye to a leaver.",
          slots: [{ name: "leaver", label: "Leaver", type: "ref", to: "employee" }],
          content: { subject: "Goodbye, {{leaver.name}}", body: "Thanks for everything." },
        },
        isNew: true,
      }),
    ),
    Command.resolve(
      SaveTemplate,
      Message.SucceededSaveTemplate({
        template: { ...welcome, name: "farewell", label: "Farewell" },
        isNew: true,
      }),
    ),
    Command.expectExact(NavigateToTemplates({ url: "/templates?template=farewell" })),
    Command.resolve(NavigateToTemplates, Message.CompletedNavigateToTemplates()),
    model((current) => {
      expect(current.editor._tag).toBe("Closed");
      expect(current.catalog).toEqual(
        expect.objectContaining({
          templates: [expect.objectContaining({ name: "farewell" }), welcome],
          types: [employee],
        }),
      );
    }),
  );
});

test("a new template can't take an existing name", () => {
  story(
    update,
    given(welcomeOpen),
    message(Message.ClickedNewTemplate()),
    message(Message.UpdatedTemplateName({ value: "welcome_email" })),
    message(Message.UpdatedTemplateDescription({ value: "Again" })),
    message(Message.UpdatedContentInput({ key: 0, value: "body" })),
    message(Message.SubmittedTemplate()),
    Command.expectNone(),
    model((current) =>
      expect(current.activity).toEqual(
        expect.objectContaining({ error: "There is already a template named welcome_email" }),
      ),
    ),
  );
});

test("editing a template starts from its saved slots and content and replaces it", () => {
  story(
    update,
    given(welcomeOpen),
    message(Message.ClickedEditTemplate()),
    model((current) =>
      expect(current.editor).toEqual(
        expect.objectContaining({
          _tag: "Editing",
          draft: {
            name: "welcome_email",
            label: "Welcome email",
            description: welcome.description,
            slots: [{ key: 0, name: "hire", label: "New hire", type: "ref", to: "employee" }],
            content: [
              { key: 1, input: "subject", text: "Welcome, {{hire.name}}" },
              { key: 2, input: "body", text: welcome.content.body },
            ],
            nextKey: 3,
          },
        }),
      ),
    ),
    message(Message.UpdatedContentText({ key: 1, value: "Welcome aboard, {{hire.name}}" })),
    message(Message.ClickedRemoveContent({ key: 2 })),
    message(Message.SubmittedTemplate()),
    Command.expectExact(
      SaveTemplate({
        template: { ...welcome, content: { subject: "Welcome aboard, {{hire.name}}" } },
        isNew: false,
      }),
    ),
    Command.resolve(
      SaveTemplate,
      Message.FailedRequest({ error: "{{hire.title}}: employee has no field title" }),
    ),
    model((current) => {
      expect(current.editor._tag).toBe("Editing");
      expect(current.activity).toEqual(
        expect.objectContaining({ error: "{{hire.title}}: employee has no field title" }),
      );
    }),
  );
});

test("deleting a template waits for confirmation, then leaves its page", () => {
  story(
    update,
    given(welcomeOpen),
    message(Message.ClickedConfirmDelete()),
    Command.expectNone(),
    message(Message.ClickedDeleteTemplate()),
    message(Message.ClickedConfirmDelete()),
    Command.expectExact(DeleteTemplate({ name: "welcome_email" })),
    Command.resolve(DeleteTemplate, Message.SucceededDeleteTemplate({ name: "welcome_email" })),
    Command.expectExact(NavigateToTemplates({ url: "/templates" })),
    Command.resolve(NavigateToTemplates, Message.CompletedNavigateToTemplates()),
    model((current) => expect(current.catalog).toEqual(expect.objectContaining({ templates: [] }))),
  );
});
