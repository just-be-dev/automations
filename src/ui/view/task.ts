/** Presents a run's open human tasks, including approval details, assignees, and forms filled from defaults and edits. */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type { HtmlBuilder } from "foldkit/html";
import { Checkbox } from "@foldkit/ui";
import { Check, UserRound, X } from "lucide";
import { button } from "@/components/ui/button";
import { input } from "@/components/ui/input";
import { componentName } from "@/lib/component";
import { localDateTimeText } from "@/lib/datetime";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  displayValue,
  type HumanField,
  type HumanTask,
  type Run,
  type ValueType,
} from "../../workflow.ts";
import { TaskAnswer } from "../domain/index.ts";
import { Message } from "../message.ts";
import { type OpenRun, RunNotice } from "../model.ts";
import { isSimulated, operationIcon, operationTitle, simulatedTagView } from "./operation.ts";
import { chipClass, eyebrowClass, notifyLabel, stepMetaView } from "./shared.ts";

export const openTasksView = (run: Run, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  Array.match(
    Array.filter(run.tasks, (task) => task.status === "open"),
    {
      onEmpty: () => h.empty,
      onNonEmpty: (tasks) =>
        h.section(
          [
            componentName("open-tasks"),
            h.AriaLabelledBy("open-tasks"),
            h.Class("flex flex-col gap-2"),
          ],
          [
            h.h3([h.Id("open-tasks"), h.Class(eyebrowClass)], ["Open tasks"]),
            h.ul(
              [h.AriaLabelledBy("open-tasks"), h.Class("flex flex-col gap-3")],
              Array.map(tasks, (task) => taskView(task, openRun, h)),
            ),
          ],
        ),
    },
  );

const jsonString = (value: Schema.Json | null, key: string) =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Option.filter(Option.fromNullishOr(value[key]), Predicate.isString)
    : Option.none<string>();

const assigneeView = (assignee: Schema.Json | null, h: HtmlBuilder<Message>) =>
  Option.match(
    Predicate.isString(assignee) ? Option.some(assignee) : jsonString(assignee, "$title"),
    {
      onNone: () => [],
      onSome: (title) => [
        h.span(
          [],
          [
            "Assigned to ",
            h.span(
              [
                h.Class(cn(chipClass, "text-foreground")),
                ...Option.match(jsonString(assignee, "email"), {
                  onNone: () => [],
                  onSome: (email) => [h.Title(email)],
                }),
              ],
              [title],
            ),
          ],
        ),
      ],
    },
  );

const isSendingAnswer = (openRun: OpenRun) => RunNotice.guards.Sending(openRun.notice);

const taskView = (task: HumanTask, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    task.step,
    [componentName("task"), h.Class("flex flex-col gap-3 rounded-[10px] bg-card p-4 shadow-card")],
    [
      h.div(
        [h.Class("flex items-start gap-2.5")],
        [
          h.span(
            [h.Class("icon-tile"), h.AriaHidden(true)],
            [
              icon(
                h,
                task.action === undefined ? UserRound : operationIcon(task.action.use),
                "size-3.5",
              ),
            ],
          ),
          h.div(
            [h.Class("flex min-w-0 flex-col gap-1")],
            [
              h.h4([h.Class("text-sm font-medium")], [task.title]),
              h.p([h.Class("text-sm whitespace-pre-wrap text-muted-foreground")], [task.prompt]),
              task.action === undefined ? h.empty : taskActionView(task.action, h),
              stepMetaView(
                [
                  ...assigneeView(task.assignee, h),
                  ...(task.approvers === undefined ? [] : [approversView(task.approvers, h)]),
                  ...(task.notify === undefined
                    ? []
                    : [`Notified via ${notifyLabel[task.notify]}`]),
                ],
                h,
              ),
            ],
          ),
        ],
      ),
      task.response === "approval"
        ? h.div(
            [h.Class("flex gap-2 pl-[34px]")],
            [
              button(
                {
                  onClick: Message.ClickedApproveTask({ step: task.step }),
                  isDisabled: isSendingAnswer(openRun),
                  size: "sm",
                },
                [icon(h, Check, "size-3.5", "inline-start"), "Approve"],
                h,
              ),
              button(
                {
                  onClick: Message.ClickedRejectTask({ step: task.step }),
                  isDisabled: isSendingAnswer(openRun),
                  variant: "outline",
                  size: "sm",
                },
                [icon(h, X, "size-3.5", "inline-start"), "Reject"],
                h,
              ),
            ],
          )
        : taskFormView(task, task.response.fields, openRun, h),
    ],
  );

const personText = (value: Schema.Json) =>
  Option.match(jsonString(value, "email"), {
    onNone: () => displayValue(value),
    onSome: (email) => `${displayValue(value)} <${email}>`,
  });

const isJsonList = (value: Schema.Json): value is ReadonlyArray<Schema.Json> =>
  Array.isArray(value);

const inputText = (value: Schema.Json) =>
  isJsonList(value) ? Array.map(value, personText).join(", ") : personText(value);

const taskActionView = (action: NonNullable<HumanTask["action"]>, h: HtmlBuilder<Message>) =>
  h.div(
    [componentName("task-action"), h.Class("flex flex-col gap-1.5 pt-1")],
    [
      h.div(
        [h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
        [operationTitle(action.use), isSimulated(action.use) ? simulatedTagView(h) : h.empty],
      ),
      h.ul(
        [
          h.AriaLabel(`${operationTitle(action.use)} details`),
          h.Class("flex flex-col gap-0.5 text-xs"),
        ],
        Array.map(Object.entries(action.inputs), ([name, value]) =>
          h.keyed("li")(
            name,
            [h.Class("break-words whitespace-pre-wrap text-muted-foreground")],
            [h.span([h.Class("font-mono text-sand-11")], [`${name}: `]), inputText(value)],
          ),
        ),
      ),
    ],
  );

const approversView = (approvers: NonNullable<HumanTask["approvers"]>, h: HtmlBuilder<Message>) =>
  h.span(
    [
      componentName("approvers"),
      h.Title(Array.map(approvers.members, (member) => member.email).join(", ")),
    ],
    [
      "Approved by ",
      h.span([h.Class(cn(chipClass, "text-foreground"))], [approvers.label]),
      ...Array.match(approvers.members, {
        onEmpty: () => [" (no members)"],
        onNonEmpty: (members) => [` (${Array.map(members, (member) => member.name).join(", ")})`],
      }),
    ],
  );

const taskFormView = (
  task: HumanTask,
  fields: ReadonlyArray<HumanField>,
  openRun: OpenRun,
  h: HtmlBuilder<Message>,
) =>
  h.form(
    [
      componentName("task-form"),
      h.AriaLabel(task.title),
      h.OnSubmit(Message.SubmittedTaskForm({ step: task.step })),
      h.Class("flex flex-col gap-3 pl-[34px]"),
    ],
    [
      ...Array.map(fields, (field) =>
        h.keyed("div")(
          field.name,
          [h.Class("max-w-xs")],
          [
            taskFieldView(
              task,
              field,
              TaskAnswer.fieldText(openRun.taskEdits, task, field.name),
              h,
            ),
          ],
        ),
      ),
      h.div(
        [],
        [button({ type: "submit", isDisabled: isSendingAnswer(openRun), size: "sm" }, "Submit", h)],
      ),
    ],
  );

const fieldInputType: Record<Exclude<ValueType, "boolean">, string> = {
  text: "text",
  number: "number",
  date: "date",
  datetime: "datetime-local",
};

const taskFieldView = (
  task: HumanTask,
  field: HumanField,
  text: string,
  h: HtmlBuilder<Message>,
) => {
  const id = `task-${task.step}-${field.name}`;
  const toMessage = (value: string) =>
    Message.UpdatedTaskField({ step: task.step, field: field.name, value });
  return field.type === "boolean"
    ? checkboxFieldView(id, field.label, text === "true", toMessage, h)
    : input(
        {
          id,
          label: field.label,
          type: fieldInputType[field.type],
          value: field.type === "datetime" ? localDateTimeText(text) : text,
          onInput: toMessage,
          wrapperAttributes: [componentName("task-field")],
        },
        h,
      );
};

const checkboxFieldView = (
  id: string,
  label: string,
  isChecked: boolean,
  toMessage: (value: string) => Message,
  h: HtmlBuilder<Message>,
) =>
  Checkbox.view(
    {
      id,
      isChecked,
      onToggle: (checked) => toMessage(String(checked)),
      toView: (attributes) =>
        h.div(
          [componentName("checkbox-field"), h.Class("flex items-center gap-2")],
          [
            h.button(
              [
                ...attributes.checkbox,
                h.Class(
                  "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-border bg-background outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground",
                ),
              ],
              [isChecked ? icon(h, Check, "size-3") : h.empty],
            ),
            h.label([...attributes.label, h.Class("text-sm font-medium")], [label]),
          ],
        ),
    },
    h,
  );
