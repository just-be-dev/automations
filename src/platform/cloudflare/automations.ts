/** Adapts named Durable Object RPC clients to the platform-independent Automations service. */
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Automations, type AutomationClient } from "../../automation/service.ts";
import { messageOf } from "../../error.ts";
import type Automation from "./automation.ts";
import { ERASED } from "./automation.ts";

/** Bind the namespace outside; capture the request's runtime inside the returned layer. */
export const automationsLayer = (namespace: Effect.Success<typeof Automation>) =>
  Layer.effect(
    Automations,
    Effect.gen(function* () {
      const runtime = yield* Alchemy.RuntimeContext;
      const remote = <A, E>(effect: Effect.Effect<A, E, Alchemy.RuntimeContext>) =>
        Effect.provideService(effect, Alchemy.RuntimeContext, runtime);
      return Automations.of({
        get: (id): AutomationClient => {
          const stub = namespace.getByName(id);
          return {
            inspectWorkflow: () => remote(stub.inspectWorkflow()),
            overview: () => remote(stub.overview()),
            templateUses: () => remote(stub.templateUses()),
            chat: (...args) => remote(stub.chat(...args)),
            answer: (...args) => remote(stub.answer(...args)),
            save: (...args) => remote(stub.save(...args)),
            setPermissions: (...args) => remote(stub.setPermissions(...args)),
            setDraft: (...args) => remote(stub.setDraft(...args)),
            // Erasing resets the object, so a removal that finished fails the call with the reset.
            remove: (automationId) =>
              remote(stub.remove(automationId)).pipe(
                Effect.catchIf(
                  (error) => messageOf(error, "").includes(ERASED),
                  () => Effect.succeed({ removed: automationId }),
                ),
              ),
            start: (...args) => remote(stub.start(...args)),
            entityChanged: (...args) => remote(stub.entityChanged(...args)),
            eventReceived: (...args) => remote(stub.eventReceived(...args)),
            respond: (...args) => remote(stub.respond(...args)),
            resumeNow: (...args) => remote(stub.resumeNow(...args)),
            run: (...args) => remote(stub.run(...args)),
            plannerTrace: () => remote(stub.plannerTrace()),
            runTrace: (...args) => remote(stub.runTrace(...args)),
          };
        },
      });
    }),
  );
