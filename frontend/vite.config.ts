import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发/preview 把 /api 代理到 FastAPI。默认 8000；本机被占用时可设 GVCSIM_API_PROXY。
const apiOrigin = process.env.GVCSIM_API_PROXY ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
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
