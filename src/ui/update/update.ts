import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { toString as urlToString } from "foldkit/url";
import { modifyFields } from "foldkit/struct";
import { withArticle } from "@/lib/format";
import { permissionOf } from "../../connections.ts";
import {
  ApplyTheme,
  FocusAutomationIdInput,
  LoadAutomations,
  LoadExternal,
  LoadRuns,
  NavigateInternal,
  PollAutomation,
  PollRun,
  SaveDraft,
  SendMessage,
  SetPermission,
  StartRun,
} from "../command.ts";
import { maxMessageLength } from "../constant.ts";
import { AutomationId, TaskAnswer } from "../domain/index.ts";
import { Message, toEntitiesMessage, toOverviewMessage } from "../message.ts";
import {
  Activity,
  Directory,
  type Model,
  messageInputOf,
  modifyMessageInput,
  Page,
  RoleChoices,
  RunDetail,
  RunNotice,
  SubjectChoices,
} from "../model.ts";
import { Entities, Overview } from "../page/index.ts";
import { automationHref, routeFromUrl, runHref } from "../route.ts";
import { nextTheme } from "../theme.ts";
import { followRoute, openRunPanel, opensInPanel } from "./navigation.ts";
import {
  answerTask,
  isListedAsIs,
  modifyOpenRun,
  noticeRun,
  openRunWithId,
  pollDelayMillis,
  reloadOpenRun,
} from "./open-run.ts";
import {
  choicesEntityType,
  chooseSubjects,
  fail,
  isAnswering,
  loadedAutomation,
  savedSubjectType,
  thinking,
} from "./studio.ts";

const foldEntities = Update.foldChild({
  update: Entities.update,
  read: (model: Model) =>
    Page.guards.Entities(model.page) ? Option.some(model.page.entities) : Option.none(),
  write: (model: Model, nextEntities: Entities.Model): Model =>
    modifyFields(model, { page: (): Page => Page.Entities({ entities: nextEntities }) }),
  toParentMessage: toEntitiesMessage,
});

const foldOverview = Update.foldChild({
  update: Overview.update,
  read: (model: Model) =>
    Page.guards.Overview(model.page) ? Option.some(model.page.overview) : Option.none(),
  write: (model, nextOverview) =>
    modifyFields(model, { page: () => Page.Overview({ overview: nextOverview }) }),
  toParentMessage: toOverviewMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<Update.Return<Model, Message>>(request, {
        Internal: ({ url }) =>
          Option.match(opensInPanel(model, routeFromUrl(url)), {
            onNone: () => ({ model, commands: [NavigateInternal({ url: urlToString(url) })] }),
            onSome: ({ automationId, runId }) => openRunPanel(model, automationId, runId),
          }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => followRoute(model, routeFromUrl(url)),
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    UpdatedAutomationId: ({ value }) => ({
      model: modifyFields(model, { automationIdInput: () => value }),
    }),
    ChangedAutomationId: () => {
      const automationId = model.automationIdInput.trim();
      if (!AutomationId.isValid(automationId)) {
        return fail(model, AutomationId.invalidError);
      }
      if (automationId === model.automationId) {
        return { model };
      }
      return { model, commands: [NavigateInternal({ url: automationHref(automationId) })] };
    },
    ClickedNewAutomation: () => ({
      model: modifyFields(model, { automationIdInput: () => "" }),
      commands: [FocusAutomationIdInput()],
    }),
    CompletedFocusAutomationIdInput: () => ({ model }),
    ToggledStepDetails: ({ stepId, isOpen }) => ({
      model: modifyFields(model, {
        expandedStepIds: (stepIds) => {
          const otherStepIds = Array.filter(stepIds, (id) => id !== stepId);
          return isOpen ? Array.append(otherStepIds, stepId) : otherStepIds;
        },
      }),
    }),
    SelectedWorkflowDisplay: ({ display }) => ({
      model: modifyFields(model, { workflowDisplay: () => display }),
    }),
    ClickedThemeToggle: () => {
      const theme = nextTheme[model.theme];
      return {
        model: modifyFields(model, { theme: () => theme }),
        commands: [ApplyTheme({ theme })],
      };
    },
    CompletedApplyTheme: () => ({ model }),
    UpdatedMessageInput: ({ value }) => ({ model: modifyMessageInput(model, () => value) }),
    ClickedSend: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!AutomationId.isValid(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      const messageInput = messageInputOf(model);
      if (!messageInput.trim() || messageInput.length > maxMessageLength) {
        return fail(model, "Message must be 1–10,000 characters");
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Sending message…" }),
        }),
        commands: [
          SendMessage({
            automationId: model.automationId.trim(),
            revision: model.revision,
            message: messageInput,
          }),
        ],
      };
    },
    ClickedSave: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!AutomationId.isValid(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      if (Option.isNone(model.maybeDraft)) {
        return fail(model, "Create a draft first");
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Saving draft…" }),
        }),
        commands: [
          SaveDraft({ automationId: model.automationId.trim(), revision: model.revision }),
        ],
      };
    },
    SelectedPermission: ({ operation, permission }) => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (Option.isNone(model.maybeDraft)) {
        return fail(model, "Create a draft first");
      }
      if (
        JSON.stringify(permissionOf(model.maybeDraft.value, operation)) ===
        JSON.stringify(permission)
      ) {
        return { model };
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Updating permissions…" }),
        }),
        commands: [
          SetPermission({
            automationId: model.automationId.trim(),
            revision: model.revision,
            operation,
            permission,
          }),
        ],
      };
    },
    SelectedSubject: ({ subjectId }) => ({
      model: modifyFields(model, {
        maybeSubjectId: () => (subjectId === "" ? Option.none() : Option.some(subjectId)),
      }),
    }),
    ClickedStart: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!AutomationId.isValid(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      if (Option.isNone(model.maybeSaved)) {
        return fail(model, "Save the draft before running it");
      }
      const maybeEntityType = savedSubjectType(model.maybeSaved);
      if (Option.isSome(maybeEntityType) && Option.isNone(model.maybeSubjectId)) {
        return fail(model, `Choose ${withArticle(maybeEntityType.value)} to run it for`);
      }
      return {
        model: modifyFields(model, {
          activity: () => Activity.Working({ notice: "Starting run…" }),
        }),
        commands: [
          StartRun({
            automationId: model.automationId.trim(),
            revision: model.revision,
            maybeSubjectId: Option.isSome(maybeEntityType) ? model.maybeSubjectId : Option.none(),
          }),
        ],
      };
    },
    ClickedCloseRunPanel: () => ({
      model: modifyFields(model, { maybeRunPanel: () => Option.none() }),
    }),
    ClickedExpandRunPanel: () =>
      Option.match(model.maybeRunPanel, {
        onNone: () => ({ model }),
        onSome: (panel) => ({
          model,
          commands: [NavigateInternal({ url: runHref(panel.automationId, panel.runId) })],
        }),
      }),
    ClickedApproveTask: ({ step }) => answerTask(model, step, TaskAnswer.approval(true)),
    ClickedRejectTask: ({ step }) => answerTask(model, step, TaskAnswer.approval(false)),
    UpdatedTaskField: ({ step, field, value }) => ({
      model: modifyOpenRun(model, (openRun) => ({
        ...openRun,
        taskEdits: Array.append(
          Array.filter(openRun.taskEdits, (edit) => edit.step !== step || edit.field !== field),
          { step, field, value },
        ),
      })),
    }),
    SubmittedTaskForm: ({ step }) =>
      answerTask(model, step, (task, edits) =>
        task.response === "approval"
          ? Result.fail("Approve or reject the request")
          : TaskAnswer.fromForm(edits, task, task.response.fields),
      ),
    SucceededLoadAutomation: ({
      revision,
      maybeDraft,
      maybeSaved,
      conversation,
      maybePendingChat,
      runs,
      maybeProgress,
    }) =>
      revision !== model.revision
        ? { model }
        : Update.combine(
            modifyFields(model, {
              maybeDraft: () => maybeDraft,
              maybeSaved: () => maybeSaved,
              conversation: () => conversation,
              maybePendingChat: () => maybePendingChat,
              runs: () => runs,
              maybeProgress: () => maybeProgress,
            }),
            [
              (stepModel) =>
                loadedAutomation(stepModel, {
                  wasWaiting: Option.exists(model.maybePendingChat, isAnswering),
                  idleNotice: Option.isSome(maybeSaved)
                    ? "Saved automation available."
                    : "No saved automation yet.",
                }),
              chooseSubjects,
            ],
          ),
    SucceededSendMessage: ({ revision, sentMessage, pendingChat }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(
              modifyMessageInput(model, (value) => (value === sentMessage ? "" : value)),
              {
                maybePendingChat: () => Option.some(pendingChat),
                maybeProgress: () => Option.none(),
                activity: () => thinking,
              },
            ),
            commands: [PollAutomation({ automationId: model.automationId.trim(), revision })],
          },
    SucceededSaveDraft: ({ revision, saved }) =>
      revision !== model.revision
        ? { model }
        : Update.combine(
            modifyFields(model, {
              maybeSaved: () => Option.some(saved),
              activity: () => Activity.Ready({ notice: "Saved. Ready to start." }),
            }),
            [(stepModel) => ({ model: stepModel, commands: [LoadAutomations()] }), chooseSubjects],
          ),
    SucceededSetPermission: ({ revision, draft }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              maybeDraft: () => Option.some(draft),
              activity: () =>
                Activity.Ready({ notice: "Permission updated. Save the draft to use it in runs." }),
            }),
          },
    SucceededLoadAutomations: ({ automations }) => ({
      model: modifyFields(model, { directory: () => Directory.Ready({ automations }) }),
    }),
    FailedLoadAutomations: ({ error }) => ({
      model: modifyFields(model, { directory: () => Directory.Unavailable({ error }) }),
    }),
    SucceededLoadRoles: ({ roles }) => ({
      model: modifyFields(model, { roles: () => RoleChoices.Ready({ roles }) }),
    }),
    FailedLoadRoles: ({ error }) => ({
      model: modifyFields(model, { roles: () => RoleChoices.Unavailable({ error }) }),
    }),
    SucceededLoadSubjects: ({ revision, entityType, label, subjects }) =>
      revision !== model.revision || !SubjectChoices.guards.Loading(model.subjectChoices)
        ? { model }
        : model.subjectChoices.entityType !== entityType
          ? { model }
          : {
              model: modifyFields(model, {
                subjectChoices: () => SubjectChoices.Ready({ entityType, label, subjects }),
                maybeSubjectId: (maybeSubjectId) =>
                  Option.filter(maybeSubjectId, (subjectId) =>
                    Array.some(subjects, (subject) => subject.id === subjectId),
                  ),
              }),
            },
    FailedLoadSubjects: ({ revision, entityType, error }) =>
      revision !== model.revision ||
      !Option.exists(choicesEntityType(model.subjectChoices), (current) => current === entityType)
        ? { model }
        : {
            model: modifyFields(model, {
              subjectChoices: () => SubjectChoices.Unavailable({ entityType, error }),
            }),
          },
    SucceededStartRun: ({ revision, runId }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: `Run ${runId} started.` }),
            }),
            commands: [NavigateInternal({ url: runHref(model.automationId.trim(), runId) })],
          },
    SucceededLoadRun: ({ revision, poll, run, maybeSubjectTitle }) => {
      if (revision !== model.revision || poll !== model.runPoll) {
        return { model };
      }
      return Option.match(openRunWithId(model, run.id), {
        onNone: () => ({ model }),
        onSome: (openRun) => {
          const automationId = openRun.automationId;
          // NOTE: the studio's list of recent runs follows the run it shows beside the draft.
          const isRecentRun = Page.guards.Studio(model.page) && automationId === model.automationId;
          return {
            model: modifyOpenRun(model, (current) => ({
              ...current,
              detail: RunDetail.Loaded({ run, maybeSubjectTitle }),
            })),
            commands: [
              ...Array.map(pollDelayMillis(run.status), (delayMillis) =>
                PollRun({ automationId, revision, poll, runId: run.id, delayMillis }),
              ),
              ...(isRecentRun && !isListedAsIs(model.runs, run)
                ? [LoadRuns({ automationId, revision })]
                : []),
            ],
          };
        },
      });
    },
    FailedLoadRun: ({ revision, poll, error }) =>
      revision !== model.revision || poll !== model.runPoll
        ? { model }
        : {
            model: modifyOpenRun(model, (openRun) =>
              RunDetail.guards.Loading(openRun.detail)
                ? { ...openRun, detail: RunDetail.Unavailable({ error }) }
                : { ...openRun, notice: RunNotice.Failed({ error }) },
            ),
          },
    SucceededLoadRuns: ({ revision, runs }) =>
      revision !== model.revision
        ? { model }
        : { model: modifyFields(model, { runs: () => runs }) },
    SucceededAnswerTask: ({ revision, runId, step }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, runId))
        ? { model }
        : reloadOpenRun(
            modifyOpenRun(model, (openRun) => ({
              ...openRun,
              taskEdits: Array.filter(openRun.taskEdits, (edit) => edit.step !== step),
              notice: RunNotice.Sent(),
            })),
          ),
    FailedAnswerTask: ({ revision, runId, error }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, runId))
        ? { model }
        : { model: noticeRun(model, RunNotice.Failed({ error })) },
    FailedRequest: ({ revision, error }) =>
      revision !== model.revision ? { model } : fail(model, error),
    GotOverviewMessage: ({ message }) => foldOverview(model, message),
    GotEntitiesMessage: ({ message }) => foldEntities(model, message),
  });
