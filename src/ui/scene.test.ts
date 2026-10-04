import { test } from "bun:test";
import * as Option from "effect/Option";
import { modifyFields } from "foldkit/struct";
import { Command, click, expect, given, label, role, scene, text, type } from "foldkit/scene";
import { Message, SendMessage, init, update, view, type Workflow } from "./main.ts";

test("the accessible message input drives chat and safely renders the workflow", () => {
  scene(
    { update, view },
    given(init().model),
    expect(label("Automation ID")).toHaveValue("my-automation"),
    type(label("Your message"), "Summarize orders"),
    click(role("button", { name: "Send message" })),
    Command.expectExact(
      SendMessage({ automationId: "my-automation", revision: 0, message: "Summarize orders" }),
    ),
    Command.resolve(
      SendMessage,
      Message.SucceededSendMessage({
        revision: 0,
        sentMessage: "Summarize orders",
        reply: "Ready to review.",
        workflow: {
          name: "Orders",
          event: null,
          steps: [
            {
              id: "summary",
              kind: "agent",
              title: "<script>alert('unsafe')</script>",
              instruction: "Summarize",
            },
          ],
        },
      }),
    ),
    expect(text("Manual start")).toExist(),
    expect(text("<script>alert('unsafe')</script>")).toExist(),
    expect(label("Your message")).toHaveValue(""),
  );
});

test("a truncated step description expands to show the full text", () => {
  const instruction =
    "Read the order payload and write a two-sentence summary of what was bought, the total, and anything unusual about shipping or payment.";
  const draft: Workflow = {
    name: "Orders",
    event: null,
    steps: [{ id: "summary", kind: "agent", title: "Summarize the order", instruction }],
  };
  const draftModel = modifyFields(init().model, { maybeDraft: () => Option.some(draft) });
  const stepToggle = role("button", { name: /Summarize the order/ });

  scene(
    { update, view },
    given(draftModel),
    expect(stepToggle).toHaveAttr("aria-expanded", "false"),
    expect(text(instruction)).toHaveClass("line-clamp-2"),
    click(stepToggle),
    expect(stepToggle).toHaveAttr("aria-expanded", "true"),
    expect(text(instruction)).not.toHaveClass("line-clamp-2"),
    expect(text(instruction)).toHaveClass("whitespace-pre-wrap"),
    click(stepToggle),
    expect(stepToggle).toHaveAttr("aria-expanded", "false"),
    expect(text(instruction)).toHaveClass("line-clamp-2"),
  );
});
