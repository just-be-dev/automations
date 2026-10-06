import * as Option from "effect/Option";
import type { HtmlBuilder } from "foldkit/html";
import { CircleAlert, LoaderCircle } from "lucide";
import { button, buttonClass } from "@/components/ui/button";
import * as Dialog from "@/components/ui/dialog";
import { textarea } from "@/components/ui/textarea";
import { icon } from "@/lib/icons";
import { newAutomationDescriptionId } from "../constant.ts";
import { Message, toNewAutomationDialogMessage } from "../message.ts";
import { type Model, NewAutomation } from "../model.ts";
import { characterCountView, submitShortcut } from "./shared.ts";

export const newAutomationDialogView = (model: Model, h: HtmlBuilder<Message>) => {
  const description = model.newAutomation.description;
  const isCreating = NewAutomation.guards.Creating(model.newAutomation);
  const maybeError = NewAutomation.match(model.newAutomation, {
    Editing: ({ maybeError }) => maybeError,
    Creating: () => Option.none<string>(),
  });
  return h.submodel({
    slotId: model.newAutomationDialog.id,
    model: model.newAutomationDialog,
    view: Dialog.view,
    toParentMessage: toNewAutomationDialogMessage,
    viewInputs: Dialog.styledViewInputs(
      {
        hasDescription: true,
        panelClass: "gap-5 sm:max-w-lg",
        content: ({ closeButton, title, description: descriptionAttributes }, h) => [
          Dialog.header(
            {},
            [
              Dialog.title({ attributes: title }, ["New automation"], h),
              Dialog.description(
                { attributes: descriptionAttributes },
                [
                  "Describe the trigger and what should happen. You can edit the workflow in chat afterward.",
                ],
                h,
              ),
            ],
            h,
          ),
          h.form(
            [
              h.AriaLabel("New automation"),
              h.OnSubmit(Message.SubmittedNewAutomation()),
              h.Class("flex flex-col gap-5"),
            ],
            [
              h.div(
                [h.Class("flex flex-col gap-1.5")],
                [
                  textarea(
                    {
                      id: newAutomationDescriptionId,
                      label: "What should it do?",
                      value: description,
                      placeholder:
                        "When an order arrives, summarize its contents and send the summary to…",
                      isDisabled: isCreating,
                      isInvalid: Option.isSome(maybeError),
                      onInput: (value) => Message.UpdatedNewAutomationDescription({ value }),
                      className: "max-h-72 min-h-28 resize-none bg-background",
                      attributes: submitShortcut(
                        model.shortcutModifier,
                        Message.SubmittedNewAutomation(),
                        h,
                      ),
                    },
                    h,
                  ),
                  Option.match(maybeError, {
                    onNone: () => h.empty,
                    onSome: (error) =>
                      h.p(
                        [
                          h.Role("alert"),
                          h.Class("flex items-center gap-1.5 text-xs text-destructive"),
                        ],
                        [icon(h, CircleAlert, "size-3.5"), error],
                      ),
                  }),
                ],
              ),
              Dialog.footer(
                { className: "items-center" },
                [
                  characterCountView(description.length, "mr-auto", h),
                  h.button(
                    [...closeButton, h.Class(buttonClass({ variant: "outline" }))],
                    ["Cancel"],
                  ),
                  button(
                    { type: "submit", isDisabled: isCreating },
                    isCreating
                      ? [
                          icon(h, LoaderCircle, "size-3.5 animate-spin", "inline-start"),
                          "Creating…",
                        ]
                      : "Create automation",
                    h,
                  ),
                ],
                h,
              ),
            ],
          ),
        ],
      },
      h,
    ),
  });
};
