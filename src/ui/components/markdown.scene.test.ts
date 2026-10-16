/** Checks that agent Markdown renders as elements without letting a reply add markup or unsafe links. */
import { test } from "bun:test";
import { expect, given, role, scene, within } from "foldkit/scene";
import type { HtmlBuilder } from "foldkit/html";
import { markdown } from "./markdown.ts";

const update = (reply: string) => ({ model: reply });
const view = (reply: string, h: HtmlBuilder<never>) =>
  h.div([h.Role("article")], [markdown(reply, h)]);

test("an agent's reply renders Markdown without letting it add markup", () => {
  const reply = [
    "**Almost done.** Two things:",
    "",
    "1. Read [the guide](https://example.com/guide)",
    "2. Ignore [this](javascript:alert(1)) and <b>raw</b> HTML",
  ].join("\n");
  const article = role("article");
  scene(
    { update, view },
    given(reply),
    expect(within(article, role("strong"))).toHaveText("Almost done."),
    expect(within(article, role("list"))).toContainText("Read the guide"),
    expect(role("link", { name: "the guide" })).toHaveAttr("href", "https://example.com/guide"),
    expect(role("link", { name: "the guide" })).toHaveAttr("target", "_blank"),
    expect(role("link", { name: "this" })).not.toExist(),
    expect(within(article, role("list"))).toContainText("Ignore this and <b>raw</b> HTML"),
  );
});
