/** Real assistant tools and specialist planner over disposable fixtures; approvals are explicit. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AssistantState, PageContext } from "../../src/assistant/model.ts";
import { assistantFixture, fixtureValue } from "../../src/assistant/fixtures.ts";
import { AssistantError } from "../../src/assistant/host.ts";
import { messageOf } from "../../src/error.ts";
import { ChangeAction } from "../../src/changes/model.ts";
import { Workflow } from "../../src/workflow/model.ts";
import type { Call } from "../framework/call.ts";
import { openPi } from "../framework/models.ts";
import { planner } from "./planner.ts";

const Input = Schema.Struct({
  message: Schema.String,
  approve: Schema.Boolean,
  /** Where the person is; defaults to the templates page. */
  context: Schema.optionalKey(PageContext),
  /** An automation the studio already lists, with its draft. */
  existing: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, name: Schema.String, draft: Workflow }),
  ),
});
const Output = Schema.Struct({
  state: AssistantState,
  changes: Schema.Array(ChangeAction),
  descriptions: Schema.Array(Schema.String),
  /** The automation each delegated draft went to, in order. */
  drafted: Schema.Array(Schema.String),
  workflows: Schema.Array(Workflow),
  toolCalls: Schema.Array(Schema.String),
});
export const assistant: Call<typeof Input.Type, typeof Output.Type> = {
  name: "assistant",
  input: Input,
  output: Output,
  timeout: "12 minutes",
  run: (input) =>
    Effect.gen(function* () {
      const f = yield* assistantFixture;
      if (input.existing !== undefined) {
        f.directory.set(input.existing.id, input.existing.name);
        f.drafts.set(input.existing.id, input.existing.draft);
      }
      const session = yield* f.open();
      const calls: Array<string> = [];
      const pi = yield* openPi(
        session.tools.map((tool) => ({
          ...tool,
          execute: (args: unknown, call: { readonly id: string }) =>
            Effect.sync(() => void calls.push(tool.name)).pipe(
              Effect.andThen(tool.execute(args, call)),
            ),
        })),
      );
      const initial = yield* session.chat(
        input.message,
        input.context ?? { pathname: "/templates" },
      );
      const turnId = fixtureValue(initial.conversation[0]).id;
      const designed = new Set<string>();
      for (let i = 0; i < 30; i++) {
        yield* session.reply(pi, turnId);
        const state = yield* session.inspect();
        if (state.status === "idle" || state.status === "failed") break;
        if (state.confirmation !== undefined)
          yield* session.confirm(state.confirmation.id, input.approve);
        if (state.questions !== undefined)
          yield* session.answer(state.questions.callId, {
            kind: "answers",
            answers: state.questions.questions.map(() => null),
          });
        for (const submission of f.submissions) {
          if (designed.has(submission.requestId)) continue;
          designed.add(submission.requestId);
          const draft = f.drafts.get(submission.id);
          const result = yield* planner.run({
            message: submission.description,
            ...(draft === undefined ? {} : { draft }),
            catalog: {
              types: yield* f.entities.listTypes,
              templates: yield* f.entities.listTemplates,
              roles: yield* f.entities.listRoles,
            },
          });
          if (result.workflow === undefined)
            f.pending.set(submission.id, {
              id: submission.requestId,
              prompt: submission.description,
              status: "failed",
              error: "Planner produced no draft",
            });
          else {
            f.drafts.set(submission.id, result.workflow);
            f.pending.delete(submission.id);
          }
        }
      }
      return {
        state: yield* session.inspect(),
        changes: f.mutations,
        descriptions: f.submissions.map((s) => s.description),
        drafted: f.submissions.map((s) => s.id),
        workflows: [...f.drafts.values()],
        toolCalls: calls,
      };
    }).pipe(Effect.mapError((error) => new AssistantError({ message: messageOf(error) }))),
};
