import * as Option from "effect/Option";
import { Command, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { PageContext } from "../../assistant/model.ts";
import * as Assistant from "../assistant/index.ts";
import { LoadAutomation, LoadAutomations, LoadRoles, NavigateInternal } from "../command.ts";
import {
  Message,
  toAssistantMessage,
  toEntitiesMessage,
  toOverviewMessage,
  toTemplatesMessage,
} from "../message.ts";
import { type Model, messageInputOf, Page } from "../model.ts";
import { LoadTypes, LoadEntities } from "../page/entities/command.ts";
import { LoadCatalog, LoadUsage } from "../page/templates/command.ts";
import { LoadOverview } from "../page/overview/command.ts";
import { automationHref, entitiesHref, runHref, templatesHref, tracesHref } from "../route.ts";

export const dirtyForms = (model: Model) =>
  (model.newAutomationDialog.isOpen && model.newAutomation.description.trim() !== "") ||
  Page.match(model.page, {
    Overview: () => false,
    Run: () => false,
    Studio: () => false,
    Traces: () => false,
    Entities: ({ entities }) =>
      entities.typeEditor._tag !== "Closed" ||
      entities.entityEditor._tag !== "Closed" ||
      entities.activity._tag === "Working",
    Templates: ({ templates }) =>
      templates.editor._tag !== "Closed" || templates.activity._tag === "Working",
  });
export const dirtyPage = (model: Model) => dirtyForms(model) || messageInputOf(model).trim() !== "";
export const pageHref = (model: Model) =>
  Page.match(model.page, {
    Overview: () => "/",
    Studio: () => automationHref(model.automationId),
    Run: ({ openRun }) => runHref(openRun.automationId, openRun.runId),
    Entities: ({ entities }) => entitiesHref(entities.maybeTypeName),
    Templates: ({ templates }) => templatesHref(templates.maybeTemplateName),
    Traces: ({ traces }) =>
      Option.match(traces.maybeSource, {
        onNone: () => "/traces",
        onSome: (source) => tracesHref(Option.some(source.automationId), source.maybeRunId),
      }),
  });
export const pageContext = (model: Model): PageContext => {
  const context = Page.match<PageContext>(model.page, {
    Overview: () => ({ pathname: "/" }),
    Studio: () => ({ pathname: "/", automationId: model.automationId }),
    Run: ({ openRun }) => ({
      pathname: "/",
      automationId: openRun.automationId,
      runId: openRun.runId,
    }),
    Templates: ({ templates }) => ({
      pathname: "/templates",
      ...Option.match(templates.maybeTemplateName, {
        onNone: () => ({}),
        onSome: (template) => ({ template }),
      }),
    }),
    Entities: ({ entities }) => ({
      pathname: "/entities",
      ...Option.match(entities.maybeTypeName, {
        onNone: () => ({}),
        onSome: (entityType) => ({ entityType }),
      }),
      ...(entities.entityEditor._tag === "Editing"
        ? { entityId: entities.entityEditor.draft.id }
        : {}),
    }),
    Traces: ({ traces }) =>
      Option.match(traces.maybeSource, {
        onNone: () => ({ pathname: "/traces" }),
        onSome: (source) => ({
          pathname: "/traces",
          automationId: source.automationId,
          ...Option.match(source.maybeRunId, {
            onNone: () => ({}),
            onSome: (runId) => ({ runId }),
          }),
        }),
      }),
  });
  return Option.match(model.maybeRunPanel, {
    onNone: () => context,
    onSome: (panel) => ({ ...context, automationId: panel.automationId, runId: panel.runId }),
  });
};
export const refreshResources = (model: Model): Update.Return<Model, Message> => ({
  model,
  commands: [
    LoadAutomations(),
    LoadRoles(),
    ...Page.match(model.page, {
      Overview: ({ overview }) =>
        Command.mapMessages(
          [LoadOverview({ session: overview.session, poll: overview.poll })],
          toOverviewMessage,
        ),
      Studio: () =>
        dirtyPage(model)
          ? []
          : [LoadAutomation({ automationId: model.automationId, revision: model.revision })],
      Run: () => [],
      Traces: () => [],
      Entities: ({ entities }) =>
        Command.mapMessages(
          [
            LoadTypes(),
            ...Option.match(entities.maybeTypeName, {
              onNone: () => [],
              onSome: (type) => [LoadEntities({ type })],
            }),
          ],
          toEntitiesMessage,
        ),
      Templates: ({ templates }) =>
        Command.mapMessages(
          [
            LoadCatalog(),
            ...Option.match(templates.maybeTemplateName, {
              onNone: () => [],
              onSome: (name) => [LoadUsage({ name })],
            }),
          ],
          toTemplatesMessage,
        ),
    }),
  ],
});
export const foldAssistant = (model: Model, message: Assistant.Message) =>
  Update.foldChild({
    update: Assistant.update(pageContext(model), dirtyPage(model)),
    read: (model: Model) => Option.some(model.assistant),
    write: (model: Model, nextAssistant: Assistant.Model) =>
      modifyFields(model, { assistant: () => nextAssistant }),
    toParentMessage: toAssistantMessage,
    foldOutMessage:
      (outMessage: Assistant.OutMessage) =>
      (model: Model): Update.Return<Model, Message> =>
        Assistant.OutMessage.match(outMessage, {
          UpdatedResources: () => refreshResources(model),
          RequestedFollow: ({ href, completed }) => {
            const refreshed = completed ? refreshResources(model) : { model };
            return {
              model: modifyFields(refreshed.model, { maybeFollowHref: () => Option.some(href) }),
              commands: [...(refreshed.commands ?? []), NavigateInternal({ url: href })],
            };
          },
        }),
  })(model, message);
