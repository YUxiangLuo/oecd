import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";

// 开发/preview 把 /api 代理到 FastAPI。默认 8000；本机被占用时可设 GVCSIM_API_PROXY。
const apiOrigin = process.env.GVCSIM_API_PROXY ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React is shared by the shell, lazy teacher workspace, labs and report renderer.
        // Keep this stable runtime independently cacheable.
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
    fs: {
      allow: [
        searchForWorkspaceRoot(fileURLToPath(new URL(".", import.meta.url))),
        // The manual lives beside the technical documentation, outside frontend/.
        fileURLToPath(new URL("../实验手册.pdf", import.meta.url)),
      ],
    },
    proxy: {
      "/api": apiOrigin,
    },
  },
  // Local browser smoke runs the compiled bundle through `vite preview`; keep its
  // same-origin API behavior aligned with development and the production Nginx route.
  preview: {
    proxy: {
      "/api": apiOrigin,
    },
  },
});
