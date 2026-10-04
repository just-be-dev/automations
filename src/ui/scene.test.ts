import { test } from "bun:test";
import { Command, click, expect, given, label, role, scene, text, type } from "foldkit/scene";
import { Message, SendMessage, init, update, view } from "./main.ts";

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
