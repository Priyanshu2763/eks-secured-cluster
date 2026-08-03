import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false, // don't ship source maps to a public origin
  },
  server: {
    port: 5173,
    /**
     * Local development only. In deployment the browser talks to API Gateway
     * on a different origin (api.<DOMAIN>) and there is no proxy — the SPA is
     * served as static files by nginx, which does not forward /api anywhere.
     *
     * This proxy exists so that during development you get same-origin
     * requests and can leave CORS off, matching production behaviour instead
     * of only discovering CORS problems after deploying.
     */
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
