/* 对话导出（R10-A A3）纯逻辑：会话 → Markdown 文本。翻页拉取循环与 Blob
   落盘在 main.ts，此处是折叠/成文/文件名三纯函数。无 DOM、无运行时 import
   （api.ts 仅 type-only，node 断言直跑同 sessions.ts 惯例）。 */

import type { ContentPart, MessageRow } from "./api.ts";

/** 翻页折叠：页内旧→新、页间新→旧（fetchMessagesPage 无 cursor=最新一页，
   cursor=更早一页），新页整段垫在已收集前；hasMore=false 或空页 → 停。
   nextCursor=当前最旧服务端 id（页内升序，rows[0] 即最小），undefined=拉全。 */
export function exportFoldPage(
  acc: MessageRow[],
  page: { rows: MessageRow[]; hasMore: boolean },
): { rows: MessageRow[]; nextCursor: number | undefined } {
  const rows = [...page.rows, ...acc];
  if (!page.hasMore || page.rows.length === 0) return { rows, nextCursor: undefined };
  return { rows, nextCursor: page.rows[0].id };
}

/** 消息内容导出：纯文本原文；vision parts 文本段原样、图片段 `[图片]` 占位
    （不嵌 base64）。 */
function contentOf(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "[图片]")).join("\n\n");
}

const two = (n: number): string => String(n).padStart(2, "0");

/** 会话 → Markdown：`# 标题` + 导出时间行；每条 `## 我`（user）/ `## 模型名`
    （空名回落 assistant）+ content 原文；空会话仅标题与时间。并答/资料折叠
    条等是本地渲染态不落库，导出的即 hub 落库内容。 */
export function sessionToMarkdown(title: string, rows: MessageRow[], now = new Date()): string {
  const head = `# ${title}\n\n> 导出于 ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  if (rows.length === 0) return `${head}\n`;
  const body = rows
    .map((m) => `## ${m.role === "user" ? "我" : m.modelName || "assistant"}\n\n${contentOf(m.content)}`)
    .join("\n\n");
  return `${head}\n\n${body}\n`;
}

/** 落盘文件名：标题替换 Windows 非法字符（\ / : * ? " < > |）与控制字符为
    _，空/纯非法回落「未命名会话」。 */
export function exportFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return `${base === "" ? "未命名会话" : base}.md`;
}
