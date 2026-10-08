import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";
import { LoaderCircle, Mic, Square, X } from "lucide";
import { button } from "@/components/ui/button";
import { componentName } from "@/lib/component";
import { icon } from "@/lib/icons";

export const Status = defineTaggedUnion({
  Idle: {},
  Connecting: {},
  Listening: {},
  Finishing: {},
  Failed: { error: Schema.String },
});
export const Model = Schema.Struct({
  sequence: Schema.Int,
  status: Status,
  partial: Schema.String,
  maybeSegment: Schema.Option(Schema.String),
  maybeEditedSegment: Schema.Option(Schema.String),
  segments: Schema.Array(Schema.String),
});
export type Model = typeof Model.Type;
export const initial = Model.make({
  sequence: 0,
  status: Status.Idle(),
  partial: "",
  maybeSegment: Option.none(),
  maybeEditedSegment: Option.none(),
  segments: [],
});
export const active = (model: Model) =>
  model.status._tag === "Connecting" ||
  model.status._tag === "Listening" ||
  model.status._tag === "Finishing";
export const cancel = (model: Model) =>
  modifyFields(model, {
    status: () => Status.Idle(),
    partial: () => "",
    maybeSegment: () => Option.none(),
  });
export const edited = (model: Model) =>
  modifyFields(model, {
    partial: () => "",
    maybeSegment: () => Option.none(),
    maybeEditedSegment: (previous) => Option.orElse(model.maybeSegment, () => previous),
  });
export const draft = (input: string, previous: string, text: string) =>
  previous !== "" && input.endsWith(previous)
    ? `${input.slice(0, -previous.length)}${text}`
    : `${input}${input === "" || text === "" || /\s$/.test(input) ? "" : " "}${text}`;

export const Message = defineMessageUnion({
  ClickedMicrophone: {},
  ClickedCancel: {},
  SucceededConnect: { sequence: Schema.Int },
  CompletedRecordingLimit: { sequence: Schema.Int },
  UpdatedTranscript: {
    sequence: Schema.Int,
    text: Schema.String,
    segment: Schema.String,
    isFinal: Schema.Boolean,
  },
  CompletedStream: { sequence: Schema.Int },
  FailedStream: { sequence: Schema.Int, error: Schema.String },
});
export type Message = typeof Message.Type;
export const OutMessage = defineMessageUnion({
  DraftedText: { previous: Schema.String, text: Schema.String },
});
export type OutMessage = typeof OutMessage.Type;

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(message, {
    ClickedMicrophone: () =>
      model.status._tag === "Listening"
        ? { model: modifyFields(model, { status: () => Status.Finishing() }) }
        : active(model)
          ? { model }
          : {
              model: modifyFields(model, {
                sequence: (sequence) => sequence + 1,
                status: () => Status.Connecting(),
                partial: () => "",
                maybeSegment: () => Option.none(),
                maybeEditedSegment: () => Option.none(),
                segments: () => [],
              }),
            },
    ClickedCancel: () => ({ model: cancel(model) }),
    SucceededConnect: ({ sequence }) =>
      sequence !== model.sequence || model.status._tag !== "Connecting"
        ? { model }
        : { model: modifyFields(model, { status: () => Status.Listening() }) },
    CompletedRecordingLimit: ({ sequence }) =>
      sequence !== model.sequence || model.status._tag !== "Listening"
        ? { model }
        : { model: modifyFields(model, { status: () => Status.Finishing() }) },
    UpdatedTranscript: ({ sequence, text, segment, isFinal }) => {
      if (sequence !== model.sequence || !active(model)) {
        return { model };
      }
      if (model.segments.includes(segment)) {
        return { model };
      }
      const wasEdited = Option.contains(model.maybeEditedSegment, segment);
      const words = text.trim();
      const next = modifyFields(model, {
        partial: () => (isFinal || wasEdited ? "" : words),
        maybeSegment: () => (isFinal || wasEdited ? Option.none() : Option.some(segment)),
        maybeEditedSegment: () =>
          wasEdited && !isFinal ? model.maybeEditedSegment : Option.none(),
        segments: (segments) => (isFinal ? [...segments, segment] : segments),
      });
      return wasEdited
        ? { model: next }
        : {
            model: next,
            outMessage: OutMessage.DraftedText({ previous: model.partial, text: words }),
          };
    },
    CompletedStream: ({ sequence }) =>
      sequence !== model.sequence || !active(model) ? { model } : { model: cancel(model) },
    FailedStream: ({ sequence, error }) =>
      sequence !== model.sequence || !active(model)
        ? { model }
        : {
            model: modifyFields(model, {
              status: () => Status.Failed({ error }),
              partial: () => "",
              maybeSegment: () => Option.none(),
            }),
          },
  });

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const listening = model.status._tag === "Listening";
  const waiting = model.status._tag === "Connecting" || model.status._tag === "Finishing";
  const label = listening
    ? "Stop dictation"
    : model.status._tag === "Finishing"
      ? "Finishing transcription"
      : waiting
        ? "Connecting transcription"
        : "Start dictation";
  return h.div(
    [componentName("dictation"), h.Class("flex shrink-0 items-center gap-1")],
    [
      active(model)
        ? button(
            {
              type: "button",
              variant: "ghost",
              size: "icon-xs",
              onClick: Message.ClickedCancel(),
              attributes: [h.AriaLabel("Cancel dictation")],
            },
            [icon(h, X, "size-3")],
            h,
          )
        : h.empty,
      button(
        {
          type: "button",
          variant: listening ? "destructive" : "ghost",
          size: "icon-sm",
          onClick: Message.ClickedMicrophone(),
          isDisabled: waiting,
          attributes: [h.AriaLabel(label), h.Title(label)],
        },
        [
          icon(
            h,
            waiting ? LoaderCircle : listening ? Square : Mic,
            waiting ? "size-3.5 animate-spin" : "size-3.5",
          ),
        ],
        h,
      ),
    ],
  );
});

export const statusView = Submodel.defineView<Model, Message>((model, h) =>
  h.span(
    [
      componentName("dictation-status"),
      h.Role("status"),
      h.Class("min-w-0 break-words text-xs text-muted-foreground"),
    ],
    [
      Status.match(model.status, {
        Idle: () => "",
        Connecting: () => "Allow microphone access…",
        Listening: () => "Listening…",
        Finishing: () => "Finishing transcription…",
        Failed: ({ error }) => error,
      }),
    ],
  ),
);

export const maybeSession = (model: Model) =>
  active(model) ? Option.some(model.sequence) : Option.none<number>();
