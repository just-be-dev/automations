import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { LoadAutomations, LoadRoles } from "./command.ts";
import { AutomationId } from "./domain/index.ts";
import type { Message } from "./message.ts";
import { Activity, Directory, Model, Page, RoleChoices, SubjectChoices } from "./model.ts";
import { AppRoute, routeFromUrl } from "./route.ts";
import type { Flags } from "./theme.ts";
import { showPage } from "./update/index.ts";

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (flags, url) => {
  const route = routeFromUrl(url);
  const automationId = AppRoute.match(route, {
    Overview: () => "",
    Entities: () => "",
    Studio: (studio) => studio.automationId,
    Run: (run) => run.automationId,
  });
  const model = Model.make({
    page: Page.Studio(),
    automationId,
    automationIdInput: automationId,
    directory: Directory.Loading(),
    roles: RoleChoices.Loading(),
    revision: 0,
    messageInput: "",
    conversation: [],
    maybeDraft: Option.none(),
    maybeSaved: Option.none(),
    maybePendingChat: Option.none(),
    runs: [],
    maybeRunPanel: Option.none(),
    runPoll: 0,
    subjectChoices: SubjectChoices.NotNeeded(),
    maybeSubjectId: Option.none(),
    maybeProgress: Option.none(),
    expandedStepIds: [],
    workflowDisplay: "Steps",
    theme: flags.theme,
    activity: AutomationId.isValid(automationId)
      ? Activity.Working({ notice: "Loading automation…" })
      : Activity.Failed({ error: AutomationId.invalidError }),
  });
  const page = showPage(model, route);
  return {
    model: page.model,
    commands: [...(page.commands ?? []), LoadAutomations(), LoadRoles()],
  };
};
