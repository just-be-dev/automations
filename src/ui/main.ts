import * as Option from "effect/Option";
import type { Runtime } from "foldkit";
import * as Dialog from "@/components/ui/dialog";
import { LoadAutomations, LoadRoles } from "./command.ts";
import { AutomationId } from "./domain/index.ts";
import type { Message } from "./message.ts";
import { newAutomationDialogId, newAutomationDescriptionId } from "./constant.ts";
import {
  Activity,
  blankNewAutomation,
  Directory,
  Model,
  Page,
  RoleChoices,
  SubjectChoices,
} from "./model.ts";
import { AppRoute, routeFromUrl } from "./route.ts";
import type { Flags } from "./theme.ts";
import { showPage } from "./update/index.ts";

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (flags, url) => {
  const route = routeFromUrl(url);
  const automationId = AppRoute.match(route, {
    Overview: () => "",
    Templates: () => "",
    Entities: () => "",
    Studio: (studio) => studio.automationId,
    Run: (run) => run.automationId,
  });
  const model = Model.make({
    page: Page.Studio(),
    automationId,
    directory: Directory.Loading(),
    newAutomationDialog: Dialog.init({
      id: newAutomationDialogId,
      focusSelector: `#${newAutomationDescriptionId}`,
    }),
    newAutomation: blankNewAutomation,
    roles: RoleChoices.Loading(),
    revision: 0,
    messageInputs: {},
    conversation: [],
    maybeDraft: Option.none(),
    maybeSaved: Option.none(),
    maybePendingChat: Option.none(),
    maybeQuestionnaire: Option.none(),
    runs: [],
    maybeRunPanel: Option.none(),
    runPoll: 0,
    subjectChoices: SubjectChoices.NotNeeded(),
    maybeSubjectId: Option.none(),
    maybeProgress: Option.none(),
    expandedStepIds: [],
    workflowDisplay: "Steps",
    theme: flags.theme,
    shortcutModifier: flags.shortcutModifier,
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
