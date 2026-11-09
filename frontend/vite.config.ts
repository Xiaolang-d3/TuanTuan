import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Defaults keep the dev server on loopback. Set BIND_HOST=0.0.0.0 plus
// PUBLIC_HOSTS=<lan-ip-or-hostname> to expose it to other devices on purpose.
const devHost = process.env.BIND_HOST?.trim() || "127.0.0.1";
const allowedHosts = [
  "127.0.0.1",
  "localhost",
  ...(process.env.PUBLIC_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.mjs"]
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("/node_modules/react/")
            || id.includes("/node_modules/react-dom/")
            || id.includes("/node_modules/scheduler/")
          ) {
            return "react";
          }
          if (id.includes("@assistant-ui")) return "assistant-ui";
          if (id.includes("@ag-ui")) return "ag-ui";
          if (
            id.includes("react-markdown")
            || id.includes("remark-gfm")
            || id.includes("micromark")
            || id.includes("mdast")
          ) {
            return "markdown";
          }
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    host: devHost,
    // Only hosts named in PUBLIC_HOSTS may reach the dev server by name.
    allowedHosts: allowedHosts,
    // Keep the backend on the development machine. Phones use the same Vite
    // origin and Vite forwards API traffic locally, avoiding LAN CORS issues.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyRes", (response) => {
            // Preserve the job-specific cookie scope after the /api rewrite.
            const cookies = response.headers["set-cookie"];
            if (cookies) response.headers["set-cookie"] = cookies.map(cookie => cookie.replace(
              /(;\s*Path=)(\/presentations\/[a-f0-9]{32}\/confirmation)(?=;|$)/i, "$1/api$2"));
          });
        },
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  preview: {
    port: 4173,
    host: devHost,
    allowedHosts: allowedHosts
  }
});
