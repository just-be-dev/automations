/** Prepares the root app for its initial URL and preferences, loading the selected page and shared catalogues. */
import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import { LoadAutomations, LoadConnections, LoadDevelopment } from "./command.ts";
import { AutomationId } from "./domain/index.ts";
import type { Message } from "./message.ts";
import { Activity, Directory, Model, Page, SubjectChoices } from "./model.ts";
import { AppRoute, routeFromUrl } from "./route.ts";
import type { Flags } from "./theme.ts";
import { showPage } from "./update/index.ts";

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (flags, url) => {
  const route = routeFromUrl(url);
  const automationId = AppRoute.match(route, {
    Overview: () => "",
    Templates: () => "",
    Traces: () => "",
    Studio: (studio) => studio.automationId,
    Run: (run) => run.automationId,
  });
  const model = Model.make({
    maybeNavigationNotice: Option.none(),
    page: Page.Studio(),
    automationId,
    directory: Directory.Loading(),
    liveConnections: [],
    isLocalDevelopment: false,
    revision: 0,
    maybeLatestChanges: Option.none(),
    maybeDraft: Option.none(),
    maybeSaved: Option.none(),
    maybePendingChat: Option.none(),
    runs: [],
    maybeRunPanel: Option.none(),
    runPoll: 0,
    automationWatch: 0,
    subjectChoices: SubjectChoices.NotNeeded(),
    maybeSubjectId: Option.none(),
    maybeEventInput: Option.none(),
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
    commands: [...(page.commands ?? []), LoadAutomations(), LoadConnections(), LoadDevelopment()],
  };
};
