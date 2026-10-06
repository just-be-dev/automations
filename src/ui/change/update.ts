import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";
import * as Dialog from "@/components/ui/dialog";
import { ChangeProposal } from "../../changes/model.ts";
import { DecideChange } from "./command.ts";
import { Message, toDialogMessage } from "./message.ts";
import type { Model } from "./model.ts";

export const OutMessage = defineMessageUnion({
  Applied: { proposal: ChangeProposal, result: Schema.Json },
  Cancelled: {},
});
export type OutMessage = typeof OutMessage.Type;
type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>;
const dialogFold = {
  read: (model: Model) => Option.some(model.dialog),
  write: (model: Model, nextDialog: Dialog.Model) =>
    modifyFields(model, { dialog: () => nextDialog }),
  toParentMessage: toDialogMessage,
  foldOutMessage: () => (model: Model) => ({ model }),
};
const close = Update.foldChildStep({ ...dialogFold, update: Dialog.close });
const decision = (model: Model, approved: boolean): Return =>
  model.decision === "Sending"
    ? { model }
    : Option.match(model.maybeProposal, {
        onNone: () => ({ model }),
        onSome: (proposal) => ({
          model: modifyFields(model, {
            decision: () => "Sending",
            maybeError: () => Option.none(),
          }),
          commands: [DecideChange({ proposalId: proposal.id, approved })],
        }),
      });
export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SucceededPrepare: ({ proposal }) =>
      Update.foldChildStep({ ...dialogFold, update: Dialog.open })(
        modifyFields(model, {
          maybeProposal: () => Option.some(proposal),
          maybeError: () => Option.none(),
          decision: (): Model["decision"] => "Ready",
        }),
      ),
    ClickedDecision: ({ approved }) => decision(model, approved),
    GotDialogMessage: ({ message }) =>
      message._tag === "RequestedClose"
        ? decision(model, false)
        : Update.foldChild({ ...dialogFold, update: Dialog.update })(model, message),
    FailedDecision: ({ proposalId, error }) =>
      !Option.exists(model.maybeProposal, (proposal) => proposal.id === proposalId)
        ? { model }
        : {
            model: modifyFields(model, {
              decision: () => "Ready",
              maybeError: () => Option.some(error),
            }),
          },
    SucceededDecision: ({ proposalId, decision }) =>
      Option.match(model.maybeProposal, {
        onNone: () => ({ model }),
        onSome: (proposal) => {
          if (proposal.id !== proposalId) {
            return { model };
          }
          const dialogClose = close(
            modifyFields(model, {
              decision: (): Model["decision"] => "Ready",
              maybeProposal: () => Option.none(),
            }),
          );
          return Update.withOutMessage(
            dialogClose,
            decision.status === "applied"
              ? OutMessage.Applied({ proposal, result: decision.result })
              : OutMessage.Cancelled(),
          );
        },
      }),
  });
