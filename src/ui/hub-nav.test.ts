/** Checks what the studio lists in the hub shell's sidebar, and the + button's way back to the assistant. */
import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { Command, given, message, story } from "foldkit/story";
import { OpenAssistant } from "./command.ts";
import { studioUrl } from "./fixtures.ts";
import {
  type HubNav,
  type HubNavGroup,
  hubActionMessage,
  hubNavOf,
  newAutomationAction,
} from "./hub-nav.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { update } from "./update/index.ts";

const opened = (search?: string, url = studioUrl(search)) => init({ theme: "System" }, url).model;

const listed = (start: Model) =>
  update(
    start,
    Message.SucceededLoadAutomations({
      automations: [
        { id: "my-automation", name: "Manager onboarding" },
        { id: "orders", name: "Order summaries" },
      ],
    }),
  ).model;

const group = (nav: HubNav, label: string | undefined): HubNavGroup => {
  const found = nav.groups.find((candidate) => candidate.label === label);
  if (found === undefined) {
    throw new Error(`No group labelled ${label}`);
  }
  return found;
};

const summary = (nav: HubNav) =>
  nav.groups.map((navGroup) => ({
    label: navGroup.label,
    items: navGroup.items.map(({ label, href, current }) => ({ label, href, current })),
    note: navGroup.note,
    noteTone: navGroup.noteTone,
  }));

const currentLabels = (nav: HubNav) =>
  nav.groups.flatMap((navGroup) =>
    navGroup.items.filter((item) => item.current === true).map((item) => item.label),
  );

test("the nav lists the pages, every automation, and the traces, as client-side routes", () => {
  const nav = hubNavOf(listed(opened()));
  expect(nav.version).toBe(1);
  expect(nav.navigation).toBe("history");
  expect(nav.switcher).toBeUndefined();
  expect(summary(nav)).toEqual([
    {
      label: undefined,
      items: [
        { label: "Overview", href: "/", current: true },
        { label: "Templates", href: "/templates", current: undefined },
      ],
      note: undefined,
      noteTone: undefined,
    },
    {
      label: "Automations",
      items: [
        { label: "Manager onboarding", href: "/?automation=my-automation", current: undefined },
        { label: "Order summaries", href: "/?automation=orders", current: undefined },
      ],
      note: undefined,
      noteTone: undefined,
    },
    {
      label: "Debug",
      items: [{ label: "Agent traces", href: "/traces", current: undefined }],
      note: undefined,
      noteTone: undefined,
    },
  ]);
  expect(group(nav, "Automations").action).toEqual({
    label: "New automation",
    icon: expect.any(Array),
    action: newAutomationAction,
  });
});

test("every link carries a lucide icon with string attributes", () => {
  const nav = hubNavOf(listed(opened()));
  const icons = nav.groups.flatMap((navGroup) => navGroup.items.map((item) => item.icon));
  expect(icons.length).toBe(5);
  for (const icon of icons) {
    expect(icon?.length).toBeGreaterThan(0);
    for (const [tag, attributes] of icon ?? []) {
      expect(typeof tag).toBe("string");
      expect(Object.values(attributes).every((value) => typeof value === "string")).toBe(true);
    }
  }
  expect(JSON.parse(JSON.stringify(nav))).toEqual(nav);
});

test("the open page is the current item: an automation stays current on its runs", () => {
  expect(currentLabels(hubNavOf(listed(opened("automation=my-automation"))))).toEqual([
    "Manager onboarding",
  ]);
  expect(currentLabels(hubNavOf(listed(opened("automation=orders&run=run-1"))))).toEqual([
    "Order summaries",
  ]);
  expect(
    currentLabels(hubNavOf(listed(opened(undefined, { ...studioUrl(), pathname: "/templates" })))),
  ).toEqual(["Templates"]);
  expect(
    currentLabels(hubNavOf(listed(opened(undefined, { ...studioUrl(), pathname: "/traces" })))),
  ).toEqual(["Agent traces"]);
});

test("the Automations group says when it's loading, empty, or couldn't load", () => {
  const loading = group(hubNavOf(opened()), "Automations");
  expect([loading.items, loading.note, loading.noteTone]).toEqual([[], "Loading…", "muted"]);

  const empty = group(
    hubNavOf(update(opened(), Message.SucceededLoadAutomations({ automations: [] })).model),
    "Automations",
  );
  expect([empty.items, empty.note, empty.noteTone]).toEqual([[], "No automations yet.", "muted"]);

  const failed = group(
    hubNavOf(update(opened(), Message.FailedLoadAutomations({ error: "Offline" })).model),
    "Automations",
  );
  expect([failed.items, failed.note, failed.noteTone]).toEqual([
    [],
    "Couldn't load automations: Offline",
    "error",
  ]);
});

test("the nav is the same for models that differ only in what it doesn't show", () => {
  const start = listed(opened("automation=my-automation"));
  const toggled = update(start, Message.ToggledStepDetails({ stepId: "approve", isOpen: true }));
  expect(JSON.stringify(hubNavOf(toggled.model))).toBe(JSON.stringify(hubNavOf(start)));
});

test("only the + action maps to a Message", () => {
  expect(hubActionMessage(newAutomationAction)).toEqual(
    Option.some(Message.ClickedNewAutomation()),
  );
  expect(hubActionMessage("something-else")).toEqual(Option.none());
});

test("the shell's + opens the hub's assistant with a request to draft an automation", () => {
  const clicked = hubActionMessage(newAutomationAction);
  if (Option.isNone(clicked)) {
    throw new Error("The + action maps to no Message");
  }
  story(
    update,
    given(opened()),
    message(clicked.value),
    Command.expectExact(OpenAssistant({ prompt: "Create a new automation that " })),
    Command.resolve(OpenAssistant, Message.CompletedOpenAssistant()),
  );
});
