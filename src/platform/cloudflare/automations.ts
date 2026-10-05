import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Automations, type AutomationClient } from "../../automation/service.ts";
import type Automation from "./automation.ts";

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
            chat: (...args) => remote(stub.chat(...args)),
            save: () => remote(stub.save()),
            setPermissions: (...args) => remote(stub.setPermissions(...args)),
            start: (...args) => remote(stub.start(...args)),
            entityChanged: (...args) => remote(stub.entityChanged(...args)),
            respond: (...args) => remote(stub.respond(...args)),
            run: (...args) => remote(stub.run(...args)),
          };
        },
      });
    }),
  );
