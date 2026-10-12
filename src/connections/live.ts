/** Which simulated-by-default connections this deployment has credentials for. */
import * as Context from "effect/Context";

/**
 * Connection IDs (such as `"slack"`) that the registry marks simulated but this deployment really
 * connects. The host provides it from its configuration; tests and other hosts default to none.
 * `GET /api/connections` serves it so the studio says "Simulated" only where it's true.
 */
export const LiveConnections = Context.Reference<ReadonlyArray<string>>(
  "automations/LiveConnections",
  { defaultValue: () => [] },
);
