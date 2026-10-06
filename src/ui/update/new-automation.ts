import * as Array from "effect/Array";
import * as Option from "effect/Option";
import { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import * as Dialog from "@/components/ui/dialog";
import { CreateAutomation, LoadAutomations, NavigateInternal } from "../command.ts";
import { maxMessageLength } from "../constant.ts";
import { type Message, toNewAutomationDialogMessage } from "../message.ts";
import {
  type AutomationSummary,
  blankNewAutomation,
  Directory,
  listedAutomations,
  type Model,
  NewAutomation,
} from "../model.ts";
import { automationHref } from "../route.ts";

const dialogFold = {
  read: (model: Model) => Option.some(model.newAutomationDialog),
  write: (model: Model, nextDialog: Dialog.Model): Model =>
    modifyFields(model, { newAutomationDialog: () => nextDialog }),
  toParentMessage: toNewAutomationDialogMessage,
  foldOutMessage: () => (model: Model) => ({ model }),
};

export const foldNewAutomationDialog = Update.foldChild({ ...dialogFold, update: Dialog.update });

const closeDialog: Update.Step<Model, Message> = Update.foldChildStep({
  ...dialogFold,
  update: Dialog.close,
});

/** Every open starts from a blank description. */
export const openNewAutomation = (model: Model): Update.Return<Model, Message> =>
  Update.foldChildStep({ ...dialogFold, update: Dialog.open })(
    modifyFields(model, { newAutomation: () => blankNewAutomation }),
  );

const descriptionError = (description: string) =>
  description.trim() === ""
    ? Option.some("Describe what the automation should do")
    : description.length > maxMessageLength
      ? Option.some("Keep the description to 10,000 characters")
      : Option.none();

export const submitNewAutomation = (model: Model): Update.Return<Model, Message> =>
  NewAutomation.match(model.newAutomation, {
    Creating: () => ({ model }),
    Editing: ({ description }) =>
      Option.match(descriptionError(description), {
        onSome: (error) => ({
          model: modifyFields(model, {
            newAutomation: () =>
              NewAutomation.Editing({ description, maybeError: Option.some(error) }),
          }),
        }),
        onNone: () => ({
          model: modifyFields(model, {
            newAutomation: () => NewAutomation.Creating({ description }),
          }),
          commands: [CreateAutomation({ description })],
        }),
      }),
  });

/**
 * The new automation joins the sidebar before the list reloads, so it's there to come back to as
 * soon as the studio opens it. The studio then shows its description as the first message, with
 * the agent answering. If the description couldn't be sent, it waits in the composer instead.
 */
export const createdAutomation = (
  model: Model,
  automation: AutomationSummary,
  wasDescriptionSent: boolean,
): Update.Return<Model, Message> =>
  Update.combine(
    modifyFields(model, {
      newAutomation: () => blankNewAutomation,
      messageInputs: (inputs) =>
        wasDescriptionSent
          ? inputs
          : { ...inputs, [automation.id]: model.newAutomation.description },
      directory: (directory) =>
        Directory.Ready({
          automations: Array.prepend(
            Array.filter(listedAutomations(directory), (listed) => listed.id !== automation.id),
            automation,
          ),
        }),
    }),
    [
      closeDialog,
      (stepModel): Update.Return<Model, Message> => ({
        model: stepModel,
        commands: [NavigateInternal({ url: automationHref(automation.id) }), LoadAutomations()],
      }),
    ],
  );

export const failedToCreate = (model: Model, error: string): Update.Return<Model, Message> =>
  NewAutomation.match(model.newAutomation, {
    Editing: () => ({ model }),
    Creating: ({ description }) => ({
      model: modifyFields(model, {
        newAutomation: () => NewAutomation.Editing({ description, maybeError: Option.some(error) }),
      }),
    }),
  });

export const describeNewAutomation = (model: Model, value: string): Update.Return<Model, Message> =>
  NewAutomation.match(model.newAutomation, {
    Creating: () => ({ model }),
    Editing: () => ({
      model: modifyFields(model, {
        newAutomation: () =>
          NewAutomation.Editing({ description: value, maybeError: Option.none() }),
      }),
    }),
  });
