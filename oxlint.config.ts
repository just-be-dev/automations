import { defineConfig } from "oxlint";
import effect from "@mpsuesser/oxlint-plugin-effect";

export default defineConfig({ extends: [effect.configs.recommended] });
