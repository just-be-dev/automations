import * as Array from "effect/Array";
import * as Match from "effect/Match";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";
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
  Array.map(ownTokens(tokens), (token) => markdownView(token, h));

const textView = <M>(text: Tokens.Text, h: HtmlBuilder<M>): Child =>
  text.tokens === undefined ? text.text : h.span([], inlineViews(text.tokens, h));

const linkView = <M>(link: Tokens.Link, h: HtmlBuilder<M>): Child => {
  const href = safeHref(link.href);
  return href === undefined
    ? h.span([], inlineViews(link.tokens, h))
    : h.a(
        [
          h.Href(href),
          h.Target("_blank"),
          h.Rel("noopener noreferrer"),
          h.Class("text-signal underline underline-offset-2 hover:no-underline"),
        ],
        inlineViews(link.tokens, h),
      );
};

const headingView = <M>(heading: Tokens.Heading, h: HtmlBuilder<M>) => {
  const children = inlineViews(heading.tokens, h);
  if (heading.depth <= 1) {
    return h.h3([h.Class("text-base font-semibold")], children);
  }
  if (heading.depth === 2) {
    return h.h4([h.Class("text-[0.95rem] font-semibold")], children);
  }
  return h.h5([h.Class("font-semibold")], children);
};

const listItemView = <M>(item: Tokens.ListItem, h: HtmlBuilder<M>) =>
  h.li(
    [h.Class("pl-0.5 [&>ol]:mt-1 [&>ul]:mt-1")],
    Array.map(ownTokens(item.tokens), (token) =>
      token.type === "text" ? textView(token, h) : markdownView(token, h),
    ),
  );

const listView = <M>(list: Tokens.List, h: HtmlBuilder<M>) => {
  const className = cn("flex flex-col pl-5", list.loose ? "gap-2" : "gap-1");
  const items = Array.map(list.items, (item) => listItemView(item, h));
  return list.ordered
    ? h.ol(
        [
          h.Class(cn(className, "list-decimal marker:text-muted-foreground")),
          ...(list.start === "" || list.start === 1 ? [] : [h.Start(list.start)]),
        ],
        items,
      )
    : h.ul([h.Class(cn(className, "list-disc marker:text-sand-8"))], items);
};

const cellClass = "border-b px-2 py-1.5 align-top";

const tableView = <M>(table: Tokens.Table, h: HtmlBuilder<M>) =>
  h.div(
    [h.Class("overflow-x-auto")],
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
    (token) => (token.type === "text" ? h.p([], [textView(token, h)]) : markdownView(token, h)),
  );

const markdownView = <M>(token: MarkedToken, h: HtmlBuilder<M>): Child =>
  Match.value(token).pipe(
    Match.discriminatorsExhaustive("type")({
      paragraph: (paragraph) => h.p([], inlineViews(paragraph.tokens, h)),
      heading: (heading) => headingView(heading, h),
      list: (list) => listView(list, h),
      list_item: (item) => listItemView(item, h),
      blockquote: (quote) =>
        h.blockquote(
          [h.Class("flex flex-col gap-2 border-l-2 pl-3 text-muted-foreground")],
          blockViews(quote.tokens, h),
        ),
      code: (code) =>
        h.pre(
          [
            h.Class(
              "overflow-x-auto rounded-lg bg-chip px-3 py-2 font-mono text-xs leading-relaxed",
            ),
          ],
          [h.code([], [code.text])],
        ),
      hr: () => h.hr([h.Class("border-border")]),
      table: (table) => tableView(table, h),
      text: (text) => textView(text, h),
      escape: (escape) => escape.text,
      strong: (strong) => h.strong([h.Class("font-semibold")], inlineViews(strong.tokens, h)),
      em: (em) => h.em([], inlineViews(em.tokens, h)),
      del: (del) => h.del([], inlineViews(del.tokens, h)),
      codespan: (code) =>
        h.code(
          [h.Class("rounded-[4px] bg-chip px-1.5 py-0.5 font-mono text-[0.92em]")],
          [code.text],
        ),
      br: () => h.br([]),
      link: (link) => linkView(link, h),
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
    [h.Class(cn("flex min-w-0 flex-col gap-2.5 wrap-break-word", className))],
    blockViews(Lexer.lex(source, { gfm: true, breaks: true }), h),
  );
