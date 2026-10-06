/** Keeps the overview current while runs are in flight and guides one manual launch at a time.
 * Drops outdated loads and asks the parent app to handle automation creation. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { subjectType } from "../../../workflow.ts";
import { LoadOverview, LoadSubjects, PollOverview, StartRun } from "./command.ts";
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
  model: modifyFields(model, { launch: () => Launch.Starting({ automationId }) }),
  commands: [StartRun({ automationId, maybeSubjectId })],
});

const isChoosingFor = (launch: Launch, automationId: string, entityType: string) =>
  Launch.guards.Choosing(launch) &&
  launch.automationId === automationId &&
  launch.entityType === entityType &&
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
          onSome: (trigger) =>
            Option.match(Option.fromNullishOr(subjectType(trigger)), {
              onNone: () => startRun(model, automationId, Option.none()),
              onSome: (entityType) => ({
                model: modifyFields(model, {
                  launch: () =>
                    Launch.Choosing({
                      automationId,
                      entityType,
                      subjects: Subjects.Loading(),
                      maybeSubjectId: Option.none(),
                    }),
                }),
                commands: [LoadSubjects({ automationId, entityType })],
              }),
            }),
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
            Launch.Choosing({
              ...launch,
              maybeSubjectId: subjectId === "" ? Option.none() : Option.some(subjectId),
            }),
        }),
      };
    },
    ClickedStart: () =>
      Launch.guards.Choosing(model.launch) && Option.isSome(model.launch.maybeSubjectId)
        ? startRun(model, model.launch.automationId, model.launch.maybeSubjectId)
        : { model },
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
      isChoosingFor(model.launch, automationId, entityType)
        ? {
            model: modifyFields(model, {
              launch: () =>
                Launch.Choosing({
                  automationId,
                  entityType,
                  subjects: Subjects.Ready({ label, subjects }),
                  maybeSubjectId: Option.none(),
                }),
            }),
          }
        : { model },
    FailedLoadSubjects: ({ automationId, entityType, error }) =>
      isChoosingFor(model.launch, automationId, entityType)
        ? {
            model: modifyFields(model, {
              launch: () =>
                Launch.Choosing({
                  automationId,
                  entityType,
                  subjects: Subjects.Unavailable({ error }),
                  maybeSubjectId: Option.none(),
                }),
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
        ? { model: modifyFields(model, { launch: () => Launch.Failed({ automationId, error }) }) }
        : { model },
  });
