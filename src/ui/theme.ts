import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { loadShortcutModifier, ShortcutModifier } from "./platform.ts";

/** The color theme the user picked. `System` follows the OS setting. */
export const Theme = Schema.Literals(["System", "Light", "Dark"]);
export type Theme = typeof Theme.Type;

/** What the studio boots with: the theme saved by an earlier visit, and the platform's shortcut key. */
export const Flags = Schema.Struct({ theme: Theme, shortcutModifier: ShortcutModifier });
export type Flags = typeof Flags.Type;

// NOTE: `public/theme.js` reads this key and these values before the app boots, so the first paint
// already has the right theme. Keep the two in sync.
const storageKey = "theme";
const attributeValue: Record<Theme, string | undefined> = {
  System: undefined,
  Light: "light",
  Dark: "dark",
};

const themeFromStorage = (value: string | null): Theme =>
  value === "light" ? "Light" : value === "dark" ? "Dark" : "System";

/** The order the header toggle steps through. */
export const nextTheme: Record<Theme, Theme> = { System: "Light", Light: "Dark", Dark: "System" };

/** Reads the saved theme. Storage can be unavailable (private browsing), so that means `System`. */
const loadTheme: Effect.Effect<Theme> = Effect.try(() => localStorage.getItem(storageKey)).pipe(
  Effect.orElseSucceed(() => null),
  Effect.map(themeFromStorage),
);

export const loadFlags: Effect.Effect<Flags> = Effect.all({
  theme: loadTheme,
  shortcutModifier: loadShortcutModifier,
});

/**
 * Sets `data-theme` on the document, which `styles.css` reads, then saves the choice. The theme
 * still applies for this visit when storage is unavailable.
 */
export const applyTheme = (theme: Theme): Effect.Effect<void> => {
  const value = attributeValue[theme];
  return Effect.sync(() => {
    if (value === undefined) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = value;
    }
  }).pipe(
    Effect.andThen(
      Effect.try(() =>
        value === undefined
          ? localStorage.removeItem(storageKey)
          : localStorage.setItem(storageKey, value),
      ),
    ),
    Effect.ignore,
  );
};
