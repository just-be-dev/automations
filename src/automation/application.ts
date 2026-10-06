import * as Effect from "effect/Effect";
import { makeDesignSession } from "./design-session.ts";
import { makeRuns } from "./runs.ts";
import { makeWorkflowStore } from "./workflow-store.ts";

/** One automation's facade. Design and execution have independent instance-bound lifecycles. */
export const makeAutomation = Effect.fn("Automation.make")(function* () {
  const workflows = yield* makeWorkflowStore();
  const design = yield* makeDesignSession(workflows);
  const runs = yield* makeRuns(workflows);

  const inspectWorkflow = Effect.fn("Automation.inspectWorkflow")(function* () {
    const session = yield* design.inspect();
    const recent = yield* runs.summaries;
    return { ...session, runs: recent.slice(0, 20) };
  });

  /** Saved trigger, every run still in flight however old, and the latest run. */
  const overview = Effect.fn("Automation.overview")(function* () {
    const saved = yield* workflows.read("saved");
    const summaries = yield* runs.summaries;
    return {
      ...(saved === undefined ? {} : { saved: { trigger: saved.trigger } }),
      activeRuns: summaries.filter((run) => run.status === "running" || run.status === "waiting"),
      ...(summaries[0] === undefined ? {} : { lastRun: summaries[0] }),
    };
  });

  return {
    callbacks: { ...runs.callbacks, planReply: design.planReply },
    inspectWorkflow,
    overview,
    chat: design.chat,
    save: workflows.save,
    setPermissions: design.setPermissions,
    start: runs.start,
    entityChanged: runs.entityChanged,
    respond: runs.respond,
    run: runs.run,
  };
});

/** Public operations shared by the local application and a remote automation client. */
export type AutomationApplication = Omit<
  Effect.Success<ReturnType<typeof makeAutomation>>,
  "callbacks"
>;
