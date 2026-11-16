/* 重载窗口恢复的纯判定（R5-A-①）。WebView 重载期间终态事件发给旧页、
   在跑任务既不进 tasks 表（终态才写）也不在新页内存——两条恢复路径
   （harness 事件重放 / hub 素材列表重建）共用这里的判定，抽出成纯函数
   便于 node 断言（client/scripts/reload.test.ts）。 */

import type { MaterialStatus, MaterialTask } from "./api";

/** 素材任务是否仍在走（pending/running）。main.ts 的 materialInProgress
    委托到此，单一归属。 */
export function isMaterialInProgress(status: MaterialStatus): boolean {
  return status === "pending" || status === "running";
}

/** 终态是否弹托盘通知：只有本页亲见的 live→终态迁移才弹。重放/重建
    载荷的迁移发生在页面缺席期间（历史行），不弹——否则一次重放可连发
    多条过期通知。 */
export function shouldNotifyOnTransition(prevLive: boolean, nowLive: boolean, replayed: boolean): boolean {
  return prevLive && !nowLive && !replayed;
}

/** hub 最近任务列表 → 需重建进轮询的条目：仅仍在走（真源没终态）且
    不在本地 map（本页已在跟的不重复建）。终态条目由本地历史
    （loadTaskHistory）负责，不在此列。 */
export function pickRebuildMaterialTasks(
  rows: readonly MaterialTask[],
  knownIds: ReadonlySet<string>,
): MaterialTask[] {
  return rows.filter((t) => isMaterialInProgress(t.status) && !knownIds.has(t.id));
}
