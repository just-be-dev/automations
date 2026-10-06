import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { WorkersAi } from "./models.ts";

/**
 * How the evals reach one LLM call (`evals/calls/`). The Evals Worker runs it, so its input and
 * output cross HTTP: their Schemas decode them on each side.
 */
export interface Call<I, O> {
  /** The Worker's route: `POST /calls/<name>`. */
  readonly name: string;
  readonly input: Schema.Codec<I, unknown>;
  readonly output: Schema.Codec<O, unknown>;
  /** How long one trial may take. */
  readonly timeout: Duration.Input;
  readonly run: (input: I) => Effect.Effect<O, { readonly message: string }, WorkersAi>;
}
