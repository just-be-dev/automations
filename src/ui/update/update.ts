/** Coordinates root app interactions across the studio, runs, and child pages.
 * Guards page-specific results against outdated page revisions and polling contexts. */
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
  LoadAutomations,
  LoadExternal,
  LoadRuns,
  LoadEventInput,
  NavigateInternal,
  PollRun,
  SaveDraft,
  SetPermission,
  StartRun,
} from "../command.ts";
import { AutomationId, EventInput, TaskAnswer } from "../domain/index.ts";
import {
  Message,
  toEntitiesMessage,
  toOverviewMessage,
  toTemplatesMessage,
  toTracesMessage,
} from "../message.ts";
import {
  Activity,
  Directory,
  type Model,
  Page,
  RoleChoices,
  RunDetail,
  RunNotice,
  RunStart,
  SubjectChoices,
} from "../model.ts";
import { Entities, Overview, Templates, Traces } from "../page/index.ts";
import { routeFromUrl, runHref } from "../route.ts";
import { nextTheme } from "../theme.ts";
import { followRoute, openRunPanel, opensInPanel } from "./navigation.ts";
import { dirtyForms, foldAssistant, pageHref, startAssistantThread } from "./assistant.ts";
import {
  answerTask,
  chooseRunSubjects,
  isListedAsIs,
  modifyOpenRun,
  noticeRun,
  openRunWithId,
  pollDelayMillis,
  reloadOpenRun,
  resumeNow,
  startSavedRun,
} from "./open-run.ts";
import {
  choicesEntityType,
  chooseSubjects,
  fail,
  isAnswering,
  loadedAutomation,
  savedSubjectType,
} from "./studio.ts";

const foldEntities = Update.foldChild({
  update: Entities.update,
  read: (model: Model) =>
    Page.guards.Entities(model.page) ? Option.some(model.page.entities) : Option.none(),
  write: (model: Model, nextEntities: Entities.Model): Model =>
    modifyFields(model, { page: (): Page => Page.Entities({ entities: nextEntities }) }),
  toParentMessage: toEntitiesMessage,
});

const foldTemplates = Update.foldChild({
  update: Templates.update,
  read: (model: Model) =>
    Page.guards.Templates(model.page) ? Option.some(model.page.templates) : Option.none(),
  write: (model: Model, nextTemplates: Templates.Model): Model =>
    modifyFields(model, { page: (): Page => Page.Templates({ templates: nextTemplates }) }),
  toParentMessage: toTemplatesMessage,
});

const foldTraces = Update.foldChild({
  update: Traces.update,
  read: (model: Model) =>
    Page.guards.Traces(model.page) ? Option.some(model.page.traces) : Option.none(),
  write: (model: Model, nextTraces: Traces.Model): Model =>
    modifyFields(model, { page: (): Page => Page.Traces({ traces: nextTraces }) }),
  toParentMessage: toTracesMessage,
});

/** New automations are drafted by the studio agent, on a fresh thread it opens for them. */
const draftNewAutomation = (model: Model) =>
  startAssistantThread(model, "Draft an automation that ");

const foldOverview = Update.foldChild({
  update: Overview.update,
  read: (model: Model) =>
    Page.guards.Overview(model.page) ? Option.some(model.page.overview) : Option.none(),
  write: (model, nextOverview) =>
    modifyFields(model, { page: () => Page.Overview({ overview: nextOverview }) }),
  toParentMessage: toOverviewMessage,
  foldOutMessage: (outMessage: Overview.OutMessage) => (model: Model) =>
    Overview.OutMessage.match<Update.Return<Model, Message>>(outMessage, {
      RequestedNewAutomation: () => draftNewAutomation(model),
    }),
});

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    GotAssistantMessage: ({ message }) => foldAssistant(model, message),
    ClickedLink: ({ request }) =>
      UrlRequest.match<Update.Return<Model, Message>>(request, {
        Internal: ({ url }) => {
          const paused = modifyFields(model, {
            assistant: (assistant) => modifyFields(assistant, { follow: () => false }),
          });
          if (dirtyForms(model)) {
            return {
              model: modifyFields(paused, {
                maybeNavigationNotice: () =>
                  Option.some("Save or cancel your open form before leaving this page."),
              }),
            };
          }
          return Option.match(opensInPanel(paused, routeFromUrl(url)), {
            onNone: () => ({
              model: modifyFields(paused, { maybeNavigationNotice: () => Option.none() }),
              commands: [NavigateInternal({ url: urlToString(url) })],
            }),
            onSome: ({ automationId, runId }) => openRunPanel(paused, automationId, runId),
          });
        },
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => {
      const href = `${url.pathname}${Option.match(url.search, { onNone: () => "", onSome: (search) => `?${search}` })}`;
      const automatic = Option.contains(model.maybeFollowHref, href);
      const paused = modifyFields(model, {
        assistant: (assistant) =>
          automatic ? assistant : modifyFields(assistant, { follow: () => false }),
        maybeFollowHref: () => Option.none(),
      });
      if (dirtyForms(model) && href !== pageHref(model)) {
        return {
          model: modifyFields(paused, {
            maybeNavigationNotice: () =>
              Option.some("Save or cancel your open form before leaving this page."),
          }),
          commands: [NavigateInternal({ url: pageHref(model) })],
        };
      }
      return followRoute(paused, routeFromUrl(url));
    },
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    ClickedNewAutomation: () => draftNewAutomation(model),
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
    GotEventInputMessage: ({ message }) => ({
      model: Activity.guards.Working(model.activity)
        ? model
        : modifyFields(model, {
            maybeEventInput: (maybeEditor) =>
              Option.map(maybeEditor, (editor) => EventInput.update(editor, message)),
          }),
    }),
    SucceededLoadEventInput: ({ revision, editor }) =>
      revision !== model.revision
        ? { model }
        : {
            model: modifyFields(model, {
              maybeEventInput: (maybeEditor) =>
                Option.map(maybeEditor, (current) => (current.revision === 0 ? editor : current)),
            }),
          },
    FailedLoadEventInput: () => ({ model }),
    ClickedCancelStart: () =>
      Activity.guards.Working(model.activity)
        ? { model }
        : {
            model: modifyFields(model, {
              maybeEventInput: () => Option.none(),
              activity: () => Activity.Ready({ notice: "" }),
            }),
          },
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
      const isEvent = model.maybeSaved.value.trigger.kind === "event";
      if (isEvent && Option.isNone(model.maybeEventInput)) {
        const saved = model.maybeSaved.value;
        return {
          model: modifyFields(model, {
            maybeEventInput: () => Option.some(EventInput.initial(saved.trigger, saved)),
          }),
          commands: [
            LoadEventInput({ automationId: model.automationId, revision: model.revision }),
          ],
        };
      }
      const parsedEvent = Option.map(model.maybeEventInput, EventInput.data);
      if (isEvent && Option.isSome(parsedEvent) && Result.isFailure(parsedEvent.value)) {
        return fail(model, parsedEvent.value.failure);
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
            ...(isEvent && Option.isSome(parsedEvent) && Result.isSuccess(parsedEvent.value)
              ? { event: { data: parsedEvent.value.success } }
              : {}),
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
    ClickedResumeNow: ({ step }) => resumeNow(model, step),
    SelectedRunSubject: ({ subjectId }) => ({
      model: modifyOpenRun(model, (openRun) => ({
        ...openRun,
        maybeSubjectId: subjectId === "" ? Option.none() : Option.some(subjectId),
        start: RunStart.guards.Starting(openRun.start) ? openRun.start : RunStart.Idle(),
      })),
    }),
    ClickedRunSavedVersion: () => startSavedRun(model),
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
      maybeLatestChanges,
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
              maybeLatestChanges: () => maybeLatestChanges,
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
    SucceededLoadConnections: ({ live }) => ({
      model: modifyFields(model, { liveConnections: () => live }),
    }),
    FailedLoadConnections: () => ({ model }),
    SucceededLoadDevelopment: ({ isLocal }) => ({
      model: modifyFields(model, { isLocalDevelopment: () => isLocal }),
    }),
    FailedLoadDevelopment: () => ({ model }),
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
    SucceededLoadRunSubjects: ({ revision, runId, entityType, label, subjects }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, runId))
        ? { model }
        : {
            model: modifyOpenRun(model, (openRun) =>
              SubjectChoices.guards.Loading(openRun.subjectChoices) &&
              openRun.subjectChoices.entityType === entityType
                ? {
                    ...openRun,
                    subjectChoices: SubjectChoices.Ready({ entityType, label, subjects }),
                  }
                : openRun,
            ),
          },
    FailedLoadRunSubjects: ({ revision, runId, entityType, error }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, runId))
        ? { model }
        : {
            model: modifyOpenRun(model, (openRun) =>
              SubjectChoices.guards.Loading(openRun.subjectChoices) &&
              openRun.subjectChoices.entityType === entityType
                ? {
                    ...openRun,
                    subjectChoices: SubjectChoices.Unavailable({ entityType, error }),
                  }
                : openRun,
            ),
          },
    SucceededStartSavedRun: ({ revision, fromRunId, runId }) =>
      revision !== model.revision
        ? { model }
        : Option.match(openRunWithId(model, fromRunId), {
            onNone: () => ({ model }),
            onSome: (openRun) => {
              const started = modifyOpenRun(model, (current) => ({
                ...current,
                start: RunStart.Idle(),
              }));
              return Page.guards.Run(model.page)
                ? {
                    model: started,
                    commands: [NavigateInternal({ url: runHref(openRun.automationId, runId) })],
                  }
                : openRunPanel(started, openRun.automationId, runId);
            },
          }),
    FailedStartSavedRun: ({ revision, fromRunId, error }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, fromRunId))
        ? { model }
        : {
            model: modifyOpenRun(model, (openRun) => ({
              ...openRun,
              start: RunStart.Failed({ error }),
            })),
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
    SucceededLoadRun: ({ revision, poll, run, maybeSubjectTitle, resumesAt }) => {
      if (revision !== model.revision || poll !== model.runPoll) {
        return { model };
      }
      return Option.match(openRunWithId(model, run.id), {
        onNone: () => ({ model }),
        onSome: (openRun) => {
          const automationId = openRun.automationId;
          // NOTE: the studio's list of recent runs follows the run it shows beside the draft.
          const isRecentRun = Page.guards.Studio(model.page) && automationId === model.automationId;
          return Update.combine(
            modifyOpenRun(model, (current) => ({
              ...current,
              detail: RunDetail.Loaded({ run, maybeSubjectTitle, resumesAt }),
            })),
            [
              (stepModel) => ({
                model: stepModel,
                commands: [
                  ...Array.map(pollDelayMillis(run, openRun.notice), (delayMillis) =>
                    PollRun({ automationId, revision, poll, runId: run.id, delayMillis }),
                  ),
                  ...(isRecentRun && !isListedAsIs(model.runs, run)
                    ? [LoadRuns({ automationId, revision })]
                    : []),
                ],
              }),
              (stepModel) => chooseRunSubjects(stepModel, run),
            ],
          );
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
    SucceededResumeNow: ({ revision, runId, step }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, runId))
        ? { model }
        : reloadOpenRun(noticeRun(model, RunNotice.Resumed({ step }))),
    FailedResumeNow: ({ revision, runId, error }) =>
      revision !== model.revision || Option.isNone(openRunWithId(model, runId))
        ? { model }
        : { model: noticeRun(model, RunNotice.Failed({ error })) },
    FailedRequest: ({ revision, error }) =>
      revision !== model.revision ? { model } : fail(model, error),
    GotOverviewMessage: ({ message }) => foldOverview(model, message),
    GotTemplatesMessage: ({ message }) => foldTemplates(model, message),
    GotEntitiesMessage: ({ message }) => foldEntities(model, message),
    GotTracesMessage: ({ message }) => foldTraces(model, message),
  });
