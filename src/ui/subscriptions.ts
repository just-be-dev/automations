import * as Option from "effect/Option";
import { Subscription } from "foldkit";
import type { Model } from "./model.ts";
import { Message } from "./message.ts";
import { subscriptions as assistantSubscriptions } from "./assistant/subscriptions.ts";

export const subscriptions = {
  assistantMicrophone: Subscription.lift(assistantSubscriptions)({
    read: (model: Model) => Option.some(model.assistant),
    toParentMessage: (message) => Message.GotAssistantMessage({ message }),
  }).microphone,
};
