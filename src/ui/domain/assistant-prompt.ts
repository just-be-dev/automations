/**
 * What the studio puts in the hub assistant's composer when it hands the person over (`hub:open`
 * with a prompt). The person finishes the sentence and sends it; the assistant designs through
 * automations' MCP tools.
 */

/** For New automation. */
export const newAutomation = "Create a new automation that ";

/** For an automation without a draft yet, naming it so the assistant drafts that one. */
export const draft = (automationId: string) => `Draft the automation ${automationId} so that `;
