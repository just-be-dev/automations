import { expect, test } from "bun:test";
import { given, message, model, story } from "foldkit/story";
import { initial, Message, update } from "./index.ts";

const connected = update(
  update(initial, Message.ClickedMicrophone()).model,
  Message.SucceededConnect({ sequence: 1 }),
).model;
const transcript = (sequence: number, text: string, isFinal = true) =>
  Message.UpdatedTranscript({ sequence, text, segment: "0", isFinal });

test("interim and final results draft the same segment, including after Stop", () => {
  const preview = update(connected, transcript(1, "Send the", false));
  expect(preview.model.partial).toBe("Send the");
  expect(preview.outMessage).toEqual({ _tag: "DraftedText", previous: "", text: "Send the" });
  const finishing = update(preview.model, Message.ClickedMicrophone());
  expect(finishing.model.status._tag).toBe("Finishing");
  const final = update(finishing.model, transcript(1, " Send the invoice. "));
  expect(final.outMessage).toEqual({
    _tag: "DraftedText",
    previous: "Send the",
    text: "Send the invoice.",
  });
  expect(final.model.partial).toBe("");
  expect(update(final.model, transcript(1, "Send the invoice.")).outMessage).toBeUndefined();
  story(
    update,
    given(final.model),
    message(Message.CompletedStream({ sequence: 1 })),
    model((current) => expect(current.status._tag).toBe("Idle")),
  );
});

test("cancel and a new recording reject stale text, connection, failure and completion events", () => {
  story(
    update,
    given(connected),
    message(Message.ClickedCancel()),
    message(transcript(1, "Discard me")),
    model((current) => expect(current.status._tag).toBe("Idle")),
    message(Message.ClickedMicrophone()),
    message(Message.SucceededConnect({ sequence: 1 })),
    message(Message.FailedStream({ sequence: 1, error: "Old socket" })),
    message(Message.CompletedStream({ sequence: 1 })),
    message(transcript(1, "Old words")),
    model((current) => {
      expect(current.sequence).toBe(2);
      expect(current.status._tag).toBe("Connecting");
      expect(current.partial).toBe("");
    }),
    message(Message.SucceededConnect({ sequence: 2 })),
    message(Message.CompletedRecordingLimit({ sequence: 2 })),
    model((current) => expect(current.status._tag).toBe("Finishing")),
  );
});
