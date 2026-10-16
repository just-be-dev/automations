/** Follows the planner's reply in progress and prepares subject choices for the saved automation's runs. */
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { type PendingChat, STOPPED_CHAT, subjectType, type Workflow } from "../../workflow.ts";
import { LoadAutomations, LoadSubjects, PollAutomation } from "../command.ts";
import type { Message } from "../message.ts";
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
const unfinishedReply =
  "The planner couldn't finish this draft. Ask the studio agent to try again.";

export const loadedAutomation = (
  model: Model,
  options: { readonly wasWaiting: boolean; readonly idleNotice: string },
): Update.Return<Model, Message> =>
  Option.match(model.maybePendingChat, {
    onNone: () =>
      options.wasWaiting
        ? {
            model: modifyFields(model, {
              activity: () =>
                Activity.Ready({ notice: "Draft updated. Review the graph before saving." }),
            }),
            commands: [LoadAutomations()],
          }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: options.idleNotice }),
            }),
          },
    onSome: (pending) =>
      Match.value(pending).pipe(
        Match.discriminatorsExhaustive("status")({
          // The person answers in the studio agent's panel, so keep watching for the planner to resume.
          asking: () => ({
            model: modifyFields(model, {
              activity: () =>
                Activity.Ready({ notice: "The studio agent is waiting for your answers." }),
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
          }),
        }),
      ),
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
