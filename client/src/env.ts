/* 设置 · 环境分区的纯展示层：引擎检测卡与安装指引。
   无 DOM、无运行时 import，node 断言脚本可直接编译复用（纪律同 material.ts）。 */

/** 单引擎检测结果（camelCase 内域形状；Rust 回包是 snake_case 的 version_hint，
    invoke 侧的边界转换在 main.ts 做，纯模块只见 camelCase）。 */
export interface EngineEnvReport {
  engine: string;
  available: boolean;
  path: string | null;
  versionHint: string | null;
}

/** 缺失项的安装指引：pkg = 可代装的 npm 包名（引擎卡出一键安装钮）；npm 条目
    本身无命令可复制，只出一键装 Node（不做版本语义比较，显示原文即够判断）。 */
export const ENV_INSTALL_HINTS: Record<string, { label: string; pkg?: string; cmd: string; note: string }> = {
  pi: { label: "pi", pkg: "@mariozechner/pi-coding-agent", cmd: "npm install -g @mariozechner/pi-coding-agent", note: "需 ≥1.5（--mode rpc 协议在 1.5 重设计）" },
  dsh: { label: "dsh", pkg: "@deepseek-ai/dsh", cmd: "npm install -g @deepseek-ai/dsh", note: "prerelease 渠道 · node ≥24.9" },
  npm: { label: "npm", cmd: "", note: "Node.js ≥24.9 · 一键安装到应用私有目录（终端内使用需自行加 PATH）" },
};

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** 与 main.ts esc 同款（模块不引 DOM 侧符号，自带一份）。 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** 一引擎一卡：徽标行（READY/MISS + 引擎名 + 版本原文，缺失 —）→ 路径 mono 小字
    （缺失不出）→ 缺失且有指引时一键安装钮（data-env-install 委托，npm 未就绪的
    引擎卡置灰）+ 安装命令行 + 复制按钮（data-env-copy 委托）+ 门槛说明。
    npmReady 只在明确 false（npm 条目探测缺失）时置灰引擎卡；undefined 视为未知不拦。 */
export function envCardHTML(r: EngineEnvReport, opts?: { npmReady?: boolean }): string {
  const b = r.available ? { word: "READY", cls: "dn" } : { word: "MISS", cls: "fl" };
  const head = `<div class="hubline"><span class="st ${b.cls} mono">${b.word}</span><span class="lbl">${esc(r.engine)}</span><span class="mono">${r.versionHint ? esc(r.versionHint) : "—"}</span></div>`;
  const path = r.path === null ? "" : `<div class="hubline"><span class="mono">${esc(r.path)}</span></div>`;
  const hint = ENV_INSTALL_HINTS[r.engine];
  if (r.available || !hint) return head + path;
  // npm 卡无 pkg 无命令：只出「安装 Node」钮，不受 npmReady 影响（装的就是 Node 本身）
  if (hint.pkg === undefined) {
    return (
      head +
      path +
      `<div class="hubline"><button type="button" class="btn pri" data-env-install="node" title="约 30MB 下载 · 安装到应用私有目录">安装 Node</button></div><div class="setd">${esc(hint.note)}</div>`
    );
  }
  const blocked = opts?.npmReady === false;
  const installBtn = `<button type="button" class="btn pri" data-env-install="${esc(r.engine)}"${blocked ? ' disabled title="先安装 Node"' : ` title="npm install -g ${esc(hint.pkg)}"`}>安装</button>`;
  return (
    head +
    path +
    `<div class="hubline"><span class="mono">${esc(hint.cmd)}</span>${installBtn}<button type="button" class="btn sec" data-env-copy="${esc(r.engine)}" title="复制 ${esc(hint.label)} 安装命令">复制</button></div><div class="setd">${esc(hint.note)}</div>`
  );
}

/** 安装流式日志块：mono 一行一 div，超 50 行只留末 50（飞行日志上限同款节流）。 */
export function envLogHTML(lines: readonly string[]): string {
  const tail = lines.length > 50 ? lines.slice(-50) : lines;
  return `<div class="env-log mono">${tail.map((l) => `<div>${esc(l)}</div>`).join("")}</div>`;
}

/** 分区内容：null = 检测中占位；数组 = 逐卡（透传 npmReady）+ 尾部「重新检测」（重拉由 main.ts 委托）。 */
export function envAreaHTML(rs: EngineEnvReport[] | null, opts?: { npmReady?: boolean }): string {
  if (rs === null) return `<div class="setd">检测中…</div>`;
  return rs.map((r) => envCardHTML(r, opts)).join("") + `<div class="hubline"><button type="button" class="btn sec" id="env-recheck">重新检测</button></div>`;
}
