import * as Schema from "effect/Schema";
import { defineMessageUnion } from "foldkit/message";
import * as Dialog from "@/components/ui/dialog";
import { ChangeDecision, ChangeProposal } from "../../changes/model.ts";

export const Message = defineMessageUnion({
  SucceededPrepare: { proposal: ChangeProposal },
  ClickedDecision: { approved: Schema.Boolean },
  GotDialogMessage: { message: Dialog.Message },
  SucceededDecision: { proposalId: Schema.String, decision: ChangeDecision },
  FailedDecision: { proposalId: Schema.String, error: Schema.String },
});
export type Message = typeof Message.Type;
export const toDialogMessage = (message: Dialog.Message) => Message.GotDialogMessage({ message });
