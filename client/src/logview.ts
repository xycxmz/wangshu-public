/* 飞行日志行渲染（纯字符串逻辑：无 DOM、无运行时 import，
   node 断言脚本 scripts/reload.test.ts 可直接编译复用）。 */

/** HTML 转义（仓内惯例：纯模块各持私有 esc，同 desktop-only/dsh/engine）。 */
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

/** Rust 侧 log 行形如 "T+00:41 TOOL write docs/x.md · 进入 HOLD 待审批"，拆 stamp/事件词/余文。
    终态行词汇：SYS 完成（绿）/ ERR …（红）/ SYS 用户中止（muted）。 */
export function logRowHTML(line: string, durSec?: number): string {
  const m = /^(T\+\d{2,}:\d{2})(?:\s+(.*))?$/.exec(line);
  const stamp = m !== null ? m[1] : "--:--";
  const body = m !== null ? (m[2] ?? "") : line;
  const tone = /^ERR /.test(body)
    ? " fail"
    : /^SYS 完成/.test(body)
      ? " ok"
      : /^SYS 用户中止/.test(body)
        ? " off"
        : /^TOOL (read|list) /.test(body)
          ? " ok"
          : /^TOOL write /.test(body)
            ? " holdline"
            : "";
  const w = /^(TOOL (?:read|write|list)|\S+)(?:\s+(.*))?$/.exec(body);
  const evt = w !== null ? w[1] : body;
  const rest = w !== null && w[2] ? ` ${w[2]}` : "";
  const dur =
    durSec === undefined
      ? ""
      : `<span class="dur">${durSec >= 60 ? `${Math.floor(durSec / 60)}m${String(durSec % 60).padStart(2, "0")}s` : `${durSec}s`}</span>`;
  return `<div class="row"><span class="tstamp">${esc(stamp)}</span><span class="evt${tone}"><b>${esc(evt)}</b>${esc(rest)}</span>${dur}</div>`;
}

/** 日志行批渲染：相邻 T+ 戳差分出每步时长（首行无前驱不标）。 */
export function renderLogRows(logs: readonly string[]): string {
  const sec = (l: string): number | null => {
    const m = /^T\+(\d{2,}):(\d{2})/.exec(l);
    return m !== null ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  return logs
    .map((l, i) => {
      if (i === 0) return logRowHTML(l);
      const cur = sec(l);
      const prev = sec(logs[i - 1]);
      return logRowHTML(l, cur !== null && prev !== null && cur >= prev ? cur - prev : undefined);
    })
    .join("");
}
