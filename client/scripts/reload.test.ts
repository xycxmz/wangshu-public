/* 重载恢复纯逻辑的 node 断言（R5-A-①）。node 24 原生剥类型直接跑：
     node scripts/reload.test.ts
   不进 vite/tsc 构建（tsconfig include 仅 src），属于本地验证脚本。 */

import assert from "node:assert/strict";
import {
  isMaterialInProgress,
  pickRebuildMaterialTasks,
  shouldNotifyOnTransition,
} from "../src/reload.ts";
import { renderLogRows } from "../src/logview.ts";
import type { MaterialStatus, MaterialTask } from "../src/api.ts";

const task = (id: string, status: MaterialStatus): MaterialTask => ({
  id,
  kind: "image",
  prompt: `p-${id}`,
  status,
  resultUrl: "",
  error: "",
  createdAt: "2026-11-12T00:00:00Z",
});

/* shouldNotifyOnTransition：只有本页亲见的 live→终态迁移才弹。 */
assert.equal(shouldNotifyOnTransition(true, false, false), true, "live transition notifies");
assert.equal(
  shouldNotifyOnTransition(true, false, true),
  false,
  "replayed transition stays silent",
);
assert.equal(shouldNotifyOnTransition(true, true, false), false, "still live never notifies");
assert.equal(shouldNotifyOnTransition(false, false, false), false, "already terminal never notifies");

/* pickRebuildMaterialTasks：只重建「仍在走且本页未知」的条目，顺序保持。 */
const rows = [
  task("a", "pending"),
  task("b", "succeeded"),
  task("c", "running"),
  task("d", "failed"),
];
const known = new Set(["c"]);
assert.deepEqual(
  pickRebuildMaterialTasks(rows, known).map((t) => t.id),
  ["a"],
  "terminal rows skipped, known ids skipped, in-flight unknown kept",
);
assert.deepEqual(pickRebuildMaterialTasks([], known), [], "empty list rebuilds nothing");
assert.deepEqual(
  pickRebuildMaterialTasks(rows, new Set()).map((t) => t.id),
  ["a", "c"],
  "empty map rebuilds every in-flight row in order",
);

/* isMaterialInProgress 与状态字面量对齐。 */
assert.equal(isMaterialInProgress("pending"), true);
assert.equal(isMaterialInProgress("running"), true);
assert.equal(isMaterialInProgress("succeeded"), false);
assert.equal(isMaterialInProgress("failed"), false);

/* renderLogRows（R6-A#4）：相邻 T+ 戳差分时长 + 终态色。 */
{
  const html = renderLogRows([
    "T+00:41 TOOL read docs/x.md",
    "T+00:44 TOOL write docs/x.md · 进入 HOLD 待审批",
    "T+06:20 ERR 上游 429",
    "无戳行",
  ]);
  const firstRow = html.split('<div class="row">')[1] ?? "";
  assert.ok(!firstRow.includes('class="dur"'), "首行无前驱不标时长");
  assert.ok(html.includes('<span class="dur">3s</span>'), "相邻 3s 差分");
  assert.ok(html.includes('<span class="dur">5m36s</span>'), "跨分钟差分 5m36s");
  assert.ok(html.includes('class="evt fail"'), "ERR 行落 fail 红");
  assert.ok(html.includes('class="evt ok"'), "TOOL read 行落 ok 绿");
  assert.ok(html.includes('class="evt holdline"'), "TOOL write 行落 holdline 橙");
  assert.ok(html.includes("--:--"), "无 T+ 戳的行落占位戳且不炸");
  const done = renderLogRows(["SYS 完成 · 全部写入"]);
  assert.ok(done.includes('class="evt ok"'), "SYS 完成 落 ok 绿");
  const abort = renderLogRows(["SYS 用户中止"]);
  assert.ok(abort.includes('class="evt off"'), "SYS 用户中止 落 off muted");
}

console.log("reload.test.ts: all assertions passed");
