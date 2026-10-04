import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: { include: ["effect", "effect/http"] },
  resolve: { dedupe: ["effect", "foldkit"] },
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
