/** Gives entity names, times, and run statuses consistent readable wording and visual cues across the UI. */
import type { RunStatus } from "../../workflow.ts";

export const withArticle = (entityType: string) => {
  const noun = entityType.replaceAll("_", " ");
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
};

/** `start_date` → `Start date`. */
export const labelFromName = (name: string) => {
  const words = name.trim().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const snakeCaseId = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);

export const formatTime = (millis: number) =>
  new Date(millis).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** A time a few days off, with its weekday: "Thu, Nov 5, 10:00 AM". */
export const formatWeekdayTime = (millis: number) =>
  new Date(millis).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export const openTasksText = (count: number) =>
  count === 1 ? "1 open task" : `${count} open tasks`;

export const runStatusLabel: Record<RunStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

export const runStatusClass: Record<RunStatus, string> = {
  running: "text-signal",
  waiting: "text-sand-11",
  completed: "text-success",
  failed: "text-destructive",
  stopped: "text-foreground",
};

export const runDotClass: Record<RunStatus, string> = {
  running: "animate-pulse bg-signal",
  waiting: "bg-sand-10",
  completed: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-foreground",
};
