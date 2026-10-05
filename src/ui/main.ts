import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command, Dom, Http, type Runtime, Update } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest, load, pushUrl } from "foldkit/navigation";
import { Url, toString as urlToString } from "foldkit/url";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { Checkbox, Disclosure, Input } from "@foldkit/ui";
import {
  Bot,
  Braces,
  CalendarDays,
  Check,
  ChevronDown,
  GitBranch,
  Hash,
  Hourglass,
  LayoutDashboard,
  Mail,
  Maximize2,
  Pencil,
  MessageSquare,
  Monitor,
  Moon,
  Scale,
  Split,
  Sun,
  UserRound,
  CircleAlert,
  CornerDownLeft,
  LoaderCircle,
  Play,
  Plus,
  Radio,
  Webhook,
  Workflow as WorkflowIcon,
  X,
} from "lucide";
import { badge } from "@/components/ui/badge";
import { Bubble } from "@/components/ui/bubble";
import { button, buttonClass } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { input, inputClass } from "@/components/ui/input";
import { Message as ChatMessage } from "@/components/ui/message";
import { textarea } from "@/components/ui/textarea";
import { icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { connectionOf, findOperation } from "../connections.ts";
import {
  HumanTask,
  PendingChat,
  Run,
  RunStatus,
  RunSummary,
  subjectType,
  TitledRun,
  templateParts,
  workflowRefs,
  Workflow,
  type ActionInput,
  type Comparison,
  type Condition,
  type HumanField,
  type RunStep,
  type Step,
  type Trigger,
  type ValueType,
} from "../workflow.ts";
import { errorText, loadSubjectOptions, requestJson, SubjectOption } from "./api.ts";
import {
  formatTime,
  openTasksText,
  runDotClass,
  runStatusClass,
  runStatusLabel,
  withArticle,
} from "./format.ts";
import * as Overview from "./overview.ts";
import { recordView } from "./record.ts";
import { AppRoute, automationHref, overviewHref, routeFromUrl, runHref } from "./route.ts";
import { applyTheme, nextTheme, Theme, type Flags } from "./theme.ts";

// MODEL

export { Workflow };

const Activity = defineTaggedUnion({
  Ready: { notice: Schema.String },
  Working: { notice: Schema.String },
  Failed: { error: Schema.String },
});

const Exchange = Schema.Struct({
  id: Schema.Int,
  prompt: Schema.String,
  reply: Schema.String,
});

const WorkflowDisplay = Schema.Literals(["Steps", "Json"]);
type WorkflowDisplay = typeof WorkflowDisplay.Type;

const AutomationSummary = Schema.Struct({ id: Schema.String, name: Schema.String });

const Directory = defineTaggedUnion({
  Loading: {},
  Ready: { automations: Schema.Array(AutomationSummary) },
  Unavailable: { error: Schema.String },
});

const SubjectChoices = defineTaggedUnion({
  NotNeeded: {},
  Loading: { entityType: Schema.String },
  Ready: { entityType: Schema.String, label: Schema.String, subjects: Schema.Array(SubjectOption) },
  Unavailable: { entityType: Schema.String, error: Schema.String },
});
type SubjectChoices = typeof SubjectChoices.Type;

const RunDetail = defineTaggedUnion({
  Loading: {},
  Loaded: { run: Run, maybeSubjectTitle: Schema.Option(Schema.String) },
  Unavailable: { error: Schema.String },
});

const TaskFieldEdit = Schema.Struct({
  step: Schema.String,
  field: Schema.String,
  value: Schema.String,
});
type TaskFieldEdit = typeof TaskFieldEdit.Type;

const TaskAnswer = Schema.Struct({
  approved: Schema.optionalKey(Schema.Boolean),
  values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
type TaskAnswer = typeof TaskAnswer.Type;

/** How the last answer to one of the run's tasks, or the last reload of the run, went. */
const RunNotice = defineTaggedUnion({
  Idle: {},
  Sending: {},
  Sent: {},
  Failed: { error: Schema.String },
});
type RunNotice = typeof RunNotice.Type;

/** A run being followed, on its own page or in the panel beside the overview or the studio. */
const OpenRun = Schema.Struct({
  automationId: Schema.String,
  runId: Schema.String,
  detail: RunDetail,
  taskEdits: Schema.Array(TaskFieldEdit),
  notice: RunNotice,
});
type OpenRun = typeof OpenRun.Type;

/**
 * The overview of every automation, the studio that edits the one in `automationId`, or one of its
 * runs. A run page shows what the run did without the designer: it ran a saved snapshot, not the
 * draft.
 */
const Page = defineTaggedUnion({
  Overview: { overview: Overview.Model },
  Studio: {},
  Run: { openRun: OpenRun },
});

export const Model = Schema.Struct({
  page: Page,
  automationId: Schema.String,
  automationIdInput: Schema.String,
  directory: Directory,
  revision: Schema.Int,
  messageInput: Schema.String,
  conversation: Schema.Array(Exchange),
  maybeDraft: Schema.Option(Workflow),
  maybeSaved: Schema.Option(Workflow),
  maybePendingChat: Schema.Option(PendingChat),
  runs: Schema.Array(RunSummary),
  /** The run open beside the overview or the studio. Changing pages closes it. */
  maybeRunPanel: Schema.Option(OpenRun),
  /** Each load of the open run starts a new chain of polls and drops the replies of older ones. */
  runPoll: Schema.Int,
  subjectChoices: SubjectChoices,
  maybeSubjectId: Schema.Option(Schema.String),
  /** What the agent is doing while it answers, as the server last described it. */
  maybeProgress: Schema.Option(Schema.String),
  expandedStepIds: Schema.Array(Schema.String),
  workflowDisplay: WorkflowDisplay,
  theme: Theme,
  activity: Activity,
});
export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  UpdatedAutomationId: { value: Schema.String },
  ChangedAutomationId: {},
  ClickedNewAutomation: {},
  CompletedFocusAutomationIdInput: {},
  UpdatedMessageInput: { value: Schema.String },
  ToggledStepDetails: { stepId: Schema.String, isOpen: Schema.Boolean },
  SelectedWorkflowDisplay: { display: WorkflowDisplay },
  ClickedThemeToggle: {},
  CompletedApplyTheme: {},
  ClickedSend: {},
  ClickedSave: {},
  SelectedSubject: { subjectId: Schema.String },
  ClickedStart: {},
  ClickedCloseRunPanel: {},
  ClickedExpandRunPanel: {},
  ClickedApproveTask: { step: Schema.String },
  ClickedRejectTask: { step: Schema.String },
  UpdatedTaskField: { step: Schema.String, field: Schema.String, value: Schema.String },
  SubmittedTaskForm: { step: Schema.String },
  SucceededLoadAutomation: {
    revision: Schema.Int,
    maybeDraft: Schema.Option(Workflow),
    maybeSaved: Schema.Option(Workflow),
    conversation: Schema.Array(Exchange),
    maybePendingChat: Schema.Option(PendingChat),
    runs: Schema.Array(RunSummary),
    maybeProgress: Schema.Option(Schema.String),
  },
  SucceededLoadAutomations: { automations: Schema.Array(AutomationSummary) },
  FailedLoadAutomations: { error: Schema.String },
  SucceededLoadSubjects: {
    revision: Schema.Int,
    entityType: Schema.String,
    label: Schema.String,
    subjects: Schema.Array(SubjectOption),
  },
  FailedLoadSubjects: { revision: Schema.Int, entityType: Schema.String, error: Schema.String },
  SucceededSendMessage: {
    revision: Schema.Int,
    sentMessage: Schema.String,
    pendingChat: PendingChat,
  },
  SucceededSaveDraft: { revision: Schema.Int, saved: Workflow },
  SucceededStartRun: { revision: Schema.Int, runId: Schema.String },
  SucceededLoadRun: {
    revision: Schema.Int,
    poll: Schema.Int,
    run: Run,
    maybeSubjectTitle: Schema.Option(Schema.String),
  },
  FailedLoadRun: { revision: Schema.Int, poll: Schema.Int, error: Schema.String },
  SucceededLoadRuns: { revision: Schema.Int, runs: Schema.Array(RunSummary) },
  SucceededAnswerTask: { revision: Schema.Int, runId: Schema.String, step: Schema.String },
  FailedAnswerTask: { revision: Schema.Int, runId: Schema.String, error: Schema.String },
  FailedRequest: { revision: Schema.Int, error: Schema.String },
  GotOverviewMessage: { message: Overview.Message },
});
export type Message = typeof Message.Type;

// INIT

const invalidIdError = "Automation IDs use letters, numbers, - and _ (up to 80 characters)";

const validId = (value: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(value.trim());

const toOverviewMessage = (message: Overview.Message) => Message.GotOverviewMessage({ message });

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (flags, url) => {
  const route = routeFromUrl(url);
  const automationId = AppRoute.match(route, {
    Overview: () => "",
    Studio: (studio) => studio.automationId,
    Run: (run) => run.automationId,
  });
  const model = Model.make({
    page: Page.Studio(),
    automationId,
    automationIdInput: automationId,
    directory: Directory.Loading(),
    revision: 0,
    messageInput: "",
    conversation: [],
    maybeDraft: Option.none(),
    maybeSaved: Option.none(),
    maybePendingChat: Option.none(),
    runs: [],
    maybeRunPanel: Option.none(),
    runPoll: 0,
    subjectChoices: SubjectChoices.NotNeeded(),
    maybeSubjectId: Option.none(),
    maybeProgress: Option.none(),
    expandedStepIds: [],
    workflowDisplay: "Steps",
    theme: flags.theme,
    activity: validId(automationId)
      ? Activity.Working({ notice: "Loading automation…" })
      : Activity.Failed({ error: invalidIdError }),
  });
  const page = showPage(model, route);
  return { model: page.model, commands: [...(page.commands ?? []), LoadAutomations()] };
};

// UPDATE

const fail = (model: Model, error: string) => ({
  model: modifyFields(model, { activity: () => Activity.Failed({ error }) }),
});

const maxMessageLength = 10_000;

const leaveAutomation = (model: Model, automationId: string): Model =>
  modifyFields(model, {
    automationId: () => automationId,
    automationIdInput: () => automationId,
    revision: (revision) => revision + 1,
    maybeDraft: () => Option.none(),
    maybeSaved: () => Option.none(),
    maybePendingChat: () => Option.none(),
    runs: () => [],
    maybeRunPanel: () => Option.none(),
    subjectChoices: () => SubjectChoices.NotNeeded(),
    maybeSubjectId: () => Option.none(),
    maybeProgress: () => Option.none(),
    expandedStepIds: () => [],
    conversation: () => [],
    activity: () => Activity.Working({ notice: "Loading automation…" }),
  });

/** Shows the route's page on a model already set to its automation, and loads what it needs. */
const showPage = (model: Model, route: AppRoute): Update.Return<Model, Message> =>
  AppRoute.match(route, {
    Overview: () =>
      Update.foldChildInit(Overview.init(model.revision), {
        toParentModel: (overview) =>
          modifyFields(model, {
            page: () => Page.Overview({ overview }),
            activity: () => Activity.Ready({ notice: "" }),
          }),
        toParentMessage: toOverviewMessage,
      }),
    Studio: ({ automationId }) => {
      const studio = modifyFields(model, { page: () => Page.Studio() });
      if (!validId(automationId)) {
        return fail(studio, invalidIdError);
      }
      return {
        model: studio,
        commands: [LoadAutomation({ automationId, revision: model.revision })],
      };
    },
    Run: ({ automationId, runId }) => {
      const runPage = modifyFields(model, {
        page: () => Page.Run({ openRun: openingRun(automationId, runId) }),
        activity: () => Activity.Ready({ notice: "" }),
      });
      if (!validId(automationId)) {
        return {
          model: modifyOpenRun(runPage, (openRun) => ({
            ...openRun,
            detail: RunDetail.Unavailable({ error: invalidIdError }),
          })),
        };
      }
      return reloadOpenRun(runPage);
    },
  });

const routeAutomationId = (route: AppRoute) =>
  AppRoute.match(route, {
    Overview: () => "",
    Studio: ({ automationId }) => automationId,
    Run: ({ automationId }) => automationId,
  });

const isShowing = (model: Model, route: AppRoute) =>
  routeAutomationId(route) === model.automationId &&
  AppRoute.match(route, {
    Overview: () => false,
    Studio: () => Page.guards.Studio(model.page),
    Run: ({ runId }) => Page.guards.Run(model.page) && model.page.openRun.runId === runId,
  });

/**
 * Every page change starts over at a new revision, so the last page's polls and late replies stop
 * there. Following a link to the run already open reloads it.
 */
const followRoute = (model: Model, route: AppRoute): Update.Return<Model, Message> => {
  if (!isShowing(model, route)) {
    return showPage(leaveAutomation(model, routeAutomationId(route)), route);
  }
  return reloadOpenRun(model);
};

/** A run link clicked on the overview or in the studio opens the run beside it. */
const opensInPanel = (model: Model, route: AppRoute) =>
  Page.guards.Run(model.page)
    ? Option.none<{ readonly automationId: string; readonly runId: string }>()
    : AppRoute.match(route, {
        Overview: () => Option.none(),
        Studio: () => Option.none(),
        Run: ({ automationId, runId }) =>
          validId(automationId) ? Option.some({ automationId, runId }) : Option.none(),
      });

const openRunPanel = (model: Model, automationId: string, runId: string) =>
  Option.exists(
    model.maybeRunPanel,
    (panel) => panel.automationId === automationId && panel.runId === runId,
  )
    ? reloadOpenRun(model)
    : reloadOpenRun(
        modifyFields(model, {
          maybeRunPanel: () => Option.some(openingRun(automationId, runId)),
        }),
      );

const foldOverview = Update.foldChild({
  update: Overview.update,
  read: (model: Model) =>
    Page.guards.Overview(model.page) ? Option.some(model.page.overview) : Option.none(),
  write: (model, nextOverview) =>
    modifyFields(model, { page: () => Page.Overview({ overview: nextOverview }) }),
  toParentMessage: toOverviewMessage,
});

const thinking = Activity.Working({ notice: "The agent is thinking…" });

const isAnswering = (pending: PendingChat) => pending.status === "working";

// People using the studio don't build software, so a failed reply never shows the technical error.
// `GET /api/automations/:id` still returns it for debugging.
const unfinishedReply = "The agent couldn't finish its reply. Send your message again to retry.";

const loadedAutomation = (
  model: Model,
  options: { readonly wasWaiting: boolean; readonly idleNotice: string },
): Update.Return<Model, Message> =>
  Option.match(model.maybePendingChat, {
    onNone: () =>
      options.wasWaiting
        ? {
            model: modifyFields(model, {
              activity: () =>
                Activity.Ready({ notice: "Draft updated. Review the graph before saving." }),
            }),
            commands: [LoadAutomations()],
          }
        : {
            model: modifyFields(model, {
              activity: () => Activity.Ready({ notice: options.idleNotice }),
            }),
          },
    onSome: (pending) =>
      Match.value(pending).pipe(
        Match.discriminatorsExhaustive("status")({
          working: () => ({
            model: modifyFields(model, { activity: () => thinking }),
            commands: [
              PollAutomation({ automationId: model.automationId.trim(), revision: model.revision }),
            ],
          }),
          failed: ({ prompt }) => ({
            model: modifyFields(model, {
              messageInput: (value) => (value === "" ? prompt : value),
              activity: () => Activity.Failed({ error: unfinishedReply }),
            }),
          }),
        }),
      ),
  });

const savedSubjectType = (maybeSaved: Option.Option<Workflow>) =>
  Option.flatMap(maybeSaved, (saved) => Option.fromNullishOr(subjectType(saved.trigger)));

const choicesEntityType = (choices: SubjectChoices) =>
  SubjectChoices.match(choices, {
    NotNeeded: () => Option.none<string>(),
    Loading: ({ entityType }) => Option.some(entityType),
    Ready: ({ entityType }) => Option.some(entityType),
    Unavailable: () => Option.none<string>(),
  });

const chooseSubjects = (model: Model): Update.Return<Model, Message> =>
  Option.match(savedSubjectType(model.maybeSaved), {
    onNone: () => ({
      model: modifyFields(model, {
        subjectChoices: () => SubjectChoices.NotNeeded(),
        maybeSubjectId: () => Option.none(),
      }),
    }),
    onSome: (entityType) =>
      Option.exists(choicesEntityType(model.subjectChoices), (current) => current === entityType)
        ? { model }
        : {
            model: modifyFields(model, {
              subjectChoices: () => SubjectChoices.Loading({ entityType }),
              maybeSubjectId: () => Option.none(),
            }),
            commands: [LoadSubjects({ revision: model.revision, entityType })],
          },
  });

const openingRun = (automationId: string, runId: string): OpenRun => ({
  automationId,
  runId,
  detail: RunDetail.Loading(),
  taskEdits: [],
  notice: RunNotice.Idle(),
});

/** The run on its own page, or else the one in the panel. */
const maybeOpenRun = (model: Model) =>
  Page.guards.Run(model.page) ? Option.some(model.page.openRun) : model.maybeRunPanel;

const modifyOpenRun = (model: Model, modify: (openRun: OpenRun) => OpenRun): Model => {
  const page = model.page;
  return Page.guards.Run(page)
    ? modifyFields(model, { page: () => Page.Run({ openRun: modify(page.openRun) }) })
    : modifyFields(model, { maybeRunPanel: (maybePanel) => Option.map(maybePanel, modify) });
};

const openRunWithId = (model: Model, runId: string) =>
  Option.filter(maybeOpenRun(model), (openRun) => openRun.runId === runId);

const reloadOpenRun = (model: Model): Update.Return<Model, Message> =>
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

const noticeRun = (model: Model, notice: RunNotice) =>
  modifyOpenRun(model, (openRun) => ({ ...openRun, notice }));

const pollDelayMillis = (status: RunStatus): ReadonlyArray<number> =>
  Match.value(status).pipe(
    Match.when("running", () => [1500]),
    Match.when("waiting", () => [5000]),
    Match.orElse(() => []),
  );

const openTaskCount = (run: Run) =>
  Array.filter(run.tasks, (task) => task.status === "open").length;

const isListedAsIs = (runs: ReadonlyArray<RunSummary>, run: Run) =>
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

export const fieldText = (edits: ReadonlyArray<TaskFieldEdit>, task: HumanTask, field: string) =>
  Option.match(
    Array.findFirst(edits, (edit) => edit.step === task.step && edit.field === field),
    {
      onNone: () => task.defaults[field] ?? "",
      onSome: (edit) => edit.value,
    },
  );

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const answerParsers: Record<ValueType, (text: string) => Option.Option<Schema.Json>> = {
  text: (text) => Option.some(text),
  number: (text) => {
    const value = Number(text.trim());
    return text.trim() !== "" && Number.isFinite(value) ? Option.some(value) : Option.none();
  },
  boolean: (text) => Option.some(text === "true"),
  date: (text) => (isoDate.test(text) ? Option.some(text) : Option.none()),
  datetime: (text) =>
    Number.isNaN(Date.parse(text)) ? Option.none() : Option.some(new Date(text).toISOString()),
};

const formAnswer = (
  edits: ReadonlyArray<TaskFieldEdit>,
  task: HumanTask,
  fields: ReadonlyArray<HumanField>,
): Result.Result<TaskAnswer, string> => {
  const parsed = Array.map(fields, (field) => ({
    field,
    maybeValue: answerParsers[field.type](fieldText(edits, task, field.name)),
  }));
  return Array.match(
    Array.filter(parsed, ({ maybeValue }) => Option.isNone(maybeValue)),
    {
      onEmpty: () =>
        Result.succeed({
          values: Object.fromEntries(
            Array.getSomes(
              Array.map(parsed, ({ field, maybeValue }) =>
                Option.map(maybeValue, (value): readonly [string, Schema.Json] => [
                  field.name,
                  value,
                ]),
              ),
            ),
          ),
        }),
      onNonEmpty: (missing) =>
        Result.fail(`Fill in ${Array.map(missing, ({ field }) => field.label).join(", ")}`),
    },
  );
};

const answerTask = (
  model: Model,
  step: string,
  toAnswer: (
    task: HumanTask,
    edits: ReadonlyArray<TaskFieldEdit>,
  ) => Result.Result<TaskAnswer, string>,
): Update.Return<Model, Message> =>
  Option.match(maybeOpenRun(model), {
    onNone: () => ({ model }),
    onSome: (openRun) => {
      if (RunNotice.guards.Sending(openRun.notice)) {
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

const approval =
  (approved: boolean) =>
  (task: HumanTask): Result.Result<TaskAnswer, string> =>
    task.response === "approval"
      ? Result.succeed({ approved })
      : Result.fail("Fill in the form to answer this task");

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
      if (!validId(automationId)) {
        return fail(model, invalidIdError);
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
    UpdatedMessageInput: ({ value }) => ({
      model: modifyFields(model, { messageInput: () => value }),
    }),
    ClickedSend: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!validId(model.automationId)) {
        return fail(model, "Use an alphanumeric automation ID");
      }
      if (!model.messageInput.trim() || model.messageInput.length > maxMessageLength) {
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
            message: model.messageInput,
          }),
        ],
      };
    },
    ClickedSave: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!validId(model.automationId)) {
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
    SelectedSubject: ({ subjectId }) => ({
      model: modifyFields(model, {
        maybeSubjectId: () => (subjectId === "" ? Option.none() : Option.some(subjectId)),
      }),
    }),
    ClickedStart: () => {
      if (Activity.guards.Working(model.activity)) {
        return { model };
      }
      if (!validId(model.automationId)) {
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
    ClickedApproveTask: ({ step }) => answerTask(model, step, approval(true)),
    ClickedRejectTask: ({ step }) => answerTask(model, step, approval(false)),
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
          : formAnswer(edits, task, task.response.fields),
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
            model: modifyFields(model, {
              maybePendingChat: () => Option.some(pendingChat),
              maybeProgress: () => Option.none(),
              messageInput: (value) => (value === sentMessage ? "" : value),
              activity: () => thinking,
            }),
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
    SucceededLoadAutomations: ({ automations }) => ({
      model: modifyFields(model, { directory: () => Directory.Ready({ automations }) }),
    }),
    FailedLoadAutomations: ({ error }) => ({
      model: modifyFields(model, { directory: () => Directory.Unavailable({ error }) }),
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
  });

// COMMAND

const requestArgs = { automationId: Schema.String, revision: Schema.Int };

const request = <T, E>(
  automationId: string,
  path: string,
  schema: Schema.Codec<T, E>,
  body?: unknown,
) => requestJson(`/api/automations/${automationId}${path}`, schema, body);

const recoverRequest = (revision: number) =>
  Effect.catch((error: unknown) =>
    Effect.succeed(Message.FailedRequest({ revision, error: errorText(error) })),
  );

const AutomationState = Schema.Struct({
  draft: Schema.OptionFromOptional(Workflow),
  saved: Schema.OptionFromOptional(Workflow),
  conversation: Schema.Array(Schema.Struct({ prompt: Schema.String, reply: Schema.String })),
  pendingChat: Schema.OptionFromOptional(PendingChat),
  runs: Schema.Array(RunSummary),
  progress: Schema.OptionFromOptional(Schema.String),
});

const loadAutomation = (automationId: string, revision: number) =>
  request(automationId, "", AutomationState).pipe(
    Effect.map((state) =>
      Message.SucceededLoadAutomation({
        revision,
        maybeDraft: state.draft,
        maybeSaved: state.saved,
        conversation: Array.map(state.conversation, (exchange, id) => ({ id, ...exchange })),
        maybePendingChat: state.pendingChat,
        runs: state.runs,
        maybeProgress: state.progress,
      }),
    ),
    recoverRequest(revision),
    Effect.provide(Http.layer),
  );

export const LoadAutomation = Command.define("LoadAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) => loadAutomation(automationId, revision),
});

/** Reloads the automation after a pause, while the agent is still answering a message. */
export const PollAutomation = Command.define("PollAutomation", {
  args: requestArgs,
  messages: [Message.SucceededLoadAutomation, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    Effect.sleep("1500 millis").pipe(Effect.andThen(loadAutomation(automationId, revision))),
});

export const LoadAutomations = Command.define("LoadAutomations", {
  messages: [Message.SucceededLoadAutomations, Message.FailedLoadAutomations],
  execute: requestJson("/api/automations", Schema.Array(AutomationSummary)).pipe(
    Effect.map((automations) => Message.SucceededLoadAutomations({ automations })),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadAutomations({ error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  ),
});

export const LoadRuns = Command.define("LoadRuns", {
  args: requestArgs,
  messages: [Message.SucceededLoadRuns, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(automationId, "", Schema.Struct({ runs: Schema.Array(RunSummary) })).pipe(
      Effect.map(({ runs }) => Message.SucceededLoadRuns({ revision, runs })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const LoadSubjects = Command.define("LoadSubjects", {
  args: { revision: Schema.Int, entityType: Schema.String },
  messages: [Message.SucceededLoadSubjects, Message.FailedLoadSubjects],
  execute: ({ revision, entityType }) =>
    loadSubjectOptions(entityType).pipe(
      Effect.map(({ label, subjects }) =>
        Message.SucceededLoadSubjects({ revision, entityType, label, subjects }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          Message.FailedLoadSubjects({ revision, entityType, error: errorText(error) }),
        ),
      ),
      Effect.provide(Http.layer),
    ),
});

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

export const ApplyTheme = Command.define("ApplyTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedApplyTheme],
  execute: ({ theme }) => applyTheme(theme).pipe(Effect.as(Message.CompletedApplyTheme())),
});

const automationIdInputId = "id";

export const FocusAutomationIdInput = Command.define("FocusAutomationIdInput", {
  messages: [Message.CompletedFocusAutomationIdInput],
  execute: Dom.focus(`#${automationIdInputId}`).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedFocusAutomationIdInput()),
  ),
});

export const SendMessage = Command.define("SendMessage", {
  args: { ...requestArgs, message: Schema.String },
  messages: [Message.SucceededSendMessage, Message.FailedRequest],
  execute: ({ automationId, revision, message }) =>
    request(automationId, "/chat", Schema.Struct({ pendingChat: PendingChat }), { message }).pipe(
      Effect.map((data) =>
        Message.SucceededSendMessage({
          revision,
          sentMessage: message,
          pendingChat: data.pendingChat,
        }),
      ),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const SaveDraft = Command.define("SaveDraft", {
  args: requestArgs,
  messages: [Message.SucceededSaveDraft, Message.FailedRequest],
  execute: ({ automationId, revision }) =>
    request(automationId, "/save", Schema.Struct({ saved: Workflow }), {}).pipe(
      Effect.map(({ saved }) => Message.SucceededSaveDraft({ revision, saved })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

export const StartRun = Command.define("StartRun", {
  args: { ...requestArgs, maybeSubjectId: Schema.Option(Schema.String) },
  messages: [Message.SucceededStartRun, Message.FailedRequest],
  execute: ({ automationId, revision, maybeSubjectId }) =>
    request(
      automationId,
      "/start",
      Schema.Struct({ id: Schema.String }),
      Option.match(maybeSubjectId, { onNone: () => ({}), onSome: (subject) => ({ subject }) }),
    ).pipe(
      Effect.map(({ id }) => Message.SucceededStartRun({ revision, runId: id })),
      recoverRequest(revision),
      Effect.provide(Http.layer),
    ),
});

const runArgs = { ...requestArgs, poll: Schema.Int, runId: Schema.String };

const fetchRun = (automationId: string, revision: number, poll: number, runId: string) =>
  request(automationId, `/runs/${runId}`, TitledRun).pipe(
    Effect.map(({ subjectTitle, ...run }) =>
      Message.SucceededLoadRun({
        revision,
        poll,
        run,
        maybeSubjectTitle: Option.fromNullishOr(subjectTitle),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed(Message.FailedLoadRun({ revision, poll, error: errorText(error) })),
    ),
    Effect.provide(Http.layer),
  );

export const LoadRun = Command.define("LoadRun", {
  args: runArgs,
  messages: [Message.SucceededLoadRun, Message.FailedLoadRun],
  execute: ({ automationId, revision, poll, runId }) =>
    fetchRun(automationId, revision, poll, runId),
});

/** Reloads the open run after a pause: 1.5 s while it runs, 5 s while it waits. */
export const PollRun = Command.define("PollRun", {
  args: { ...runArgs, delayMillis: Schema.Int },
  messages: [Message.SucceededLoadRun, Message.FailedLoadRun],
  execute: ({ automationId, revision, poll, runId, delayMillis }) =>
    Effect.sleep(delayMillis).pipe(Effect.andThen(fetchRun(automationId, revision, poll, runId))),
});

export const AnswerTask = Command.define("AnswerTask", {
  args: { ...requestArgs, runId: Schema.String, step: Schema.String, answer: TaskAnswer },
  messages: [Message.SucceededAnswerTask, Message.FailedAnswerTask],
  execute: ({ automationId, revision, runId, step, answer }) =>
    request(automationId, `/runs/${runId}/tasks/${step}`, Schema.Unknown, answer).pipe(
      Effect.map(() => Message.SucceededAnswerTask({ revision, runId, step })),
      Effect.catch((error) =>
        Effect.succeed(Message.FailedAnswerTask({ revision, runId, error: errorText(error) })),
      ),
      Effect.provide(Http.layer),
    ),
});

// VIEW

type Exchange = typeof Exchange.Type;

const eyebrowClass = "text-xs font-medium text-sand-10";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Automations studio",
  body: h.div(
    [h.Class("flex min-h-full flex-col bg-sidebar lg:h-full lg:flex-row")],
    [
      sidebarView(model, h),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col bg-background lg:min-h-0 lg:border-l")],
        [
          headerView(model, h),
          h.div(
            [h.Class("flex flex-1 flex-col lg:min-h-0 lg:flex-row")],
            [
              pageView(model, h),
              Option.match(model.maybeRunPanel, {
                onNone: () => h.empty,
                onSome: (openRun) => runPanelView(model, openRun, h),
              }),
            ],
          ),
        ],
      ),
    ],
  ),
});

const pageView = (model: Model, h: HtmlBuilder<Message>) =>
  Page.match(model.page, {
    Overview: ({ overview }) =>
      h.main(
        [h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0")],
        [
          h.submodel({
            slotId: "overview",
            model: overview,
            view: Overview.view,
            toParentMessage: toOverviewMessage,
          }),
        ],
      ),
    Studio: () =>
      h.main(
        [
          h.Class(
            "grid min-w-0 flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]",
          ),
        ],
        [conversationView(model, h), workflowPanelView(model, h)],
      ),
    Run: ({ openRun }) => runPageView(model, openRun, h),
  });

const headerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.header(
    [
      h.Class(
        "grid h-12 shrink-0 grid-cols-[1fr_minmax(0,28rem)_1fr] items-center gap-2 border-b px-4",
      ),
    ],
    [
      h.div([]),
      Input.view(
        {
          id: automationIdInputId,
          value: model.automationIdInput,
          placeholder: "new-automation-id",
          onInput: (value) => Message.UpdatedAutomationId({ value }),
          toView: (attributes) =>
            h.div(
              [
                h.Class(
                  "flex h-8 w-full max-w-md items-center gap-1.5 rounded-[10px] border bg-sidebar px-2 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25",
                ),
              ],
              [
                icon(h, Hash, "size-4 text-muted-foreground"),
                h.label([...attributes.label, h.Class("sr-only")], ["Automation ID"]),
                h.input([
                  ...attributes.input,
                  h.Autocomplete("off"),
                  h.Spellcheck(false),
                  h.OnChange(() => Message.ChangedAutomationId()),
                  h.Class(
                    "h-full min-w-0 flex-1 bg-transparent px-0.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground",
                  ),
                ]),
              ],
            ),
        },
        h,
      ),
      themeToggleView(model.theme, h),
    ],
  );

const themeIcon: Record<Theme, Parameters<typeof icon>[1]> = {
  System: Monitor,
  Light: Sun,
  Dark: Moon,
};

const themeToggleView = (theme: Theme, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.ClickedThemeToggle(),
      variant: "ghost",
      size: "icon-sm",
      className: "justify-self-end rounded-[10px] text-sand-10",
      attributes: [
        h.AriaLabel(`Color theme: ${theme}`),
        h.Title(`Color theme: ${theme}. Click for ${nextTheme[theme]}.`),
      ],
    },
    [icon(h, themeIcon[theme], "size-4")],
    h,
  );

// VIEW: SIDEBAR

const sidebarNoteClass = "px-1.5 py-1 text-xs text-muted-foreground";

const navItemClass =
  "group/nav-item my-px flex items-start gap-2 rounded-[8px] py-1.5 pr-2.5 pl-1.5 text-muted-foreground transition-colors duration-100 outline-none hover:bg-hover hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const sidebarView = (model: Model, h: HtmlBuilder<Message>) =>
  h.nav(
    [
      h.AriaLabel("Automations"),
      h.Class("flex shrink-0 flex-col border-b px-2 pb-2 lg:min-h-0 lg:w-60 lg:border-b-0"),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-1.5 px-2 py-3")],
        [
          h.span(
            [
              h.Class(
                "flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-brand/80 to-brand text-[13px] font-medium text-signal-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]",
              ),
              h.AriaHidden(true),
            ],
            ["A"],
          ),
          h.span([h.Class("truncate text-sm font-medium")], ["Automations studio"]),
        ],
      ),
      h.a(
        [
          h.Href(overviewHref),
          ...(Page.guards.Overview(model.page) ? [h.AriaCurrent("page")] : []),
          h.Class(
            cn(
              navItemClass,
              "items-center text-[13px] font-medium tracking-tight",
              Page.guards.Overview(model.page) && "bg-hover text-foreground",
            ),
          ),
        ],
        [icon(h, LayoutDashboard, "size-4"), "Overview"],
      ),
      h.div(
        [h.Class("mt-3 mb-px flex h-[22px] items-center justify-between gap-2 pr-0.5 pl-1.5")],
        [
          h.h2([h.Class("text-[11px] font-semibold tracking-tight text-sand-10")], ["Automations"]),
          button(
            {
              onClick: Message.ClickedNewAutomation(),
              variant: "ghost",
              size: "icon-xs",
              className: "text-sand-10",
              attributes: [h.AriaLabel("New automation"), h.Title("New automation")],
            },
            [icon(h, Plus, "size-3.5")],
            h,
          ),
        ],
      ),
      h.div(
        [h.Class("max-h-56 overflow-y-auto lg:max-h-none lg:flex-1")],
        [
          Directory.match(model.directory, {
            Loading: () => h.p([h.Class(sidebarNoteClass)], ["Loading…"]),
            Unavailable: ({ error }) =>
              h.p(
                [h.Class(cn(sidebarNoteClass, "text-destructive"))],
                [`Couldn't load automations: ${error}`],
              ),
            Ready: ({ automations }) =>
              Array.match(automations, {
                onEmpty: () =>
                  h.p(
                    [h.Class(sidebarNoteClass)],
                    ["Automations show up here once the agent drafts one."],
                  ),
                onNonEmpty: (listed) =>
                  h.ul(
                    [h.Class("flex flex-col")],
                    Array.map(listed, (automation) =>
                      automationLinkView(
                        automation,
                        Page.guards.Studio(model.page) && automation.id === model.automationId,
                        h,
                      ),
                    ),
                  ),
              }),
          }),
        ],
      ),
    ],
  );

const automationLinkView = (
  automation: typeof AutomationSummary.Type,
  isCurrent: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    automation.id,
    [],
    [
      h.a(
        [
          h.Href(automationHref(automation.id)),
          ...(isCurrent ? [h.AriaCurrent("page")] : []),
          h.Class(cn(navItemClass, isCurrent && "bg-hover text-foreground")),
        ],
        [
          h.span([h.Class("flex h-5 shrink-0 items-center")], [icon(h, WorkflowIcon, "size-4")]),
          h.span(
            [h.Class("flex min-w-0 flex-col gap-0.5")],
            [
              h.span(
                [h.Class("truncate text-[13px] font-medium tracking-tight")],
                [automation.name],
              ),
              h.span([h.Class("truncate font-mono text-[11px] text-sand-10")], [automation.id]),
            ],
          ),
        ],
      ),
    ],
  );

// VIEW: CONVERSATION

const conversationView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [
      h.Class("flex flex-col border-b lg:min-h-0 lg:border-r lg:border-b-0"),
      h.AriaLabel("Conversation"),
    ],
    [
      h.div(
        [
          h.Id("messages"),
          h.AriaLive("polite"),
          h.Class("flex flex-1 flex-col px-5 py-6 lg:overflow-y-auto"),
        ],
        [
          Array.match(conversationItems(model, h), {
            onEmpty: () =>
              Option.match(model.maybeDraft, {
                onNone: () =>
                  emptyConversationView(
                    "Describe what should happen",
                    "Say what starts the automation and what each step does. The draft on the right updates after every reply, so keep adjusting until it reads correctly.",
                    h,
                  ),
                onSome: () =>
                  emptyConversationView(
                    "No saved conversation",
                    "This draft was made before conversations were saved. Send a message to keep refining it; the agent still remembers the earlier turns.",
                    h,
                  ),
              }),
            onNonEmpty: (items) => ChatMessage.group({ className: "gap-7" }, items, h),
          }),
        ],
      ),
      composerView(model, h),
    ],
  );

const emptyConversationView = (title: string, description: string, h: HtmlBuilder<Message>) =>
  Empty(
    { className: "flex-none items-start p-0 pt-2 text-left" },
    [
      Empty.header(
        { className: "items-start" },
        [
          Empty.title({ className: "text-xl font-semibold" }, [title], h),
          Empty.description({}, [description], h),
        ],
        h,
      ),
    ],
    h,
  );

const conversationItems = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  ...Array.map(model.conversation, (exchange) => exchangeView(exchange, h)),
  ...Option.match(model.maybePendingChat, {
    onNone: () => [],
    onSome: (pending) => [pendingChatView(pending, model.maybeProgress, h)],
  }),
];

const promptView = (prompt: string, h: HtmlBuilder<Message>) =>
  ChatMessage(
    { align: "end" },
    [
      ChatMessage.content(
        {},
        [
          Bubble(
            { variant: "secondary", align: "end" },
            [Bubble.content({ className: "whitespace-pre-wrap" }, [prompt], h)],
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  );

const replyView = (children: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  ChatMessage(
    {},
    [
      ChatMessage.content(
        { className: "gap-1.5" },
        [
          ChatMessage.header(
            { className: "gap-2 text-sm font-medium text-sand-10" },
            [
              h.span([h.Class("icon-tile"), h.AriaHidden(true)], [icon(h, Bot, "size-3.5")]),
              "Agent",
            ],
            h,
          ),
          Bubble({ variant: "ghost" }, [Bubble.content({}, children, h)], h),
        ],
        h,
      ),
    ],
    h,
  );

const exchangeView = (exchange: Exchange, h: HtmlBuilder<Message>) =>
  h.keyed("div")(
    String(exchange.id),
    [h.Class("flex flex-col gap-4")],
    [
      promptView(exchange.prompt, h),
      replyView([h.span([h.Class("whitespace-pre-wrap")], [exchange.reply])], h),
    ],
  );

const pendingChatView = (
  pending: PendingChat,
  maybeProgress: Option.Option<string>,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("div")(
    pending.id,
    [h.Class("flex flex-col gap-4")],
    [
      promptView(pending.prompt, h),
      replyView(
        Match.value(pending).pipe(
          Match.discriminatorsExhaustive("status")({
            working: () => [
              h.span(
                [h.Class("flex items-center gap-2 text-muted-foreground")],
                [
                  icon(h, LoaderCircle, "size-3.5 shrink-0 animate-spin text-signal"),
                  h.span(
                    [h.Class("truncate")],
                    [Option.getOrElse(maybeProgress, () => "Thinking…")],
                  ),
                ],
              ),
            ],
            failed: () => [
              h.span(
                [h.Class("flex items-center gap-2 text-destructive")],
                [icon(h, CircleAlert, "size-3.5"), "Sorry, I couldn't finish this one."],
              ),
            ],
          }),
        ),
        h,
      ),
    ],
  );

const composerView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("p-3")],
    [
      h.div(
        [
          h.Class(
            "rounded-xl bg-background shadow-raised transition-shadow duration-200 focus-within:ring-3 focus-within:ring-ring/25",
          ),
        ],
        [
          textarea(
            {
              id: "message",
              label: "Your message",
              labelClass: "sr-only",
              value: model.messageInput,
              placeholder: "When an order arrives, summarize its contents and send the summary to…",
              onInput: (value) => Message.UpdatedMessageInput({ value }),
              className:
                "max-h-60 min-h-20 resize-none border-0 bg-transparent px-3.5 pt-3 placeholder:text-muted-foreground/80 focus-visible:ring-0",
            },
            h,
          ),
          h.div(
            [h.Class("flex items-center justify-between gap-3 pr-2 pb-2 pl-3.5")],
            [
              h.span(
                [h.Class("font-mono text-[11px] text-muted-foreground tabular-nums")],
                [`${model.messageInput.length} / ${maxMessageLength.toLocaleString("en-US")}`],
              ),
              button(
                {
                  onClick: Message.ClickedSend(),
                  isDisabled: Activity.guards.Working(model.activity),
                  attributes: [h.Id("send")],
                },
                ["Send message", icon(h, CornerDownLeft, "size-3.5", "inline-end")],
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );

// VIEW: WORKFLOW

const workflowPanelView = (model: Model, h: HtmlBuilder<Message>) =>
  h.section(
    [h.Class("flex flex-col lg:min-h-0"), h.AriaLabel("Workflow")],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-4 px-6 pt-5")],
        [
          panelTitleView(
            "Draft",
            Option.match(model.maybeDraft, {
              onNone: () => "Untitled workflow",
              onSome: (workflow) => workflow.name,
            }),
            h,
          ),
          workflowDisplayToggleView(model.workflowDisplay, h),
        ],
      ),
      h.div(
        [h.Id("graph"), h.AriaLive("polite"), h.Class("flex-1 px-6 py-6 lg:overflow-y-auto")],
        [draftView(model, h)],
      ),
      h.div(
        [h.Class("flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-6 py-3")],
        [
          statusView(model, h),
          h.div(
            [h.Class("ml-auto flex flex-wrap items-center gap-2")],
            [
              button(
                {
                  onClick: Message.ClickedSave(),
                  isDisabled: Activity.guards.Working(model.activity),
                  variant: "outline",
                  attributes: [h.Id("save")],
                },
                "Save draft",
                h,
              ),
              subjectPickerView(model, h),
              button(
                {
                  onClick: Message.ClickedStart(),
                  isDisabled: Activity.guards.Working(model.activity),
                  attributes: [h.Id("start")],
                },
                [icon(h, Play, "size-3.5", "inline-start"), "Run saved version"],
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  );

const panelTitleView = (eyebrow: string, title: string, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("min-w-0")],
    [
      h.div([h.Class(eyebrowClass)], [eyebrow]),
      h.h2([h.Class("truncate text-xl font-semibold")], [title]),
    ],
  );

const editAutomationView = (automationId: string, h: HtmlBuilder<Message>) =>
  h.a(
    [
      h.Href(automationHref(automationId)),
      h.DataAttribute("slot", "button"),
      h.Class(buttonClass({ variant: "outline", size: "sm" })),
    ],
    [icon(h, Pencil, "size-3.5", "inline-start"), "Edit automation"],
  );

// VIEW: RUN

const runTitle = (openRun: OpenRun) =>
  RunDetail.match(openRun.detail, {
    Loading: () => openRun.runId,
    Unavailable: () => openRun.runId,
    Loaded: ({ run }) => run.workflow.name,
  });

const runStatusBadgeView = (openRun: OpenRun, isCompact: boolean, h: HtmlBuilder<Message>) =>
  RunDetail.match(openRun.detail, {
    Loading: () => h.empty,
    Unavailable: () => h.empty,
    Loaded: ({ run }) => runBadgeView(run, isCompact, h),
  });

const runBodyView = (openRun: OpenRun, model: Model, h: HtmlBuilder<Message>) =>
  RunDetail.match(openRun.detail, {
    Loading: () => h.p([h.Class("text-sm text-muted-foreground")], ["Loading the run…"]),
    Unavailable: ({ error }) =>
      h.p(
        [
          h.Role("alert"),
          h.Class(
            "flex items-start gap-2 rounded-[10px] bg-destructive/10 px-3 py-2 text-sm text-destructive",
          ),
        ],
        [icon(h, CircleAlert, "mt-0.5 size-3.5"), `Couldn't load this run: ${error}`],
      ),
    Loaded: ({ run, maybeSubjectTitle }) => runView(openRun, run, maybeSubjectTitle, model, h),
  });

const runNoticeView = (openRun: OpenRun, className: string, h: HtmlBuilder<Message>) =>
  RunNotice.match(openRun.notice, {
    Idle: () => h.empty,
    Sending: () =>
      h.div(
        [h.Role("status"), h.Class(cn(noticeBarClass, "text-muted-foreground", className))],
        [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), "Sending your answer…"],
      ),
    Sent: () =>
      h.div(
        [h.Role("status"), h.Class(cn(noticeBarClass, "text-muted-foreground", className))],
        ["Answer sent."],
      ),
    Failed: ({ error }) =>
      h.div(
        [h.Role("status"), h.Class(cn(noticeBarClass, "text-destructive", className))],
        [icon(h, CircleAlert, "size-3.5"), error],
      ),
  });

const noticeBarClass = "flex min-w-0 items-center gap-2 border-t py-3 text-xs";

const runPageView = (model: Model, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  h.main(
    [h.Class("flex min-w-0 flex-1 flex-col lg:min-h-0"), h.AriaLabel("Run")],
    [
      h.div(
        [h.Class("flex-1 px-6 py-6 lg:overflow-y-auto")],
        [
          h.div(
            [h.Class("flex max-w-3xl flex-col gap-6")],
            [
              h.div(
                [h.Class("flex items-start justify-between gap-4")],
                [
                  panelTitleView("Run", runTitle(openRun), h),
                  h.div(
                    [h.Class("flex shrink-0 items-center gap-3")],
                    [
                      runStatusBadgeView(openRun, false, h),
                      editAutomationView(openRun.automationId, h),
                    ],
                  ),
                ],
              ),
              runBodyView(openRun, model, h),
            ],
          ),
        ],
      ),
      runNoticeView(openRun, "px-6", h),
    ],
  );

/** A run beside the overview or the studio, so it can play out while the page stays put. */
const runPanelView = (model: Model, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  h.aside(
    [
      h.AriaLabel("Run preview"),
      h.Class(
        "flex flex-col border-t bg-background animate-in fade-in slide-in-from-right-2 duration-200 lg:min-h-0 lg:w-[26rem] lg:shrink-0 lg:border-t-0 lg:border-l xl:w-[32rem] 2xl:w-[38rem]",
      ),
    ],
    [
      h.div(
        [h.Class("flex items-start justify-between gap-3 border-b px-5 py-3")],
        [
          h.div(
            [h.Class("flex min-w-0 flex-col gap-0.5")],
            [
              h.div(
                [h.Class("flex items-center gap-2")],
                [h.span([h.Class(eyebrowClass)], ["Run"]), runStatusBadgeView(openRun, true, h)],
              ),
              h.h2([h.Class("truncate text-base font-semibold")], [runTitle(openRun)]),
            ],
          ),
          h.div(
            [h.Class("flex shrink-0 items-center gap-0.5")],
            [
              button(
                {
                  onClick: Message.ClickedExpandRunPanel(),
                  variant: "ghost",
                  size: "icon-sm",
                  className: "text-sand-10",
                  attributes: [h.AriaLabel("Open the run's page"), h.Title("Open the run's page")],
                },
                [icon(h, Maximize2, "size-4")],
                h,
              ),
              button(
                {
                  onClick: Message.ClickedCloseRunPanel(),
                  variant: "ghost",
                  size: "icon-sm",
                  className: "text-sand-10",
                  attributes: [h.AriaLabel("Close the run"), h.Title("Close the run")],
                },
                [icon(h, X, "size-4")],
                h,
              ),
            ],
          ),
        ],
      ),
      h.div([h.Class("flex-1 px-5 py-5 lg:overflow-y-auto")], [runBodyView(openRun, model, h)]),
      runNoticeView(openRun, "px-5", h),
    ],
  );

const draftView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex flex-col gap-10")],
    [
      Option.match(model.maybeDraft, {
        onNone: () => emptyWorkflowView(h),
        onSome: (workflow) =>
          model.workflowDisplay === "Json"
            ? workflowJsonView(workflow, h)
            : workflowView(
                workflow,
                {
                  scope: "draft",
                  expandedStepIds: model.expandedStepIds,
                  maybeRunSteps: Option.none(),
                },
                h,
              ),
      }),
      recentRunsView(model, h),
    ],
  );

const subjectPickerView = (model: Model, h: HtmlBuilder<Message>) =>
  SubjectChoices.match(model.subjectChoices, {
    NotNeeded: () => h.empty,
    Loading: ({ entityType }) =>
      h.span(
        [h.Class("text-xs text-muted-foreground")],
        [`Loading ${entityType.replaceAll("_", " ")} records…`],
      ),
    Unavailable: ({ entityType, error }) =>
      h.span(
        [h.Class("text-xs text-destructive"), h.Title(error)],
        [`Couldn't load ${entityType.replaceAll("_", " ")} records`],
      ),
    Ready: ({ entityType, label, subjects }) =>
      h.div(
        [h.Class("flex items-center")],
        [
          h.label([h.For("subject"), h.Class("sr-only")], [label]),
          h.select(
            [
              h.Id("subject"),
              h.Value(Option.getOrElse(model.maybeSubjectId, () => "")),
              h.OnChange((subjectId) => Message.SelectedSubject({ subjectId })),
              h.Class(cn(inputClass, "h-8 w-48 bg-background md:text-[13px]")),
            ],
            [
              h.option(
                [h.Value(""), h.Selected(Option.isNone(model.maybeSubjectId))],
                [`Choose ${withArticle(entityType)}…`],
              ),
              ...Array.map(subjects, (subject) =>
                subjectOptionView(
                  subject,
                  Option.exists(model.maybeSubjectId, (subjectId) => subjectId === subject.id),
                  h,
                ),
              ),
            ],
          ),
        ],
      ),
  });

const subjectOptionView = (subject: SubjectOption, isSelected: boolean, h: HtmlBuilder<Message>) =>
  h.keyed("option")(subject.id, [h.Value(subject.id), h.Selected(isSelected)], [subject.title]);

const workflowDisplayToggleView = (display: WorkflowDisplay, h: HtmlBuilder<Message>) =>
  button(
    {
      onClick: Message.SelectedWorkflowDisplay({ display: display === "Json" ? "Steps" : "Json" }),
      variant: display === "Json" ? "secondary" : "ghost",
      size: "xs",
      attributes: [h.AriaPressed(String(display === "Json")), h.Title("Show the draft's raw JSON")],
    },
    [icon(h, Braces, "size-3", "inline-start"), "JSON"],
    h,
  );

const workflowJsonView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.pre(
    [
      h.AriaLabel("Draft JSON"),
      h.Class(
        "max-w-3xl overflow-x-auto rounded-[10px] bg-card px-4 py-3 font-mono text-xs leading-relaxed shadow-card",
      ),
    ],
    [JSON.stringify(workflow, null, 2)],
  );

const emptyWorkflowView = (h: HtmlBuilder<Message>) =>
  Empty(
    { className: "max-w-xl rounded-[10px] bg-card shadow-card" },
    [
      Empty.header(
        {},
        [
          Empty.media({ className: "icon-tile" }, [icon(h, WorkflowIcon, "size-3.5")], h),
          Empty.title({}, ["No draft yet"], h),
          Empty.description(
            {},
            [
              "Steps show up here once the agent replies. They run top to bottom, started by hand or when a record such as an employee changes.",
            ],
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  );

const chipClass =
  "rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em] box-decoration-clone";

const subjectRefView = (ref: string, h: HtmlBuilder<Message>) =>
  h.span(
    [h.Class(cn(chipClass, "text-foreground")), h.Title(`Read from the subject: ${ref}`)],
    [ref],
  );

const stepRefClass = cn(chipClass, "text-sand-11");

const refView = (ref: string, h: HtmlBuilder<Message>) => {
  const [root, ...path] = ref.split(".");
  return root === "steps"
    ? h.span(
        [h.Class(stepRefClass), h.Title(`Recorded by step ${path[0] ?? ""}`)],
        [path.join(".")],
      )
    : subjectRefView(ref, h);
};

const templateView = (text: string, h: HtmlBuilder<Message>) =>
  Array.map(templateParts(text), (part) =>
    part.kind === "ref" ? refView(part.ref, h) : part.text,
  );

const joinedViews = (
  items: ReadonlyArray<ReadonlyArray<Html | string>>,
  separator: string,
): ReadonlyArray<Html | string> =>
  Array.flatMap(items, (item, index) => [...(index === 0 ? [] : [separator]), ...item]);

const readsView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  Array.match(
    Array.filter(workflowRefs(workflow), (ref) => !ref.startsWith("steps.")),
    {
      onEmpty: () => h.empty,
      onNonEmpty: (refs) =>
        h.div(
          [h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-1.5")],
          [
            h.h3([h.Id("trigger-reads"), h.Class("text-muted-foreground")], ["Reads"]),
            h.ul(
              [h.AriaLabelledBy("trigger-reads"), h.Class("flex flex-wrap gap-1.5")],
              Array.map(refs, (ref) => h.keyed("li")(ref, [], [subjectRefView(ref, h)])),
            ),
          ],
        ),
    },
  );

const changedFieldsView = (
  fields: ReadonlyArray<string> | undefined,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  fields === undefined || Array.isReadonlyArrayEmpty(fields)
    ? ["changes"]
    : [
        "its ",
        ...joinedViews(
          Array.map(fields, (field) => [
            h.span([h.Class(cn(chipClass, "text-foreground"))], [field]),
          ]),
          " or ",
        ),
        " changes",
      ];

const triggerTextView = (trigger: Trigger, h: HtmlBuilder<Message>): ReadonlyArray<Html | string> =>
  Match.value(trigger).pipe(
    Match.discriminatorsExhaustive("kind")({
      manual: (manual) =>
        manual.subject === undefined
          ? ["Manual start"]
          : [`Manual start for ${withArticle(manual.subject)}`],
      entity: (entity) => [
        `When ${withArticle(entity.entity)} is created or `,
        ...changedFieldsView(entity.fields, h),
        ...(entity.when === undefined ? [] : [", and ", ...conditionView(entity.when, h)]),
      ],
    }),
  );

const triggerView = (workflow: Workflow, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex gap-3")],
    [
      h.div(
        [h.Class("flex w-[18px] shrink-0 flex-col items-center"), h.AriaHidden(true)],
        [
          icon(
            h,
            workflow.trigger.kind === "entity" ? Radio : Play,
            "mt-[3px] size-[18px] text-muted-foreground",
          ),
          h.div([h.Class("mt-1.5 w-[1.5px] flex-1 bg-rail")]),
        ],
      ),
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col gap-2 text-sm")],
        [
          h.p([h.Class("leading-6 text-muted-foreground")], triggerTextView(workflow.trigger, h)),
          readsView(workflow, h),
        ],
      ),
    ],
  );

interface StepContext {
  /** Tells apart the same step shown in the draft and in a run beside it. */
  readonly scope: "draft" | "run";
  readonly expandedStepIds: ReadonlyArray<string>;
  readonly maybeRunSteps: Option.Option<Readonly<Record<string, RunStep>>>;
}

const workflowView = (workflow: Workflow, context: StepContext, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class("flex max-w-2xl flex-col")],
    [
      triggerView(workflow, h),
      h.ol(
        [h.AriaLabel("Steps"), h.Class("mt-3 flex flex-col gap-3")],
        Array.map(workflow.steps, (step) => stepView(step, context, h)),
      ),
    ],
  );

type IconNode = Parameters<typeof icon>[1];

const connectionIcon: Readonly<Record<string, IconNode>> = {
  email: Mail,
  slack: MessageSquare,
  calendar: CalendarDays,
  http: Webhook,
};

const stepIcon = (step: Step): IconNode =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => Bot,
      action: (action) => connectionIcon[connectionOf(action.use)?.id ?? ""] ?? Webhook,
      wait: () => Hourglass,
      parallel: () => Split,
      if: () => GitBranch,
      decide: () => Scale,
      human: () => UserRound,
    }),
  );

const operationTitle = (operationId: string) => findOperation(operationId)?.title ?? operationId;

const stepLabel = (step: Step): string =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => "Agent",
      action: (action) => operationTitle(action.use),
      wait: () => "Wait",
      parallel: () => "Parallel",
      if: () => "Condition",
      decide: () => "Decision",
      human: () => "Human",
    }),
  );

const isSimulated = (operationId: string) => connectionOf(operationId)?.simulated === true;

const comparisonLabel: Record<Comparison, string> = {
  equals: "is",
  notEquals: "is not",
  greaterThan: "is greater than",
  lessThan: "is less than",
  contains: "contains",
  before: "is before",
  after: "is after",
};

const valueView = (value: unknown, h: HtmlBuilder<Message>) =>
  h.span([h.Class("font-mono text-[0.92em] text-foreground")], [JSON.stringify(value)]);

const comparedValueView = (op: Comparison, value: unknown, h: HtmlBuilder<Message>) =>
  (op === "before" || op === "after") && Predicate.isString(value)
    ? h.span([h.Class("font-mono text-[0.92em] text-foreground")], [value])
    : valueView(value, h);

const joinedConditions = (
  conditions: ReadonlyArray<Condition>,
  separator: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  joinedViews(
    Array.map(conditions, (condition) => conditionView(condition, h)),
    separator,
  );

const conditionView = (
  condition: Condition,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => {
  if ("all" in condition) {
    return ["(", ...joinedConditions(condition.all, " and ", h), ")"];
  }
  if ("any" in condition) {
    return ["(", ...joinedConditions(condition.any, " or ", h), ")"];
  }
  if ("not" in condition) {
    return ["not ", ...conditionView(condition.not, h)];
  }
  if (condition.op === "exists") {
    return [refView(condition.ref, h), " is set"];
  }
  return [
    refView(condition.ref, h),
    ` ${comparisonLabel[condition.op]} `,
    comparedValueView(condition.op, condition.value, h),
  ];
};

const offsetText = (offset: string) =>
  offset.startsWith("-") ? `${offset.slice(1)} before ` : `${offset} after `;

const detailClass = (isExpanded: boolean) =>
  cn(
    "text-xs text-muted-foreground",
    isExpanded ? "whitespace-pre-wrap break-words" : "line-clamp-2",
  );

const notifyLabel: Record<"email" | "slack", string> = { email: "Email", slack: "Slack" };

const fieldChipsView = (names: ReadonlyArray<string>, h: HtmlBuilder<Message>) =>
  joinedViews(
    Array.map(names, (name) => [h.span([h.Class(cn(chipClass, "text-foreground"))], [name])]),
    " ",
  );

const actionInputView = (value: ActionInput, h: HtmlBuilder<Message>) =>
  Predicate.isString(value)
    ? templateView(value, h)
    : joinedViews(
        Array.map(value, (item) => templateView(item, h)),
        ", ",
      );

const simulatedTagView = (h: HtmlBuilder<Message>) =>
  badge({ variant: "secondary", className: "h-4 px-1.5 text-[10px]" }, ["Simulated"], h);

const humanFieldView = (field: HumanField, h: HtmlBuilder<Message>) =>
  h.keyed("li")(
    field.name,
    [],
    [
      h.span([h.Class("text-foreground")], [field.label]),
      ` · ${field.type}`,
      ...(field.default === undefined ? [] : [" · default ", ...templateView(field.default, h)]),
    ],
  );

const stepDetailView = (step: Step, isExpanded: boolean, h: HtmlBuilder<Message>) =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: (agent) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(agent.instruction, h)),
            agent.output === undefined
              ? h.empty
              : stepMetaView(
                  [
                    h.span(
                      [],
                      [
                        "Records ",
                        ...fieldChipsView(
                          Array.map(agent.output.fields, (field) => field.name),
                          h,
                        ),
                      ],
                    ),
                  ],
                  h,
                ),
          ],
        ),
      action: (action) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.div(
              [h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
              [operationTitle(action.use), isSimulated(action.use) ? simulatedTagView(h) : h.empty],
            ),
            h.ul(
              [h.AriaLabel(`${action.title} inputs`), h.Class("flex flex-col gap-0.5 text-xs")],
              Array.map(Object.entries(action.with), ([name, value]) =>
                h.keyed("li")(
                  name,
                  [
                    h.Class(
                      cn("text-muted-foreground", isExpanded ? "break-words" : "line-clamp-1"),
                    ),
                  ],
                  [
                    h.span([h.Class("font-mono text-sand-11")], [`${name}: `]),
                    ...actionInputView(value, h),
                  ],
                ),
              ),
            ),
          ],
        ),
      wait: (wait) =>
        h.p(
          [h.Class("text-xs text-muted-foreground")],
          "until" in wait
            ? [
                "Until ",
                wait.offset === undefined ? "" : offsetText(wait.offset),
                refView(wait.until, h),
              ]
            : [`Pauses for ${wait.duration}`],
        ),
      parallel: (parallel) =>
        h.p(
          [h.Class("text-xs text-muted-foreground")],
          [`${parallel.branches.length} branches run at the same time, then the run continues.`],
        ),
      if: () =>
        h.p([h.Class("text-xs text-muted-foreground")], ["Runs the first case that matches."]),
      decide: (decide) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(decide.question, h)),
            stepMetaView([`Model: ${decide.model}`], h),
          ],
        ),
      human: (human) =>
        h.div(
          [h.Class("flex flex-col gap-1.5")],
          [
            h.p([h.Class(detailClass(isExpanded))], templateView(human.prompt, h)),
            stepMetaView(
              [
                ...(human.assignee === undefined
                  ? []
                  : [h.span([], ["Assignee: ", refView(human.assignee, h)])]),
                ...(human.notify === undefined
                  ? []
                  : [`Notifies via ${notifyLabel[human.notify]}`]),
                human.response === "approval" ? "Approve or reject" : "Fills in a form",
                ...(human.timeout === undefined ? [] : [`Times out after ${human.timeout}`]),
              ],
              h,
            ),
            human.response === "approval"
              ? h.empty
              : h.ul(
                  [
                    h.AriaLabel(`${human.title} form`),
                    h.Class("flex flex-col gap-0.5 text-[11px] text-muted-foreground"),
                  ],
                  Array.map(human.response.fields, (field) => humanFieldView(field, h)),
                ),
          ],
        ),
    }),
  );

const stepMetaView = (items: ReadonlyArray<Html | string>, h: HtmlBuilder<Message>) =>
  h.ul(
    [h.Class("flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground")],
    Array.map(items, (item) => h.li([], [item])),
  );

interface Lane {
  readonly label: string;
  readonly heading: ReadonlyArray<Html | string>;
  readonly steps: ReadonlyArray<Step>;
}

const stepLanes = (step: Step, h: HtmlBuilder<Message>): ReadonlyArray<Lane> =>
  Match.value(step).pipe(
    Match.discriminatorsExhaustive("kind")({
      agent: () => [],
      action: () => [],
      wait: () => [],
      human: () => [],
      parallel: (parallel) =>
        Array.map(parallel.branches, (steps, index) => ({
          label: `Branch ${index + 1}`,
          heading: [`Branch ${index + 1}`],
          steps,
        })),
      if: (branch) => [
        ...Array.map(branch.cases, (branchCase, index) => ({
          label: `Case ${index + 1}`,
          heading: ["If ", ...conditionView(branchCase.when, h)],
          steps: branchCase.steps,
        })),
        ...(branch.otherwise === undefined || Array.isReadonlyArrayEmpty(branch.otherwise)
          ? []
          : [{ label: "Otherwise", heading: ["Otherwise"], steps: branch.otherwise }]),
      ],
      decide: (decide) =>
        Array.map(decide.options, (option) => ({
          label: `Option ${option.id}`,
          heading: [
            h.span([h.Class("font-mono text-foreground")], [option.id]),
            ` · ${option.description}`,
          ],
          steps: option.steps,
        })),
    }),
  );

const laneView = (lane: Lane, context: StepContext, h: HtmlBuilder<Message>) =>
  h.li(
    [h.Class("flex flex-col gap-2")],
    [
      h.div([h.Class("text-xs text-muted-foreground")], lane.heading),
      h.ol(
        [h.AriaLabel(lane.label), h.Class("rail-start flex flex-col gap-3")],
        Array.map(lane.steps, (step) => stepView(step, context, h)),
      ),
    ],
  );

const stepStatusLabel: Record<RunStep["status"], string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
};

const stepStatusView = (runStep: RunStep, h: HtmlBuilder<Message>) =>
  h.span(
    [
      h.Class(
        cn(
          "mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] font-medium",
          runStep.status === "done" && "text-success",
          runStep.status === "running" && "text-signal",
          runStep.status === "waiting" && "text-sand-11",
        ),
      ),
    ],
    [
      Match.value(runStep.status).pipe(
        Match.when("done", () => icon(h, Check, "size-3.5")),
        Match.when("running", () => icon(h, LoaderCircle, "size-3.5 animate-spin")),
        Match.when("waiting", () => icon(h, Hourglass, "size-3.5")),
        Match.exhaustive,
      ),
      stepStatusLabel[runStep.status],
    ],
  );

const stepResultView = (
  step: Step,
  record: Schema.Json,
  isExpanded: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex flex-col gap-1.5")],
    [
      h.div(
        [h.Class("text-[11px] text-muted-foreground")],
        [
          step.kind === "action" && isSimulated(step.use)
            ? "Simulated: nothing was sent. This is what it would have sent."
            : "Result",
        ],
      ),
      h.div(
        [
          h.AriaLabel(`${step.title} result`),
          h.Class("rounded-md bg-sidebar px-3 py-2.5 text-[13px] leading-relaxed"),
        ],
        [recordView(record, isExpanded, h)],
      ),
    ],
  );

const stepView = (step: Step, context: StepContext, h: HtmlBuilder<Message>): Html => {
  const expansionKey = `${context.scope}:${step.id}`;
  const isExpanded = Array.contains(context.expandedStepIds, expansionKey);
  const maybeRunStep = Option.flatMap(context.maybeRunSteps, (runSteps) =>
    Option.fromNullishOr(runSteps[step.id]),
  );
  const isUnreached = Option.isSome(context.maybeRunSteps) && Option.isNone(maybeRunStep);
  return h.keyed("li")(
    step.id,
    [
      h.Class(
        cn(
          "rail-item animate-in fade-in slide-in-from-top-1 duration-300",
          isUnreached && "opacity-60",
        ),
      ),
    ],
    [
      Disclosure.view(
        {
          id: `${context.scope}-step-${step.id}`,
          isOpen: isExpanded,
          onToggle: (isOpen) => Message.ToggledStepDetails({ stepId: expansionKey, isOpen }),
          toView: ({ button, panel }) =>
            h.div(
              [h.Class("flex flex-col gap-1")],
              [
                h.button(
                  [
                    ...button,
                    h.Class(
                      "group/step flex w-full cursor-pointer items-start gap-2.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    ),
                  ],
                  [
                    h.span(
                      [h.Class("icon-tile"), h.Title(stepLabel(step)), h.AriaHidden(true)],
                      [icon(h, stepIcon(step), "size-3.5")],
                    ),
                    h.span(
                      [h.Class("min-w-0 flex-1 py-0.5 text-sm")],
                      [
                        h.span([h.Class("sr-only")], [`${stepLabel(step)}: `]),
                        ...templateView(step.title, h),
                      ],
                    ),
                    Option.match(maybeRunStep, {
                      onNone: () => h.empty,
                      onSome: (runStep) => stepStatusView(runStep, h),
                    }),
                    icon(
                      h,
                      ChevronDown,
                      "mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover/step:opacity-100 group-focus-visible/step:opacity-100 group-aria-expanded/step:rotate-180 group-aria-expanded/step:opacity-100",
                    ),
                  ],
                ),
                h.div(
                  [...panel, h.Class("flex flex-col gap-2 pl-[34px]")],
                  [
                    stepDetailView(step, isExpanded, h),
                    Option.match(
                      Option.flatMap(maybeRunStep, (runStep) =>
                        Option.fromNullishOr(runStep.record),
                      ),
                      {
                        onNone: () => h.empty,
                        onSome: (record) => stepResultView(step, record, isExpanded, h),
                      },
                    ),
                  ],
                ),
                Array.match(stepLanes(step, h), {
                  onEmpty: () => h.empty,
                  onNonEmpty: (lanes) =>
                    h.ul(
                      [h.Class("flex flex-col gap-3 pt-1.5 pl-[34px]")],
                      Array.map(lanes, (lane) => laneView(lane, context, h)),
                    ),
                }),
              ],
            ),
        },
        h,
      ),
    ],
  );
};

// VIEW: RUNS

const runBadgeView = (run: Run, isCompact: boolean, h: HtmlBuilder<Message>) =>
  h.span(
    [
      h.Class(
        cn(
          "inline-flex items-center gap-1.5 text-sm font-semibold whitespace-nowrap",
          runStatusClass[run.status],
        ),
      ),
    ],
    [
      h.span([h.Class(cn("size-1.5 rounded-full", runDotClass[run.status])), h.AriaHidden(true)]),
      runStatusLabel[run.status],
      isCompact
        ? h.empty
        : h.span([h.Class("font-mono text-xs font-normal text-sand-10")], [run.id]),
    ],
  );

const recentRunsView = (model: Model, h: HtmlBuilder<Message>) =>
  Array.match(model.runs, {
    onEmpty: () => h.empty,
    onNonEmpty: (runs) =>
      h.section(
        [h.AriaLabelledBy("recent-runs"), h.Class("flex max-w-2xl flex-col gap-2")],
        [
          h.h3([h.Id("recent-runs"), h.Class(eyebrowClass)], ["Recent runs"]),
          h.ul(
            [h.AriaLabelledBy("recent-runs"), h.Class("-mx-2 flex flex-col")],
            Array.map(runs, (run) =>
              runRowView(
                model.automationId,
                run,
                Option.exists(model.maybeRunPanel, (panel) => panel.runId === run.id),
                h,
              ),
            ),
          ),
        ],
      ),
  });

const runRowView = (
  automationId: string,
  run: RunSummary,
  isOpen: boolean,
  h: HtmlBuilder<Message>,
) =>
  h.keyed("li")(
    run.id,
    [],
    [
      h.a(
        [
          h.Href(runHref(automationId, run.id)),
          ...(isOpen ? [h.AriaCurrent("true")] : []),
          h.Class(
            cn(
              "flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[13px] transition-colors outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50",
              isOpen && "bg-hover",
            ),
          ),
        ],
        [
          h.span([
            h.Class(cn("size-1.5 shrink-0 rounded-full", runDotClass[run.status])),
            h.AriaHidden(true),
          ]),
          h.span([h.Class("min-w-0 flex-1 truncate font-medium")], [run.subject ?? "Manual run"]),
          h.span(
            [h.Class(cn("text-xs", runStatusClass[run.status]))],
            [runStatusLabel[run.status]],
          ),
          run.openTasks > 0
            ? badge({ variant: "secondary" }, [openTasksText(run.openTasks)], h)
            : h.empty,
          h.span(
            [h.Class("shrink-0 text-xs text-sand-10 tabular-nums")],
            [formatTime(run.startedAt)],
          ),
        ],
      ),
    ],
  );

const runView = (
  openRun: OpenRun,
  run: Run,
  maybeSubjectTitle: Option.Option<string>,
  model: Model,
  h: HtmlBuilder<Message>,
) =>
  h.div(
    [h.Class("flex max-w-2xl flex-col gap-6")],
    [
      h.p(
        [h.Class("text-sm text-muted-foreground")],
        [
          ...Option.match(maybeSubjectTitle, {
            onNone: () => [],
            onSome: (title) => [
              "For ",
              h.span([h.Class(cn(chipClass, "text-foreground"))], [title]),
              " · ",
            ],
          }),
          `Started ${formatTime(run.startedAt)} · Runs the version saved when it started`,
        ],
      ),
      run.error === undefined
        ? h.empty
        : h.p(
            [
              h.Role("alert"),
              h.Class(
                "flex items-start gap-2 rounded-[10px] bg-destructive/10 px-3 py-2 text-sm text-destructive",
              ),
            ],
            [icon(h, CircleAlert, "mt-0.5 size-3.5"), run.error],
          ),
      openTasksView(run, openRun, h),
      workflowView(
        run.workflow,
        {
          scope: "run",
          expandedStepIds: model.expandedStepIds,
          maybeRunSteps: Option.some(run.steps),
        },
        h,
      ),
    ],
  );

const openTasksView = (run: Run, openRun: OpenRun, h: HtmlBuilder<Message>) =>
  Array.match(
    Array.filter(run.tasks, (task) => task.status === "open"),
    {
      onEmpty: () => h.empty,
      onNonEmpty: (tasks) =>
        h.section(
          [h.AriaLabelledBy("open-tasks"), h.Class("flex flex-col gap-2")],
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
    [h.Class("flex flex-col gap-3 rounded-[10px] bg-card p-4 shadow-card")],
    [
      h.div(
        [h.Class("flex items-start gap-2.5")],
        [
          h.span([h.Class("icon-tile"), h.AriaHidden(true)], [icon(h, UserRound, "size-3.5")]),
          h.div(
            [h.Class("flex min-w-0 flex-col gap-1")],
            [
              h.h4([h.Class("text-sm font-medium")], [task.title]),
              h.p([h.Class("text-sm whitespace-pre-wrap text-muted-foreground")], [task.prompt]),
              stepMetaView(
                [
                  ...assigneeView(task.assignee, h),
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

const taskFormView = (
  task: HumanTask,
  fields: ReadonlyArray<HumanField>,
  openRun: OpenRun,
  h: HtmlBuilder<Message>,
) =>
  h.form(
    [
      h.AriaLabel(task.title),
      h.OnSubmit(Message.SubmittedTaskForm({ step: task.step })),
      h.Class("flex flex-col gap-3 pl-[34px]"),
    ],
    [
      ...Array.map(fields, (field) =>
        h.keyed("div")(
          field.name,
          [h.Class("max-w-xs")],
          [taskFieldView(task, field, fieldText(openRun.taskEdits, task, field.name), h)],
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

const pad = (value: number) => String(value).padStart(2, "0");

const localDateTimeText = (text: string) => {
  const millis = Date.parse(text);
  if (Number.isNaN(millis) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    return text;
  }
  const date = new Date(millis);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
          className: "bg-background",
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
          [h.Class("flex items-center gap-2")],
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

const statusView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [
      h.Id("status"),
      h.Role("status"),
      h.Class(
        cn(
          "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
          Activity.guards.Failed(model.activity) && "text-destructive",
        ),
      ),
    ],
    Activity.match(model.activity, {
      Ready: ({ notice }) => [notice],
      Working: ({ notice }) => [icon(h, LoaderCircle, "size-3.5 animate-spin text-signal"), notice],
      Failed: ({ error }) => [icon(h, CircleAlert, "size-3.5"), error],
    }),
  );
