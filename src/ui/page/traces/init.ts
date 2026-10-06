import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import { LoadAutomations, LoadRuns, LoadTrace } from "./command.ts";
import {
  Automations,
  isSameId,
  isSameSource,
  Model,
  Runs,
  type Source,
  TraceState,
} from "./model.ts";
import type { UpdateReturn } from "./update.ts";

const automationOf = (maybeSource: Option.Option<Source>) =>
  Option.map(maybeSource, (source) => source.automationId);

const runsFor = (maybeSource: Option.Option<Source>) =>
  Option.match(maybeSource, {
    onNone: () => Runs.NotSelected(),
    onSome: ({ automationId }) => Runs.Loading({ automationId }),
  });

const traceFor = (maybeSource: Option.Option<Source>) =>
  Option.match(maybeSource, {
    onNone: () => TraceState.NotSelected(),
    onSome: () => TraceState.Loading(),
  });

export const loadRuns = (maybeSource: Option.Option<Source>) =>
  Option.match(maybeSource, {
    onNone: () => [],
    onSome: ({ automationId }) => [LoadRuns({ automationId })],
  });

export const loadTrace = (maybeSource: Option.Option<Source>, load: number) =>
  Option.match(maybeSource, {
    onNone: () => [],
    onSome: ({ automationId, maybeRunId }) => [LoadTrace({ load, automationId, maybeRunId })],
  });

export const init = (maybeSource: Option.Option<Source>): UpdateReturn => ({
  model: Model.make({
    maybeSource,
    automations: Automations.Loading(),
    runs: runsFor(maybeSource),
    trace: traceFor(maybeSource),
    load: 0,
  }),
  commands: [LoadAutomations(), ...loadRuns(maybeSource), ...loadTrace(maybeSource, 0)],
});

/** Opens the trace the URL selects, keeping the run list while the automation stays the same. */
export const reflectUrl = (model: Model, maybeSource: Option.Option<Source>): UpdateReturn => {
  if (isSameSource(model.maybeSource, maybeSource)) {
    return { model };
  }
  const isSameAutomation = isSameId(automationOf(model.maybeSource), automationOf(maybeSource));
  const load = model.load + 1;
  return {
    model: modifyFields(model, {
      maybeSource: () => maybeSource,
      runs: (runs) => (isSameAutomation ? runs : runsFor(maybeSource)),
      trace: () => traceFor(maybeSource),
      load: () => load,
    }),
    commands: [...(isSameAutomation ? [] : loadRuns(maybeSource)), ...loadTrace(maybeSource, load)],
  };
};
