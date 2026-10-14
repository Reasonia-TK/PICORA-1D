/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1425,
    strictPort: true,
    host: "127.0.0.1",
    // Rust のビルド成果物は監視しない。Windows の実行ファイルロックも避ける。
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
  test: { pool: "threads", include: ["tests/**/*.test.ts"] },
});
