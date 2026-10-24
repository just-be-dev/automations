/**
 * Tells the hub shell what to list under this app in the platform's one sidebar, and maps the
 * shell's action buttons back to Messages. The shapes are the host↔shell protocol in agents'
 * `docs/hub-shell.md`; keep them in step with it.
 */
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import {
  FileText,
  type IconNode as LucideIconNode,
  LayoutDashboard,
  Plus,
  ScrollText,
  Workflow as WorkflowIcon,
} from "lucide";
import { Message } from "./message.ts";
import { Directory, type Model, Page } from "./model.ts";
import { automationHref, overviewHref, templatesHref, tracesHref } from "./route.ts";

/** lucide's icon format: SVG children as `[tag, attributes]`. */
export type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>;

export interface HubNavLink {
  readonly label: string;
  /** An absolute path on this origin or a full URL. */
  readonly href: string;
  readonly icon?: IconNode;
  readonly count?: number;
  readonly current?: boolean;
  readonly mono?: boolean;
}

export interface HubNavAction {
  readonly label: string;
  readonly icon: IconNode;
  /** The ID the shell hands back in a `hub:action` event. */
  readonly action: string;
}

export interface HubNavGroup {
  readonly label?: string;
  readonly action?: HubNavAction;
  readonly items: ReadonlyArray<HubNavLink>;
  /** Shown in place of `items` when there are none. */
  readonly note?: string;
  readonly noteTone?: "muted" | "error";
}

export interface HubNav {
  readonly version: 1;
  readonly navigation?: "history" | "document";
  readonly switcher?: {
    readonly label: string;
    readonly icon?: IconNode;
    readonly items: ReadonlyArray<HubNavLink>;
    readonly actions?: ReadonlyArray<HubNavAction>;
  };
  readonly groups: ReadonlyArray<HubNavGroup>;
}

declare global {
  interface Window {
    hubNav?: HubNav;
  }
}

/** A lucide icon with its attribute values as strings, as the protocol carries them. */
const iconOf = (node: LucideIconNode): IconNode =>
  Array.map(node, ([tag, attributes]) => [
    tag,
    Object.fromEntries(
      Array.flatMap(Object.entries(attributes), ([name, value]) =>
        value === undefined ? [] : [[name, String(value)] as const],
      ),
    ),
  ]);

/** The `hub:action` ID of the Automations group's + button. */
export const newAutomationAction = "new-automation";

/** The Message a `hub:action` stands for: the same one the studio's own button sends. */
export const hubActionMessage = (action: string): Option.Option<Message> =>
  action === newAutomationAction ? Option.some(Message.ClickedNewAutomation()) : Option.none();

const link = (
  label: string,
  href: string,
  icon: LucideIconNode,
  isCurrent: boolean,
): HubNavLink => ({
  label,
  href,
  icon: iconOf(icon),
  ...(isCurrent ? { current: true } : {}),
});

const automationsGroup = (model: Model): HubNavGroup => {
  const header = {
    label: "Automations",
    action: { label: "New automation", icon: iconOf(Plus), action: newAutomationAction },
  };
  const isOpen = (automationId: string) =>
    (Page.guards.Studio(model.page) || Page.guards.Run(model.page)) &&
    automationId === model.automationId;
  return Directory.match<HubNavGroup>(model.directory, {
    Loading: () => ({ ...header, items: [], note: "Loading…", noteTone: "muted" }),
    Unavailable: ({ error }) => ({
      ...header,
      items: [],
      note: `Couldn't load automations: ${error}`,
      noteTone: "error",
    }),
    Ready: ({ automations }) =>
      Array.match(automations, {
        onEmpty: () => ({ ...header, items: [], note: "No automations yet.", noteTone: "muted" }),
        onNonEmpty: (listed) => ({
          ...header,
          items: Array.map(listed, (automation) =>
            link(
              automation.name,
              automationHref(automation.id),
              WorkflowIcon,
              isOpen(automation.id),
            ),
          ),
        }),
      }),
  });
};

/** What the studio lists under its entry in the hub's sidebar, with the open page marked. */
export const hubNavOf = (model: Model): HubNav => ({
  version: 1,
  navigation: "history",
  groups: [
    {
      items: [
        link("Overview", overviewHref, LayoutDashboard, Page.guards.Overview(model.page)),
        link(
          "Templates",
          templatesHref(Option.none()),
          FileText,
          Page.guards.Templates(model.page),
        ),
      ],
    },
    automationsGroup(model),
    {
      label: "Debug",
      items: [
        link(
          "Agent traces",
          tracesHref(Option.none(), Option.none()),
          ScrollText,
          Page.guards.Traces(model.page),
        ),
      ],
    },
  ],
});

/** Hands the shell `nav`: the global covers a shell that loads after the app. */
export const publishHubNav = (nav: HubNav) => {
  window.hubNav = nav;
  window.dispatchEvent(new CustomEvent("hub:nav", { detail: nav }));
};
