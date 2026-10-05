import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import Automation from "../automation/durable-object.ts";
import { AutomationIndexD1 } from "../automation/index-d1.ts";
import { EntityStoreD1 } from "../entities/d1.ts";
import { EntitySubscribers } from "../entities/subscribers.ts";
import { automationRoutes } from "./automations.ts";
import { catalogRoutes } from "./catalog.ts";
import { entityRoutes } from "./entities.ts";
import { mcpRoutes } from "./mcp.ts";
import { json } from "./response.ts";

/** The private API Worker: bind resources here and build runtime services per request. */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-04" },
    // Cloudflare Access guards the Studio Worker, which forwards `/api/*` here.
    workersDev: false,
  },
  Effect.gen(function* () {
    const automations = yield* Automation;
    const index = yield* AutomationIndexD1;
    const entities = yield* EntityStoreD1;
    const subscribers = Layer.unwrap(
      Effect.gen(function* () {
        const runtime = yield* Alchemy.RuntimeContext;
        return EntitySubscribers.layer((id, change) =>
          automations
            .getByName(id)
            .entityChanged(change.before, change.after)
            .pipe(Effect.provideService(Alchemy.RuntimeContext, runtime)),
        );
      }),
    ).pipe(Layer.provideMerge(entities));
    const services = Layer.merge(index, subscribers);
    const handler = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(
        automationRoutes(automations),
        entityRoutes,
        catalogRoutes,
        mcpRoutes,
        HttpRouter.add("*", "*", json({ error: "Not found" }, 404)),
      ),
    );
    // RuntimeContext is only available when this returned effect handles a request.
    return { fetch: handler.pipe(Effect.provide(services)) };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
