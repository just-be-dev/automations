/** Who an MCP call acts for: the person whose approval a write carries, or no one. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A tool that changes something was called for no one. */
export class NoPerson extends Schema.TaggedError<NoPerson>()("NoPerson", {
  message: Schema.String,
}) {}

const noPerson = new NoPerson({
  message:
    "This call acts for no one, so it can't change anything. Ask the person to do it signed in.",
});

/**
 * The person an MCP call acts for. HTTP MCP acts for the Access email, or the studio's shared
 * `local` owner like every other route; the `mcp` RPC acts only for the person its caller names.
 */
export class McpCaller extends Context.Service<
  McpCaller,
  {
    readonly owner: string | undefined;
    /** The owner, or `NoPerson` for a call that acts for no one. */
    readonly person: Effect.Effect<string, NoPerson>;
  }
>()("automations/McpCaller") {}

export const mcpCaller = (owner: string | undefined) =>
  McpCaller.of({
    owner,
    person: owner === undefined ? Effect.fail(noPerson) : Effect.succeed(owner),
  });

/** The person the current call acts for, or `NoPerson`. */
export const callerPerson = McpCaller.use((caller) => caller.person);
