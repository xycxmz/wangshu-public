/* 素材任务的纯展示/聚合逻辑：无 DOM、无运行时 import（api 仅 type import），
   node 断言脚本可直接编译复用。 */

import type { MaterialKind, MaterialStatus, UsageRow } from "./api";

/** 任务列状态字：pending/running→RUN、succeeded→DONE、failed→FAIL（色类沿用 .run/.dn/.fl）。 */
export function materialBadge(status: MaterialStatus): { word: string; cls: string } {
  if (status === "succeeded") return { word: "DONE", cls: "dn" };
  if (status === "failed") return { word: "FAIL", cls: "fl" };
  return { word: "RUN", cls: "run" };
}

/** @生图 前缀解析（R9-B B1，与 @agent 的 startsWith 宽松度一致）：
    `@生图视频 <描述>`=video、`@生图 <描述>`=image；非本路由（无前缀）返回
    null 交回对话路径；前缀命中但描述为空返回空 prompt，由调用方出用法提示。 */
export interface AtImageCommand {
  kind: MaterialKind;
  prompt: string;
}

export function parseAtImage(text: string): AtImageCommand | null {
  if (!text.startsWith("@生图")) return null;
  // 视频前缀先判：@生图 是 @生图视频 的前缀
  if (text.startsWith("@生图视频")) return { kind: "video", prompt: text.slice(5).trim() };
  return { kind: "image", prompt: text.slice(3).trim() };
}

/** 素材卡标题：prompt 空白折叠后取前 20 字，超长补省略号。 */
export function materialTitle(prompt: string): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length <= 20 ? t : t.slice(0, 20) + "…";
}

/** 卡内失败行：error 取首行并截 48 字（errline 单行纪律）。 */
export function materialErrLine(error: string): string {
  const first = error.split("\n")[0].replace(/\s+/g, " ").trim();
  return first.length <= 48 ? first : first.slice(0, 48) + "…";
}

/** created_at 短格式：今天 HH:MM，跨天 MM-DD HH:MM（本地时区，mono 时刻侧）。 */
export function materialTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 素材面板空态示例 prompt（Mission Report 世界观，代码自有常量无需转义）。 */
export const MATERIAL_EXAMPLE_PROMPTS: readonly string[] = [
  "冷白纸面上的任务报告封面",
  "信号橙仪表盘特写，1px 规则线构图",
  "午夜蓝调度台全景，等宽字体读数",
];

/** 一行式示例 chip：main.ts 以 data-mat-example 委托点击，填入 PROMPT 输入框。 */
export function materialExampleChipsHTML(): string {
  return MATERIAL_EXAMPLE_PROMPTS.map(
    (p) => `<button type="button" class="mat-example" data-mat-example="${p}">${p}</button>`,
  ).join("");
}

export interface MaterialUsage {
  imageReqs: number;
  videoReqs: number;
  costCents: number;
}

/** usage 行中 material:* 聚合：图/视频各计 requests 之和，cost 累计 cents（其余 model 忽略）。 */
export function materialUsageOf(rows: UsageRow[]): MaterialUsage {
  const out: MaterialUsage = { imageReqs: 0, videoReqs: 0, costCents: 0 };
  for (const r of rows) {
    if (r.modelName === "material:image") out.imageReqs += r.requests;
    else if (r.modelName === "material:video") out.videoReqs += r.requests;
    else continue;
    out.costCents += r.costCents;
  }
  return out;
}

/** 任务列底部一行汇总：「素材 · 图 N / 视频 M · ¥X.XX」。 */
export function materialUsageLine(u: MaterialUsage): string {
  return `素材 · 图 ${u.imageReqs} / 视频 ${u.videoReqs} · ¥${(u.costCents / 100).toFixed(2)}`;
}
