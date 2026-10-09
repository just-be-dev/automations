/** Routes automation design and run operations and builds the overview from each listed automation's status. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Automations } from "../automation/service.ts";
import { QuestionsAnswer } from "../ai/ask-question/question.ts";
import { createAutomation } from "../automation/creation.ts";
import { AutomationIndex } from "../automation/index.ts";
import type { AutomationOverview } from "../automation/model.ts";
import { EntityId } from "../entities/model.ts";
import { SuppliedEvent } from "../events/model.ts";
import { HumanResponse } from "../workflow/interpreter.ts";
import { Permissions } from "../workflow/model.ts";
import { RunId } from "../workflow/run.ts";
import { RequestIdentity } from "./identity.ts";
import { messageOf } from "../error.ts";
import { limitedBody, NotFound, pathParams, respond } from "./response.ts";

const AutomationParams = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/)),
});
const RunParams = Schema.Struct({ ...AutomationParams.fields, runId: RunId });
const TaskParams = Schema.Struct({ ...RunParams.fields, stepId: Schema.String });
const CreateBody = Schema.Struct({ description: Schema.String });
const ChatBody = Schema.Struct({ message: Schema.optionalKey(Schema.String) });
const AnswersBody = Schema.Struct({ chatId: Schema.String, answer: QuestionsAnswer });
const StartBody = Schema.Struct({
  subject: Schema.optionalKey(EntityId),
  event: Schema.optionalKey(SuppliedEvent),
});
const PermissionsBody = Schema.Struct({ permissions: Permissions });
const automationParams = pathParams(AutomationParams);

/** Handlers address automations through the request's application service. */
export const automationRoutes = Layer.merge(
  HttpRouter.addAll(
    [
      HttpRouter.route("GET", "/", respond(AutomationIndex.use((index) => index.list))),
      HttpRouter.route(
        "POST",
        "/",
        respond(
          Effect.gen(function* () {
            const body = yield* limitedBody(CreateBody);
            return yield* createAutomation(body.description);
          }),
          201,
        ),
      ),
      HttpRouter.route(
        "GET",
        "/:id",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const automations = yield* Automations;
            const automation = yield* automations.get(id).inspectWorkflow();
            const workflow = automation.draft ?? automation.saved;
            if (workflow !== undefined) {
              const index = yield* AutomationIndex;
              yield* index.recordIfMissing(id, workflow.name).pipe(Effect.ignore);
            }
            return automation;
          }),
        ),
      ),
      HttpRouter.route(
        "GET",
        "/:id/runs/:runId",
        respond(
          Effect.gen(function* () {
            const { id, runId } = yield* pathParams(RunParams);
            const automations = yield* Automations;
            const run = yield* automations.get(id).run(runId);
            if (run === undefined) {
              return yield* new NotFound({ message: "Run not found" });
            }
            return run;
          }),
        ),
      ),
      HttpRouter.route(
        "GET",
        "/:id/trace",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const automations = yield* Automations;
            return yield* automations.get(id).plannerTrace();
          }),
        ),
      ),
      HttpRouter.route(
        "GET",
        "/:id/runs/:runId/trace",
        respond(
          Effect.gen(function* () {
            const { id, runId } = yield* pathParams(RunParams);
            const automations = yield* Automations;
            const trace = yield* automations.get(id).runTrace(runId);
            if (trace === undefined) {
              return yield* new NotFound({ message: "Run not found" });
            }
            return trace;
          }),
        ),
      ),
      HttpRouter.route(
        "POST",
        "/:id/runs/:runId/tasks/:stepId",
        respond(
          Effect.gen(function* () {
            const { id, runId, stepId } = yield* pathParams(TaskParams);
            const body = yield* limitedBody(HumanResponse);
            const { email } = yield* RequestIdentity;
            const automations = yield* Automations;
            return yield* automations.get(id).respond(runId, stepId, body, email);
          }),
        ),
      ),
      HttpRouter.route(
        "POST",
        "/:id/chat",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const body = yield* limitedBody(ChatBody);
            const automations = yield* Automations;
            return yield* automations.get(id).chat(id, body.message ?? "");
          }),
          202,
        ),
      ),
      // Answers the questions the planner is waiting on, which resumes its reply.
      HttpRouter.route(
        "POST",
        "/:id/answers",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const body = yield* limitedBody(AnswersBody);
            const automations = yield* Automations;
            return yield* automations.get(id).answer(id, body.chatId, body.answer);
          }),
          202,
        ),
      ),
      HttpRouter.route(
        "POST",
        "/:id/save",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const automations = yield* Automations;
            return yield* automations.get(id).save(id);
          }),
        ),
      ),
      HttpRouter.route(
        "POST",
        "/:id/permissions",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const body = yield* limitedBody(PermissionsBody);
            const automations = yield* Automations;
            return yield* automations.get(id).setPermissions(body.permissions);
          }),
        ),
      ),
      HttpRouter.route(
        "POST",
        "/:id/start",
        respond(
          Effect.gen(function* () {
            const { id } = yield* automationParams;
            const body = yield* limitedBody(StartBody);
            const automations = yield* Automations;
            return yield* automations.get(id).start(body.subject, body.event);
          }),
          202,
        ),
      ),
    ],
    { prefix: "/api/automations" },
  ),
  HttpRouter.add(
    "GET",
    "/api/overview",
    respond(
      Effect.gen(function* () {
        const index = yield* AutomationIndex;
        const automations = yield* Automations;
        const listed = yield* index.list;
        return yield* Effect.forEach(
          listed,
          (automation) =>
            automations
              .get(automation.id)
              .overview()
              .pipe(
                Effect.map((status): AutomationOverview => ({ ...automation, ...status })),
                // One unreachable automation must not hide the others from the overview.
                Effect.catchCause((cause) =>
                  Effect.succeed<AutomationOverview>({
                    ...automation,
                    activeRuns: [],
                    error: messageOf(Cause.squash(cause)),
                  }),
                ),
              ),
          { concurrency: 8 },
        );
      }),
    ),
  ),
);
