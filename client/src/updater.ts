/* 软件更新桥接层：tauri-plugin-updater 检查/安装 + plugin-process 重启的 TS 侧建模。
   结果收敛为联合类型（main.ts 只按 kind 渲染，不接触插件对象）。
   @tauri-apps 插件包一律动态 import（纪律同 harness.ts，非 Tauri 环境不静态引入）。 */

import { isTauri } from "./harness";

/** 一键检查+安装的结果：available = 已下载安装完成，待重启生效。 */
export type UpdaterOutcome =
  | { kind: "up-to-date" }
  | { kind: "available"; version: string }
  | { kind: "error"; message: string };

export async function checkAndInstall(): Promise<UpdaterOutcome> {
  if (!isTauri()) return { kind: "error", message: "软件更新需桌面应用环境" };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update === null) return { kind: "up-to-date" };
    const version = update.version;
    await update.downloadAndInstall();
    return { kind: "available", version };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** 启动时的静默检查：只报告不安装，安装动作留给用户在设置页决定。 */
export async function checkOnly(): Promise<UpdaterOutcome> {
  if (!isTauri()) return { kind: "error", message: "软件更新需桌面应用环境" };
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update === null) return { kind: "up-to-date" };
    return { kind: "available", version: update.version };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** 安装完成后重启应用以生效。 */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
