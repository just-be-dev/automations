import { expect, test } from "bun:test";
import { given, message, model, story, Command } from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import * as Dictation from "./dictation/index.ts";
import * as Assistant from "./assistant/index.ts";
import { assistantOf } from "./assistant/fixtures.ts";
import { init } from "./main.ts";
import { Message } from "./message.ts";
import { studioUrl } from "./fixtures.ts";
import { update } from "./update/index.ts";
import { PersistCollapsed } from "./assistant/command.ts";

const assistant = (message: Dictation.Message) =>
  Message.GotAssistantMessage({ message: Assistant.Message.GotDictationMessage({ message }) });
const words = (sequence: number, text: string) =>
  Dictation.Message.UpdatedTranscript({ sequence, text, segment: "1:2", isFinal: true });
const initial = modifyFields(
  init({ theme: "System", shortcutModifier: "Meta" }, studioUrl("automation=invoice")).model,
  { assistant: () => assistantOf() },
);

test("the assistant drafts live revisions and preserves typed edits and visible words after failure or cancel", () => {
  const toParent = assistant;
  const inputOf = (current: typeof initial) => current.assistant.input;
  const typed = (value: string) =>
    Message.GotAssistantMessage({ message: Assistant.Message.UpdatedInput({ value }) });
  const result = (text: string, segment = "0", isFinal = false) =>
    toParent(Dictation.Message.UpdatedTranscript({ sequence: 1, text, segment, isFinal }));
  story(
    update,
    given(initial),
    message(typed("Please:")),
    message(toParent(Dictation.Message.ClickedMicrophone())),
    message(toParent(Dictation.Message.SucceededConnect({ sequence: 1 }))),
    message(result("Send an")),
    model((current) => expect(inputOf(current)).toBe("Please: Send an")),
    message(result("Send an invoice")),
    model((current) => expect(inputOf(current)).toBe("Please: Send an invoice")),
    message(result("Send the invoice.", "0", true)),
    message(result("Send the invoice.", "0", true)),
    model((current) => expect(inputOf(current)).toBe("Please: Send the invoice.")),
    message(result("Tomorrow morning", "3")),
    message(typed("Please: Send the invoice. Tomorrow afternoon")),
    message(result("Tomorrow morning at nine", "3")),
    message(result("Tomorrow morning at nine.", "3", true)),
    model((current) =>
      expect(inputOf(current)).toBe("Please: Send the invoice. Tomorrow afternoon"),
    ),
    message(result("To Ada", "6")),
    message(toParent(Dictation.Message.FailedStream({ sequence: 1, error: "Connection lost" }))),
    model((current) =>
      expect(inputOf(current)).toBe("Please: Send the invoice. Tomorrow afternoon To Ada"),
    ),
    message(toParent(Dictation.Message.ClickedMicrophone())),
    message(toParent(Dictation.Message.SucceededConnect({ sequence: 2 }))),
    message(
      toParent(
        Dictation.Message.UpdatedTranscript({
          sequence: 2,
          text: "And Bob",
          segment: "0",
          isFinal: false,
        }),
      ),
    ),
    message(toParent(Dictation.Message.ClickedCancel())),
    message(
      toParent(
        Dictation.Message.UpdatedTranscript({
          sequence: 2,
          text: "Late words",
          segment: "0",
          isFinal: true,
        }),
      ),
    ),
    model((current) =>
      expect(inputOf(current)).toBe("Please: Send the invoice. Tomorrow afternoon To Ada And Bob"),
    ),
  );
});

test("dictation appends to current edits, blocks Send, and stops when the assistant collapses", () => {
  story(
    update,
    given(initial),
    message(
      Message.GotAssistantMessage({
        message: Assistant.Message.UpdatedInput({ value: "Please\n" }),
      }),
    ),
    message(assistant(Dictation.Message.ClickedMicrophone())),
    message(assistant(Dictation.Message.SucceededConnect({ sequence: 1 }))),
    message(assistant(words(1, "Draft a reminder."))),
    message(Message.GotAssistantMessage({ message: Assistant.Message.SubmittedChat() })),
    Command.expectNone(),
    model((current) => expect(current.assistant.input).toBe("Please\nDraft a reminder.")),
    message(Message.GotAssistantMessage({ message: Assistant.Message.ClickedCollapse() })),
    Command.resolve(PersistCollapsed, Assistant.Message.CompletedPersistCollapsed()),
    model((current) => expect(current.assistant.dictation.status._tag).toBe("Idle")),
  );
});
