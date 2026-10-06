import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Dialog from "@/components/ui/dialog";
import { ChangeProposal } from "../../changes/model.ts";

export const Model = Schema.Struct({
  dialog: Dialog.Model,
  maybeProposal: Schema.Option(ChangeProposal),
  decision: Schema.Literals(["Ready", "Sending"]),
  maybeError: Schema.Option(Schema.String),
});
export type Model = typeof Model.Type;
export const initial = Model.make({
  dialog: Dialog.init({ id: "manual-change", focusSelector: "#manual-change button" }),
  maybeProposal: Option.none(),
  decision: "Ready",
  maybeError: Option.none(),
});
