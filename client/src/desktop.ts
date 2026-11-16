/* 桌面常规件桥接层：开机自启状态回读/开关（tauri-plugin-autostart）。
   托盘与全局快捷键在 Rust 侧装配（src-tauri/src/desktop.rs），前端不触达命令，
   TOGGLE_SHORTCUT 仅为 Rust 常量的展示副本（两侧同步修改）。
   @tauri-apps 插件包一律动态 import（纪律同 updater.ts，非 Tauri 环境不静态引入）。 */

import { isTauri } from "./harness";

/** Rust desktop.rs TOGGLE_SHORTCUT 的展示副本：全局显示/隐藏主窗口。 */
export const TOGGLE_SHORTCUT = "Alt+Shift+P";

/** 开机自启当前状态（Windows=HKCU Run 注册表项）。非 Tauri 环境返回 null，调用方按不可用渲染。 */
export async function autostartIsEnabled(): Promise<boolean | null> {
  if (!isTauri()) return null;
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

/** 开机自启开关；失败抛出，由调用方落 errline（同 byok.ts 风格）。 */
export async function setAutostart(enabled: boolean): Promise<void> {
  const { enable, disable } = await import("@tauri-apps/plugin-autostart");
  if (enabled) await enable();
  else await disable();
}
