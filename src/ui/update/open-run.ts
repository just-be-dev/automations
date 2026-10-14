/** Manages the run followed on a page or in a panel, including reloads, polling cadence, and human-task answers. */
import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Update } from "foldkit";
import { modifyFields } from "foldkit/struct";
import type { HumanTask, Run, RunSummary } from "../../workflow.ts";
import { AnswerTask, LoadRun, ResumeNow } from "../command.ts";
import type { TaskAnswer } from "../domain/index.ts";
import type { Message } from "../message.ts";
import { type Model, type OpenRun, Page, RunDetail, RunNotice } from "../model.ts";

export const openingRun = (automationId: string, runId: string): OpenRun => ({
  automationId,
  runId,
  detail: RunDetail.Loading(),
  taskEdits: [],
  notice: RunNotice.Idle(),
});

/** The run on its own page, or else the one in the panel. */
const maybeOpenRun = (model: Model) =>
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
