import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Http } from "foldkit";
import { ChangeDecision, ChangeProposal, type ChangeAction } from "../../changes/model.ts";
import { errorText, requestJson } from "../api.ts";
import { Message } from "./message.ts";

export const prepare = Effect.fn("UI.prepareChange")(function* (action: ChangeAction) {
  const proposal = yield* requestJson("/api/changes", ChangeProposal, { action });
  return Message.SucceededPrepare({ proposal });
});
export const DecideChange = Command.define("DecideChange", {
  args: { proposalId: Schema.String, approved: Schema.Boolean },
  messages: [Message.SucceededDecision, Message.FailedDecision],
  execute: ({ proposalId, approved }) =>
    requestJson(`/api/changes/${encodeURIComponent(proposalId)}/decision`, ChangeDecision, {
      approved,
    }).pipe(
      Effect.map((decision) => Message.SucceededDecision({ proposalId, decision })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedDecision({ proposalId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});
