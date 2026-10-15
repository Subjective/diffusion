import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const engine = process.env.DIFFUSION_ENGINE ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": { target: engine, changeOrigin: false } } },
  test: { environment: "jsdom", globals: true, setupFiles: ["src/test/setup.ts"] },
});
