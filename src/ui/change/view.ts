import * as Option from "effect/Option";
import { Submodel } from "foldkit";
import * as Dialog from "@/components/ui/dialog";
import { componentName } from "@/lib/component";
import { changeProposalView } from "../components/change-proposal.ts";
import { Message, toDialogMessage } from "./message.ts";
import type { Model } from "./model.ts";

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: model.dialog.id,
    model: model.dialog,
    view: Dialog.view,
    toParentMessage: toDialogMessage,
    viewInputs: Dialog.styledViewInputs(
      {
        attributes: [componentName("manual-change-dialog")],
        hasDescription: true,
        panelClass: "sm:max-w-lg max-h-[85vh] overflow-y-auto",
        content: ({ title, description }, h) => [
          Dialog.title({ attributes: title }, ["Confirm change"], h),
          Dialog.description(
            { attributes: description },
            ["Review this change before applying it."],
            h,
          ),
          Option.match(model.maybeProposal, {
            onNone: () => h.empty,
            onSome: (proposal) =>
              changeProposalView(
                proposal,
                Message.ClickedDecision({ approved: true }),
                Message.ClickedDecision({ approved: false }),
                model.decision === "Sending",
                h,
              ),
          }),
          Option.match(model.maybeError, {
            onNone: () => h.empty,
            onSome: (error) => h.p([h.Role("alert"), h.Class("text-destructive")], [error]),
          }),
        ],
      },
      h,
    ),
  }),
);
