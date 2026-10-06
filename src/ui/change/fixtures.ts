import type { ChangeAction, ChangeProposal } from "../../changes/model.ts";

export const proposalOf = (action: ChangeAction): ChangeProposal => ({
  id: "proposal-1",
  action,
  title: "Update approved resource",
  confirmLabel: "Apply reviewed change",
  details: [{ label: "Name", before: "Previous name", after: "Reviewed name" }],
  consequences: ["Server supplied consequence; do not replace this wording."],
});
