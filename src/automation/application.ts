/** Joins independent design and execution lifecycles into one automation's public operations and reads. */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { usedTemplates } from "../entities/templates.ts";
import { nextOccurrence } from "../workflow/schedule.ts";
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

  /**
   * Saved trigger and when its schedule next starts runs, every run still in flight however old,
   * and the latest run.
   */
  const overview = Effect.fn("Automation.overview")(function* () {
    const saved = yield* workflows.read("saved");
    const summaries = yield* runs.summaries;
    const now = yield* Clock.currentTimeMillis;
    const trigger = saved?.trigger;
    return {
      ...(trigger === undefined
        ? {}
        : {
            saved: {
              trigger,
              ...(trigger.kind === "schedule" ? { nextRunAt: nextOccurrence(trigger, now) } : {}),
            },
          }),
      activeRuns: summaries.filter((run) => run.status === "running" || run.status === "waiting"),
      ...(summaries[0] === undefined ? {} : { lastRun: summaries[0] }),
    };
  });

  /** The templates the saved workflow and the draft use, by name. */
  const templateUses = Effect.fn("Automation.templateUses")(function* () {
    const saved = yield* workflows.read("saved");
    const draft = yield* workflows.read("draft");
    return {
      saved: saved === undefined ? [] : usedTemplates(saved),
      draft: draft === undefined ? [] : usedTemplates(draft),
    };
  });

  return {
    callbacks: { ...runs.callbacks, planReply: design.planReply },
    inspectWorkflow,
    overview,
    templateUses,
    chat: design.chat,
    answer: design.answer,
    save: workflows.save,
    setPermissions: design.setPermissions,
    start: runs.start,
    entityChanged: runs.entityChanged,
    respond: runs.respond,
    run: runs.run,
    plannerTrace: design.plannerTrace,
    runTrace: runs.runTrace,
  };
});

/** Public operations shared by the local application and a remote automation client. */
export type AutomationApplication = Omit<
  Effect.Success<ReturnType<typeof makeAutomation>>,
  "callbacks"
>;
