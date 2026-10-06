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
