/**
 * Hands the person to the platform's assistant in the hub shell's drawer, and says which forms on
 * the page would be lost by leaving it.
 */
import * as Option from "effect/Option";
import type { Update } from "foldkit";
import { OpenAssistant } from "../command.ts";
import type { Message } from "../message.ts";
import { type Model, Page } from "../model.ts";
import { automationHref, runHref, templatesHref, tracesHref } from "../route.ts";

export const dirtyForms = (model: Model) =>
  Page.match(model.page, {
    Overview: () => false,
    Run: () => false,
    Studio: () => false,
    Traces: () => false,
    Templates: ({ templates }) =>
      templates.editor._tag !== "Closed" || templates.activity._tag === "Working",
  });

export const pageHref = (model: Model) =>
  Page.match(model.page, {
    Overview: () => "/",
    Studio: () => automationHref(model.automationId),
    Run: ({ openRun }) => runHref(openRun.automationId, openRun.runId),
    Templates: ({ templates }) => templatesHref(templates.maybeTemplateName),
    Traces: ({ traces }) =>
      Option.match(traces.maybeSource, {
        onNone: () => "/traces",
        onSome: (source) => tracesHref(Option.some(source.automationId), source.maybeRunId),
      }),
  });

/** Opens the hub's assistant on a new chat with `prompt` in its composer, unsent. */
export const askAssistant = (model: Model, prompt: string): Update.Return<Model, Message> => ({
  model,
  commands: [OpenAssistant({ prompt })],
});
