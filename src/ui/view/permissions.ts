import * as Array from "effect/Array";
import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { CircleCheck, Hand } from "lucide";
import { inputClass } from "@/components/ui/input";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { permissionOf } from "../../connections.ts";
import type { Role } from "../../entities.ts";
import { operationsUsed, type Permission, type Workflow } from "../../workflow.ts";
import { Message } from "../message.ts";
import { Activity, type Model, readyRoles } from "../model.ts";
import {
  type IconNode,
  isSimulated,
  operationIcon,
  operationTitle,
  simulatedTagView,
} from "./operation.ts";
import { eyebrowClass } from "./shared.ts";

const askedRole = (maybePermission: Option.Option<Permission>) =>
  Option.flatMap(maybePermission, (permission) =>
    permission === "auto" ? Option.none() : Option.some(permission.ask),
  );

export const permissionsView = (workflow: Workflow, model: Model, h: HtmlBuilder<Message>) =>
  Array.match(operationsUsed(workflow.steps), {
    onEmpty: () => h.empty,
    onNonEmpty: (operationIds) =>
      h.section(
        [h.AriaLabelledBy("permissions"), h.Class("flex max-w-2xl flex-col gap-2")],
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
                readyRoles(model.roles),
                Activity.guards.Working(model.activity),
                h,
              ),
            ),
          ),
        ],
      ),
  });

const permissionRowView = (
  operationId: string,
  maybePermission: Option.Option<Permission>,
  roles: ReadonlyArray<Role>,
  isWorking: boolean,
  h: HtmlBuilder<Message>,
) => {
  const maybeRole = askedRole(maybePermission);
  const select = (permission: Permission) =>
    Message.SelectedPermission({ operation: operationId, permission });
  return h.keyed("li")(
    operationId,
    [h.Class("flex flex-wrap items-center gap-2.5 py-1.5")],
    [
      h.span(
        [h.Class("icon-tile"), h.AriaHidden(true)],
        [icon(h, operationIcon(operationId), "size-3.5")],
      ),
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2 text-sm")],
        [
          h.span([], [operationTitle(operationId)]),
          isSimulated(operationId) ? simulatedTagView(h) : h.empty,
        ],
      ),
      Option.match(maybeRole, {
        onNone: () => h.empty,
        onSome: (role) =>
          h.select(
            [
              h.AriaLabel(`${operationTitle(operationId)} approver`),
              h.Title("Who approves it"),
              h.Value(role),
              h.Disabled(isWorking),
              h.OnChange((ask) => select({ ask })),
              h.Class(cn(inputClass, "h-7 w-auto bg-background px-2 text-xs md:text-xs")),
            ],
            Array.map(roles, (candidate) =>
              h.keyed("option")(
                candidate.name,
                [h.Value(candidate.name), h.Selected(candidate.name === role)],
                [candidate.label],
              ),
            ),
          ),
      }),
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
              hint: Array.isReadonlyArrayEmpty(roles)
                ? "Add a role to ask first"
                : "Waits until someone in a role approves it",
              icon: Hand,
              isChosen: Option.isSome(maybeRole),
              maybeOnClick: isWorking
                ? Option.none()
                : Option.map(
                    Option.orElse(maybeRole, () =>
                      Option.map(Array.head(roles), (role) => role.name),
                    ),
                    (ask) => select({ ask }),
                  ),
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
