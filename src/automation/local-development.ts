/** Says whether this studio runs on a developer's machine, which unlocks development-only controls. */
import * as Context from "effect/Context";

/**
 * True only under local development (`alchemy dev` on a `dev_` stage). Development-only operations,
 * such as resuming a waiting run now, refuse without it, and `GET /api/dev` serves it so the studio
 * shows their controls only where they work. The host provides it from its configuration; deployed
 * stages, tests and other hosts default to false.
 */
export const LocalDevelopment = Context.Reference<boolean>("automations/LocalDevelopment", {
  defaultValue: () => false,
});
