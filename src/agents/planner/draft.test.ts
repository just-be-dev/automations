import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { decodeDraft, scanBrackets } from "./draft.ts";

describe("planner draft", () => {
  test("parses a fenced draft and rejects one without a reply", () => {
    const workflow = {
      name: "Welcome new hires",
      trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
      steps: [
        { id: "draft", title: "Draft", kind: "agent", instruction: "Write a welcome" },
        {
          id: "send",
          title: "Send it",
          kind: "action",
          use: "email.send",
          with: { to: "{{employee}}", subject: "Welcome", body: "{{steps.draft.output}}" },
        },
      ],
    };
    const draft = Effect.runSync(
      decodeDraft("```json\n" + JSON.stringify({ reply: "Added email", workflow }) + "\n```"),
    );
    expect(draft.workflow.steps.map((step) => step.id)).toEqual(["draft", "send"]);
    const notJson = Effect.runSync(decodeDraft("Sure! Here you go.").pipe(Effect.flip));
    expect(notJson._tag).toBe("InvalidWorkflow");
    const noReply = Effect.runSync(
      decodeDraft(JSON.stringify({ reply: " ", workflow })).pipe(Effect.flip),
    );
    expect(noReply.message).toContain("reply");
  });

  // A reply shaped like one Kimi sent: the if step's last list, then a stray "}" before "]".
  const nested = JSON.stringify({
    reply: "Reminds everyone who hasn't finished",
    workflow: {
      name: "Training reminder",
      trigger: { kind: "entity", entity: "employee", fields: ["start_date"] },
      steps: [
        {
          id: "check",
          title: "Anyone left?",
          kind: "if",
          cases: [
            {
              when: { ref: "employee.start_date", op: "exists" },
              steps: [{ id: "email", title: "Email them", kind: "agent", instruction: "Email" }],
            },
          ],
          otherwise: [{ id: "log", title: "Log it", kind: "agent", instruction: "Log {x}" }],
        },
      ],
    },
  });

  test("repairs a closing bracket out of order", () => {
    expect(nested.endsWith('"}]}]}}')).toBe(true);
    const slipped = `${nested.slice(0, -'"}]}]}}'.length)}"}]}}]}}`;
    const draft = Effect.runSync(decodeDraft(slipped));
    expect(draft.workflow.steps[0]).toMatchObject({ otherwise: [{ id: "log" }] });
  });

  test("closes brackets the reply left open", () => {
    const draft = Effect.runSync(decodeDraft(nested.slice(0, -3)));
    expect(draft.workflow.name).toBe("Training reminder");
  });

  test("leaves brackets inside strings alone", () => {
    expect(scanBrackets('{"a":"}]","b":"\\"}]"}')).toEqual({
      balanced: '{"a":"}]","b":"\\"}]"}',
      missing: "",
      endsInString: false,
    });
    expect(scanBrackets('{"a":["}"}')).toEqual({
      balanced: '{"a":["}"]}',
      mismatch: { at: 9, found: "}", expected: "]" },
      missing: "]}",
      endsInString: false,
    });
  });

  test("tells the agent which bracket is wrong when the repair doesn't parse", () => {
    const error = Effect.runSync(
      decodeDraft('{"reply":"Hi","workflow":{"steps":[1,}]}').pipe(Effect.flip),
    );
    expect(error.message).toStartWith("The reply is not valid JSON: ");
    expect(error.message).toContain(
      `The "}" at the end of "…{"reply":"Hi","workflow":{"steps":[1,}" is wrong: the innermost open bracket there needs "]".`,
    );
  });

  test("tells the agent when the reply was cut off inside a string", () => {
    const error = Effect.runSync(
      decodeDraft('{"reply":"Hi","workflow":{"name":"Rem').pipe(Effect.flip),
    );
    expect(error.message).toContain("It ends inside a string");
  });

  test("leaves prose to the parser's error", () => {
    const error = Effect.runSync(decodeDraft("Sure! Here you go.").pipe(Effect.flip));
    expect(error.message).toStartWith("The reply is not valid JSON: ");
    expect(error.message).not.toContain("bracket");
  });
});
