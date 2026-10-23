/** Follows the planner's reply in progress and prepares subject choices for the saved automation's runs. */
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { type PendingChat, STOPPED_CHAT, subjectType, type Workflow } from "../../workflow.ts";
import { LoadAutomations, LoadSubjects, PollAutomation, WatchAutomation } from "../command.ts";
import type { LoadedAutomation, Message } from "../message.ts";
import { Activity, type Model, SubjectChoices } from "../model.ts";

export const fail = (model: Model, error: string) => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

/** What the planner is doing while it drafts, as the server last described it. */
export const drafting = (model: Model) =>
  Activity.Working({ notice: Option.getOrElse(model.maybeProgress, () => "Thinking…") });

export const isAnswering = (pending: PendingChat) => pending.status === "working";

// People using the studio don't build software, so a failed reply never shows the technical error.
// `GET /api/automations/:id` still returns it for debugging.
const unfinishedReply = "The planner couldn't finish this draft. Ask the assistant to try again.";

/**
 * Looks again in a few seconds while the planner is idle: the hub's assistant designs from its
 * drawer, and nothing tells the page when it sends the planner a message. A page change bumps
 * `revision`, which drops the watch.
 */
const watch = (model: Model) =>
  WatchAutomation({
    automationId: model.automationId.trim(),
    revision: model.revision,
    watch: model.automationWatch,
  });

export const loadedAutomation = (
  loaded: Model,
  options: { readonly wasWaiting: boolean; readonly idleNotice: string },
): Update.Return<Model, Message> => {
  // A load starts a new watch chain; any older one's replies are dropped.
  const model = modifyFields(loaded, { automationWatch: (watch) => watch + 1 });
  return Option.match(model.maybePendingChat, {
    onNone: () =>
      options.wasWaiting
        ? {
            model: modifyFields(model, {
              activity: () =>
                Activity.Ready({ notice: "Draft updated. Review the graph before saving." }),
            }),
            commands: [LoadAutomations(), watch(model)],
          }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: options.idleNotice }),
            }),
            commands: [watch(model)],
          },
    onSome: (pending) =>
      Match.value(pending).pipe(
        Match.discriminatorsExhaustive("status")({
          // The person answers in the hub's assistant, so keep watching for the planner to resume.
          asking: () => ({
            model: modifyFields(model, {
              activity: () =>
                Activity.Ready({
                  notice: "The planner is waiting for your answers. Answer them in the assistant.",
                }),
            }),
            commands: [
              PollAutomation({ automationId: model.automationId.trim(), revision: model.revision }),
            ],
          }),
          working: () => ({
            model: modifyFields(model, { activity: () => drafting(model) }),
            commands: [
              PollAutomation({ automationId: model.automationId.trim(), revision: model.revision }),
            ],
          }),
          failed: ({ error }) => ({
            model: modifyFields(model, {
              activity: () =>
                error === STOPPED_CHAT
                  ? Activity.Ready({ notice: "The planner was stopped. The draft is unchanged." })
                  : Activity.Failed({ error: unfinishedReply }),
            }),
            commands: [watch(model)],
          }),
        }),
      ),
  });
};

/** Whether a watch found the automation as the page already shows it. */
export const unchangedAutomation = (model: Model, loaded: LoadedAutomation) =>
  JSON.stringify([
    Option.getOrNull(model.maybeDraft),
    Option.getOrNull(model.maybeSaved),
    Option.getOrNull(model.maybePendingChat),
    model.runs,
  ]) ===
  JSON.stringify([
    Option.getOrNull(loaded.maybeDraft),
    Option.getOrNull(loaded.maybeSaved),
    Option.getOrNull(loaded.maybePendingChat),
    loaded.runs,
  ]);

/** Keeps watching an idle automation, in the same chain. */
export const watchAgain = (model: Model): Update.Return<Model, Message> => ({
  model,
  commands: [watch(model)],
});

export const savedSubjectType = (maybeSaved: Option.Option<Workflow>) =>
  Option.flatMap(maybeSaved, (saved) => Option.fromNullishOr(subjectType(saved.trigger)));

export const choicesEntityType = (choices: SubjectChoices) =>
  SubjectChoices.match(choices, {
    NotNeeded: () => Option.none<string>(),
    Loading: ({ entityType }) => Option.some(entityType),
    Ready: ({ entityType }) => Option.some(entityType),
    Unavailable: () => Option.none<string>(),
  });

export const chooseSubjects = (model: Model): Update.Return<Model, Message> =>
  Option.match(savedSubjectType(model.maybeSaved), {
    onNone: () => ({
      model: modifyFields(model, {
        subjectChoices: () => SubjectChoices.NotNeeded(),
        maybeSubjectId: () => Option.none(),
      }),
    }),
    onSome: (entityType) =>
      Option.exists(choicesEntityType(model.subjectChoices), (current) => current === entityType)
        ? { model }
        : {
            model: modifyFields(model, {
              subjectChoices: () => SubjectChoices.Loading({ entityType }),
              maybeSubjectId: () => Option.none(),
            }),
            commands: [LoadSubjects({ revision: model.revision, entityType })],
          },
  });
