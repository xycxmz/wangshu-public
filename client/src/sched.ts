/* R10-B B2/B3 定时任务与任务模板纯逻辑：
   无 DOM、无运行时 import，node 断言脚本直跑（同 prompts.ts 惯例）。
   调用与存储面在 main.ts——schedules 走 Rust 命令（schedule_list/save/
   toggle/delete，字段 snake_case 与 Rust 表逐字对齐）；模板走 prefs
   "task.templates"（Tauri）/localStorage（浏览器兜底，同 prompts 先例）。 */

export type SchedKind = "interval" | "daily";
export type SchedStatus = "ok" | "fail" | "running" | "idle";

/** schedules 行（schedule_list 回包视图，字段与 src-tauri ScheduleRow 逐字对齐）。
    value 恒 string：interval=分钟数字串（"30"）、daily="HH:MM"；next_run/last_run
    为 unix 秒（last_run null=未跑过）；last_status null=未跑过按 idle 呈现；
    webhookUrl 缺失/空串=不推送（R11-S1）。 */
export interface ScheduleRow {
  id: string;
  name: string;
  kind: SchedKind;
  value: string;
  goal: string;
  workdir: string;
  enabled: boolean;
  webhookUrl: string;
  next_run: number | null;
  last_run: number | null;
  last_status: SchedStatus;
  last_task_id: string | null;
}

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

/** 计划人类可读：interval=「每 N 分钟」、daily=「每天 HH:MM」（纯展示，坏值原样带出）。 */
export function fmtSchedulePlan(kind: SchedKind, value: string): string {
  return kind === "daily" ? `每天 ${value}` : `每 ${value} 分钟`;
}

/** 上次状态徽标（materialBadge 形态）：ok 绿/run、fail 红/fl、running 橙/hd、idle 灰/dn。 */
export function schedBadge(status: SchedStatus): { word: string; cls: string } {
  if (status === "ok") return { word: "OK", cls: "run" };
  if (status === "fail") return { word: "FAIL", cls: "fl" };
  if (status === "running") return { word: "RUN", cls: "hd" };
  return { word: "IDLE", cls: "dn" };
}

/** unix 秒 → 本地短时刻：今天 HH:MM，跨天 MM-DD HH:MM，null/非数占位 —（materialTime 同款边界）。 */
export function schedTime(sec: number | null, now = new Date()): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** 表单 value 域校验（按 kind 切换，与 Rust next_after 同界）：interval=≥1 的
    整数分钟（去前导零归一，如 030 → "30"；上限只卡安全整数）；daily=HH:MM
    （单位数补零归一，如 9:5 → "09:05"）。返回规整后的 string（契约 value 恒
    string），不合法返回 null。 */
export function parseSchedValue(kind: SchedKind, raw: string): string | null {
  const v = raw.trim();
  if (kind === "daily") {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(v);
    if (m === null) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (n < 1 || n > Number.MAX_SAFE_INTEGER) return null;
  return String(n);
}

/** webhook 域校验（R11-S1，可选字段）：空/纯空白 → ""（不推送）；
    trim 后单个 http(s) 链接（refIsUrl 同形）→ 规整后的串；其余 null。
    深校验（可达性/2xx）是 Rust 推送侧的事，前端只卡协议形态。 */
export function parseSchedWebhook(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "";
  return /^https?:\/\/\S+$/i.test(v) ? v : null;
}

/** schedule_list 回包边界解析：非数组/坏行丢弃不炸整表；可选数值缺失落 null、
    未知 last_status 落 idle、enabled 缺失按停用（prompts 读侧同款纪律）。 */
export function decodeScheduleList(v: unknown): ScheduleRow[] {
  if (!Array.isArray(v)) return [];
  const out: ScheduleRow[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      typeof r.goal !== "string" ||
      typeof r.workdir !== "string"
    ) {
      continue;
    }
    if (r.kind !== "interval" && r.kind !== "daily") continue;
    if (typeof r.value !== "string") continue;
    const st = r.last_status;
    out.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      value: r.value,
      goal: r.goal,
      workdir: r.workdir,
      enabled: r.enabled === true,
      webhookUrl: typeof r.webhook_url === "string" ? r.webhook_url : "",
      next_run: typeof r.next_run === "number" ? r.next_run : null,
      last_run: typeof r.last_run === "number" ? r.last_run : null,
      last_status: st === "ok" || st === "fail" || st === "running" ? st : "idle",
      last_task_id: typeof r.last_task_id === "string" ? r.last_task_id : null,
    });
  }
  return out;
}

/** 列表行 HTML（mcpRowHTML 先例：armed=删除两步武装态；停用行 .off 降透明）。
    R11：计划尾 ·webhook 标注（webhookUrl 非空）；「立即运行」钮无确认直接跑
    （schedule_fire_now），running 占位期间禁用（Rust 侧单并发守卫的镜像）。 */
export function schedRowHTML(s: ScheduleRow, armed = false): string {
  const b = schedBadge(s.last_status);
  return `<div class="schedrow schedgrid${s.enabled ? "" : " off"}" data-sid="${esc(s.id)}">`
    + `<span class="st ${b.cls}" title="上次 ${schedTime(s.last_run)}">${b.word}</span>`
    + `<span class="n" title="${esc(`${s.name} · ${s.goal}`)}">${esc(s.name)}</span>`
    + `<span class="pl">${esc(fmtSchedulePlan(s.kind, s.value))}${s.webhookUrl === "" ? "" : " ·webhook"}</span>`
    + `<span class="nx">${esc(schedTime(s.next_run))}</span>`
    + `<span class="wd" title="${esc(s.workdir)}">${esc(s.workdir)}</span>`
    + `<span class="ops">`
    + `<button type="button" class="mop" data-schtoggle="${esc(s.id)}">${s.enabled ? "停用" : "启用"}</button>`
    + `<button type="button" class="mop" data-sched-fire="${esc(s.id)}"${s.last_status === "running" ? " disabled" : ""}>立即运行</button>`
    + `<button type="button" class="mop" data-schedit="${esc(s.id)}">编辑</button>`
    + `<button type="button" class="mop del${armed ? " armed" : ""}" data-schdel="${esc(s.id)}">${armed ? "确认删" : "删除"}</button>`
    + `</span></div>`;
}

/** sched 行统一详情体（T1 详情泛化）：计划/目标/目录 + 下次触发 + 上次状态 +
    立即运行（data-sched-fire 走任务域既有委托，running 占位禁用同列表行）。
    last_task_id 有则附上次 DSH 任务块——lastTask 为 dsh.sessions 历史按 uuid
    解析出的 {task, at(ms)}（null=历史未命中，仍给 uuid 短码兜底）；uuid 即
    dsh 续跑句柄，按钮 data-udsh-resume 由接线层回填 Agent tab。 */
export function schedDetailBodyHTML(
  s: ScheduleRow,
  lastTask: { task: string; at: number } | null,
): string {
  const b = schedBadge(s.last_status);
  const plan = fmtSchedulePlan(s.kind, s.value) + (s.webhookUrl === "" ? "" : " ·webhook");
  const lastId = s.last_task_id ?? "";
  const neverRan = s.last_run === null && s.last_status === "idle";
  const lastLine = neverRan
    ? `<span class="mono">未跑过</span>`
    : `<span class="st ${b.cls}">${b.word}</span><span class="mono">${esc(schedTime(s.last_run))}</span>`;
  const lastTaskBlock =
    lastId === ""
      ? ""
      : `
  <div class="hubline"><span class="lbl">上次任务</span><span class="mono" title="${esc(lastId)}">${esc(lastTask?.task ?? lastId.slice(0, 13))}</span><span class="mono">${lastTask === null ? "" : esc(schedTime(Math.floor(lastTask.at / 1000)))}</span></div>
  <div class="hubline"><span class="lbl"></span><button type="button" class="btn sec" data-udsh-resume="${esc(lastId)}">Agent tab 续跑该会话</button></div>`;
  return `
  <div class="ud-body">
    <div class="hubline"><span class="lbl">计划</span><span class="mono">${esc(plan)} · ${s.enabled ? "启用" : "停用"}</span></div>
    <div class="hubline"><span class="lbl">GOAL</span><span class="mono">${esc(s.goal)}</span></div>
    <div class="hubline"><span class="lbl">WORKDIR</span><span class="mono">${esc(s.workdir)}</span></div>
    <div class="hubline"><span class="lbl">下次触发</span><span class="mono">${esc(schedTime(s.next_run))}</span></div>
    <div class="hubline"><span class="lbl">上次状态</span>${lastLine}</div>${lastTaskBlock}
    <div class="hubline"><span class="lbl"></span><button type="button" class="btn sec" data-sched-fire="${esc(s.id)}"${s.last_status === "running" ? " disabled" : ""}>立即运行</button></div>
  </div>`;
}

/* ── B3 任务模板：prefs JSON [{id,name,goal,workdir}]（解析纪律同 prompts） ── */

export interface TemplateItem {
  id: string;
  name: string;
  goal: string;
  workdir: string;
}

export function parseTemplates(raw: string | null): TemplateItem[] {
  if (raw === null || raw.trim() === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: TemplateItem[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      typeof r.goal !== "string" ||
      typeof r.workdir !== "string"
    ) {
      continue;
    }
    const name = r.name.trim();
    if (name === "") continue;
    out.push({ id: r.id, name, goal: r.goal, workdir: r.workdir });
  }
  return out;
}

export function serializeTemplates(list: TemplateItem[]): string {
  return JSON.stringify(list);
}

/** 「存为模板」自动取名：goal 空白折叠后前 12 字，超长补省略号（materialTitle 同款）。 */
export function templateNameOf(goal: string): string {
  const t = goal.replace(/\s+/g, " ").trim();
  return t.length <= 12 ? t : t.slice(0, 12) + "…";
}
