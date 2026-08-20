import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

/**
 * The page, built once and served from two places.
 *
 * `base: "./"` because the hosted copy may sit under a path (an nsite, a
 * subdirectory) while the loopback copy is served from the root — an absolute
 * asset URL works in exactly one of those.
 *
 * The dev server proxies the API to a `hex serve --ui` on the default port, so
 * `npm run dev` in this directory is a live control plane rather than a mock.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwind()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 1779,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:1778",
        changeOrigin: true,
        // Server-sent events die in a buffering proxy.
        configure: (proxy) => {
          proxy.on("proxyRes", (res) => {
            res.headers["x-accel-buffering"] = "no";
          });
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
