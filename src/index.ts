export { AutomationAgent } from "./agent.ts";

export default {
  fetch() {
    return new Response("Automations setup ready");
  },
};
