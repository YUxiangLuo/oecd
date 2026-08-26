import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发/preview 把 /api 代理到 FastAPI。默认 8000；本机被占用时可设 GVCSIM_API_PROXY。
const apiOrigin = process.env.GVCSIM_API_PROXY ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React is shared by the main course UI and the lazy report renderer.
        // Keep it in a stable vendor chunk so the application entry stays below
        // Vite's large-chunk warning threshold and can be cached independently.
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/");
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(normalized)) {
            return "react-vendor";
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": apiOrigin,
    },
  },
  // CI browser smoke runs the compiled bundle through `vite preview`; keep its
  // same-origin API behavior aligned with development and the production Nginx route.
  preview: {
    proxy: {
      "/api": apiOrigin,
    },
  },
});
