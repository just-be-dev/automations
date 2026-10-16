import * as Option from "effect/Option";
import { Subscription } from "foldkit";
import type { Model } from "./model.ts";
import { Message } from "./message.ts";
import { subscriptions as dictationSubscriptions } from "../dictation/audio.ts";

export const subscriptions = Subscription.lift(dictationSubscriptions)({
  read: (model: Model) => Option.some(model.dictation),
  toParentMessage: (message) => Message.GotDictationMessage({ message }),
});
