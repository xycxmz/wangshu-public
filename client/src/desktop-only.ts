/* 浏览器降级态统一帮助层（ui-review 2026-11-12 P1-9/P1-12）。
   desktopOnlyNote 统一五处降级文案（内置 tab / 资产页 / 设置页横幅 / DSH / PI）：
   前缀「桌面应用 · 」+ feature + 可选 hint，一种句式一种形态。
   demoTagHTML / asideEmptyText 是浏览器演示态自洽文案。
   纯字符串输出、零 DOM 依赖，node 原生剥类型断言直接覆盖（scripts/reload.test.ts 惯例）。 */

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** 桌面专属能力的降级提示：一个 .env-note，前缀「桌面应用 · 」+ feature + 可选 hint。 */
export function desktopOnlyNote(feature: string, hint?: string): string {
  const tail = hint !== undefined && hint !== "" ? ` · ${esc(hint)}` : "";
  return `<div class="env-note">桌面应用 · ${esc(feature)}${tail}</div>`;
}

/** 浏览器态静态演示的诚实标注（kicker 行尾 mono 小字）。演示体只在浏览器态渲染，无桌面分支。 */
export function demoTagHTML(): string {
  return `<span class="demo-tag">示例 · 不可交互</span>`;
}

/** 任务列空态文案：浏览器态补一句示例数据边界，桌面态原样。
    桌面态 9 字版在 ≤1320 媒体段实测断行（空态是 2 列网格里的 107px 单格，P2-17），
    缩为 6 字单行。 */
export function asideEmptyText(inTauri: boolean): string {
  return inTauri ? "尚未发起任务" : "尚未发起任务（示例数据不进任务列）";
}
