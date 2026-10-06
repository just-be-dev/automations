import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { AutomationNamer, NamerError } from "../../agents/namer/namer.ts";
import { Automations } from "../../automation/service.ts";
import { EntitySubscribers } from "../../entities/subscribers.ts";
import { apiRoutes } from "../../http/api.ts";
import { accessIdentity } from "./access.ts";
import Automation from "./automation.ts";
import { automationsLayer } from "./automations.ts";
import { AutomationIndexD1 } from "./automation-index-d1.ts";
import { EntityStoreD1 } from "./entity-store-d1.ts";

const NAMING_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Only the Access-protected Studio Worker can reach this private API. */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url, compatibility: { date: "2026-10-04" }, workersDev: false },
  Effect.gen(function* () {
    const namespace = yield* Automation;
    const ai = yield* Cloudflare.Workers.AI();
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreD1;
    const automations = automationsLayer(namespace);
    const subscribers = Layer.unwrap(
      Automations.use((service) =>
        Effect.succeed(
          EntitySubscribers.layer((id, change) =>
            service.get(id).entityChanged(change.before, change.after),
          ),
        ),
      ),
    ).pipe(Layer.provideMerge(Layer.merge(entities, automations)));
    const namer = Layer.effect(
      AutomationNamer,
      Effect.gen(function* () {
        const runtime = yield* Alchemy.RuntimeContext;
        return AutomationNamer.of({
          complete: (request) =>
            ai.run(NAMING_MODEL, { ...request, messages: [...request.messages] }).pipe(
              Effect.provideService(Alchemy.RuntimeContext, runtime),
              Effect.map((output) => output.response ?? ""),
              Effect.mapError((error) => new NamerError({ message: `Namer: ${error.message}` })),
            ),
        });
      }),
    );
    const services = Layer.mergeAll(index, subscribers, accessIdentity, namer);
    const handler = yield* HttpRouter.toHttpEffect(apiRoutes);
    // RuntimeContext and request headers exist only when this returned effect handles a request.
    return { fetch: handler.pipe(Effect.provide(services)) };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Workers.AIBinding, Cloudflare.D1.QueryDatabaseBinding),
    ),
  ),
) {}
