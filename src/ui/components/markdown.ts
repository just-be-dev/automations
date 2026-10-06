import * as Array from "effect/Array";
import * as Match from "effect/Match";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { componentName } from "@/lib/component";
import { cn } from "@/lib/utils";

// Markdown from the agent, built as elements rather than set as HTML, so nothing it writes can
// add markup, scripts, or styles. Raw HTML shows as text, and links only open web and mail
// addresses, in a new tab so the studio stays open.

type Child = Html | string;

// NOTE: marked types every token as possibly coming from an extension. None is registered, so
// the lexer only makes its own tokens.
const ownTokens = (tokens: ReadonlyArray<Token>) => tokens as ReadonlyArray<MarkedToken>;

const safeHref = (href: string) => {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

const inlineViews = <M>(tokens: ReadonlyArray<Token>, h: HtmlBuilder<M>): ReadonlyArray<Child> =>
  Array.map(ownTokens(tokens), (token) => markdownTokenView(token, h));

const markdownTextView = <M>(text: Tokens.Text, h: HtmlBuilder<M>): Child =>
  text.tokens === undefined
    ? text.text
    : h.span([componentName("markdown-text")], inlineViews(text.tokens, h));

const markdownLinkView = <M>(link: Tokens.Link, h: HtmlBuilder<M>): Child => {
  const href = safeHref(link.href);
  return href === undefined
    ? h.span([componentName("markdown-link")], inlineViews(link.tokens, h))
    : h.a(
        [
          componentName("markdown-link"),
          h.Href(href),
          h.Target("_blank"),
          h.Rel("noopener noreferrer"),
          h.Class("text-signal underline underline-offset-2 hover:no-underline"),
        ],
        inlineViews(link.tokens, h),
      );
};

const markdownHeadingView = <M>(heading: Tokens.Heading, h: HtmlBuilder<M>) => {
  const children = inlineViews(heading.tokens, h);
  if (heading.depth <= 1) {
    return h.h3([componentName("markdown-heading"), h.Class("text-base font-semibold")], children);
  }
  if (heading.depth === 2) {
    return h.h4(
      [componentName("markdown-heading"), h.Class("text-[0.95rem] font-semibold")],
      children,
    );
  }
  return h.h5([componentName("markdown-heading"), h.Class("font-semibold")], children);
};

const markdownListItemView = <M>(item: Tokens.ListItem, h: HtmlBuilder<M>) =>
  h.li(
    [componentName("markdown-list-item"), h.Class("pl-0.5 [&>ol]:mt-1 [&>ul]:mt-1")],
    Array.map(ownTokens(item.tokens), (token) =>
      token.type === "text" ? markdownTextView(token, h) : markdownTokenView(token, h),
    ),
  );

const markdownListView = <M>(list: Tokens.List, h: HtmlBuilder<M>) => {
  const className = cn("flex flex-col pl-5", list.loose ? "gap-2" : "gap-1");
  const items = Array.map(list.items, (item) => markdownListItemView(item, h));
  return list.ordered
    ? h.ol(
        [
          componentName("markdown-list"),
          h.Class(cn(className, "list-decimal marker:text-muted-foreground")),
          ...(list.start === "" || list.start === 1 ? [] : [h.Start(list.start)]),
        ],
        items,
      )
    : h.ul(
        [componentName("markdown-list"), h.Class(cn(className, "list-disc marker:text-sand-8"))],
        items,
      );
};

const cellClass = "border-b px-2 py-1.5 align-top";

const markdownTableView = <M>(table: Tokens.Table, h: HtmlBuilder<M>) =>
  h.div(
    [componentName("markdown-table"), h.Class("overflow-x-auto")],
    [
      h.table(
        [h.Class("w-full border-collapse text-left text-xs")],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                Array.map(table.header, (cell) =>
                  h.th(
                    [h.Class(cn(cellClass, "font-semibold")), h.Scope("col")],
                    inlineViews(cell.tokens, h),
                  ),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            Array.map(table.rows, (row) =>
              h.tr(
                [],
                Array.map(row, (cell) => h.td([h.Class(cellClass)], inlineViews(cell.tokens, h))),
              ),
            ),
          ),
        ],
      ),
    ],
  );

const blockViews = <M>(tokens: ReadonlyArray<Token>, h: HtmlBuilder<M>): ReadonlyArray<Child> =>
  Array.map(
    Array.filter(ownTokens(tokens), (token) => token.type !== "space" && token.type !== "def"),
    (token) =>
      token.type === "text" ? h.p([], [markdownTextView(token, h)]) : markdownTokenView(token, h),
  );

const markdownTokenView = <M>(token: MarkedToken, h: HtmlBuilder<M>): Child =>
  Match.value(token).pipe(
    Match.discriminatorsExhaustive("type")({
      paragraph: (paragraph) =>
        h.p([componentName("markdown-token")], inlineViews(paragraph.tokens, h)),
      heading: (heading) => markdownHeadingView(heading, h),
      list: (list) => markdownListView(list, h),
      list_item: (item) => markdownListItemView(item, h),
      blockquote: (quote) =>
        h.blockquote(
          [
            componentName("markdown-token"),
            h.Class("flex flex-col gap-2 border-l-2 pl-3 text-muted-foreground"),
          ],
          blockViews(quote.tokens, h),
        ),
      code: (code) =>
        h.pre(
          [
            componentName("markdown-token"),
            h.Class(
              "overflow-x-auto rounded-lg bg-chip px-3 py-2 font-mono text-xs leading-relaxed",
            ),
          ],
          [h.code([], [code.text])],
        ),
      hr: () => h.hr([componentName("markdown-token"), h.Class("border-border")]),
      table: (table) => markdownTableView(table, h),
      text: (text) => markdownTextView(text, h),
      escape: (escape) => escape.text,
      strong: (strong) =>
        h.strong(
          [componentName("markdown-token"), h.Class("font-semibold")],
          inlineViews(strong.tokens, h),
        ),
      em: (em) => h.em([componentName("markdown-token")], inlineViews(em.tokens, h)),
      del: (del) => h.del([componentName("markdown-token")], inlineViews(del.tokens, h)),
      codespan: (code) =>
        h.code(
          [
            componentName("markdown-token"),
            h.Class("rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em]"),
          ],
          [code.text],
        ),
      br: () => h.br([componentName("markdown-token")]),
      link: (link) => markdownLinkView(link, h),
      image: (image) => image.text,
      checkbox: (checkbox) => (checkbox.checked ? "☑ " : "☐ "),
      html: (html) => html.text,
      space: () => "",
      def: () => "",
    }),
  );

/** Markdown as elements: paragraphs, headings, lists, quotes, code, tables, and inline styles. */
export const markdown = <M>(source: string, h: HtmlBuilder<M>, className?: string) =>
  h.div(
    [
      componentName("markdown"),
      h.Class(cn("flex min-w-0 flex-col gap-2.5 wrap-break-word", className)),
    ],
    blockViews(Lexer.lex(source, { gfm: true, breaks: true }), h),
  );
