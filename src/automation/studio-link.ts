/** Knows where the studio is, so messages sent outside it can link back to a run. */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

/**
 * The studio's origin when the deployment configures one (`STUDIO_URL`). It wins over the origin
 * a save recorded. The Studio Worker binds the private Api, so neither can be given the other's
 * URL when the stack is planned; without this setting, the origin comes from the requests the
 * studio forwards.
 */
export const ConfiguredStudioOrigin = Context.Reference<string | null>(
  "automations/ConfiguredStudioOrigin",
  { defaultValue: () => null },
);

/**
 * The automation's own ID, and the studio origin its latest save came from, stored under `studio`
 * by save: a persisted contract. The automation's runs link to the studio with them.
 */
export const StudioLink = Schema.Struct({
  automationId: Schema.String,
  origin: Schema.optionalKey(Schema.String),
});
export interface StudioLink extends Schema.Schema.Type<typeof StudioLink> {}

export const STUDIO_LINK_KEY = "studio";

/** A URL's origin when it is an HTTP or HTTPS URL, such as a request's or `STUDIO_URL`. */
export const studioOrigin = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The studio page of one run, where its open tasks are answered: `/?automation=<id>&run=<runId>`. */
export const runUrl = (origin: string, automationId: string, runId: string) => {
  const url = new URL("/", origin);
  url.searchParams.set("automation", automationId);
  url.searchParams.set("run", runId);
  return url.toString();
};
