import { Subscription } from "foldkit";
import type { Model } from "./model.ts";
import { Message } from "./message.ts";
import { subscriptions as assistantSubscriptions } from "./assistant/subscriptions.ts";
import { subscriptions as dictationSubscriptions } from "./dictation/audio.ts";

export const subscriptions = {
  plannerMicrophone: Subscription.lift(dictationSubscriptions)({
    toChildModel: (model: Model) => model.dictation,
    toParentMessage: (message) => Message.GotDictationMessage({ message }),
  }).microphone,
  assistantMicrophone: Subscription.lift(assistantSubscriptions)({
    toChildModel: (model: Model) => model.assistant,
    toParentMessage: (message) => Message.GotAssistantMessage({ message }),
  }).microphone,
};
