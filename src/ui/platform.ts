/** Chooses the browser platform's modifier key for submitting text without losing plain Enter for newlines. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The key held with Enter to submit a textarea: ⌘ on Apple platforms, Ctrl everywhere else. */
export const ShortcutModifier = Schema.Literals(["Meta", "Control"]);
export type ShortcutModifier = typeof ShortcutModifier.Type;

const applePlatform = /mac|iphone|ipad|ipod/i;

/** Reads the browser's platform. Browsers that don't report one get Ctrl. */
export const loadShortcutModifier: Effect.Effect<ShortcutModifier> = Effect.try(() => {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return applePlatform.test(platform) ? ("Meta" as const) : ("Control" as const);
}).pipe(Effect.orElseSucceed((): ShortcutModifier => "Control"));
