/** Capability for preparing and confirming studio mutations, bound to a person's identity. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Event } from "../events/model.ts";
import type { ChangeAction, ChangeDecision, ChangeProposal } from "./model.ts";

export class ChangeError extends Schema.TaggedError<ChangeError>()("ChangeError", {
  message: Schema.String,
}) {}

export class Changes extends Context.Service<
  Changes,
  {
    /** Checks and describes an action as `prepare` does, without storing a proposal. */
    readonly preview: (action: ChangeAction) => Effect.Effect<Omit<ChangeProposal, "id">, unknown>;
    readonly prepare: (
      owner: string,
      action: ChangeAction,
      requestId?: string,
      /** Trusted event consumer only; persisted to carry the chain limit through recovery. */
      sourceEvent?: Event,
    ) => Effect.Effect<ChangeProposal, unknown>;
    readonly decide: (
      owner: string,
      proposalId: string,
      approved: boolean,
    ) => Effect.Effect<ChangeDecision, unknown>;
  }
>()("automations/Changes") {}
