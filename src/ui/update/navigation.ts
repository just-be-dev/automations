import * as Option from "effect/Option";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { LoadAutomation } from "../command.ts";
import { AutomationId } from "../domain/index.ts";
import { type Message, toEntitiesMessage, toOverviewMessage } from "../message.ts";
import { Activity, type Model, Page, RunDetail, SubjectChoices } from "../model.ts";
import { Entities, Overview } from "../page/index.ts";
import { AppRoute } from "../route.ts";
import { modifyOpenRun, openingRun, reloadOpenRun } from "./open-run.ts";
import { fail } from "./studio.ts";

const leaveAutomation = (model: Model, automationId: string): Model =>
  modifyFields(model, {
    automationId: () => automationId,
    automationIdInput: () => automationId,
    revision: (revision) => revision + 1,
    maybeDraft: () => Option.none(),
    maybeSaved: () => Option.none(),
    maybePendingChat: () => Option.none(),
    runs: () => [],
    maybeRunPanel: () => Option.none(),
    subjectChoices: () => SubjectChoices.NotNeeded(),
    maybeSubjectId: () => Option.none(),
    maybeProgress: () => Option.none(),
    expandedStepIds: () => [],
    conversation: () => [],
    activity: () => Activity.Working({ notice: "Loading automation…" }),
  });

/** Shows the route's page on a model already set to its automation, and loads what it needs. */
export const showPage = (model: Model, route: AppRoute): Update.Return<Model, Message> =>
  AppRoute.match(route, {
    Overview: () =>
      Update.foldChildInit(Overview.init(model.revision), {
        toParentModel: (overview) =>
          modifyFields(model, {
            page: () => Page.Overview({ overview }),
            activity: () => Activity.Ready({ notice: "" }),
          }),
        toParentMessage: toOverviewMessage,
      }),
    Entities: ({ maybeTypeName }) =>
      Update.foldChildInit(Entities.init(maybeTypeName), {
        toParentModel: (entities) =>
          modifyFields(model, {
            page: () => Page.Entities({ entities }),
            activity: () => Activity.Ready({ notice: "" }),
          }),
        toParentMessage: toEntitiesMessage,
      }),
    Studio: ({ automationId }) => {
      const studio = modifyFields(model, { page: () => Page.Studio() });
      if (!AutomationId.isValid(automationId)) {
        return fail(studio, AutomationId.invalidError);
      }
      return {
        model: studio,
        commands: [LoadAutomation({ automationId, revision: model.revision })],
      };
    },
    Run: ({ automationId, runId }) => {
      const runPage = modifyFields(model, {
        page: () => Page.Run({ openRun: openingRun(automationId, runId) }),
        activity: () => Activity.Ready({ notice: "" }),
      });
      if (!AutomationId.isValid(automationId)) {
        return {
          model: modifyOpenRun(runPage, (openRun) => ({
            ...openRun,
            detail: RunDetail.Unavailable({ error: AutomationId.invalidError }),
          })),
        };
      }
      return reloadOpenRun(runPage);
    },
  });

const routeAutomationId = (route: AppRoute) =>
  AppRoute.match(route, {
    Overview: () => "",
    Entities: () => "",
    Studio: ({ automationId }) => automationId,
    Run: ({ automationId }) => automationId,
  });

const isShowing = (model: Model, route: AppRoute) =>
  routeAutomationId(route) === model.automationId &&
  AppRoute.match(route, {
    Overview: () => false,
    Entities: () => false,
    Studio: () => Page.guards.Studio(model.page),
    Run: ({ runId }) => Page.guards.Run(model.page) && model.page.openRun.runId === runId,
  });

/**
 * Every page change starts over at a new revision, so the last page's polls and late replies stop
 * there. Following a link to the run already open reloads it.
 */
export const followRoute = (model: Model, route: AppRoute): Update.Return<Model, Message> => {
  if (AppRoute.guards.Entities(route) && Page.guards.Entities(model.page)) {
    return Update.foldChildInit(Entities.reflectUrl(model.page.entities, route.maybeTypeName), {
      toParentModel: (entities): Model =>
        modifyFields(model, { page: (): Page => Page.Entities({ entities }) }),
      toParentMessage: toEntitiesMessage,
    });
  }
  if (!isShowing(model, route)) {
    return showPage(leaveAutomation(model, routeAutomationId(route)), route);
  }
  return reloadOpenRun(model);
};

/** A run link clicked on the overview or in the studio opens the run beside it. */
export const opensInPanel = (model: Model, route: AppRoute) =>
  Page.guards.Run(model.page)
    ? Option.none<{ readonly automationId: string; readonly runId: string }>()
    : AppRoute.match(route, {
        Overview: () => Option.none(),
        Entities: () => Option.none(),
        Studio: () => Option.none(),
        Run: ({ automationId, runId }) =>
          AutomationId.isValid(automationId) ? Option.some({ automationId, runId }) : Option.none(),
      });

export const openRunPanel = (model: Model, automationId: string, runId: string) =>
  Option.exists(
    model.maybeRunPanel,
    (panel) => panel.automationId === automationId && panel.runId === runId,
  )
    ? reloadOpenRun(model)
    : reloadOpenRun(
        modifyFields(model, {
          maybeRunPanel: () => Option.some(openingRun(automationId, runId)),
        }),
      );
