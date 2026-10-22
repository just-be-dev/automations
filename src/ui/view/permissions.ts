/** Presents each workflow operation's permission: runs on its own, or asks first. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { CircleCheck, Hand } from "lucide";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { permissionOf } from "../../connections.ts";
import {
  operationsUsed,
  type Permission,
  type PermissionChange,
  type Workflow,
} from "../../workflow.ts";
import { Message } from "../message.ts";
import { Activity, type Model, replyChanges } from "../model.ts";
import {
  type IconNode,
  isSimulated,
  operationIcon,
  operationTitle,
  simulatedTagView,
} from "./operation.ts";
import { eyebrowClass } from "./shared.ts";

export const permissionsView = (workflow: Workflow, model: Model, h: HtmlBuilder<Message>) =>
  Array.match(operationsUsed(workflow.steps), {
    onEmpty: () => h.empty,
    onNonEmpty: (operationIds) =>
      h.section(
        [
          componentName("permissions"),
          h.AriaLabelledBy("permissions"),
          h.Class("flex max-w-2xl flex-col gap-2"),
        ],
        [
          h.h3([h.Id("permissions"), h.Class(eyebrowClass)], ["Permissions"]),
          h.p(
            [h.Class("text-xs text-muted-foreground")],
            [
              "The agent sets these permissions. You can change them. Save the draft to apply the changes to runs.",
            ],
          ),
          h.ul(
            [h.AriaLabelledBy("permissions"), h.Class("flex flex-col")],
            Array.map(operationIds, (operationId) =>
              permissionRowView(
                operationId,
                Option.fromNullishOr(permissionOf(workflow, operationId)),
                Option.flatMap(replyChanges(model), (changes) =>
                  Array.findFirst(
                    changes.permissions,
                    (change) => change.operation === operationId,
                  ),
                ),
                Activity.guards.Working(model.activity),
                model.liveConnections,
                h,
              ),
            ),
          ),
        ],
      ),
  });

const permissionLabel = (permission: Permission) => (permission === "auto" ? "Allow" : "Ask first");

/** Marks a permission the agent's latest reply set, with the one it replaced struck through. */
const permissionChangeView = (change: PermissionChange, h: HtmlBuilder<Message>) =>
  h.span(
    [componentName("permission-change"), h.Class("flex items-center gap-1.5 text-xs")],
    [
      h.span(
        [
          h.Class(
            "inline-flex items-center rounded-[5px] bg-change px-1.5 text-[11px] leading-[18px] font-medium text-white",
          ),
        ],
        [change.before === undefined ? "Added" : "Changed"],
      ),
      change.before === undefined
        ? h.empty
        : h.del([h.Class("text-muted-foreground line-through")], [permissionLabel(change.before)]),
    ],
  );

const permissionRowView = (
  operationId: string,
  maybePermission: Option.Option<Permission>,
  maybeChange: Option.Option<PermissionChange>,
  isWorking: boolean,
  liveConnections: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
) => {
  const select = (permission: Permission) =>
    Message.SelectedPermission({ operation: operationId, permission });
  return h.keyed("li")(
    operationId,
    [
      componentName("permission-row"),
      h.Class(
        cn(
          "flex flex-wrap items-center gap-2.5 py-1.5",
          Option.isSome(maybeChange) &&
            "-mx-2 my-0.5 rounded-lg bg-change-soft px-2 ring-1 ring-change-line ring-inset",
        ),
      ),
    ],
    [
      h.span(
        [h.Class("icon-tile"), h.AriaHidden(true)],
        [icon(h, operationIcon(operationId), "size-3.5")],
      ),
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2 text-sm")],
        [
          h.span([], [operationTitle(operationId)]),
          isSimulated(operationId, liveConnections) ? simulatedTagView(h) : h.empty,
          Option.match(maybeChange, {
            onNone: () => h.empty,
            onSome: (change) => permissionChangeView(change, h),
          }),
        ],
      ),
      h.div(
        [
          h.Role("group"),
          h.AriaLabel(`${operationTitle(operationId)} permission`),
          h.Class("flex shrink-0 items-center gap-px rounded-[9px] bg-sidebar p-0.5"),
        ],
        [
          permissionButtonView(
            {
              label: "Allow",
              hint: "Runs on its own",
              icon: CircleCheck,
              isChosen: Option.exists(maybePermission, (permission) => permission === "auto"),
              maybeOnClick: isWorking ? Option.none() : Option.some(select("auto")),
            },
            h,
          ),
          permissionButtonView(
            {
              label: "Ask first",
              hint: "Waits until someone approves it",
              icon: Hand,
              isChosen: Option.exists(maybePermission, (permission) => permission === "ask"),
              maybeOnClick: isWorking ? Option.none() : Option.some(select("ask")),
            },
            h,
          ),
        ],
      ),
    ],
  );
};

interface PermissionButton {
  readonly label: string;
  readonly hint: string;
  readonly icon: IconNode;
  readonly isChosen: boolean;
  readonly maybeOnClick: Option.Option<Message>;
}

const permissionButtonView = (button: PermissionButton, h: HtmlBuilder<Message>) =>
  h.button(
    [
      componentName("permission-button"),
      h.Type("button"),
      h.AriaLabel(button.label),
      h.AriaPressed(String(button.isChosen)),
      h.Title(`${button.label}: ${button.hint}`),
      h.Disabled(Option.isNone(button.maybeOnClick)),
      ...Option.match(button.maybeOnClick, {
        onNone: () => [],
        onSome: (message) => [h.OnClick(message)],
      }),
      h.Class(
        cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-[7px] text-sand-10 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
          button.isChosen && "bg-background text-foreground shadow-card",
        ),
      ),
    ],
    [icon(h, button.icon, "size-3.5")],
  );
