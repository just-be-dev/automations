import { Subscription } from "foldkit";
import type { Model } from "./model.ts";
import { Message } from "./message.ts";
import { subscriptions as dictationSubscriptions } from "../dictation/audio.ts";

export const subscriptions = Subscription.lift(dictationSubscriptions)({
  toChildModel: (model: Model) => model.dictation,
  toParentMessage: (message) => Message.GotDictationMessage({ message }),
});
