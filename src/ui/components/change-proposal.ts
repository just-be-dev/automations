import type { HtmlBuilder } from "foldkit/html";
import { button } from "@/components/ui/button";
import { componentName } from "@/lib/component";
import type { ChangeProposal } from "../../changes/model.ts";

export const changeProposalView = <M>(
  proposal: ChangeProposal,
  approve: M,
  cancel: M,
  busy: boolean,
  h: HtmlBuilder<M>,
) =>
  h.section(
    [componentName("change-proposal"), h.Class("flex flex-col gap-4")],
    [
      h.h3([h.Class("font-medium")], [proposal.title]),
      h.dl(
        [h.Class("space-y-3 text-sm")],
        proposal.details.map((detail) =>
          h.div(
            [],
            [
              h.dt([h.Class("font-medium")], [detail.label]),
              h.dd(
                [h.Class("whitespace-pre-wrap break-words text-muted-foreground")],
                ["Before: ", detail.before],
              ),
              h.dd([h.Class("whitespace-pre-wrap break-words")], ["After: ", detail.after]),
            ],
          ),
        ),
      ),
      h.div(
        [],
        [
          h.h4([h.Class("text-sm font-medium")], ["Consequences"]),
          h.ul(
            [h.Class("list-disc space-y-1 pl-5 text-sm text-muted-foreground")],
            proposal.consequences.map((consequence) => h.li([], [consequence])),
          ),
        ],
      ),
      h.div(
        [h.Class("flex flex-wrap gap-2")],
        [
          button({ onClick: approve, isDisabled: busy }, proposal.confirmLabel, h),
          button({ onClick: cancel, variant: "outline", isDisabled: busy }, "Cancel", h),
        ],
      ),
    ],
  );
