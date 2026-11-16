/* R9-C 纯渲染件：
   C1 并答块列渲染（N 列 grid 类名 / 列脚注 / 转入钮 data 属性）、
   C2 搜索命中高亮、C3 MCP upstream 行三态。
   无 DOM、无运行时 import，node 断言直跑（纪律同 material.ts）。
   并答块的消息编排与流式 DOM 更新在 main.ts，这里只钉可观察形状。 */

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

/* ── C1 并答列 ── */

export const PARALLEL_MIN = 2;
export const PARALLEL_MAX = 4;

export type ParallelCellStatus = "streaming" | "done" | "error";

/** 并答块单列状态（流式/DOM 更新由 main.ts 驱动，本形状是渲染唯一真源）。 */
export interface ParallelCellView {
  key: string; // 列头模型键（托管=模型名 / BYOK=`byok:名字`）
  status: ParallelCellStatus;
  answer: string;
  error: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  startedAt: number;
  endedAt: number | null;
}

/** 列宽随列数自适应（2/3/4）；转入对话后剩 1 列也不回落 2 列空槽。 */
export function parallelColClass(n: number): string {
  const cols = Math.min(PARALLEL_MAX, Math.max(1, n));
  return `pcols-${cols}`;
}

function tokenK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 列脚注：完成后出耗时（+tokens，BYOK 上游不给 usage 则只出耗时）；
    流式中/失败不出（失败由列内 errline 承载，不塌整块）。 */
export function parallelFootLine(c: ParallelCellView): string {
  if (c.status !== "done" || c.endedAt === null) return "";
  const sec = ((c.endedAt - c.startedAt) / 1000).toFixed(1);
  const tk =
    c.usage !== null ? ` · ${tokenK(c.usage.promptTokens)}+${tokenK(c.usage.completionTokens)} tk` : "";
  return `${sec}s${tk}`;
}

/** 单列 HTML：列头（模型名 + 完成后「转入对话」）+ 流式正文 + errline + 脚注。
    bodyHTML 由调用方渲染（main.ts 走 renderContentHTML），纯模块不依赖 marked。 */
export function parallelCellHTML(c: ParallelCellView, blockId: number, idx: number, bodyHTML: string): string {
  const promote =
    c.status === "done"
      ? `<button type="button" class="mop" data-ppromote="${blockId}:${idx}">转入对话</button>`
      : "";
  const streaming = c.status === "streaming" ? " streaming" : "";
  const body = bodyHTML !== "" ? bodyHTML : c.status === "streaming" ? "…" : "—";
  const err = c.status === "error" ? `<div class="errline">${esc(c.error)}</div>` : "";
  const foot = parallelFootLine(c);
  return `<div class="pcol" data-pcell="${blockId}-${idx}"><div class="phead"><span class="n" title="${esc(c.key)}">${esc(c.key)}</span>${promote}</div><div class="bubble ai"><div class="b pbody${streaming}">${body}</div></div>${err}${foot !== "" ? `<div class="pfoot mono">${esc(foot)}</div>` : ""}</div>`;
}

/* ── C2 搜索命中高亮 ── */

/** snippet/标题命中词 <mark> 高亮：大小写不敏感、逐次非重叠匹配，保留原文
    大小写；无命中/空关键词返回纯转义文本（mark 只包命中段，全文一律转义）。 */
export function highlightSnippet(text: string, q: string): string {
  const needle = q.trim();
  if (needle === "") return esc(text);
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = lower.indexOf(n, i);
    if (at < 0) {
      out.push(esc(text.slice(i)));
      break;
    }
    out.push(esc(text.slice(i, at)), `<mark>${esc(text.slice(at, at + needle.length))}</mark>`);
    i = at + needle.length;
  }
  return out.join("");
}

/* ── C3 MCP upstream 行 ── */

/** MCP 行视图：tools=null 表示未设白名单（全部工具可见，server 语义）。 */
export interface McpRowView {
  name: string;
  enabled: boolean;
  tools: number | null;
  armed?: boolean; // 两步删除武装态（sessions.armClick 同款语义）
}

/** MCP upstream 行：状态点 + 名称 + 工具面 + （admin）启停/两步删除；
    非 admin 整行只读无操作钮（403 降级后由调用方传 admin=false）。 */
export function mcpRowHTML(v: McpRowView, admin: boolean): string {
  const dot = `<span class="dot${v.enabled ? "" : " off"}"></span>`;
  const tools = v.tools === null ? "全部工具" : `${v.tools} 工具`;
  const ops = admin
    ? `<span class="ops"><button type="button" class="mop" data-mcptoggle="${esc(v.name)}">${v.enabled ? "停用" : "启用"}</button><button type="button" class="mop del${v.armed ? " armed" : ""}" data-mcpdel="${esc(v.name)}">${v.armed ? "确认删" : "删除"}</button></span>`
    : "";
  return `<div class="mcprow">${dot}<span class="n" title="${esc(v.name)}">${esc(v.name)}</span><span class="u">${esc(tools)}</span>${ops}</div>`;
}
