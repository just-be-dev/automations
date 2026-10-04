import { page } from "./page.ts";
export { AutomationAgent } from "./agent.ts";

interface Env {
  AUTOMATIONS: DurableObjectNamespace<import("./agent.ts").AutomationAgent>;
  API_TOKEN: ReturnType<StringConstructor>;
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET")
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        },
      });
    if (!env.API_TOKEN || request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`)
      return json({ error: "Unauthorized" }, 401);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      parts[0] !== "api" ||
      parts[1] !== "automations" ||
      !parts[2] ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(parts[2])
    )
      return json({ error: "Not found" }, 404);
    const agent = env.AUTOMATIONS.getByName(parts[2]);
    try {
      if (request.method === "GET" && parts.length === 3)
        return json(await agent.inspectWorkflow());
      if (request.method === "GET" && parts[3] === "runs" && parts[4] && parts.length === 5) {
        const run = await agent.run(parts[4]);
        return run ? json(run) : json({ error: "Run not found" }, 404);
      }
      if (
        request.method !== "POST" ||
        (parts.length !== 4 && !(parts.length === 5 && parts[3] === "events"))
      )
        return json({ error: "Not found" }, 404);
      if (Number(request.headers.get("content-length")) > 32_000)
        return json({ error: "Payload too large" }, 413);
      if (parts[3] === "save") return json(await agent.save());
      const body = (await request.json()) as { message?: string; input?: unknown };
      if (parts[3] === "events" && parts[4])
        return json(await agent.start(body.input ?? null, parts[4]), 202);
      if (parts[3] === "chat") return json(await agent.chat(body.message ?? ""));
      if (parts[3] === "start") return json(await agent.start(body.input ?? null), 202);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 400);
    }
  },
};
