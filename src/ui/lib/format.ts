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

export const formatTime = (millis: number) =>
  new Date(millis).toLocaleString("en-US", {
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
