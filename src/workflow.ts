export type Step =
  | { id: string; title: string; kind: "agent"; instruction: string }
  | { id: string; title: string; kind: "webhook"; url: string };

export interface Workflow {
  name: string;
  event: string | null;
  steps: Step[];
}

export function parseWorkflow(value: unknown): Workflow {
  if (!value || typeof value !== "object") throw new Error("Invalid workflow");
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120)
    throw new Error("A name is required (maximum 120 characters)");
  if (
    input.event !== null &&
    (typeof input.event !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(input.event))
  )
    throw new Error("Event must be null or an identifier");
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20)
    throw new Error("A workflow needs 1–20 steps");
  const ids = new Set<string>();
  const steps: Step[] = input.steps.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid step");
    const step = raw as Record<string, unknown>;
    if (typeof step.id !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(step.id) || ids.has(step.id))
      throw new Error("Step IDs must be unique identifiers");
    ids.add(step.id);
    if (typeof step.title !== "string" || !step.title.trim() || step.title.length > 120)
      throw new Error("A step title is required");
    if (
      step.kind === "agent" &&
      typeof step.instruction === "string" &&
      step.instruction.trim() &&
      step.instruction.length <= 4000
    )
      return { id: step.id, title: step.title, kind: "agent", instruction: step.instruction };
    if (step.kind === "webhook" && typeof step.url === "string") {
      const url = new URL(step.url);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
          url.hostname,
        )
      )
        return { id: step.id, title: step.title, kind: "webhook", url: url.href };
    }
    throw new Error("Step must be an agent instruction or a public HTTPS webhook");
  });
  return { name: input.name, event: input.event as string | null, steps };
}

export function graph(workflow: Workflow) {
  return {
    nodes: [
      {
        id: "trigger",
        title: workflow.event ? `Event: ${workflow.event}` : "Manual start",
        kind: "trigger",
      },
      ...workflow.steps.map(({ id, title, kind }) => ({ id, title, kind })),
    ],
    edges: workflow.steps.map((step, index) => ({
      from: workflow.steps[index - 1]?.id ?? "trigger",
      to: step.id,
    })),
  };
}

export function parseDraft(text: string): { reply: string; workflow: Workflow } {
  const clean = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const value = JSON.parse(clean) as { reply: string; workflow: unknown };
  if (typeof value.reply !== "string" || !value.reply.trim())
    throw new Error("Agent did not provide a reply");
  return { reply: value.reply, workflow: parseWorkflow(value.workflow) };
}
