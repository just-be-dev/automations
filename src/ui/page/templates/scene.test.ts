import { test } from "bun:test";
import * as Option from "effect/Option";
import {
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from "foldkit/scene";
import { welcome, welcomeOpen } from "./fixtures.ts";
import { Message, SaveTemplate, init, update, view } from "./index.ts";

test("a template shows its slots, its content, and the automations that use it", () => {
  scene(
    { update, view },
    given(welcomeOpen),
    expect(role("link", { name: /Welcome email/ })).toHaveAttr("aria-current", "page"),
    expect(role("table", { name: "Welcome email slots" })).toContainText("ref → employee"),
    expect(role("region", { name: "Content" })).toContainText("Welcome, hire.name"),
    expect(role("link", { name: /Onboard new hires/ })).toHaveAttr(
      "href",
      "/?automation=onboarding",
    ),
    expect(role("link", { name: /Onboard new hires/ })).toContainText("Saved and draft"),
    expect(role("link", { name: /Remind hires/ })).toContainText("Draft only"),
    expect(text("Couldn't check Broken automation: Reset")).toExist(),
    click(role("button", { name: "Delete" })),
    expect(
      text("Delete welcome_email? 2 automations use it, and their runs will fail until they stop."),
    ).toExist(),
  );
});

test("editing a template warns that it changes the runs that start afterwards", () => {
  scene(
    { update, view },
    given(welcomeOpen),
    click(role("button", { name: "Edit template" })),
    expect(label("Name")).toHaveAttr("data-readonly"),
    expect(text(/2 automations use this template/)).toExist(),
    type(label("Text (subject)"), "Welcome, {{hire.name}}!"),
    submit(role("form", { name: "Edit welcome_email" })),
    Command.expectExact(
      SaveTemplate({
        template: {
          ...welcome,
          content: { ...welcome.content, subject: "Welcome, {{hire.name}}!" },
        },
        isNew: false,
      }),
    ),
    Command.resolve(
      SaveTemplate,
      Message.SucceededSaveTemplate({ template: welcome, isNew: false }),
    ),
    expect(role("status")).toHaveText("Saved welcome_email"),
  );
});

test("with no template chosen, the page explains templates", () => {
  scene(
    { update, view },
    given(
      update(init(Option.none()).model, Message.SucceededLoadCatalog({ templates: [], types: [] }))
        .model,
    ),
    expect(text("No templates yet.")).toExist(),
    expect(role("button", { name: "New template" })).toExist(),
  );
});
