/** Resets a local `mise run dev` studio to the demo's known state through the studio's own API. */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AutomationSummary } from "../src/automation/model.ts";
import { type ChangeAction, ChangeDecision, ChangeProposal } from "../src/changes/model.ts";
import { EntityRecord, EntityType, Role } from "../src/entities/model.ts";
import { Template } from "../src/entities/templates.ts";
import { messageOf } from "../src/error.ts";
import { Workflow } from "../src/workflow/model.ts";
import {
  approverNote,
  employees,
  employeeType,
  fallback,
  fallbackId,
  newHire,
  people,
  roles,
  startDateFrom,
  templates,
} from "./seed.ts";

/**
 * Brings the studio that `mise run dev` serves to the demo's known state:
 *
 *   mise run demo:reset
 *
 * It deletes every automation with its runs, restores the employee type, the people, the People
 * Ops role and the welcome templates, deletes every other entity, type, role and template, and
 * saves the fallback onboarding workflow. Entity, type and template writes go through
 * `/api/changes`, prepared and then approved, so the studio validates them as it does a person's.
 * A write that would change nothing is skipped, so running it again changes only the new hire's
 * start date when the calendar has moved on.
 *
 * People's addresses come from `.env` (`DEMO_ADA_EMAIL` and the others in `seed.ts`), and the
 * Studio URL from `STUDIO_URL` or the local Alchemy state. It says whether `DEV_USER_EMAIL`, who
 * you are in the local studio, can approve the welcome email. It refuses any host but this machine.
 */

class ResetError extends Schema.TaggedError<ResetError>()("ResetError", {
  message: Schema.String,
}) {}

const fail = (message: string) => new ResetError({ message });

const StackOutput = Schema.Struct({ url: Schema.String });
const Connections = Schema.Struct({ live: Schema.Array(Schema.String) });
const Removed = Schema.Struct({ removed: Schema.String });
const Deleted = Schema.Struct({ deleted: Schema.String });
const Draft = Schema.Struct({ draft: Workflow });
const Saved = Schema.Struct({ saved: Workflow });
const ApiError = Schema.Struct({ error: Schema.String });

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `STUDIO_URL`, or the URL `mise run dev` recorded for this checkout's stage. */
const studioUrl = Effect.gen(function* () {
  const configured = yield* Config.option(Config.String("STUDIO_URL"));
  const url = Option.isSome(configured)
    ? configured.value
    : yield* Effect.gen(function* () {
        const stage = `dev_${yield* Config.String("USER")}`;
        const file = `.alchemy/state/automations/${stage}/__stack_output__.json`;
        const text = yield* Effect.tryPromise({
          try: () => Bun.file(file).text(),
          catch: () => fail(`No ${file}. Start \`mise run dev\` first, or set STUDIO_URL.`),
        });
        return (yield* Schema.decodeEffect(Schema.fromJsonString(StackOutput))(text)).url;
      });
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: () => fail(`STUDIO_URL ${url} isn't a URL`),
  });
  if (!localHosts.has(parsed.hostname)) {
    return yield* fail(
      `demo:reset only resets a local \`mise run dev\` studio, not ${parsed.origin}.`,
    );
  }
  return parsed.origin;
});

/** Each person's address from `.env`, by key. Unset keys keep their placeholder. */
const configuredEmails = Effect.gen(function* () {
  const entries = yield* Effect.forEach(people, (each) =>
    Config.option(Config.String(each.emailKey)).pipe(
      Effect.flatMap((value) => {
        const email = Option.getOrUndefined(value)?.trim() || undefined;
        return email === undefined || /^[^\s@]+@[^\s@]+$/.test(email)
          ? Effect.succeed([each.emailKey, email] as const)
          : Effect.fail(fail(`${each.emailKey} isn't an email address: ${email}`));
      }),
    ),
  );
  return Object.fromEntries(entries);
});

/** JSON with sorted keys, so stored values compare by content. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The studio's API, failing with the `{ error }` message it returns. */
const makeStudio = (origin: string) => {
  const call = <A>(
    method: string,
    path: string,
    schema: Schema.Codec<A, unknown>,
    body?: unknown,
  ) =>
    Effect.gen(function* () {
      const label = `${method} ${path}`;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(new URL(path, origin), {
            method,
            signal: AbortSignal.timeout(60_000),
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          }),
        catch: (cause) =>
          fail(`${label}: ${messageOf(cause)}. Is \`mise run dev\` running at ${origin}?`),
      });
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => fail(`${label}: ${messageOf(cause)}`),
      });
      const json = yield* Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: () => fail(`${label} answered ${response.status} with ${text.slice(0, 200)}`),
      });
      if (!response.ok) {
        const error = Schema.decodeUnknownOption(ApiError)(json);
        return yield* fail(
          `${label} failed (${response.status}): ${Option.isSome(error) ? error.value.error : text}`,
        );
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((error) => fail(`${label} answered unexpectedly: ${error.message}`)),
      );
    });

  /** Prepares a change and approves exactly that proposal, as a person in the studio does. */
  const change = Effect.fn("Demo.change")(function* (action: ChangeAction) {
    const proposal = yield* call("POST", "/api/changes", ChangeProposal, { action });
    const decision = yield* call("POST", `/api/changes/${proposal.id}/decision`, ChangeDecision, {
      approved: true,
    });
    if (decision.status !== "applied") {
      return yield* fail(`${proposal.title} wasn't applied`);
    }
    return proposal.title;
  });

  return { call, change };
};

const program = Effect.gen(function* () {
  const origin = yield* studioUrl;
  const emails = yield* configuredEmails;
  // The address a local studio knows you by. The server read it when dev started.
  const devUser = Option.getOrUndefined(
    yield* Config.option(Config.String("DEV_USER_EMAIL")).pipe(
      Effect.map(Option.map((email) => email.trim())),
      Effect.map(Option.filter((email) => email !== "")),
    ),
  );
  const startDate = startDateFrom(new Date());
  const { call, change } = makeStudio(origin);
  const done: Array<string> = [];
  const get = <A>(path: string, schema: Schema.Codec<A, unknown>) => call("GET", path, schema);

  const { live } = yield* get("/api/connections", Connections);
  yield* Console.log(`Resetting the demo at ${origin}`);

  // Automations go first: removing one drops its subscription, so the entity writes below start
  // no runs, and nothing watches the types and templates about to be deleted.
  const listed = yield* get("/api/automations", Schema.Array(AutomationSummary));
  const automationIds = [...new Set([...listed.map((each) => each.id), fallbackId])];
  for (const id of automationIds) {
    yield* call("DELETE", `/api/automations/${id}`, Removed);
  }
  if (listed.length > 0) {
    done.push(`Deleted ${listed.length} automation${listed.length === 1 ? "" : "s"}`);
  }

  // The type, then the people in it, then the role that names them.
  const types = yield* get("/api/entities/types", Schema.Array(EntityType));
  if (
    !same(
      types.find((type) => type.name === employeeType.name),
      employeeType,
    )
  ) {
    done.push(yield* change({ kind: "putType", type: employeeType }));
  }
  const seededPeople = employees(emails, startDate);
  const storedPeople = yield* get(`/api/entities/${employeeType.name}`, Schema.Array(EntityRecord));
  for (const { id, data } of seededPeople) {
    if (!same(storedPeople.find((stored) => stored.id === id)?.data, data)) {
      done.push(yield* change({ kind: "putEntity", type: employeeType.name, id, data }));
    }
  }
  // Role writes are direct; the studio has no proposal for them.
  const storedRoles = yield* get("/api/roles", Schema.Array(Role));
  for (const role of roles) {
    if (
      !same(
        storedRoles.find((stored) => stored.name === role.name),
        role,
      )
    ) {
      yield* call("PUT", `/api/roles/${role.name}`, Role, role);
      done.push(`Save role ${role.name}`);
    }
  }
  for (const role of storedRoles.filter((stored) => !roles.some((r) => r.name === stored.name))) {
    yield* call("DELETE", `/api/roles/${role.name}`, Deleted);
    done.push(`Delete role ${role.name}`);
  }

  const storedTemplates = yield* get("/api/templates", Schema.Array(Template));
  for (const template of templates) {
    if (
      !same(
        storedTemplates.find((stored) => stored.name === template.name),
        template,
      )
    ) {
      done.push(yield* change({ kind: "putTemplate", template }));
    }
  }
  for (const extra of storedTemplates.filter((s) => !templates.some((t) => t.name === s.name))) {
    done.push(yield* change({ kind: "deleteTemplate", name: extra.name }));
  }

  // Everything else: entities first, since a type with entities can't be deleted.
  const allTypes = yield* get("/api/entities/types", Schema.Array(EntityType));
  for (const type of allTypes) {
    const stored = yield* get(`/api/entities/${type.name}`, Schema.Array(EntityRecord));
    for (const entity of stored) {
      const seeded =
        type.name === employeeType.name && seededPeople.some((each) => each.id === entity.id);
      if (!seeded) {
        done.push(yield* change({ kind: "deleteEntity", type: type.name, id: entity.id }));
      }
    }
  }
  // A type another one points to waits until that one is gone.
  let extraTypes = allTypes.filter((type) => type.name !== employeeType.name);
  while (extraTypes.length > 0) {
    const results = yield* Effect.forEach(extraTypes, (type) =>
      change({ kind: "deleteType", name: type.name }).pipe(Effect.result),
    );
    const left = extraTypes.filter((_, index) => results[index]?._tag === "Failure");
    done.push(...results.flatMap((result) => (result._tag === "Success" ? [result.success] : [])));
    if (left.length === extraTypes.length) {
      const reasons = results.flatMap((result) =>
        result._tag === "Failure" ? [result.failure.message] : [],
      );
      return yield* fail(`Couldn't delete entity types:\n${reasons.join("\n")}`);
    }
    extraTypes = left;
  }

  // Saved last, after the writes it would otherwise react to.
  yield* call("PUT", `/api/automations/${fallbackId}/draft`, Draft, fallback);
  yield* call("POST", `/api/automations/${fallbackId}/save`, Saved);
  done.push(`Save the fallback workflow "${fallback.name}"`);

  for (const line of done) yield* Console.log(`  ${line}`);
  const hire = seededPeople.find((each) => each.id === newHire);
  yield* Console.log(`\n${hire?.data["name"]} starts on Monday ${startDate}.`);
  yield* Console.log("People:");
  for (const each of people) {
    const record = seededPeople.find((seeded) => seeded.id === each.id);
    const configured = emails[each.emailKey] !== undefined;
    yield* Console.log(
      `  ${String(record?.data["name"]).padEnd(18)} ${String(record?.data["email"]).padEnd(32)} ${configured ? "" : `(set ${each.emailKey} in .env)`}`,
    );
  }
  yield* Console.log(approverNote(devUser, seededPeople));
  yield* Console.log(
    `Slack: ${live.includes("slack") ? "live. Running the workflow posts to the workspace." : "simulated. Set SLACK_BOT_TOKEN in .env and restart dev to post."}`,
  );
  yield* Console.log(`\nFallback workflow: ${origin}/?automation=${fallbackId}`);
  yield* Console.log(
    "The assistant panel keeps its conversation per browser. Open the studio in a private window to start it fresh.",
  );
});

program.pipe(BunRuntime.runMain);
