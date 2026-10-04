import { defineConfig } from "oxlint";
import effect from "@mpsuesser/oxlint-plugin-effect";

export default defineConfig({
  jsPlugins: effect.configs.recommended.jsPlugins,
  rules: {
    "effect/avoid-non-null-assertion": "error",
    "effect/no-chained-type-assertions": "error",
    "effect/no-module-mocking": "error",
  },
});
