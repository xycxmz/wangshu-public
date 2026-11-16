/* 任务终态托盘通知（B4，roadmap-r4）：仅在窗口不可见（隐藏到托盘/最小化，
   document.hidden 为真）时发系统通知——盯屏时不打扰。插件初始化在 Rust 侧
   （tauri-plugin-notification）；权限动态请求尽力而为，失败只 console.warn，
   不影响任务流。浏览器降级环境无插件宿主，import 抛错同被吞掉。 */

export async function notifyTaskDone(title: string, body: string): Promise<void> {
  if (!document.hidden) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch (e) {
    console.warn("[notify] 通知发送失败", e);
  }
}
