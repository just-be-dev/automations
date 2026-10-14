/** Manages the run followed on a page or in a panel, including reloads, polling cadence, and human-task answers. */
import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { withArticle } from "@/lib/format";
import type { HumanTask, Run, RunSummary } from "../../workflow.ts";
import { AnswerTask, LoadRun, LoadRunSubjects, ResumeNow, StartSavedRun } from "../command.ts";
import type { TaskAnswer } from "../domain/index.ts";
import type { Message } from "../message.ts";
import {
  type Model,
  type OpenRun,
  Page,
  RunDetail,
  RunNotice,
  RunStart,
  runSubjectType,
  SubjectChoices,
} from "../model.ts";

export const openingRun = (automationId: string, runId: string): OpenRun => ({
  automationId,
  runId,
  detail: RunDetail.Loading(),
  taskEdits: [],
  notice: RunNotice.Idle(),
  subjectChoices: SubjectChoices.NotNeeded(),
  maybeSubjectId: Option.none(),
  start: RunStart.Idle(),
});

/** The run on its own page, or else the one in the panel. */
export const maybeOpenRun = (model: Model) =>
  Page.guards.Run(model.page) ? Option.some(model.page.openRun) : model.maybeRunPanel;

export const modifyOpenRun = (model: Model, modify: (openRun: OpenRun) => OpenRun): Model => {
  const page = model.page;
  return Page.guards.Run(page)
    ? modifyFields(model, { page: () => Page.Run({ openRun: modify(page.openRun) }) })
    : modifyFields(model, { maybeRunPanel: (maybePanel) => Option.map(maybePanel, modify) });
};

export const openRunWithId = (model: Model, runId: string) =>
  Option.filter(maybeOpenRun(model), (openRun) => openRun.runId === runId);

export const reloadOpenRun = (model: Model): Update.Return<Model, Message> =>
  Option.match(maybeOpenRun(model), {
    onNone: () => ({ model }),
    onSome: (openRun) => {
      const reloading = modifyFields(model, { runPoll: (poll) => poll + 1 });
      return {
        model: reloading,
        commands: [
          LoadRun({
            automationId: openRun.automationId,
            revision: model.revision,
            poll: reloading.runPoll,
            runId: openRun.runId,
          }),
        ],
      };
    },
  });

export const noticeRun = (model: Model, notice: RunNotice) =>
  modifyOpenRun(model, (openRun) => ({ ...openRun, notice }));

/** Polls quickly while the run runs, or while a wait resumed early hasn't moved on yet. */
export const pollDelayMillis = (run: Run, notice: RunNotice): ReadonlyArray<number> =>
  Match.value(run.status).pipe(
    Match.when("running", () => [1500]),
    Match.when("waiting", () =>
      RunNotice.guards.Resumed(notice) && run.steps[notice.step]?.status === "waiting"
        ? [1500]
        : [5000],
    ),
    Match.orElse(() => []),
  );

const openTaskCount = (run: Run) =>
  Array.filter(run.tasks, (task) => task.status === "open").length;

export const isListedAsIs = (runs: ReadonlyArray<RunSummary>, run: Run) =>
  Array.some(
    runs,
    (summary) =>
      summary.id === run.id &&
      summary.status === run.status &&
      summary.openTasks === openTaskCount(run),
  );

const openTask = (openRun: OpenRun, step: string) =>
  RunDetail.match(openRun.detail, {
    Loading: () => Option.none<HumanTask>(),
    Unavailable: () => Option.none<HumanTask>(),
    Loaded: ({ run }) =>
      Array.findFirst(run.tasks, (task) => task.step === step && task.status === "open"),
  });

/** Sending an answer or resuming a wait; the run takes one of them at a time. */
const isBusy = (openRun: OpenRun) =>
  RunNotice.guards.Sending(openRun.notice) || RunNotice.guards.Resuming(openRun.notice);

const isWaitingOnClock = (openRun: OpenRun, step: string) =>
  RunDetail.match(openRun.detail, {
    Loading: () => false,
    Unavailable: () => false,
    Loaded: ({ resumesAt }) => resumesAt[step] !== undefined,
  });

/** Local development only: resumes the open run's wait step now instead of when it's due. */
export const resumeNow = (model: Model, step: string): Update.Return<Model, Message> =>
  Option.match(maybeOpenRun(model), {
    onNone: () => ({ model }),
    onSome: (openRun) => {
      if (isBusy(openRun)) {
        return { model };
      }
      if (!model.isLocalDevelopment || !isWaitingOnClock(openRun, step)) {
        return {
          model: noticeRun(
            model,
            RunNotice.Failed({ error: "That step isn't waiting on a clock" }),
          ),
        };
      }
      return {
        model: noticeRun(model, RunNotice.Resuming()),
        commands: [
          ResumeNow({
            automationId: openRun.automationId,
            revision: model.revision,
            runId: openRun.runId,
            step,
          }),
        ],
      };
    },
  });

export const answerTask = (
  model: Model,
  step: string,
  toAnswer: (
    task: HumanTask,
    edits: ReadonlyArray<TaskAnswer.TaskFieldEdit>,
  ) => Result.Result<TaskAnswer.TaskAnswer, string>,
): Update.Return<Model, Message> =>
  Option.match(maybeOpenRun(model), {
    onNone: () => ({ model }),
    onSome: (openRun) => {
      if (isBusy(openRun)) {
        return { model };
      }
      return Option.match(openTask(openRun, step), {
        onNone: () => ({
          model: noticeRun(
            model,
            RunNotice.Failed({ error: "That task isn't waiting for an answer" }),
          ),
        }),
        onSome: (task) =>
          Result.match(toAnswer(task, openRun.taskEdits), {
            onFailure: (error) => ({ model: noticeRun(model, RunNotice.Failed({ error })) }),
            onSuccess: (answer) => ({
              model: noticeRun(model, RunNotice.Sending()),
              commands: [
                AnswerTask({
                  automationId: openRun.automationId,
                  revision: model.revision,
                  runId: openRun.runId,
                  step,
                  answer,
                }),
              ],
            }),
          }),
      });
    },
  });

const choicesEntityType = (choices: SubjectChoices) =>
  SubjectChoices.match(choices, {
    NotNeeded: () => Option.none<string>(),
    Loading: ({ entityType }) => Option.some(entityType),
    Ready: ({ entityType }) => Option.some(entityType),
    Unavailable: ({ entityType }) => Option.some(entityType),
  });

/** Loads the footer's subjects once per type, starting from the run's own subject. */
export const chooseRunSubjects = (model: Model, run: Run): Update.Return<Model, Message> =>
  Option.match(
    Option.filter(
      Option.flatMap(openRunWithId(model, run.id), (openRun) =>
        Option.map(runSubjectType(run), (entityType) => ({ openRun, entityType })),
      ),
      ({ openRun, entityType }) =>
        !Option.contains(choicesEntityType(openRun.subjectChoices), entityType),
    ),
    {
      onNone: () => ({ model }),
      onSome: ({ entityType }) => ({
        model: modifyOpenRun(model, (openRun) => ({
          ...openRun,
          subjectChoices: SubjectChoices.Loading({ entityType }),
          maybeSubjectId: Option.orElse(openRun.maybeSubjectId, () =>
            Option.map(
              Option.filter(
                Option.fromNullishOr(run.subject),
                (subject) => subject.type === entityType,
              ),
              (subject) => subject.id,
            ),
          ),
        })),
        commands: [LoadRunSubjects({ revision: model.revision, runId: run.id, entityType })],
      }),
    },
  );

const loadedRun = (openRun: OpenRun) =>
  RunDetail.match(openRun.detail, {
    Loading: () => Option.none<Run>(),
    Unavailable: () => Option.none<Run>(),
    Loaded: ({ run }) => Option.some(run),
  });

const failStart = (model: Model, error: string) =>
  modifyOpenRun(model, (openRun) => ({ ...openRun, start: RunStart.Failed({ error }) }));

/** Starts another run of the saved version for the footer's subject. */
export const startSavedRun = (model: Model): Update.Return<Model, Message> =>
  Option.match(
    Option.filter(maybeOpenRun(model), (openRun) => !RunStart.guards.Starting(openRun.start)),
    {
      onNone: () => ({ model }),
      onSome: (openRun) =>
        Option.match(loadedRun(openRun), {
          onNone: () => ({ model }),
          onSome: (run) => {
            if (run.workflow.trigger.kind === "event") {
              return { model: failStart(model, "Start event runs from the studio") };
            }
            const maybeEntityType = runSubjectType(run);
            if (Option.isSome(maybeEntityType) && Option.isNone(openRun.maybeSubjectId)) {
              return {
                model: failStart(
                  model,
                  `Choose ${withArticle(maybeEntityType.value)} to run it for`,
                ),
              };
            }
            return {
              model: modifyOpenRun(model, (current) => ({
                ...current,
                start: RunStart.Starting(),
              })),
              commands: [
                StartSavedRun({
                  automationId: openRun.automationId,
                  revision: model.revision,
                  fromRunId: openRun.runId,
                  maybeSubjectId: Option.isSome(maybeEntityType)
                    ? openRun.maybeSubjectId
                    : Option.none(),
                }),
              ],
            };
          },
        }),
    },
  );
