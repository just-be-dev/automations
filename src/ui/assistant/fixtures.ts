import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import type { AssistantState } from "../../assistant/model.ts";
import { initial } from "./model.ts";

export const sessionId = "b7286b84-df29-4d4a-a7b7-ccfdd37e0a1a";
export const stateOf = (fields: Partial<AssistantState> = {}): AssistantState => ({
  sessionId,
  conversation: [],
  status: "idle",
  activities: [],
  ...fields,
});
export const assistantOf = (fields: Partial<AssistantState> = {}) =>
  modifyFields(initial, {
    sessionId: () => sessionId,
    maybeState: () => Option.some(stateOf(fields)),
  });
