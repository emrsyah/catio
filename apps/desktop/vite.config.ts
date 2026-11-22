import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing so Rust logs stay visible.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Cargo owns src-tauri; watching target/ makes Vite crash with EBUSY mid-build.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: false,
    // Two pages: the pad, and the quick-capture field (which loads only @catio/core).
    rollupOptions: {
      input: { main: "index.html", capture: "capture.html" },
    },
  },
});
