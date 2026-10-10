/** Exercises template details and editing, including usage warnings and links to affected automations. */
import { test } from "bun:test";
import * as Option from "effect/Option";
import {
  Command,
  click,
  expect,
  given,
  Mount,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from "foldkit/scene";
import { welcome, welcomeOpen } from "./fixtures.ts";
import { Message, SaveTemplate, init, update, view } from "./index.ts";
import * as Change from "../../change/index.ts";
import { proposalOf } from "../../change/fixtures.ts";
import { DeleteTemplate } from "./command.ts";
import { openedResolvers, closedResolvers } from "../../change/test-resolvers.test.ts";
import { Dialog } from "@foldkit/ui";

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
    Command.resolve(
      DeleteTemplate,
      Message.GotChangeMessage({
        message: Change.Message.SucceededPrepare({
          proposal: proposalOf({ kind: "deleteTemplate", name: "welcome_email" }),
        }),
      }),
    ),
    Command.resolveAll(...openedResolvers()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(text("Server supplied consequence; do not replace this wording.")).toExist(),
    expect(text("Before: Previous name")).toExist(),
    expect(text("After: Reviewed name")).toExist(),
  );
});

test("editing a template warns that it changes the runs that start afterwards", () => {
  scene(
    { update, view },
    given(welcomeOpen),
    click(role("button", { name: "Edit template" })),
    expect(label("ID")).toHaveAttr("data-readonly"),
    type(label("Name"), "Welcome aboard"),
    expect(label("ID")).toHaveValue("welcome_email"),
    expect(text(/2 automations use this template/)).toExist(),
    type(label("Text (subject)"), "Welcome, {{hire.name}}!"),
    submit(role("form", { name: "Edit welcome_email" })),
    Command.expectExact(
      SaveTemplate({
        template: {
          ...welcome,
          label: "Welcome aboard",
          content: { ...welcome.content, subject: "Welcome, {{hire.name}}!" },
        },
        isNew: false,
      }),
    ),
    Command.resolve(
      SaveTemplate,
      Message.GotChangeMessage({
        message: Change.Message.SucceededPrepare({
          proposal: proposalOf({ kind: "putTemplate", template: welcome }),
        }),
      }),
    ),
    Command.resolveAll(...openedResolvers()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    click(role("button", { name: "Apply reviewed change" })),
    Command.resolve(
      Change.DecideChange,
      Change.Message.SucceededDecision({
        proposalId: "proposal-1",
        decision: { status: "applied", result: welcome },
      }),
    ),
    Command.resolveAll(...closedResolvers()),
    Mount.expectEnded(Dialog.AcquireResources),
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

test("creating a template derives an editable ID and removes only the chosen content", () => {
  scene(
    { update, view },
    given(
      update(init(Option.none()).model, Message.SucceededLoadCatalog({ templates: [], types: [] }))
        .model,
    ),
    click(role("button", { name: "New template" })),
    expect(role("heading", { name: "Create template" })).toExist(),
    type(label("Name"), "Café Welcome Email!"),
    expect(label("ID")).toHaveValue("cafe_welcome_email"),
    type(label("ID"), "Employee-Welcome V2"),
    expect(label("ID")).toHaveValue("employee_welcome_v2"),
    expect(label("Name")).toHaveValue("Café Welcome Email!"),
    type(label("Description"), "Welcome wording for new employees."),
    type(label("Input name (new input)"), "body"),
    type(label("Text (body)"), "This content will be removed."),
    click(role("button", { name: "Add input" })),
    type(label("Input name (new input)"), "subject"),
    type(label("Text (subject)"), "Welcome aboard!"),
    click(role("button", { name: "Remove input body" })),
    expect(label("Text (body)")).not.toExist(),
    expect(label("Text (subject)")).toHaveValue("Welcome aboard!"),
    submit(role("form", { name: "New template" })),
    Command.expectExact(
      SaveTemplate({
        template: {
          name: "employee_welcome_v2",
          label: "Café Welcome Email!",
          description: "Welcome wording for new employees.",
          slots: [],
          content: { subject: "Welcome aboard!" },
        },
        isNew: true,
      }),
    ),
    Command.resolve(SaveTemplate, Message.FailedRequest({ error: "Try again" })),
  );
});
