import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: { include: ["effect", "effect/http"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: {
    // `alchemy dev` sets API_ORIGIN to the local Worker it starts.
    proxy: { "/api": process.env.API_ORIGIN ?? "http://127.0.0.1:8787" },
    watch: { ignored: ["**/.alchemy/**"] },
  },
});
