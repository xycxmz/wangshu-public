import { defineConfig } from "vite";

// Tauri 推荐配置：clearScreen 保留 Rust 编译输出；strictPort 保证 devUrl 固定；
// envPrefix 只放行 TAURI_ 前缀的环境变量进入前端代码。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: "TAURI_",
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: "esbuild",
    sourcemap: false,
  },
});
