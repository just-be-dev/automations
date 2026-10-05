import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { RunSummary, Trigger } from "../../../workflow.ts";
import { errorText, loadSubjectOptions, requestJson } from "../../api.ts";
import { Message } from "./message.ts";

const OverviewResponse = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    saved: Schema.OptionFromOptional(Schema.Struct({ trigger: Trigger })),
    activeRuns: Schema.Array(RunSummary),
    lastRun: Schema.OptionFromOptional(RunSummary),
    error: Schema.OptionFromOptional(Schema.String),
  }),
);

const loadOverview = (session: number, poll: number) =>
  requestJson("/api/overview", OverviewResponse).pipe(
    Effect.map((listed) =>
      Message.SucceededLoadOverview({
        session,
        poll,
        automations: Array.map(listed, (automation) => ({
          id: automation.id,
          name: automation.name,
          maybeTrigger: Option.map(automation.saved, (saved) => saved.trigger),
          activeRuns: automation.activeRuns,
          maybeLastRun: automation.lastRun,
          maybeError: automation.error,
        })),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadOverview({ session, poll, error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  );

const pollArgs = { session: Schema.Int, poll: Schema.Int };

export const LoadOverview = Command.define("LoadOverview", {
  args: pollArgs,
  messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
  execute: ({ session, poll }) => loadOverview(session, poll),
});

/** Reloads the overview after a pause, while any run is still in flight or the last load failed. */
export const PollOverview = Command.define("PollOverview", {
  args: { ...pollArgs, delayMillis: Schema.Int },
  messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
  execute: ({ session, poll, delayMillis }) =>
    Effect.sleep(delayMillis).pipe(Effect.andThen(loadOverview(session, poll))),
});

export const LoadSubjects = Command.define("LoadSubjects", {
  args: { automationId: Schema.String, entityType: Schema.String },
  messages: [Message.SucceededLoadSubjects, Message.FailedLoadSubjects],
  execute: ({ automationId, entityType }) =>
    loadSubjectOptions(entityType).pipe(
      Effect.map(({ label, subjects }) =>
        Message.SucceededLoadSubjects({ automationId, entityType, label, subjects }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadSubjects({ automationId, entityType, error: errorText(error) }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

export const StartRun = Command.define("StartRun", {
  args: { automationId: Schema.String, maybeSubjectId: Schema.Option(Schema.String) },
  messages: [Message.SucceededStartRun, Message.FailedStartRun],
  execute: ({ automationId, maybeSubjectId }) =>
    requestJson(
      `/api/automations/${automationId}/start`,
      Schema.Struct({ id: Schema.String }),
      Option.match(maybeSubjectId, { onNone: () => ({}), onSome: (subject) => ({ subject }) }),
    ).pipe(
      Effect.map(({ id }) => Message.SucceededStartRun({ automationId, runId: id })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedStartRun({ automationId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});
