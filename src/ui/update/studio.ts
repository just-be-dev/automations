/** Guides chat submission and pending replies and prepares subject choices for the saved automation's runs. */
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { type PendingChat, subjectType, type Workflow } from "../../workflow.ts";
import { LoadAutomations, LoadSubjects, PollAutomation, SendMessage } from "../command.ts";
import { maxMessageLength } from "../constant.ts";
import { AutomationId } from "../domain/index.ts";
import type { Message } from "../message.ts";
import { Activity, type Model, modifyMessageInput, SubjectChoices } from "../model.ts";

export const fail = (model: Model, error: string) => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

export const thinking = Activity.Working({ notice: "The agent is thinking…" });

/** Sends `message` to the open automation's agent, unless it's busy or the message won't do. */
export const sendMessage = (model: Model, message: string): Update.Return<Model, Message> => {
  if (Activity.guards.Working(model.activity)) {
    return { model };
  }
  if (!AutomationId.isValid(model.automationId)) {
    return fail(model, "Use an alphanumeric automation ID");
  }
  if (!message.trim() || message.length > maxMessageLength) {
    return fail(model, "Message must be 1–10,000 characters");
  }
  return {
    model: modifyFields(model, {
      activity: () => Activity.Working({ notice: "Sending message…" }),
    }),
    commands: [
      SendMessage({ automationId: model.automationId.trim(), revision: model.revision, message }),
    ],
  };
};

export const isAnswering = (pending: PendingChat) => pending.status === "working";

// People using the studio don't build software, so a failed reply never shows the technical error.
// `GET /api/automations/:id` still returns it for debugging.
const unfinishedReply = "The agent couldn't finish its reply. Send your message again to retry.";

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
          asking: () => ({
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: "The agent is waiting for your answers." }),
            }),
          }),
          working: () => ({
            model: modifyFields(model, { activity: () => thinking }),
            commands: [
              PollAutomation({ automationId: model.automationId.trim(), revision: model.revision }),
            ],
          }),
          failed: ({ prompt }) => ({
            model: modifyFields(
              modifyMessageInput(model, (value) => (value === "" ? prompt : value)),
              { activity: () => Activity.Failed({ error: unfinishedReply }) },
            ),
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
