import { expect, test } from "bun:test";
import * as Option from "effect/Option";
import { given, message, model, story, Command } from "foldkit/story";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import * as Assistant from "./assistant/index.ts";
import { assistantOf, sessionId, stateOf } from "./assistant/fixtures.ts";
import { init } from "./main.ts";
import { Message, toAssistantMessage } from "./message.ts";
import { Page, type Model } from "./model.ts";
import { studioUrl } from "./fixtures.ts";
import { update } from "./update/index.ts";
import { pageContext } from "./update/assistant.ts";
import { employeesOpen } from "./page/entities/fixtures.ts";
import { welcomeOpen } from "./page/templates/fixtures.ts";
import { Message as EntityMessage, update as updateEntities } from "./page/entities/index.ts";
import { Message as TemplateMessage, update as updateTemplates } from "./page/templates/index.ts";

const root = (): Model =>
  modifyFields(init({ theme: "System", shortcutModifier: "Meta" }, studioUrl()).model, {
    assistant: () => assistantOf(),
  });
const response = (sequence: number, fields: Parameters<typeof stateOf>[0] = {}) =>
  toAssistantMessage(
    Assistant.Message.SucceededRequest({
      sessionId,
      sequence,
      state: stateOf(fields),
      sentInput: "",
    }),
  );
const templateUrl = modifyFields(studioUrl(), {
  pathname: () => "/templates",
  search: () => Option.some("template=welcome_email"),
});

test("assistant response sequencing rejects late responses and other sessions", () => {
  story(
    update,
    given(
      modifyFields(root(), {
        assistant: (assistant) => modifyFields(assistant, { sequence: () => 4 }),
      }),
    ),
    message(response(3, { status: "failed", error: "Late" })),
    message(
      toAssistantMessage(
        Assistant.Message.SucceededRequest({
          sessionId: "other",
          sequence: 4,
          state: stateOf(),
          sentInput: "",
        }),
      ),
    ),
    model((current) => expect(current.assistant.sequence).toBe(4)),
    message(response(4, { conversation: [{ id: "reply", prompt: "Hello", reply: "Current" }] })),
    model((current) =>
      expect(Option.getOrThrow(current.assistant.maybeState).conversation[0]?.reply).toBe(
        "Current",
      ),
    ),
    message(response(4, { status: "failed", error: "Duplicate" })),
    model((current) => expect(Option.getOrThrow(current.assistant.maybeState).status).toBe("idle")),
    Command.expectNone(),
  );
});

test("manual navigation retains a pending assistant, but pauses following", () => {
  const typing = update(
    root(),
    toAssistantMessage(Assistant.Message.UpdatedInput({ value: "Make a template" })),
  ).model;
  const sending = update(typing, toAssistantMessage(Assistant.Message.SubmittedChat())).model;
  const following = modifyFields(sending, {
    assistant: (assistant) => modifyFields(assistant, { follow: () => true }),
  });
  const clicked = update(
    following,
    Message.ClickedLink({ request: UrlRequest.Internal({ url: templateUrl }) }),
  );
  expect(clicked.model.assistant.sessionId).toBe(sessionId);
  expect(clicked.model.assistant.request._tag).toBe("Sending");
  expect(clicked.model.assistant.follow).toBe(false);
  const navigated = update(clicked.model, Message.ChangedUrl({ url: templateUrl })).model;
  expect(navigated.revision).toBe(1);
  const replied = update(navigated, response(1, { status: "working" }));
  expect(Option.getOrThrow(replied.model.assistant.maybeState).status).toBe("working");
  expect(replied.commands?.some((command) => command.name === "RequestAssistant")).toBe(true);
});

test("following uses real resources once, and preserves following across automatic navigation", () => {
  const following = modifyFields(root(), {
    assistant: (assistant) => modifyFields(assistant, { follow: () => true }),
  });
  const fields = {
    activities: [
      {
        id: "resource",
        label: "Editing welcome",
        status: "working",
        href: "/templates?template=welcome_email",
      },
    ],
  } satisfies Parameters<typeof stateOf>[0];
  const followed = update(following, response(0, fields));
  expect(followed.commands?.find((command) => command.name === "NavigateInternal")?.args).toEqual({
    url: "/templates?template=welcome_email",
  });
  const navigated = update(followed.model, Message.ChangedUrl({ url: templateUrl })).model;
  expect(navigated.assistant.follow).toBe(true);
  expect(
    update(navigated, response(1, fields)).commands?.some(
      (command) => command.name === "NavigateInternal",
    ) ?? false,
  ).toBe(false);
  const unsafe = update(
    following,
    response(0, {
      activities: [{ id: "outside", label: "Outside", status: "working", href: "//evil.test" }],
    }),
  );
  expect(unsafe.commands?.some((command) => command.name === "NavigateInternal") ?? false).toBe(
    false,
  );
});

test("follow and manual navigation guard dirty forms, while completed work refreshes catalog without losing edits", () => {
  const entities = updateEntities(
    employeesOpen,
    EntityMessage.ClickedEditEntity({ id: "ada" }),
  ).model;
  const templates = updateTemplates(welcomeOpen, TemplateMessage.ClickedEditTemplate()).model;
  const pages = [Page.Entities({ entities }), Page.Templates({ templates })];
  pages.forEach((page) => {
    const dirty = modifyFields(root(), {
      page: () => page,
      assistant: (assistant) => modifyFields(assistant, { follow: () => true }),
    });
    const completed = update(
      dirty,
      response(0, {
        activities: [
          { id: "resource", label: "Saved", status: "completed", href: "/?automation=new" },
        ],
      }),
    );
    expect(
      completed.commands?.some((command) => command.name === "NavigateInternal") ?? false,
    ).toBe(false);
    expect(
      completed.commands?.some(
        (command) => command.name === "LoadTypes" || command.name === "LoadCatalog",
      ),
    ).toBe(true);
    expect(completed.model.page).toEqual(page);
    const clicked = update(
      dirty,
      Message.ClickedLink({ request: UrlRequest.Internal({ url: studioUrl() }) }),
    );
    expect(clicked.commands).toBeUndefined();
    expect(clicked.model.page).toEqual(page);
    expect(Option.isSome(clicked.model.maybeNavigationNotice)).toBe(true);
  });
  expect(pageContext(modifyFields(root(), { page: () => Page.Entities({ entities }) }))).toEqual({
    pathname: "/entities",
    entityType: "employee",
    entityId: "ada",
  });
});

test("pending assistant turns keep the next message without submitting it", () => {
  const statuses: ReadonlyArray<"working" | "confirming" | "asking"> = [
    "working",
    "confirming",
    "asking",
  ];
  statuses.forEach((status) => {
    const pending = modifyFields(root(), {
      assistant: () => assistantOf({ status }),
    });
    const typed = update(
      pending,
      toAssistantMessage(Assistant.Message.UpdatedInput({ value: "Next request" })),
    ).model;
    const submitted = update(typed, toAssistantMessage(Assistant.Message.SubmittedChat()));
    expect(submitted.commands ?? []).toEqual([]);
    expect(submitted.model.assistant.input).toBe("Next request");
  });
});

test("collapsed assistant continues polling, and unsent planner and new-automation descriptions prevent following", () => {
  const collapsed = modifyFields(root(), {
    assistant: (assistant) => modifyFields(assistant, { collapsed: () => true }),
  });
  expect(
    update(collapsed, response(0, { status: "working" })).commands?.some(
      (command) => command.name === "RequestAssistant",
    ),
  ).toBe(true);
  const planner = modifyFields(root(), {
    automationId: () => "studio",
    page: () => Page.Studio(),
    messageInputs: () => ({ studio: "Keep this planner message" }),
  });
  const newAutomation = update(
    update(root(), Message.ClickedNewAutomation()).model,
    Message.UpdatedNewAutomationDescription({ value: "Keep this description" }),
  ).model;
  [planner, newAutomation].forEach((dirty) => {
    const following = modifyFields(dirty, {
      assistant: (assistant) => modifyFields(assistant, { follow: () => true }),
    });
    expect(
      update(
        following,
        response(0, {
          activities: [{ id: "resource", label: "Created", status: "working", href: "/templates" }],
        }),
      ).commands?.some((command) => command.name === "NavigateInternal") ?? false,
    ).toBe(false);
  });
});
