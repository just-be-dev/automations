/** Keeps the overview current while runs are in flight and guides one manual launch at a time.
 * Drops outdated loads and asks the parent app to handle automation creation. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { subjectType } from "../../../workflow.ts";
import { EventInput } from "../../domain/index.ts";
import { LoadEventInput, LoadOverview, LoadSubjects, PollOverview, StartRun } from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { type Automation, isRunning, Launch, Listing, type Model, Subjects } from "./model.ts";

const pollDelayMillis = 5000;

const findAutomation = (model: Model, automationId: string) =>
  Listing.match(model.listing, {
    Loading: () => Option.none<Automation>(),
    Unavailable: () => Option.none<Automation>(),
    Ready: ({ automations }) =>
      Array.findFirst(automations, (automation) => automation.id === automationId),
  });

const startRun = (
  model: Model,
  automationId: string,
  maybeSubjectId: Option.Option<string>,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    launch: () => Launch.Starting({ automationId, maybeForm: Option.none() }),
  }),
  commands: [StartRun({ automationId, maybeSubjectId })],
});

const isChoosingFor = (launch: Launch, automationId: string, entityType: string) =>
  Launch.guards.Choosing(launch) &&
  launch.automationId === automationId &&
  Option.contains(launch.maybeEntityType, entityType) &&
  Subjects.guards.Loading(launch.subjects);

const isStarting = (launch: Launch, automationId: string) =>
  Launch.guards.Starting(launch) && launch.automationId === automationId;

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(message, {
    ClickedNewAutomation: () => ({ model, outMessage: OutMessage.RequestedNewAutomation() }),
    ClickedRunNow: ({ automationId }) => {
      if (Launch.guards.Starting(model.launch)) {
        return { model };
      }
      return Option.match(
        Option.flatMap(
          findAutomation(model, automationId),
          (automation) => automation.maybeTrigger,
        ),
        {
          onNone: () => ({ model }),
          onSome: (trigger) => {
            const maybeEntityType = Option.fromNullishOr(subjectType(trigger));
            if (trigger.kind !== "event" && Option.isNone(maybeEntityType)) {
              return startRun(model, automationId, Option.none());
            }
            return {
              model: modifyFields(model, {
                launch: () =>
                  Launch.Choosing({
                    automationId,
                    maybeEntityType,
                    subjects: Option.isSome(maybeEntityType)
                      ? Subjects.Loading()
                      : Subjects.NotNeeded(),
                    maybeSubjectId: Option.none(),
                    maybeEventInput:
                      trigger.kind === "event"
                        ? Option.some(EventInput.initial(trigger))
                        : Option.none(),
                    maybeError: Option.none(),
                  }),
              }),
              commands: [
                ...(trigger.kind === "event" ? [LoadEventInput({ automationId })] : []),
                ...Option.match(maybeEntityType, {
                  onNone: () => [],
                  onSome: (entityType) => [LoadSubjects({ automationId, entityType })],
                }),
              ],
            };
          },
        },
      );
    },
    SelectedSubject: ({ subjectId }) => {
      const launch = model.launch;
      if (!Launch.guards.Choosing(launch)) {
        return { model };
      }
      return {
        model: modifyFields(model, {
          launch: () =>
            modifyFields(launch, {
              maybeSubjectId: () => (subjectId === "" ? Option.none() : Option.some(subjectId)),
            }),
        }),
      };
    },
    GotEventInputMessage: ({ message }) => {
      const launch = model.launch;
      return Launch.guards.Choosing(launch) && Option.isSome(launch.maybeEventInput)
        ? {
            model: modifyFields(model, {
              launch: () =>
                modifyFields(launch, {
                  maybeEventInput: (maybeEditor) =>
                    Option.map(maybeEditor, (editor) => EventInput.update(editor, message)),
                  maybeError: () => Option.none(),
                }),
            }),
          }
        : { model };
    },
    SucceededLoadEventInput: ({ automationId, editor }) => {
      const launch = model.launch;
      return Launch.guards.Choosing(launch) && launch.automationId === automationId
        ? {
            model: modifyFields(model, {
              launch: () =>
                modifyFields(launch, {
                  maybeEventInput: (maybeEditor) =>
                    Option.map(maybeEditor, (current) =>
                      current.revision === 0 ? editor : current,
                    ),
                }),
            }),
          }
        : { model };
    },
    FailedLoadEventInput: () => ({ model }),
    ClickedStart: () => {
      const launch = model.launch;
      if (
        !Launch.guards.Choosing(launch) ||
        (Option.isSome(launch.maybeEntityType) && Option.isNone(launch.maybeSubjectId))
      ) {
        return { model };
      }
      if (Option.isNone(launch.maybeEventInput)) {
        return startRun(model, launch.automationId, launch.maybeSubjectId);
      }
      const parsed = EventInput.data(launch.maybeEventInput.value);
      if (Result.isFailure(parsed)) {
        return {
          model: modifyFields(model, {
            launch: () =>
              modifyFields(launch, {
                maybeError: () => Option.some(parsed.failure),
              }),
          }),
        };
      }
      return {
        model: modifyFields(model, {
          launch: () =>
            Launch.Starting({ automationId: launch.automationId, maybeForm: Option.some(launch) }),
        }),
        commands: [
          StartRun({
            automationId: launch.automationId,
            maybeSubjectId: launch.maybeSubjectId,
            event: { data: parsed.success },
          }),
        ],
      };
    },
    ClickedCancelStart: () =>
      Launch.guards.Starting(model.launch)
        ? { model }
        : { model: modifyFields(model, { launch: () => Launch.Idle() }) },
    SucceededLoadOverview: ({ session, poll, automations }) => {
      if (session !== model.session || poll !== model.poll) {
        return { model };
      }
      const loaded = modifyFields(model, { listing: () => Listing.Ready({ automations }) });
      return Array.some(automations, isRunning)
        ? {
            model: loaded,
            commands: [PollOverview({ session, poll, delayMillis: pollDelayMillis })],
          }
        : { model: loaded };
    },
    FailedLoadOverview: ({ session, poll, error }) =>
      session !== model.session || poll !== model.poll
        ? { model }
        : Listing.match(model.listing, {
            Loading: () => ({
              model: modifyFields(model, { listing: () => Listing.Unavailable({ error }) }),
            }),
            Unavailable: () => ({
              model: modifyFields(model, { listing: () => Listing.Unavailable({ error }) }),
            }),
            Ready: () => ({
              model,
              commands: [PollOverview({ session, poll, delayMillis: pollDelayMillis })],
            }),
          }),
    SucceededLoadSubjects: ({ automationId, entityType, label, subjects }) =>
      Launch.guards.Choosing(model.launch) && isChoosingFor(model.launch, automationId, entityType)
        ? {
            model: modifyFields(model, {
              launch: () =>
                Launch.guards.Choosing(model.launch)
                  ? modifyFields(model.launch, {
                      subjects: () => Subjects.Ready({ label, subjects }),
                    })
                  : model.launch,
            }),
          }
        : { model },
    FailedLoadSubjects: ({ automationId, entityType, error }) =>
      isChoosingFor(model.launch, automationId, entityType)
        ? {
            model: modifyFields(model, {
              launch: () =>
                Launch.guards.Choosing(model.launch)
                  ? modifyFields(model.launch, { subjects: () => Subjects.Unavailable({ error }) })
                  : model.launch,
            }),
          }
        : { model },
    SucceededStartRun: ({ automationId, runId }) => {
      if (!isStarting(model.launch, automationId)) {
        return { model };
      }
      const poll = model.poll + 1;
      return {
        model: modifyFields(model, {
          poll: () => poll,
          launch: () => Launch.Started({ automationId, runId }),
        }),
        commands: [LoadOverview({ session: model.session, poll })],
      };
    },
    FailedStartRun: ({ automationId, error }) =>
      isStarting(model.launch, automationId)
        ? {
            model: modifyFields(model, {
              launch: () =>
                Launch.guards.Starting(model.launch)
                  ? Option.match(model.launch.maybeForm, {
                      onNone: () => Launch.Failed({ automationId, error }),
                      onSome: (form) =>
                        Launch.Choosing(
                          modifyFields(form, { maybeError: () => Option.some(error) }),
                        ),
                    })
                  : model.launch,
            }),
          }
        : { model },
  });
