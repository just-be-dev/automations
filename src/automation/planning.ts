import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { planOf, Plan } from "../agents/planner/plan.ts";
import { plannerTools, type PlanStore } from "../agents/planner/tools.ts";
import { AgentToolError } from "../ai/pi.ts";
import { EntityStore } from "../entities/store.ts";
import type { Workflow } from "../workflow/model.ts";
import { AutomationHost, decodeOrDrop } from "./host.ts";
import { catalogOf } from "./workflow-store.ts";

/**
 * The working copy the planner edits while it answers one message, kept under `plan` so the edits
 * survive a restart mid-answer. The draft changes only once the answer is accepted.
 */
const StoredPlan = Schema.Struct({ chatId: Schema.String, plan: Plan });

const noDesign = new AgentToolError({ message: "There is no message being answered" });

export const makePlanning = Effect.fn("Automation.makePlanning")(function* () {
  const { storage } = yield* AutomationHost;
  const entities = yield* EntityStore;

  const stored = storage.get("plan").pipe(Effect.flatMap(decodeOrDrop(StoredPlan)));

  /** Starts the working copy for `chatId` from the draft, unless a delivery already did. */
  const start = (chatId: string, draft: Workflow | undefined) =>
    stored.pipe(
      Effect.flatMap((current) =>
        current?.chatId === chatId
          ? Effect.void
          : storage.put("plan", { chatId, plan: planOf(draft) }),
      ),
    );

  const store: PlanStore = {
    read: stored.pipe(
      Effect.flatMap((current) =>
        current === undefined ? Effect.fail(noDesign) : Effect.succeed(current.plan),
      ),
    ),
    write: (plan) =>
      stored.pipe(
        Effect.flatMap((current) =>
          current === undefined
            ? Effect.fail(noDesign)
            : storage.put("plan", { chatId: current.chatId, plan }),
        ),
      ),
  };

  const tools = plannerTools(
    store,
    catalogOf(entities).pipe(
      Effect.mapError((error) => new AgentToolError({ message: error.message })),
    ),
  );

  return { start, plan: store.read.pipe(Effect.orDie), tools };
});
