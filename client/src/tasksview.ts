/* R11 T1/T2 统一任务中心纯逻辑：无 DOM、
   无运行时 import，node 断言直跑（同 sched.ts 惯例）。
   UnifiedRow 与 Rust tasks_unified 契约逐字一致（snake_case，kind 不含
   material——素材行由前端 hub 轮询数据映射同形）；harness 行在 Rust 快照
   缺席/落后时以本地事件流条目兜底覆盖（HOLD/终态即时反映）。
   拉取、轮询与接线在 main.ts。 */

export type UnifiedKind = "harness" | "material" | "dsh" | "pi" | "sched";
export type UnifiedStatus = "run" | "hold" | "done" | "fail" | "pending";

export interface UnifiedRow {
  kind: UnifiedKind;
  id: string;
  title: string;
  status: UnifiedStatus;
  /** epoch ms（Rust 契约 number；material createdAt ISO 在映射处转换，坏值落 0 排尾） */
  started_at: number;
  /** 运行耗时快照；material 终态无结束时刻为 null */
  elapsed_ms: number | null;
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

const KINDS: UnifiedKind[] = ["harness", "material", "dsh", "pi", "sched"];
const STATUSES: UnifiedStatus[] = ["run", "hold", "done", "fail", "pending"];

/** kind 单字母徽标：mono 量侧标识，五种混排一眼分源。 */
export function kindBadge(kind: UnifiedKind): string {
  const words: Record<UnifiedKind, string> = { harness: "H", material: "M", dsh: "D", pi: "P", sched: "S" };
  return words[kind];
}

/** 统一状态徽标（materialBadge 形态）：pending=待触发（sched 未到 next_run），落灰 WAIT。 */
export function unifiedStatusBadge(status: UnifiedStatus): { word: string; cls: string } {
  if (status === "hold") return { word: "HOLD", cls: "hd" };
  if (status === "done") return { word: "DONE", cls: "dn" };
  if (status === "fail") return { word: "FAIL", cls: "fl" };
  if (status === "pending") return { word: "WAIT", cls: "dn" };
  return { word: "RUN", cls: "run" };
}

/** 详情 kicker 的大徽标（liveBadge 形态）：run 橙 LIVE、hold 橙警、终态绿灰、
    pending 灰（sched 未到点）。 */
export function unifiedLiveBadge(status: UnifiedStatus): { word: string; cls: string } {
  if (status === "hold") return { word: "HOLD", cls: "live warn" };
  if (status === "done") return { word: "DONE", cls: "live off" };
  if (status === "fail") return { word: "FAILED", cls: "live fail" };
  if (status === "pending") return { word: "WAIT", cls: "live off" };
  return { word: "RUNNING", cls: "live" };
}

/** 顶栏任务徽标计数（统一列表口径，全类型）：run=RUN、hold=HOLD，
    pending/done/fail 不计（非进行态）。 */
export function badgeCountsOf(rows: UnifiedRow[]): { run: number; hold: number } {
  let run = 0;
  let hold = 0;
  for (const r of rows) {
    if (r.status === "run") run++;
    else if (r.status === "hold") hold++;
  }
  return { run, hold };
}

/** 统一标题：空白折叠 + 24 字截断（titleFrom 同界）；看板卡再由 CSS 两行钳制。 */
export function unifiedTitle(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length <= 24 ? t : t.slice(0, 24) + "…";
}

/** epoch ms → 本地短时刻（schedTime 同界）：今天 HH:MM，跨天 MM-DD HH:MM，坏值 —。 */
export function unifiedTime(ms: number, now = new Date()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

/** elapsed 快照 → mm:ss（ELAPSED 遥测同形，不折小时）；null（终态未知）显 —。 */
export function fmtElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** tasks_unified 回包边界解析：非数组/坏行丢弃不炸整表（decodeScheduleList 同纪律）。
    素材真源在前端轮询侧，rust 回包混入的 material 行一并丢弃（防同 id 双显）；
    started_at 收 number 或可解析 ISO 串（防御 Rust 侧形态漂移），坏值丢行。 */
export function decodeTasksUnified(v: unknown): UnifiedRow[] {
  if (!Array.isArray(v)) return [];
  const out: UnifiedRow[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string") continue;
    if (typeof r.kind !== "string" || !KINDS.includes(r.kind as UnifiedKind)) continue;
    if (r.kind === "material") continue;
    if (typeof r.status !== "string" || !STATUSES.includes(r.status as UnifiedStatus)) continue;
    const at = typeof r.started_at === "number" ? r.started_at : typeof r.started_at === "string" ? Date.parse(r.started_at) : NaN;
    if (!Number.isFinite(at)) continue;
    const elapsed = typeof r.elapsed_ms === "number" && Number.isFinite(r.elapsed_ms) ? r.elapsed_ms : null;
    out.push({ kind: r.kind as UnifiedKind, id: r.id, title: r.title, status: r.status as UnifiedStatus, started_at: at, elapsed_ms: elapsed });
  }
  return out;
}

/** material 条目（hub 轮询形状）→ 统一行：pending/running→run、succeeded→done、
    failed→fail（设计稿状态映射表）；elapsed 仅运行态有（终态 hub 不给结束时刻）。 */
export function materialRowOf(
  m: { id: string; prompt: string; status: "pending" | "running" | "succeeded" | "failed"; createdAt: string },
  now = Date.now(),
): UnifiedRow {
  const at = Date.parse(m.createdAt);
  const live = m.status === "pending" || m.status === "running";
  return {
    kind: "material",
    id: m.id,
    title: m.prompt,
    status: m.status === "succeeded" ? "done" : m.status === "failed" ? "fail" : "run",
    started_at: Number.isFinite(at) ? at : 0,
    elapsed_ms: live && Number.isFinite(at) ? Math.max(0, now - at) : null,
  };
}

/** harness 条目（本地事件流形状）→ 统一行：state null=已发起未到首事件按 run；
    aborted 归 done（用户主动收束，非失败，统一状态集不设第五种）。 */
export function harnessRowOf(
  e: { id: string; goal: string; state: { type: string } | null; startedAt: number; endedAt: number | null },
  now = Date.now(),
): UnifiedRow {
  const t = e.state?.type;
  const status: UnifiedStatus =
    t === "awaiting_approval" ? "hold" : t === "done" || t === "aborted" ? "done" : t === "failed" ? "fail" : "run";
  return {
    kind: "harness",
    id: e.id,
    title: e.goal,
    status,
    started_at: e.startedAt,
    elapsed_ms: Math.max(0, (e.endedAt ?? now) - e.startedAt),
  };
}

/** 三源合并 = Rust 快照（dsh/pi/sched + 快照内的 harness）+ 本地 harness 覆盖/补位
    + 前端 material 行，按 started_at 降序（设计稿「新者在上」）。
    rust=null（命令缺席/浏览器态/拉取失败）→ 整列回退本地 harness 映射；
    快照在场时同 id 的 harness 以本地为准（事件流比 10s 快照鲜活），本地独有
    （快照落地前刚发起）的 harness 追加。 */
export function mergeUnifiedRows(
  rust: UnifiedRow[] | null,
  localHarness: UnifiedRow[],
  material: UnifiedRow[],
): UnifiedRow[] {
  let rows: UnifiedRow[];
  if (rust === null) {
    rows = localHarness.slice();
  } else {
    const localById = new Map(localHarness.map((r) => [r.id, r]));
    const rustIds = new Set<string>();
    rows = rust.map((r) => {
      if (r.kind !== "harness") return r;
      rustIds.add(r.id);
      return localById.get(r.id) ?? r;
    });
    for (const r of localHarness) if (!rustIds.has(r.id)) rows.push(r);
  }
  return [...rows, ...material].sort((a, b) => b.started_at - a.started_at);
}

/** 任务列统一行：kind 徽标 + 标题 + 状态徽标 + 时刻（data-uid/ukind 供委托寻址）。
    五类全可点进统一详情（dsh/pi/sched 详情泛化同批）。 */
export function unifiedRowHTML(r: UnifiedRow, cur: boolean, now = new Date()): string {
  const b = unifiedStatusBadge(r.status);
  return `<div class="cell ucell${cur ? " cur" : ""}" data-uid="${esc(r.id)}" data-ukind="${r.kind}" role="button" tabindex="0"><div class="uhead"><span class="kb mono">${kindBadge(r.kind)}</span><span class="st ${b.cls}">${b.word}</span></div><div class="ttl">${esc(unifiedTitle(r.title))}</div><div class="cnt">${esc(unifiedTime(r.started_at, now))}</div></div>`;
}

/* ── T2 看板：五列按统一状态分类，列序即看板从左到右的流转 ── */

export const BOARD_COLUMNS: { key: UnifiedStatus; label: string }[] = [
  { key: "pending", label: "待触发" },
  { key: "run", label: "运行中" },
  { key: "hold", label: "待审批" },
  { key: "done", label: "已完成" },
  { key: "fail", label: "失败" },
];

/** 状态 → 看板列 key（列分类边界：pending 落首列待触发）；未知态归运行中列
    （decode 后不可达，防御行）。 */
export function boardColumnOf(status: UnifiedStatus): UnifiedStatus {
  return BOARD_COLUMNS.some((c) => c.key === status) ? status : "run";
}

/** 选中寻址（列表/看板/详情共用）：id 跨 kind 不唯一（harness 任务号与 engine
    会话号可撞数字串），必须二元组。 */
export interface UnifiedSel {
  kind: UnifiedKind;
  id: string;
}

function boardCardHTML(r: UnifiedRow, cur: UnifiedSel | null): string {
  const isCur = cur !== null && cur.kind === r.kind && cur.id === r.id;
  return `<div class="kbcard${isCur ? " cur" : ""}" data-uid="${esc(r.id)}" data-ukind="${r.kind}" role="button" tabindex="0"><span class="kb mono">${kindBadge(r.kind)}</span><div class="ttl">${esc(unifiedTitle(r.title))}</div><div class="cnt mono">${fmtElapsed(r.elapsed_ms)}</div></div>`;
}

/** 看板整板：五列恒在场（空列留淡占位，列不塌陷），卡 = kind 徽标 + 两行截断标题 + 耗时。 */
export function boardHTML(rows: UnifiedRow[], cur: UnifiedSel | null): string {
  const cols: UnifiedRow[][] = BOARD_COLUMNS.map(() => []);
  for (const r of rows) cols[BOARD_COLUMNS.findIndex((c) => c.key === boardColumnOf(r.status))].push(r);
  return BOARD_COLUMNS.map((c, i) => {
    const cards = cols[i].map((r) => boardCardHTML(r, cur)).join("");
    const body = cards !== "" ? cards : `<div class="kbph">${esc(c.label)} · 空</div>`;
    return `<div class="kbcol"><div class="kbcol-h"><span>${esc(c.label)}</span><span class="n">${cols[i].length}</span></div>${body}</div>`;
  }).join("");
}
