import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";

// Alchemy runs Vite for the Studio Worker (`Cloudflare.Website.Foldkit` in alchemy.run.ts) and layers
// its Cloudflare integration on top of this config, in both `alchemy dev` and `alchemy deploy`.
export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: { entries: ["src/ui/entry.ts"], include: ["effect", "effect/http"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: { watch: { ignored: ["**/.alchemy/**"] } },
});
