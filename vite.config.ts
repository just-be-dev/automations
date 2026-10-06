/** Configures the Foldkit browser build; Alchemy layers Cloudflare hosting onto it in dev and deploy. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [foldkit(), tailwindcss()],
  optimizeDeps: { entries: ["src/ui/entry.ts"], include: ["effect", "effect/http"] },
  resolve: {
    alias: { "@/": fileURLToPath(new URL("./src/ui/", import.meta.url)) },
    dedupe: ["effect", "foldkit"],
  },
  server: { watch: { ignored: ["**/.alchemy/**"] } },
});
