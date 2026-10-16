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
import { pageContext, startAssistantThread } from "./update/assistant.ts";
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

test("collapsed assistant continues polling", () => {
  const collapsed = modifyFields(root(), {
    assistant: (assistant) => modifyFields(assistant, { collapsed: () => true }),
  });
  expect(
    update(collapsed, response(0, { status: "working" })).commands?.some(
      (command) => command.name === "RequestAssistant",
    ),
  ).toBe(true);
});

test("a new automation opens the collapsed assistant on a fresh thread with the request started", () => {
  const collapsed = modifyFields(root(), {
    assistant: (assistant) => modifyFields(assistant, { collapsed: () => true }),
  });
  const requested = startAssistantThread(collapsed, "Draft an automation that ");
  expect(requested.model.assistant.collapsed).toBe(false);
  expect(requested.commands?.map((command) => command.name)).toEqual([
    "CreateThread",
    "PersistCollapsed",
  ]);
  const created = update(
    requested.model,
    toAssistantMessage(
      Assistant.Message.CompletedCreateThread({
        sessionId: "c3a1e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c5d",
        input: "Draft an automation that ",
      }),
    ),
  );
  expect(created.model.assistant.sessionId).toBe("c3a1e2b4-5d6f-4a7b-8c9d-0e1f2a3b4c5d");
  expect(created.model.assistant.input).toBe("Draft an automation that ");
  expect(Option.isNone(created.model.assistant.maybeState)).toBe(true);
  expect(created.commands?.map((command) => command.name)).toEqual([
    "RequestAssistant",
    "FocusInput",
  ]);
  // A late reply for the previous thread is ignored.
  expect(Option.isNone(update(created.model, response(1)).model.assistant.maybeState)).toBe(true);
});

test("archiving the open thread moves on to a fresh one; archiving another doesn't", () => {
  const threads = [
    { id: sessionId, createdAt: 0, updatedAt: 0, archived: true },
    { id: "other", createdAt: 0, updatedAt: 0, archived: true },
  ];
  const archivedOpen = update(
    root(),
    toAssistantMessage(
      Assistant.Message.SucceededArchiveThread({ sessionId, archived: true, threads }),
    ),
  );
  expect(archivedOpen.commands?.map((command) => command.name)).toEqual(["CreateThread"]);
  const archivedOther = update(
    root(),
    toAssistantMessage(
      Assistant.Message.SucceededArchiveThread({ sessionId: "other", archived: true, threads }),
    ),
  );
  expect(archivedOther.commands ?? []).toEqual([]);
});

test("opening a thread doesn't follow its earlier activities", () => {
  const following = modifyFields(root(), {
    assistant: (assistant) =>
      modifyFields(assistant, { follow: () => true, maybeState: () => Option.none() }),
  });
  const opened = update(
    following,
    response(0, {
      activities: [
        { id: "old", label: "Old", status: "completed", href: "/templates?template=welcome_email" },
      ],
    }),
  );
  expect(opened.commands?.some((command) => command.name === "NavigateInternal") ?? false).toBe(
    false,
  );
  expect(opened.model.assistant.seenActivities).toEqual(["old:/templates?template=welcome_email"]);
});
