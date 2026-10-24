/** Configures the Foldkit browser build; Alchemy layers Cloudflare hosting onto it in dev and deploy. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// NOTE: One build serves at `/` on the studio's own host and under `/automations/` or
// `/automations@<stage>/` on the hub, so asset URLs are relative to the page's `<base>`
// (src/ui/base-path.ts).
export default defineConfig({
  base: "./",
  plugins: [foldkit(), tailwindcss()],
  optimizeDeps: { entries: ["src/ui/entry.ts"], include: ["effect", "effect/http"] },
  resolve: {
    alias: { "@/": fileURLToPath(new URL("./src/ui/", import.meta.url)) },
    dedupe: ["effect", "foldkit"],
  },
  server: { watch: { ignored: ["**/.alchemy/**"] } },
});
