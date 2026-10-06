import type { HtmlBuilder } from "foldkit/html";
import { CalendarDays, Mail, MessageSquare, Webhook } from "lucide";
import { badge } from "@/components/ui/badge";
import { componentName } from "@/lib/component";
import type { icon } from "@/lib/icons";
import { connectionOf, findOperation } from "../../connections.ts";
import type { Message } from "../message.ts";

export type IconNode = Parameters<typeof icon>[1];

const connectionIcon: Readonly<Record<string, IconNode>> = {
  email: Mail,
  slack: MessageSquare,
  calendar: CalendarDays,
  http: Webhook,
};

export const operationIcon = (operationId: string): IconNode =>
  connectionIcon[connectionOf(operationId)?.id ?? ""] ?? Webhook;

export const operationTitle = (operationId: string) =>
  findOperation(operationId)?.title ?? operationId;

export const isSimulated = (operationId: string) => connectionOf(operationId)?.simulated === true;

export const tagView = (label: string, h: HtmlBuilder<Message>) =>
  badge(
    {
      variant: "secondary",
      className: "h-4 px-1.5 text-[10px]",
      attributes: [componentName("tag")],
    },
    [label],
    h,
  );

export const simulatedTagView = (h: HtmlBuilder<Message>) => tagView("Simulated", h);
