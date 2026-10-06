/** Refreshes the trace debugger's data while keeping the current conversation visible until its replacement arrives. */
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { LoadAutomations } from "./command.ts";
import { loadRuns, loadTrace } from "./init.ts";
import { Message } from "./message.ts";
import { Automations, type Model, Runs, TraceState } from "./model.ts";

export type UpdateReturn = Update.Return<Model, Message>;

const isShowingAutomation = (model: Model, automationId: string) =>
  Option.exists(model.maybeSource, (source) => source.automationId === automationId);

const refreshing = (trace: TraceState) =>
  TraceState.match(trace, {
    NotSelected: () => trace,
    Loading: () => trace,
    Ready: ({ trace: shown }) => TraceState.Refreshing({ trace: shown }),
    Refreshing: () => trace,
    Unavailable: () => TraceState.Loading(),
  });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedRefresh: () => {
      const load = model.load + 1;
      return {
        model: modifyFields(model, { trace: refreshing, load: () => load }),
        commands: [
          LoadAutomations(),
          ...loadRuns(model.maybeSource),
          ...loadTrace(model.maybeSource, load),
        ],
      };
    },
    SucceededLoadAutomations: ({ automations }) => ({
      model: modifyFields(model, { automations: () => Automations.Ready({ automations }) }),
    }),
    FailedLoadAutomations: ({ error }) => ({
      model: modifyFields(model, { automations: () => Automations.Unavailable({ error }) }),
    }),
    SucceededLoadRuns: ({ automationId, runs }) =>
      isShowingAutomation(model, automationId)
        ? { model: modifyFields(model, { runs: () => Runs.Ready({ automationId, runs }) }) }
        : { model },
    FailedLoadRuns: ({ automationId, error }) =>
      isShowingAutomation(model, automationId)
        ? { model: modifyFields(model, { runs: () => Runs.Unavailable({ automationId, error }) }) }
        : { model },
    SucceededLoadTrace: ({ load, trace }) =>
      load === model.load
        ? { model: modifyFields(model, { trace: () => TraceState.Ready({ trace }) }) }
        : { model },
    FailedLoadTrace: ({ load, error }) =>
      load === model.load
        ? { model: modifyFields(model, { trace: () => TraceState.Unavailable({ error }) }) }
        : { model },
  });
