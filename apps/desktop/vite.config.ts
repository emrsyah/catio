import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing so Rust logs stay visible.
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
