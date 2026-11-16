import "./styles.css";
import {
  ApiError,
  ProtocolError,
  SessionExpired,
  api,
  appendMessage,
  chatStream,
  createMaterial,
  createMcpUpstream,
  decodeMaterialTask,
  decodeMaterialTaskList,
  decodeMe,
  decodeModels,
  decodeSessionCreated,
  decodeSessions,
  deleteMcpUpstream,
  fetchMcpUpstreams,
  fetchUsage,
  fieldString,
  fetchMessagesPage,
  deleteSession,
  getToken,
  hubUrl,
  isObj,
  kbCreateDoc,
  kbDeleteDoc,
  kbListDocs,
  kbRebuild,
  kbRebuildHint,
  kbSearch,
  login,
  renameSession,
  searchSessions,
  setMcpUpstreamEnabled,
  setToken,
} from "./api";
import type {
  ChatMessageWire,
  ContentPart,
  HostedModel,
  KbDocRow,
  KbSourceType,
  MaterialKind,
  MaterialStatus,
  MessageRow,
  McpUpstreamView,
  SessionRow,
  SessionSearchRow,
  StreamUsage,
  UsageRow,
} from "./api";
import { fenceLanguage, renderCodeBlock, renderRich } from "./markdown";
import { byokDelete, byokGetSecret, byokList, byokSave } from "./byok";
import type { ByokView } from "./byok";
import {
  brand,
  domains,
  flightLog,
  hold,
  holdActions,
  railFoot,
  railSections,
  taskHeader,
  telemetry,
} from "./data";
import type { DomainId, TelemetryCell } from "./data";
import { TOGGLE_SHORTCUT, autostartIsEnabled, setAutostart } from "./desktop";
import { asideEmptyText, demoTagHTML, desktopOnlyNote } from "./desktop-only";
import { renderLogRows } from "./logview";
import { costCellText } from "./cost";
import { beginInlineHubEdit } from "./hub-edit";
import { mountHubProbe, onHubHealth } from "./hubProbe";
import { initTheme, readTheme, writeTheme } from "./theme";
import {
  decodeTaskUpdate,
  harnessAbort,
  harnessApprove,
  harnessRecentEvents,
  harnessRun,
  harnessStatus,
  isTauri,
  listenHarnessTaskUpdate,
  skillsList,
  taskHistoryList,
  taskHistorySave,
} from "./harness";
import type { HarnessTaskState, HarnessTaskUpdate, TaskHistoryRecord } from "./harness";
import {
  materialBadge,
  materialErrLine,
  materialExampleChipsHTML,
  materialTime,
  materialTitle,
  materialUsageLine,
  materialUsageOf,
  parseAtImage,
} from "./material";
import {
  badgeCountsOf,
  boardHTML,
  decodeTasksUnified,
  harnessRowOf,
  materialRowOf,
  mergeUnifiedRows,
  unifiedLiveBadge,
  unifiedRowHTML,
} from "./tasksview";
import type { UnifiedKind, UnifiedRow } from "./tasksview";
import {
  dshDetailBodyHTML,
  dshDetailState,
  ensureDshDetail,
  ensurePiDetail,
  feedEngineUpdate,
  piDetailBodyHTML,
  piDetailState,
} from "./udetail";
import { decodeEngineUpdate } from "./engine";
import type { EnginePanelState } from "./engine";
import {
  KB_K_DEFAULT,
  REF_MAX_BYTES,
  isTextFile,
  kbCollapsedHTML,
  kbHitsKey,
  kbKOf,
  parseAtKb,
  parseAtRef,
  refCollapsedHTML,
  refFilesPayload,
  refIsUrl,
  refOverLimit,
  refQuestionOf,
} from "./refdoc";
import type { KbHit } from "./refdoc";
import {
  atAcceptValue,
  parsePrompts,
  promptDesc,
  promptFirstLine,
  promptNameOk,
  serializePrompts,
} from "./prompts";
import type { PromptItem } from "./prompts";
import { exportFilename, exportFoldPage, sessionToMarkdown } from "./exportmd";
import { usageBars, usageByModel } from "./usagechart";
import { dshPanelSnapshot, dshPrefillSession, dshSessionList, mountDshPanel, unmountDshPanel } from "./dsh";
import type { DshPanelState } from "./dsh";
import { enginePanelSnapshot, mountEnginePanel, prefGet, unmountEnginePanel } from "./engine";
import { ENV_INSTALL_HINTS, envAreaHTML, envLogHTML } from "./env";
import type { EngineEnvReport } from "./env";
import { notifyTaskDone } from "./notify";
import { isMaterialInProgress, pickRebuildMaterialTasks, shouldNotifyOnTransition } from "./reload";
import { assetList, assetReveal, assetSaveFromUrl, assetSrc, assetTitle, type AssetRecord } from "./assets";
import { ARM_WINDOW_MS, armClick, armExpired, renameDecision, sessionTime } from "./sessions";
import type { ArmState } from "./sessions";
import { checkAndInstall, checkOnly, relaunchApp } from "./updater";
import {
  PARALLEL_MAX,
  PARALLEL_MIN,
  highlightSnippet,
  mcpRowHTML,
  parallelCellHTML,
  parallelColClass,
} from "./parallel";
import type { McpRowView, ParallelCellView } from "./parallel";
import {
  decodeScheduleList,
  parseSchedValue,
  parseSchedWebhook,
  parseTemplates,
  schedDetailBodyHTML,
  schedRowHTML,
  serializeTemplates,
  templateNameOf,
} from "./sched";
import type { ScheduleRow, SchedKind, TemplateItem } from "./sched";

/* ── 对话域状态（hub 实数据 + BYOK 本地模型） ── */

/** chip 序列元素：托管池模型或 BYOK 直连（key 唯一，byok 条目前缀 `byok:`）。 */
type ModelRef = { kind: "hosted"; model: HostedModel } | { kind: "byok"; view: ByokView };

interface ChatState {
  nickname: string;
  sessions: SessionRow[];
  currentId: string | null;
  messages: MessageRow[];
  msgHasMore: boolean; // R5-B#2：当前会话还有更早消息（顶置「加载更早」）
  models: HostedModel[]; // 托管池（任务域发起条的模型下拉也用它）
  modelsLoaded: boolean; // 首次拉取完成（含 0 模型结果），顶栏 ROUTE 行以此区分加载中
  byok: ByokView[]; // BYOK 本地模型（Tauri 内有效）
  modelSeq: ModelRef[]; // 对话域 chip 序列 = 托管 + byok:
  modelIdx: number; // 指向 modelSeq
  streaming: boolean;
}

const chatState: ChatState = {
  nickname: "",
  sessions: [],
  currentId: null,
  messages: [],
  msgHasMore: false,
  models: [],
  modelsLoaded: false,
  byok: [],
  modelSeq: [],
  modelIdx: 0,
  streaming: false,
};

const appEl = document.getElementById("app");
if (!appEl) throw new Error("#app not found");
const app: HTMLElement = appEl;

/* ── 任务域状态（Tauri 内 harness 实数据 + hub 素材任务；浏览器内素材亦可用） ── */

/** harness 内置 agent 任务（Tauri 事件流驱动）。 */
interface HarnessEntry {
  source: "harness";
  id: string;
  goal: string;
  model: string;
  state: HarnessTaskState | null; // null = 已发起、首个事件未到，按在走处理
  lastStep: number;
  tokensIn: number; // 累计用量（事件快照）
  tokensOut: number;
  logs: string[];
  startedAt: number;
  endedAt: number | null;
  holdErr: string;
}

/** hub 素材任务（图/视频，HTTP 轮询驱动；浏览器降级环境同样可用）。 */
interface MaterialEntry {
  source: "material";
  id: string;
  kind: MaterialKind;
  prompt: string;
  status: MaterialStatus;
  resultUrl: string;
  error: string;
  createdAt: string;
  saved: boolean; // B5：结果已收进本地资产（内存标记；重启后由资产表比对回填）
}

type TaskEntry = HarnessEntry | MaterialEntry;

const inTauri = isTauri();
const taskEntries = new Map<string, TaskEntry>(); // 插入序即发起序（id：harness 数字转串 / 素材 uuid）
let taskSelected: string | null = null;
/** 选中行的统一类型（id 跨 kind 不唯一——harness 任务号与 engine 会话号可撞
    数字串，寻址必须 (kind, id) 二元组）。 */
let taskSelKind: UnifiedKind = "harness";
let taskBusy = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let materialPollTimer: ReturnType<typeof setInterval> | null = null;
let usageTimer: ReturnType<typeof setInterval> | null = null;
let unlistenHarness: (() => void) | null = null;
let materialKind: MaterialKind = "image";
let materialBusy = false;

/* ── R11 T1/T2 统一任务列 + 看板：tasks_unified 快照 + 视图形态 ── */

/** Rust tasks_unified 快照（harness/dsh/pi/sched）；null=命令缺席或拉取失败
    （浏览器态 / Rust 侧未合入）→ 任务列回退本地 harness 映射，material 恒本地。 */
let unifiedRustRows: UnifiedRow[] | null = null;
let unifiedTimer: ReturnType<typeof setInterval> | null = null;
let unifiedRowsCache: UnifiedRow[] = []; // renderTaskDyn 每次重建，行点击寻址用

/** 任务域视图形态（T2）：list=共享详情区，board=五列看板；prefs "task.view" 记忆。 */
type TaskViewMode = "list" | "board";
let taskView: TaskViewMode = "list";
let taskTabNow: TaskTab = "builtin"; // 一级 tab 当前项（共享区显隐联动）

function taskLiveState(st: HarnessTaskState | null): boolean {
  return st === null || st.type === "running" || st.type === "awaiting_approval";
}

function taskLive(e: HarnessEntry): boolean {
  return taskLiveState(e.state);
}

/** 单活策略只约束 harness：素材任务在 hub 侧排队，允许多个并行轮询。 */
function anyLiveHarness(): boolean {
  for (const e of taskEntries.values()) if (e.source === "harness" && taskLive(e)) return true;
  return false;
}

function materialInProgress(m: MaterialEntry): boolean {
  return isMaterialInProgress(m.status);
}

/* ── 任务历史（本地终态持久化，重启后任务列可见） ── */

/** 历史记录 → 任务列条目。harness "h<n>" 回填内存键 "n"；material 历史不存 kind，图默认直显。 */
function entryFromHistory(r: TaskHistoryRecord): TaskEntry | null {
  if (r.source === "harness") {
    const numId = r.id.startsWith("h") ? r.id.slice(1) : "";
    if (!/^\d+$/.test(numId)) return null;
    const state: HarnessTaskState | null =
      r.status === "done"
        ? { type: "done", summary: r.detail }
        : r.status === "failed"
          ? { type: "failed", error: r.detail }
          : r.status === "aborted"
            ? { type: "aborted" }
            : null;
    if (state === null) return null;
    return {
      source: "harness",
      id: numId,
      goal: r.title,
      model: "",
      state,
      lastStep: 0,
      tokensIn: 0,
      tokensOut: 0,
      // 历史无飞行日志：合成一行终态摘要，避免日志区落在「等待首个事件」占位
      logs:
        r.status === "done"
          ? [`SYS 完成 · ${r.detail}`]
          : r.status === "failed"
            ? [`ERR ${r.detail}`]
            : ["SYS 用户中止"],
      startedAt: r.createdAt,
      endedAt: r.finishedAt,
      holdErr: "",
    };
  }
  if (r.status !== "succeeded" && r.status !== "failed") return null;
  return {
    source: "material",
    id: r.id,
    kind: "image",
    prompt: r.title,
    status: r.status,
    resultUrl: r.status === "succeeded" ? r.detail : "",
    error: r.status === "failed" ? r.detail : "",
    createdAt: new Date(r.createdAt).toISOString(),
    saved: false, // 历史条目不比对资产表（省一次全表查询）；收进资产入口仍可用
  };
}

/** 载入本地终态历史填充任务列；同 id 以内存（在跑）为准。
    列表按 finished_at 倒序，倒序插入使最新终态在任务列顶部（对齐在跑任务的新者在上）。 */
async function loadTaskHistory(): Promise<void> {
  if (!inTauri) return;
  try {
    const rows = await taskHistoryList();
    for (const r of [...rows].reverse()) {
      const e = entryFromHistory(r);
      if (e !== null && !taskEntries.has(e.id)) taskEntries.set(e.id, e);
    }
    if (taskSelected === null && taskEntries.size > 0) {
      const keys = [...taskEntries.keys()];
      taskSelected = keys[keys.length - 1] ?? null;
      const e = taskSelected === null ? undefined : taskEntries.get(taskSelected);
      if (e !== undefined) taskSelKind = e.source;
    }
    renderTaskDyn();
  } catch (err) {
    console.warn("[tasks] 历史加载失败", err);
  }
}

/** 素材任务到终态：写本地历史（fire-and-forget，失败不影响 UI；浏览器环境无本地库）。 */
function persistMaterial(m: MaterialEntry): void {
  if (!inTauri || materialInProgress(m)) return;
  void taskHistorySave({
    id: m.id,
    source: "material",
    title: materialTitle(m.prompt),
    status: m.status,
    detail: m.status === "succeeded" ? m.resultUrl : m.error,
  }).catch((e) => console.warn("[tasks] 素材历史写入失败", e));
}

/** hub 任务视图 → 任务列条目（发起/重试/重载恢复三路径共用形状）。 */
function materialEntryOf(t: {
  id: string;
  kind: MaterialKind;
  prompt: string;
  status: MaterialStatus;
  resultUrl: string;
  error: string;
  createdAt: string;
}): MaterialEntry {
  return {
    source: "material",
    id: t.id,
    kind: t.kind,
    prompt: t.prompt,
    status: t.status,
    resultUrl: t.resultUrl,
    error: t.error,
    createdAt: t.createdAt,
    saved: false,
  };
}

function selectedTask(): TaskEntry | null {
  if (taskSelected === null) return null;
  if (taskSelKind !== "harness" && taskSelKind !== "material") return null;
  return taskEntries.get(taskSelected) ?? null;
}

/** 选中行（dsh/pi/sched 三型）：统一快照内按 (kind, id) 寻址；不在快照返回
    null（行已出列——renderTaskDyn 处自愈清选）。 */
function selectedUnifiedRow(): UnifiedRow | null {
  if (taskSelected === null) return null;
  if (taskSelKind === "harness" || taskSelKind === "material") return null;
  return unifiedRowsCache.find((r) => r.kind === taskSelKind && r.id === taskSelected) ?? null;
}

/** 事件流里出现未知 id（如页面重载后 Rust 侧任务仍在走）时补一条占位记录。 */
function ensureTask(id: number): HarnessEntry {
  const key = String(id);
  const known = taskEntries.get(key);
  if (known !== undefined && known.source === "harness") return known;
  const e: HarnessEntry = {
    source: "harness",
    id: key,
    goal: `task #${id} · 本页未记录目标`,
    model: "",
    state: null,
    lastStep: 0,
    tokensIn: 0,
    tokensOut: 0,
    logs: [],
    startedAt: Date.now(),
    endedAt: null,
    holdErr: "",
  };
  taskEntries.set(key, e);
  return e;
}

function elapsedMs(e: HarnessEntry): number {
  return (e.endedAt ?? Date.now()) - e.startedAt;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** token 累计缩写：不足 1k 原样；以上一位小数 + k/M 单位小字（同 STEPS/ELAPSED 遥测习惯）。 */
function tokenValue(n: number): { value: string; unit?: string } {
  if (n >= 1_000_000) return { value: (n / 1_000_000).toFixed(1), unit: "M" };
  if (n >= 1000) return { value: (n / 1000).toFixed(1), unit: "k" };
  return { value: String(n) };
}

/** COST 格取值（P2 本地估算）：任务自带模型名按名查价；名缺（历史回填/重载孤儿）
    按发起默认（首个启用托管模型，与 agentSendCore 同选法）估并注明口径。
    模型不在池或未定价（含旧 hub 无价字段）→ —；随事件重渲染与 tokens 同步。 */
function costCell(e: HarnessEntry): { value: string; unit?: string } {
  const fallback = e.model === "";
  const m = fallback
    ? chatState.models.find((x) => x.enabled)
    : chatState.models.find((x) => x.name === e.model);
  if (m === undefined) return { value: "—" };
  const value = costCellText(e.tokensIn, e.tokensOut, m.priceIn, m.priceOut);
  return { value, ...(fallback && value !== "—" ? { unit: "按默认模型" } : {}) };
}

function statusBadge(e: TaskEntry): { word: string; cls: string } {
  if (e.source === "material") return materialBadge(e.status);
  const t = e.state?.type;
  if (t === "awaiting_approval") return { word: "HOLD", cls: "hd" };
  if (t === "done") return { word: "DONE", cls: "dn" };
  if (t === "failed") return { word: "FAIL", cls: "fl" };
  if (t === "aborted") return { word: "ABORT", cls: "dn" };
  return { word: "RUN", cls: "run" };
}

function liveBadge(e: HarnessEntry): { word: string; cls: string } {
  const t = e.state?.type;
  if (t === "awaiting_approval") return { word: "HOLD", cls: "live warn" };
  if (t === "failed") return { word: "FAILED", cls: "live fail" };
  if (t === "aborted" || t === "done") return { word: t === "done" ? "DONE" : "ABORTED", cls: "live off" };
  return { word: "RUNNING", cls: "live" };
}

function materialLiveBadge(m: MaterialEntry): { word: string; cls: string } {
  if (m.status === "succeeded") return { word: "DONE", cls: "live off" };
  if (m.status === "failed") return { word: "FAILED", cls: "live fail" };
  return { word: "RUNNING", cls: "live" };
}

function renderKickerHTML(e: TaskEntry | null, row: UnifiedRow | null): string {
  // 空选中占位仅在桌面态出（发起条就在下方）；浏览器态 harness 不可用，留白不误导
  if (row !== null) {
    const b = unifiedLiveBadge(row.status);
    const phase =
      row.kind === "sched" ? "SCHED" : `AGENT · ${row.kind === "dsh" ? "DSH" : "PI"} #${esc(row.id)}`;
    return `<div class="phase">${phase}</div><h1>${esc(row.title)}<span class="${b.cls}">${b.word}</span></h1>`;
  }
  if (!e) return inTauri ? `<div class="phase">AGENT · HARNESS</div><h1>尚未发起任务</h1>` : "";
  if (e.source === "material") {
    const b = materialLiveBadge(e);
    return `<div class="phase">MATERIAL · ${e.kind === "image" ? "IMAGE" : "VIDEO"}</div><h1>${esc(titleFrom(e.prompt))}<span class="${b.cls}">${b.word}</span></h1>`;
  }
  const b = liveBadge(e);
  return `<div class="phase">AGENT TASK · #${e.id}</div><h1>${esc(titleFrom(e.goal))}<span class="${b.cls}">${b.word}</span></h1>${taskLive(e) ? `<button type="button" class="btn sec abort" id="task-abort">中止</button>` : ""}`;
}

function renderHoldHTML(e: HarnessEntry): string {
  const st = e.state;
  if (!st || st.type !== "awaiting_approval") return "";
  const desc =
    st.tool.type === "write_file"
      ? `写 ${st.tool.path} · 批准后先建 .bak 备份再写入`
      : `${st.tool.type} ${"path" in st.tool ? st.tool.path : ""}`;
  const diff = st.preview
    .split("\n")
    .map((l) =>
      l.startsWith("+ ")
        ? `<span class="add">${esc(l)}</span>`
        : l.startsWith("- ")
          ? `<span class="del">${esc(l)}</span>`
          : esc(l),
    )
    .join("\n");
  return `<div class="hold">
  <div class="bar"><span class="tag">HOLD</span><span class="desc">${esc(desc)}</span></div>
  <div class="diff">${diff}</div>
  ${e.holdErr ? `<div class="errline">${esc(e.holdErr)}</div>` : ""}
  <div class="acts"><button type="button" class="btn pri" data-approve="1">批准写入</button><button type="button" class="btn sec" data-approve="0">拒绝</button></div>
</div>`;
}

/** 素材任务选中态主区：结果直显（img 是内容不是 chrome）/ 视频外链 / 失败行 /
    生成中提示；succeeded 附「收进资产」（B5：下载落盘本地资产夹）。 */
function renderMaterialBody(m: MaterialEntry): string {
  if (m.status === "succeeded" && m.resultUrl) {
    const saveBtn = inTauri
      ? `<div class="mat-save"><button type="button" class="btn sec" data-asset="${esc(m.id)}" ${m.saved ? "disabled" : ""}>${m.saved ? "已收进资产" : "收进资产"}</button></div>`
      : "";
    const href = safeUrl(m.resultUrl);
    if (!href) return `<div class="errline">结果 URL 协议不受支持 · ${esc(m.resultUrl)}</div>${saveBtn}`;
    if (m.kind === "image") {
      return `<img class="mat-img" src="${esc(href)}" alt="${esc(materialTitle(m.prompt))}">${saveBtn}`;
    }
    return `<a class="mat-link" href="${esc(href)}" target="_blank" rel="noreferrer">打开视频 · 新窗口</a>${saveBtn}`;
  }
  if (m.status === "failed")
    return `<div class="errline">${esc(materialErrLine(m.error) || "生成失败")}</div>${materialRetryHTML(m)}`;
  return `<div class="task-empty">生成中 · 每 5s 轮询 hub 任务状态</div>`;
}

function renderDynBody(e: TaskEntry | null): string {
  if (!e) return inTauri ? `<div class="task-empty">在下方发起区填写目标与信任目录，发起第一个任务。</div>` : "";
  if (e.source === "material") return renderMaterialBody(e);
  const live = taskLive(e);
  const cells: TelemetryCell[] = [
    { label: "STEPS", value: String(e.lastStep), readout: live },
    { label: "TOKENS", ...tokenValue(e.tokensIn + e.tokensOut), readout: live },
    { label: "COST", ...costCell(e), readout: live },
    { label: "ELAPSED", value: mmss(elapsedMs(e)), readout: live },
    { label: "AGENT", value: "harness", compact: true },
  ];
  const log =
    e.logs.length > 0
      ? renderLogRows(e.logs)
      : `<div class="row"><span class="tstamp">--:--</span><span class="evt"><b>SYS</b> 等待首个事件…</span></div>`;
  return `<div class="telem">${telemHTML(cells)}
  </div>
  <div class="log">${log}
  </div>
  ${renderHoldHTML(e)}`;
}

/** 失败重试钮（主区/任务卡共用）：原参重提入口；远古持久化条目可能缺 kind，缺则不出钮。 */
function materialRetryHTML(m: MaterialEntry): string {
  if (m.kind !== "image" && m.kind !== "video") return "";
  return `<div class="mat-retry"><button type="button" class="btn sec" data-retry="${esc(m.id)}">重试</button></div>`;
}

/* ── 统一任务列（T1）：Rust 快照 + 本地 harness 覆盖/兜底 + 前端 material 行 ── */

/** 三源合并成统一行集：material/harness 从 taskEntries 映射（事件流鲜活），
    dsh/pi/sched 来自 tasks_unified 快照。renderTaskDyn 每次重建。 */
function currentUnifiedRows(): UnifiedRow[] {
  const now = Date.now();
  const harness: UnifiedRow[] = [];
  const material: UnifiedRow[] = [];
  for (const e of taskEntries.values()) {
    if (e.source === "harness") harness.push(harnessRowOf(e, now));
    else material.push(materialRowOf({ id: e.id, prompt: e.prompt, status: e.status, createdAt: e.createdAt }, now));
  }
  return mergeUnifiedRows(unifiedRustRows, harness, material);
}

/** 拉 tasks_unified 存快照后重绘任务面；失败落 null 走本地兜底（下个周期重试）。 */
async function refreshUnifiedTasks(): Promise<void> {
  if (!inTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    unifiedRustRows = decodeTasksUnified(await invoke("tasks_unified"));
  } catch (err) {
    unifiedRustRows = null;
    console.warn("[tasks] tasks_unified 拉取失败，任务列回退本地映射", err);
  }
  renderTaskDyn();
}

function startUnifiedPoll(): void {
  if (unifiedTimer !== null) return;
  unifiedTimer = setInterval(() => void refreshUnifiedTasks(), 10_000);
}

function renderAsideGridHTML(rows: UnifiedRow[]): string {
  if (rows.length === 0) return `<div class="aside-empty">${asideEmptyText(inTauri)}</div>`;
  return rows.map((r) => unifiedRowHTML(r, r.id === taskSelected && r.kind === taskSelKind)).join("");
}

/* ── 详情泛化（T1 下批）：dsh/pi/sched 行点击进统一详情骨架 ── */

/** engine 行在统一快照内的定位（详情事件流建态的 kind/起始时刻源）。 */
function engineRowRefOf(id: string): { kind: "dsh" | "pi"; startedAt: number } | null {
  const r = unifiedRowsCache.find((x) => (x.kind === "dsh" || x.kind === "pi") && x.id === id);
  if (r === undefined || (r.kind !== "dsh" && r.kind !== "pi")) return null;
  return { kind: r.kind, startedAt: r.started_at };
}

/** Agent tab dsh 面板当前任务的快照作详情 seed（同任务连历史日志带过来）。 */
function dshSeedOf(id: string): DshPanelState | null {
  const snap = dshPanelSnapshot();
  return snap !== null && snap.runId !== null && snap.runId === Number(id) ? snap : null;
}

/** Agent tab PI 面板当前会话的快照作详情 seed。 */
function piSeedOf(id: string): EnginePanelState | null {
  const snap = enginePanelSnapshot();
  return snap !== null && snap.sessionId !== null && snap.sessionId === Number(id) ? snap : null;
}

/** sched 详情的关联 DSH 任务解析缓存（uuid → 历史条目标题/时刻，dsh.sessions）。 */
const schedLastTaskCache = new Map<string, { task: string; at: number }>();

/** sched 行选中后的异步补齐：每次选中都重拉 schedules（内存行可能落后——
    调度器在后台已触发/终态）+ 关联任务的历史解析；期间用户点走即弃
    （重新选中会再触发）。 */
async function prepareSchedDetail(id: string): Promise<void> {
  await refreshScheds();
  if (taskSelected !== id || taskSelKind !== "sched") return;
  const cur = schedRows.find((s) => s.id === id);
  const lastId = cur?.last_task_id ?? "";
  if (cur === undefined || lastId === "" || schedLastTaskCache.has(lastId)) {
    renderTaskDyn();
    return;
  }
  try {
    for (const e of await dshSessionList()) schedLastTaskCache.set(e.id, { task: e.task, at: e.at });
  } catch {
    // 历史不可达：详情体按 uuid 短码兜底，不阻塞
  }
  if (taskSelected !== id || taskSelKind !== "sched") return;
  renderTaskDyn();
}

/** 引擎/sched 行的详情体分派（renderTaskDyn 与事件 repaint 共用）。 */
function renderUnifiedDetailBody(row: UnifiedRow): string {
  if (row.kind === "sched") {
    const s = schedRows.find((x) => x.id === row.id);
    if (s === undefined) return `<div class="task-empty">计划信息加载中…</div>`;
    const lastId = s.last_task_id ?? "";
    return schedDetailBodyHTML(s, lastId === "" ? null : (schedLastTaskCache.get(lastId) ?? null));
  }
  if (row.kind === "dsh") return dshDetailBodyHTML(row, dshDetailState(row.id));
  return piDetailBodyHTML(row, piDetailState(row.id));
}

/** 程序化切一级 tab（assets CTA 同款按钮寻址）：引擎/sched 行详情需要可见的
    共享详情区，Agent/定时 tab 上它隐藏——落内置 tab。 */
function gotoTaskTab(id: TaskTab): void {
  if (taskTabNow === id) return;
  const labels: Record<TaskTab, string> = { builtin: "内置", material: "素材", agent: "Agent", sched: "定时" };
  const btn = [...document.querySelectorAll("#task-tabs button")].find((x) => x.textContent === labels[id]);
  if (btn instanceof HTMLButtonElement) btn.click();
}

/** 任务列/看板共用的行点击：五型全可进详情——harness/material 走既有
    TaskEntry 详情；dsh/pi 起 keyed 状态（面板快照 seed）出只读日志流详情；
    sched 出计划详情并异步补齐关联任务（看板态先回列表显详情）。 */
function onUnifiedRowClick(el: HTMLElement): void {
  const kind = el.dataset.ukind as UnifiedKind;
  const id = el.dataset.uid ?? "";
  if (kind !== "harness" && kind !== "material" && kind !== "dsh" && kind !== "pi" && kind !== "sched") return;
  if (kind === "harness" || kind === "material") {
    if (!taskEntries.has(id)) {
      // Rust 快照先于事件流到的 harness 行：按行内标题补占位（事件到后由 ensureTask 兜住）
      if (kind !== "harness" || !/^\d+$/.test(id)) return;
      const known = ensureTask(Number(id));
      const row = unifiedRowsCache.find((r) => r.kind === "harness" && r.id === id);
      if (row !== undefined) known.goal = row.title;
    }
    taskSelKind = kind;
    taskSelected = id;
  } else if (kind === "dsh" || kind === "pi") {
    const row = unifiedRowsCache.find((r) => r.kind === kind && r.id === id);
    if (row === undefined) return;
    if (kind === "dsh") ensureDshDetail(id, row.started_at, dshSeedOf(id));
    else ensurePiDetail(id, row.started_at, piSeedOf(id));
    taskSelKind = kind;
    taskSelected = id;
    gotoTaskTab("builtin");
  } else {
    taskSelKind = "sched";
    taskSelected = id;
    void prepareSchedDetail(id);
    gotoTaskTab("builtin");
  }
  if (taskView === "board") setTaskView("list");
  renderTaskDyn();
}

/** 引擎事件订阅（详情流，模块级一次）：喂 keyed 状态；命中当前选中行时
    rAF 合并重绘详情体（高频 delta 一帧一绘，dsh.ts 面板同节律）。 */
let engineDetailListenersReady = false;
let detailRepaintScheduled = false;

function ensureEngineDetailListener(): void {
  if (!inTauri || engineDetailListenersReady) return;
  engineDetailListenersReady = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => {
      void listen<unknown>("engine://update", (ev) => {
        try {
          const u = decodeEngineUpdate(ev.payload);
          const hit = feedEngineUpdate(u.id, u.event, engineRowRefOf);
          if (hit && taskSelected === String(u.id) && (taskSelKind === "dsh" || taskSelKind === "pi")) {
            scheduleDetailRepaint();
          }
        } catch (err) {
          console.warn("[tasks] 引擎事件形状不符（详情流）", err);
        }
      });
    })
    .catch((err: unknown) => console.warn("[tasks] 引擎事件订阅失败（详情流）", err));
}

function scheduleDetailRepaint(): void {
  if (detailRepaintScheduled) return;
  detailRepaintScheduled = true;
  requestAnimationFrame(() => {
    detailRepaintScheduled = false;
    const row = selectedUnifiedRow();
    const dyn = document.getElementById("task-dyn");
    if (dyn === null || row === null) return;
    dyn.innerHTML = renderUnifiedDetailBody(row);
    // 日志流跟底（dsh.ts paintAll 同款）：重绘后贴回最底行
    const out = dyn.querySelector(".sc-out");
    if (out !== null) out.scrollTop = out.scrollHeight;
  });
}

/** 任务域唯一渲染入口：事件 / 计时 / 点击选择都经此处串行落 DOM。 */
function renderTaskDyn(scrollLog = false): void {
  updateLaunchBar();
  unifiedRowsCache = currentUnifiedRows();
  updateTaskBadge();
  // 引擎/sched 选中行已出快照（dsh 收割转终态行/sched 触发出窗）：清选回空详情
  if (taskSelected !== null && selectedUnifiedRow() === null && taskSelKind !== "harness" && taskSelKind !== "material") {
    taskSelected = null;
    taskSelKind = "harness";
  }
  const row = selectedUnifiedRow();
  const e = selectedTask();
  const kick = document.getElementById("task-kicker");
  const dyn = document.getElementById("task-dyn");
  const grid = document.getElementById("aside-grid");
  const board = document.getElementById("task-board");
  if (kick) kick.innerHTML = renderKickerHTML(e, row);
  if (dyn) dyn.innerHTML = row !== null ? renderUnifiedDetailBody(row) : renderDynBody(e);
  if (grid) grid.innerHTML = renderAsideGridHTML(unifiedRowsCache);
  const cur = row !== null ? { kind: row.kind, id: row.id } : e !== null ? { kind: e.source, id: e.id } : null;
  if (board) board.innerHTML = boardHTML(unifiedRowsCache, cur);
  if (scrollLog) {
    const sec = document.getElementById("task-sec");
    if (sec) sec.scrollTop = sec.scrollHeight;
  }
}

function updateLaunchBar(): void {
  const sel = document.getElementById("task-model");
  const btn = document.getElementById("task-run");
  if (!(sel instanceof HTMLSelectElement) || !(btn instanceof HTMLButtonElement)) return;
  const names = chatState.models.map((m) => m.name);
  const cur = sel.value;
  if (
    sel.options.length !== names.length ||
    names.some((n, i) => sel.options.item(i)?.value !== n)
  ) {
    sel.innerHTML =
      names.length > 0
        ? names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")
        : `<option value="">无可用模型</option>`;
    if (names.includes(cur)) sel.value = cur;
  }
  // 单活任务策略：任一 harness 任务在走（含 HOLD）期间不允许再发起（素材任务不占此锁）
  btn.disabled = taskBusy || names.length === 0 || anyLiveHarness();
}

function applyState(e: HarnessEntry, st: HarnessTaskState): void {
  const wasLive = taskLive(e);
  if (st.type === "running" || st.type === "awaiting_approval") e.lastStep = st.step;
  e.state = st;
  if (wasLive && !taskLive(e) && e.endedAt === null) e.endedAt = Date.now();
}

function onHarnessUpdate(u: HarnessTaskUpdate, replayed = false): void {
  const e = ensureTask(u.id);
  const prevLive = taskLive(e);
  const prevType = e.state?.type;
  applyState(e, u.state);
  e.tokensIn = u.tokensIn;
  e.tokensOut = u.tokensOut;
  if (prevType === "awaiting_approval" && u.state.type !== "awaiting_approval") e.holdErr = "";
  if (u.log) e.logs.push(u.log);
  // B4：窗口不可见时的终态托盘通知（done/failed/aborted 三态全覆盖）。
  // 重放载荷（replayed）的迁移发生在页面缺席期间，视为历史行不弹（R5-A-①）。
  if (shouldNotifyOnTransition(prevLive, taskLive(e), replayed)) {
    void notifyTaskDone(
      `任务${u.state.type === "done" ? "完成" : u.state.type === "failed" ? "失败" : "中止"} · ${titleFrom(e.goal)}`,
      u.state.type === "done" ? e.goal : "点托盘图标打开主窗口查看",
    ).catch(() => {});
  }
  if (taskSelected === null) {
    taskSelected = String(u.id);
    taskSelKind = "harness";
  }
  renderTaskDyn(true);
  // 任务卡随事件刷新（R6-B U3）：对话流里有卡时同步重绘；流式回答中跳过防打断
  if (!chatState.streaming && chatState.messages.some((m) => m.meta !== undefined)) renderMessages();
}

async function onTaskRun(): Promise<void> {
  const goalEl = document.getElementById("task-goal");
  const wdEl = document.getElementById("task-wd");
  const modelEl = document.getElementById("task-model");
  const hint = document.getElementById("task-hint");
  if (
    !(goalEl instanceof HTMLInputElement) ||
    !(wdEl instanceof HTMLInputElement) ||
    !(modelEl instanceof HTMLSelectElement) ||
    !(hint instanceof HTMLElement)
  ) {
    return;
  }
  const goal = goalEl.value.trim();
  const workingDir = wdEl.value.trim();
  const model = modelEl.value;
  if (!goal || !workingDir || !model) {
    hint.textContent = "goal / 信任目录 / 模型 均必填";
    return;
  }
  hint.textContent = "";
  taskBusy = true;
  updateLaunchBar();
  try {
    const id = await harnessRun({ goal, workingDir, model, hubUrl: hubUrl(), token: await getToken() });
    const key = String(id);
    taskEntries.set(key, {
      source: "harness",
      id: key,
      goal,
      model,
      state: null,
      lastStep: 0,
      tokensIn: 0,
      tokensOut: 0,
      logs: [],
      startedAt: Date.now(),
      endedAt: null,
      holdErr: "",
    });
    taskSelected = key;
    taskSelKind = "harness";
    goalEl.value = "";
    // R6-B U4：记忆信任目录供 @agent 默认取用（尽力而为，失败仅日志）
    if (inTauri) {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("pref_set", { key: "chat.workdir", value: workingDir }))
        .catch((e) => console.warn("[tasks] workdir 记忆写入失败", e));
    }
    renderTaskDyn(true);
  } catch (err) {
    hint.textContent = errText(err);
  } finally {
    taskBusy = false;
    updateLaunchBar();
  }
}

async function onApprove(id: number, approved: boolean): Promise<void> {
  // 点击即锁双钮，防重复审批打到已关闭的通道；状态事件到达后随重渲染复位
  // （R6-B：任务域 dyn 与对话流任务卡两处的 [data-approve] 全锁）
  document.querySelectorAll<HTMLButtonElement>("[data-approve]").forEach((b) => {
    b.disabled = true;
  });
  try {
    await harnessApprove(id, approved);
  } catch (err) {
    const e = taskEntries.get(String(id));
    if (e !== undefined && e.source === "harness") {
      e.holdErr = errText(err);
      renderTaskDyn();
    }
  }
}

async function onAbort(id: number): Promise<void> {
  const hint = document.getElementById("task-hint");
  try {
    await harnessAbort(id);
  } catch (err) {
    if (hint) hint.textContent = errText(err);
  }
}

function startTick(): void {
  if (tickTimer !== null) return;
  tickTimer = setInterval(() => {
    if (anyLiveHarness()) renderTaskDyn();
  }, 1000);
}

function stopTick(): void {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/* ── 素材任务：提交 / 5s 轮询 / 用量行 ── */

function syncMaterialPane(): void {
  const bar = document.getElementById("mat-kind");
  if (bar) {
    for (const b of bar.querySelectorAll<HTMLButtonElement>("button[data-mat-kind]")) {
      b.setAttribute("aria-selected", String(b.dataset.matKind === materialKind));
    }
  }
  const btn = document.getElementById("material-run");
  if (btn instanceof HTMLButtonElement) btn.textContent = materialKind === "image" ? "生成图片" : "生成视频";
}

async function onMaterialRun(): Promise<void> {
  const inputEl = document.getElementById("material-prompt");
  const hint = document.getElementById("material-hint");
  if (!(inputEl instanceof HTMLInputElement) || !(hint instanceof HTMLElement) || materialBusy) return;
  const prompt = inputEl.value.trim();
  if (!prompt) {
    hint.textContent = "prompt 必填";
    return;
  }
  hint.textContent = "";
  materialBusy = true;
  const btn = document.getElementById("material-run");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  try {
    const t = await createMaterial(materialKind, prompt);
    const entry = materialEntryOf(t);
    taskEntries.set(t.id, entry);
    persistMaterial(entry);
    taskSelected = t.id;
    taskSelKind = "material";
    inputEl.value = "";
    renderTaskDyn(true);
  } catch (err) {
    if (err instanceof SessionExpired) {
      renderLogin();
      return;
    }
    hint.textContent = errText(err);
  } finally {
    materialBusy = false;
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
}

function startMaterialPoll(): void {
  if (materialPollTimer !== null) return;
  materialPollTimer = setInterval(() => void pollMaterialTasks(), 5000);
}

/** 失败任务一键重试：原 kind+prompt 重提，新任务顶替选中；与首发共用 materialBusy 防抖。 */
async function onMaterialRetry(id: string): Promise<void> {
  const cur = taskEntries.get(id);
  if (!cur || cur.source !== "material" || cur.status !== "failed" || materialBusy) return;
  if (cur.kind !== "image" && cur.kind !== "video") return;
  materialBusy = true;
  const hint = document.getElementById("material-hint");
  try {
    const t = await createMaterial(cur.kind, cur.prompt);
    const entry = materialEntryOf(t);
    taskEntries.set(t.id, entry);
    persistMaterial(entry);
    taskSelected = t.id;
    taskSelKind = "material";
    if (hint instanceof HTMLElement) hint.textContent = "";
    renderTaskDyn(true);
  } catch (err) {
    if (err instanceof SessionExpired) {
      renderLogin();
      return;
    }
    if (hint instanceof HTMLElement) hint.textContent = errText(err);
  } finally {
    materialBusy = false;
  }
}

function stopMaterialPoll(): void {
  if (materialPollTimer !== null) {
    clearInterval(materialPollTimer);
    materialPollTimer = null;
  }
}

/** 只轮本页创建（map 内）的运行态素材任务，终态后自然退出轮询集合；单次失败保快照待下周期。 */
async function pollMaterialTasks(): Promise<void> {
  const live: MaterialEntry[] = [];
  for (const e of taskEntries.values()) if (e.source === "material" && materialInProgress(e)) live.push(e);
  if (live.length === 0) return;
  let changed = false;
  for (const m of live) {
    try {
      const t = decodeMaterialTask(await api(`/api/v1/material/generations/${encodeURIComponent(m.id)}`));
      const cur = taskEntries.get(t.id);
      if (cur !== undefined && cur.source === "material" && cur.status !== t.status) {
        const wasLive = materialInProgress(cur);
        cur.status = t.status;
        cur.resultUrl = t.resultUrl;
        cur.error = t.error;
        persistMaterial(cur);
        // B4：窗口不可见时的终态托盘通知（轮询亲见的 live→终态迁移，非重放）
        if (shouldNotifyOnTransition(wasLive, materialInProgress(cur), false)) {
          void notifyTaskDone(
            `素材${t.status === "succeeded" ? "完成" : "失败"} · ${materialTitle(cur.prompt)}`,
            t.status === "succeeded"
              ? cur.kind === "image"
                ? "图片已生成 · 可在资产页收存"
                : "视频已生成 · 可在资产页收存"
              : materialErrLine(cur.error) || "生成失败",
          ).catch(() => {});
        }
        changed = true;
      }
    } catch (err) {
      if (err instanceof SessionExpired) {
        renderLogin();
        return;
      }
      // 瞬时失败：保留本地快照，下个周期重试
    }
  }
  if (changed) {
    // material 轮询亲见迁移：除重绘外重拉一次统一快照（elapsed/其余源随批刷新）
    void refreshUnifiedTasks();
    renderTaskDyn();
    // @生图卡随轮询刷新（R9-B B1）：对话流有素材卡时同步重绘（流式中跳过防打断）
    if (!chatState.streaming && chatState.messages.some((m) => m.meta?.materialTaskId !== undefined)) renderMessages();
  }
}

async function refreshMaterialUsage(): Promise<void> {
  try {
    const rows = await fetchUsage(30);
    const line = document.getElementById("usage-line");
    if (line) line.textContent = materialUsageLine(materialUsageOf(rows));
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    console.warn("[usage] 素材用量拉取失败", e);
  }
}

function startUsageTimer(): void {
  if (usageTimer !== null) return;
  usageTimer = setInterval(() => void refreshMaterialUsage(), 60_000);
}

function stopUsageTimer(): void {
  if (usageTimer !== null) {
    clearInterval(usageTimer);
    usageTimer = null;
  }
}

async function refreshTaskStates(): Promise<void> {
  for (const e of taskEntries.values()) {
    if (e.source !== "harness") continue;
    try {
      const st = await harnessStatus(Number(e.id));
      if (st) applyState(e, st);
    } catch {
      // 查询失败保留本地快照
    }
  }
  renderTaskDyn();
}

async function bindHarness(): Promise<void> {
  if (unlistenHarness !== null) return;
  try {
    unlistenHarness = await listenHarnessTaskUpdate(onHarnessUpdate);
    await replayRecentHarnessEvents();
    await refreshTaskStates();
  } catch (err) {
    console.warn("[harness] 事件订阅失败", err);
  }
}

/** 重载窗口恢复（R5-A-①）：订阅成功后重放 Rust 进程内缓存的最近事件。
    重载期间在跑/HOLD 的任务由此回任务列（HOLD 卡可再审批），重放不弹
    通知。订阅与拉取之间到达的活事件会双重出现——状态幂等，仅可能重复
    一行日志，窗口为一次 IPC 往返，可接受。 */
async function replayRecentHarnessEvents(): Promise<void> {
  let raw: unknown[];
  try {
    raw = await harnessRecentEvents();
  } catch (err) {
    console.warn("[harness] 重放事件拉取失败", err);
    return;
  }
  for (const p of raw) {
    try {
      onHarnessUpdate(decodeTaskUpdate(p), true);
    } catch (err) {
      console.warn("[harness] 丢弃形状不符的重放事件", err);
    }
  }
}

/** 重载窗口恢复（素材侧）：hub 是真源，拉最近任务把仍在走且本页未知
    的重建进内存——重载天然可恢复；终态迁移由后续轮询亲见才弹通知。 */
async function recoverMaterialTasks(): Promise<void> {
  let rows;
  try {
    rows = decodeMaterialTaskList(await api("/api/v1/material/generations?limit=20"));
  } catch (err) {
    if (err instanceof SessionExpired) {
      renderLogin();
      return;
    }
    console.warn("[material] 重载恢复拉取失败", err);
    return;
  }
  const rebuild = pickRebuildMaterialTasks(rows, new Set(taskEntries.keys()));
  if (rebuild.length === 0) return;
  for (const t of rebuild) {
    taskEntries.set(t.id, materialEntryOf(t));
  }
  renderTaskDyn();
}

function wireTaskDomain(): void {
  ensureEngineDetailListener();
  const sec = document.getElementById("task-sec");
  if (sec) {
    sec.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      // 统一详情续跑/续聊：切 Agent tab 对应引擎面板（单实例写入口），dsh 回填会话号
      const resume = t.closest("[data-udsh-resume]");
      if (resume instanceof HTMLElement && resume.dataset.udshResume) {
        const sid = resume.dataset.udshResume;
        chooseAgentEngine("dsh");
        gotoTaskTab("agent");
        dshPrefillSession(sid);
        return;
      }
      if (t.closest("[data-upi-open]") !== null) {
        chooseAgentEngine("pi");
        gotoTaskTab("agent");
        return;
      }
      if (t.id === "task-run") {
        void onTaskRun();
        return;
      }
      if (t.id === "material-run") {
        void onMaterialRun();
        return;
      }
      if (t.id === "sched-save") {
        void onSchedSave();
        return;
      }
      if (t.id === "sched-refresh") {
        schedHintFlash("");
        void refreshScheds();
        return;
      }
      if (t.id === "task-tpl-save") {
        onTemplateSave();
        return;
      }
      // 模板 chip：先判尾部 ×（两步删除）再判 chip 本体（回填），× 嵌在 chip 内
      const tplDel = t.closest("[data-tpldel]");
      if (tplDel instanceof HTMLElement && tplDel.dataset.tpldel) {
        onTemplateDeleteClick(tplDel.dataset.tpldel);
        return;
      }
      const tplChip = t.closest("[data-tpl]");
      if (tplChip instanceof HTMLElement && tplChip.dataset.tpl) {
        fillTemplate(tplChip.dataset.tpl);
        return;
      }
      const schTgl = t.closest("[data-schtoggle]");
      if (schTgl instanceof HTMLElement && schTgl.dataset.schtoggle) {
        void onSchedToggle(schTgl.dataset.schtoggle);
        return;
      }
      const schFire = t.closest("[data-sched-fire]");
      if (schFire instanceof HTMLElement && schFire.dataset.schedFire) {
        void onSchedFire(schFire.dataset.schedFire);
        return;
      }
      const schEdit = t.closest("[data-schedit]");
      if (schEdit instanceof HTMLElement && schEdit.dataset.schedit) {
        beginSchedEdit(schEdit.dataset.schedit);
        return;
      }
      const schDel = t.closest("[data-schdel]");
      if (schDel instanceof HTMLElement && schDel.dataset.schdel) {
        onSchedDeleteClick(schDel.dataset.schdel);
        return;
      }
      const mk = t.dataset.matKind;
      if (mk === "image" || mk === "video") {
        materialKind = mk;
        syncMaterialPane();
        return;
      }
      const example = t.dataset.matExample;
      if (example !== undefined) {
        const input = document.getElementById("material-prompt");
        if (input instanceof HTMLInputElement) {
          input.value = example;
          input.focus();
        }
        return;
      }
      const ap = t.dataset.approve;
      if (ap !== undefined) {
        const sel = selectedTask();
        if (sel !== null && sel.source === "harness") void onApprove(Number(sel.id), ap === "1");
        return;
      }
      const asset = t.closest("[data-asset]");
      if (asset instanceof HTMLElement && asset.dataset.asset) {
        void onAssetSave(asset.dataset.asset);
        return;
      }
      const retry = t.closest("[data-retry]");
      if (retry instanceof HTMLElement && retry.dataset.retry) {
        void onMaterialRetry(retry.dataset.retry);
        return;
      }
      if (t.id === "task-abort") {
        const sel = selectedTask();
        if (sel !== null && sel.source === "harness") void onAbort(Number(sel.id));
      }
    });
    // 定时表单计划两态切换 value 输入域提示（change 冒泡到任务域容器）
    sec.addEventListener("change", (ev) => {
      if (ev.target instanceof HTMLElement && ev.target.id === "sched-kind") syncSchedValueField();
    });
  }
  const grid = document.getElementById("aside-grid");
  if (grid) {
    grid.addEventListener("click", (ev) => {
      const cell = ev.target instanceof Element ? ev.target.closest(".cell") : null;
      if (cell instanceof HTMLElement) onUnifiedRowClick(cell);
    });
  }
  const board = document.getElementById("task-board");
  if (board) {
    board.addEventListener("click", (ev) => {
      const card = ev.target instanceof Element ? ev.target.closest(".kbcard") : null;
      if (card instanceof HTMLElement) onUnifiedRowClick(card);
    });
  }
  // 历史素材不存 kind：succeeded 按图直显，视频 URL 加载失败时捕获换外链；
  // 非 http(s) src（safeUrl 不放行）降级为 URL 文本，不留可注入 href
  const dyn = document.getElementById("task-dyn");
  if (dyn) {
    dyn.addEventListener(
      "error",
      (ev) => {
        const t = ev.target;
        if (t instanceof HTMLImageElement && t.classList.contains("mat-img") && t.src) {
          const href = safeUrl(t.src);
          let repl: HTMLElement;
          if (href) {
            const a = document.createElement("a");
            a.className = "mat-link";
            a.href = href;
            a.target = "_blank";
            a.rel = "noreferrer";
            a.textContent = "打开结果 · 新窗口";
            repl = a;
          } else {
            const s = document.createElement("span");
            s.className = "mat-link";
            s.textContent = `结果 URL 协议不受支持 · ${t.src}`;
            repl = s;
          }
          t.replaceWith(repl);
        }
      },
      true,
    );
  }
  renderTaskDyn();
}

/* ── 工具 ── */

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

/** 仅放行 http(s) 素材链接：resultUrl 来自 hub 侧不可信输入，非 http(s)
    scheme（javascript:/data: 等）返回空串，调用方降级为 URL 文本。 */
function safeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : "";
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "NETWORK") return `hub 不可达 · ${hubUrl()}（点下方「修改」可切换地址）`;
    return e.message || `${e.status} ${e.code}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 24 ? t : t.slice(0, 24) + "…";
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "更早";
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/* ── 正文渲染（Two Registers Rule：code/block 落 Mono；R9-A：text 走 marked） ── */

type ContentSeg = { text: string } | { code: string } | { block: string; lang?: string };

function parseContent(content: string): ContentSeg[] {
  const out: ContentSeg[] = [];
  content.split("```").forEach((part, i) => {
    if (i % 2 === 1) {
      let block = part;
      let lang = "";
      const nl = block.indexOf("\n");
      // 围栏首行若是纯语言标记（js / python…）则剥掉并留作标签，空行也剥
      if (nl >= 0) {
        const mark = fenceLanguage(block.slice(0, nl));
        if (mark !== "" || nl === 0) {
          lang = mark;
          block = block.slice(nl + 1);
        }
      }
      out.push(lang !== "" ? { block: block.replace(/\n$/, ""), lang } : { block: block.replace(/\n$/, "") });
    } else if (part.length > 0) {
      part.split("`").forEach((p, j) => {
        if (p.length === 0) return;
        out.push(j % 2 === 1 ? { code: p } : { text: p });
      });
    }
  });
  return out;
}

/** 分段消息（R9-A vision）里的图片段：仅放行 http(s) 与 data:image/，其余降级文本。 */
function safeImgSrc(u: string): string {
  return /^(?:https?:|data:image\/)/i.test(u) ? u : "";
}

function renderMsgImage(url: string): string {
  const src = safeImgSrc(url);
  return src !== ""
    ? `<img class="msg-img" src="${esc(src)}" alt="图片" loading="lazy">`
    : `<span class="mat-link">图片 URL 协议不受支持 · ${esc(url)}</span>`;
}

/** 正文渲染：parts 形态逐段展开（text 段复用纯文本管线，image 段出缩略图）。 */
function renderContentHTML(content: string | ContentPart[]): string {
  if (typeof content !== "string") {
    return content.map((p) => (p.type === "text" ? renderContentHTML(p.text) : renderMsgImage(p.image_url.url))).join("");
  }
  // 连续 text/code 段重组为原串（单反引号还原），交给 marked 一体解析——
  // 逐段独立渲染会把行内代码切成孤立 <p>，打碎段落流
  const out: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      out.push(renderRich(run.join("`")));
      run = [];
    }
  };
  for (const seg of parseContent(content)) {
    if ("block" in seg) {
      flush();
      out.push(renderCodeBlock(seg.block, seg.lang));
    } else {
      run.push("text" in seg ? seg.text : seg.code);
    }
  }
  flush();
  return out.join("");
}

/** 消息文本视图（标题/复制/重发用）：parts 取 text 段拼接。 */
function textOfContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/* ── 壳层渲染 ── */

function renderHeader(user: string): string {
  return `
<header>
  <span class="brand">${brand}</span>
  <div class="domains" role="group" aria-label="工作域切换">
    ${domains
      .map(
        (d) =>
          `<button type="button" id="btn-${d.id}" data-domain="${d.id}" aria-pressed="false">${d.label}</button>`,
      )
      .join("")}
  </div>
  <button type="button" class="taskbadge" id="task-badge" hidden></button>
  <div class="thist" id="task-hist" hidden></div>
  <span class="spacer"></span>
  <span class="route" id="route-info">${routeInfoHTML()}</span>
  <span class="user" id="user-slot">${esc(user)}</span>
</header>`;
}

/** 任务中心徽标（R6-A#3，口径改统一列表）：RUN n · HOLD m mono 读数，全类型
    计数（badgeCountsOf：run=RUN hold=HOLD，pending/done/fail 不计），二者皆零
    隐藏。数据源与刷新时机同统一列表（tasks_unified 10s 轮询/事件/素材迁移都
    经 renderTaskDyn 顺带刷新——后台 dsh/sched 跑动也随轮询反映）。 */
function updateTaskBadge(): void {
  const el = document.getElementById("task-badge");
  if (!el) return;
  const { run, hold } = badgeCountsOf(unifiedRowsCache);
  if (run === 0 && hold === 0) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  const seg = (word: string, n: number, cls: string) => (n > 0 ? ` <b class="${cls}">${word} ${n}</b>` : "");
  el.innerHTML = `任务中心${seg("RUN", run, "run")}${seg("HOLD", hold, "hd")}`;
}

/** 任务历史面板行（含搜索过滤后的全量条目，新→旧）。 */
function renderTaskHist(filter: string): string {
  const q = filter.trim().toLowerCase();
  const rows: string[] = [];
  const entries = [...taskEntries.values()].reverse();
  for (const e of entries) {
    const title = e.source === "material" ? e.prompt : e.goal;
    if (q !== "" && !title.toLowerCase().includes(q)) continue;
    const b = statusBadge(e);
    const time = e.source === "material" ? materialTime(e.createdAt) : materialTime(new Date(e.startedAt).toISOString());
    rows.push(
      `<div class="trow" data-tid="${esc(e.id)}" role="button" tabindex="0"><span class="st ${b.cls}">${b.word}</span><span class="ttl">${esc(title)}</span><span class="tm">${esc(time)}</span></div>`,
    );
  }
  const list = rows.length > 0 ? rows.join("") : `<div class="task-empty">无匹配任务</div>`;
  return `
  <input type="search" id="thist-q" placeholder="搜索任务标题…" value="${esc(filter)}">
  <div class="tlist">${list}</div>`;
}

/** 徽标与历史面板接线（renderShell 后一次性装；面板行点击经容器委托）。 */
function wireTaskBadge(): void {
  const badge = document.getElementById("task-badge");
  const panel = document.getElementById("task-hist");
  if (!badge || !panel) return;
  badge.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      panel.innerHTML = renderTaskHist("");
      const q = document.getElementById("thist-q");
      if (q instanceof HTMLInputElement) q.focus();
    }
  });
  document.addEventListener("click", (ev) => {
    if (panel.hidden) return;
    const t = ev.target;
    if (t instanceof Node && badge.contains(t)) return;
    if (t instanceof Node && panel.contains(t)) return;
    panel.hidden = true;
  });
  panel.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const row = t.closest(".trow");
    if (row instanceof HTMLElement && row.dataset.tid) {
      const id = row.dataset.tid;
      if (taskEntries.has(id)) {
        taskSelected = id;
        taskSelKind = taskEntries.get(id)?.source ?? "harness";
        setView("task");
        renderTaskDyn();
      }
      panel.hidden = true;
      return;
    }
    if (t.id === "thist-q") return;
  });
  panel.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.id === "thist-q") {
      const scroll = t.selectionStart;
      panel.innerHTML = renderTaskHist(t.value);
      const q2 = document.getElementById("thist-q");
      if (q2 instanceof HTMLInputElement) {
        q2.focus();
        if (scroll !== null) q2.setSelectionRange(scroll, scroll);
      }
    }
  });
}

/** 顶栏 ROUTE 行真数据（P1-8）：当前 chip 模型 + 托管池模型数 + BYOK 条数
    （无 BYOK 整段省略）。与 model-chip 同源（modelSeq/modelIdx），chip 动即重绘。 */
function routeInfoHTML(): string {
  if (!chatState.modelsLoaded) return `ROUTE <b>…</b>`;
  if (parallelOn) return `ROUTE <b>并答 ${parallelPickedRefs().length} 模型</b> / 托管池 ${chatState.models.length} 模型`;
  const m = currentModel();
  const route = m !== null ? esc(modelKey(m)) : "—";
  const byok = chatState.byok.length > 0 ? ` · BYOK <b>${chatState.byok.length} 个</b>` : "";
  return `ROUTE <b>${route}</b> / 托管池 ${chatState.models.length} 模型${byok}`;
}

function renderRouteInfo(): void {
  const el = document.getElementById("route-info");
  if (el) el.innerHTML = routeInfoHTML();
}

function renderRail(): string {
  const sec = (s: (typeof railSections)[number]): string => {
    const attrs = s.domain ? ` data-sec="${s.domain}" data-domain="${s.domain}"` : "";
    return `
    <button type="button" class="sec${s.group === "platform" ? " platform" : ""}"${attrs}>
      <div class="no">${s.no}</div><div class="nm">${s.name}</div>
    </button>`;
  };
  const work = railSections.filter((s) => s.group === "work").map(sec).join("");
  const platform = railSections.filter((s) => s.group === "platform").map(sec).join("");
  return `
<nav class="rail" aria-label="分区导航">
  ${work}
  <div class="divider" role="separator"></div>
  ${platform}
  <div class="foot">${railFoot}</div>
</nav>`;
}

function telemHTML(cells: TelemetryCell[]): string {
  return cells
    .map((t) => {
      const cls = ["v", t.readout && "readout", t.compact && "compact"].filter(Boolean).join(" ");
      return `
    <div class="t"><div class="l">${t.label}</div><div class="${cls}">${t.value}${t.unit ? `<small>${t.unit}</small>` : ""}</div></div>`;
    })
    .join("");
}

/** 非 Tauri 环境的「内置」tab 内容：静态示例（data.ts 演示数据）。 */
function renderTaskDemoBody(): string {
  const log = flightLog
    .map(
      (r) => `
    <div class="row"><span class="tstamp">${r.stamp}</span><span class="evt${r.tone ? ` ${logToneClass[r.tone]}` : ""}"><b>${r.event}</b>${r.rest}</span></div>`,
    )
    .join("");
  const diff = hold.diff.map((l) => `<span class="${l.kind}">${l.kind === "del" ? "- " : "+ "}${l.text}</span>`).join("\n");
  return `
  <div class="kicker-row">
    <span class="phase">${taskHeader.phase}</span>
    <h1>${taskHeader.title}<span class="live">${taskHeader.live}</span></h1>
    ${demoTagHTML()}
  </div>
  <div class="telem">${telemHTML(telemetry)}
  </div>
  <div class="log">${log}
  </div>
  <div class="hold">
    <div class="bar"><span class="tag">HOLD</span><span class="desc">${hold.desc}</span></div>
    <div class="diff">${diff}</div>
    <div class="acts">${holdActions.map((a, i) => `<button type="button" class="btn ${i === 0 ? "pri" : "sec"}" disabled>${a}</button>`).join("")}</div>
  </div>`;
}

/** 任务域（两环境同一模板）：一级 tab 内置|素材|Agent|定时（PI/DSH 引擎在 Agent 面板内
    分段切换，案 1；定时=桌面常驻调度，浏览器态整 tab 降级）；
    素材走 hub HTTP，浏览器降级环境同样可用。
    结果主区（kicker+dyn）是 tabs 下的共享详情容器 #task-detail，内置/素材共用——不随任一
    tab 面板的 hidden 连带隐藏（否则素材结果在素材 tab 不可达）；浏览器态同样输出骨架，
    renderTaskDyn 才有落点（素材是浏览器态唯一可用任务能力）。 */
function renderTaskSection(): string {
  const builtin = inTauri
    ? `
  <div class="launch" id="task-launch">
    <div class="fld grow"><label for="task-goal">GOAL</label><input id="task-goal" type="text" placeholder="目标，如：梳理 docs 并生成周报"></div>
    <div class="fld wd"><label for="task-wd">WORKDIR</label><input id="task-wd" type="text" placeholder="信任目录绝对路径"></div>
    <div class="fld md"><label for="task-model">MODEL</label><select id="task-model"></select></div>
    <button type="button" class="btn pri" id="task-run">发起任务</button>
    <button type="button" class="btn sec" id="task-tpl-save">存为模板</button>
    <span class="hint" id="task-hint"></span>
  </div>
  <div class="tpl-row" id="tpl-row"></div>`
    : `
${desktopOnlyNote("agent 任务", "素材生成可用（切「素材」tab）· 以下为静态示例")}
${renderTaskDemoBody()}`;
  const sched = inTauri
    ? `
  <div class="launch" id="sched-launch">
    <div class="fld"><label for="sched-name">NAME</label><input id="sched-name" type="text" placeholder="如：nightly-report"></div>
    <div class="fld"><label for="sched-kind">计划</label><select id="sched-kind"><option value="interval">每 N 分钟</option><option value="daily">每天 HH:MM</option></select></div>
    <div class="fld"><label for="sched-value">VALUE</label><input id="sched-value" type="text" placeholder="分钟数，如 30"></div>
    <div class="fld grow"><label for="sched-goal">GOAL</label><input id="sched-goal" type="text" placeholder="目标，如：梳理 docs 并生成周报"></div>
    <div class="fld wd"><label for="sched-wd">WORKDIR</label><input id="sched-wd" type="text" placeholder="信任目录绝对路径"></div>
    <div class="fld hook"><label for="sched-hook">WEBHOOK</label><input id="sched-hook" type="text" placeholder="可选 · 终态推送 http(s) URL"></div>
    <button type="button" class="btn pri" id="sched-save">添加</button>
    <button type="button" class="btn sec" id="sched-refresh">刷新</button>
    <span class="hint" id="sched-hint"></span>
  </div>
  <div id="sched-list"><div class="bk-empty">加载中…</div></div>`
    : desktopOnlyNote("定时任务", "调度线程由桌面应用常驻执行");
  return `
<section class="task" aria-label="任务域" id="task-sec">
  <div class="taskbar">
    <div class="tabs" id="task-tabs" role="tablist" aria-label="任务类型切换"></div>
    <button type="button" class="viewtoggle mono" id="task-view-toggle" aria-pressed="false" title="任务列视图：列表 ⇄ 看板">看板</button>
  </div>
  <div id="task-detail">
    <div class="kicker-row" id="task-kicker"></div>
    <div id="task-dyn"></div>
  </div>
  <div id="task-board" hidden></div>
  <div id="task-builtin">${builtin}
  </div>
  <div id="task-material" hidden>
    <div class="tabs mat-kind" id="mat-kind" role="tablist" aria-label="素材类型切换">
      <button type="button" data-mat-kind="image" aria-selected="true">图</button>
      <button type="button" data-mat-kind="video" aria-selected="false">视频</button>
    </div>
    <div class="launch">
      <div class="fld grow"><label for="material-prompt">PROMPT</label><input id="material-prompt" type="text" placeholder="描述要生成的画面，如：冷白纸面上的任务报告封面"></div>
      <button type="button" class="btn pri" id="material-run">生成图片</button>
      <span class="hint" id="material-hint"></span>
    </div>
    <div class="mat-examples">${materialExampleChipsHTML()}</div>
  </div>
  <div id="task-agent" hidden>
    <div class="kicker-row">
      <span class="phase">AGENT · ENGINE</span>
      <div class="tabs mat-kind" id="eng-kind" role="tablist" aria-label="Agent 引擎切换">
        <button type="button" data-engine="pi" aria-selected="true">PI 会话式</button>
        <button type="button" data-engine="dsh" aria-selected="false">DSH 任务式</button>
      </div>
      <span class="eng-meta" id="eng-desc"></span>
    </div>
    <div id="task-sidecar"></div>
  </div>
  <div id="task-sched" hidden>${sched}
  </div>
</section>`;
}

/* ── 附件输入（R9-A A1 图片 / R11-B U3 通用附件）：paste / drop / 附件按钮
   三入口；图片限 3 图/条、4MB/图，文本白名单 ≤256K 作本轮资料前缀 ── */

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = REF_MAX_BYTES;

/** 待发图片（读成 dataURL，随消息 parts 内联发出）。 */
interface PendingImage {
  name: string;
  dataUrl: string;
}

/** 待发文本附件（读成字符串，发送时并入本轮资料前缀）。 */
interface PendingText {
  name: string;
  text: string;
}

let pendingImages: PendingImage[] = [];
let pendingTexts: PendingText[] = [];
let composerHintTimer: number | undefined;

/** 拒收提示：composer 上方红字，2.5s 自愈（env/资产复制反馈同款节律）。 */
function composerHintFlash(text: string): void {
  const hint = document.getElementById("composer-hint");
  if (!hint) return;
  hint.textContent = text;
  hint.hidden = false;
  window.clearTimeout(composerHintTimer);
  composerHintTimer = window.setTimeout(() => {
    hint.hidden = true;
  }, 2500);
}

/** 待发预览条：图片缩略图 + 文本附件（文件名 + 字数，区别于缩略图）。 */
function renderImgBar(): void {
  const bar = document.getElementById("img-bar");
  if (!bar) return;
  bar.hidden = pendingImages.length === 0 && pendingTexts.length === 0;
  bar.innerHTML =
    pendingImages
      .map(
        (p, i) =>
          `<div class="imgthumb"><img src="${esc(p.dataUrl)}" alt="${esc(p.name || "待发图片")}"><button type="button" class="imgdel" data-imgdel="${i}" title="移除">×</button></div>`,
      )
      .join("") +
    pendingTexts
      .map(
        (t, i) =>
          `<div class="imgthumb txtthumb" title="${esc(t.name)}"><span class="tname">${esc(t.name)}</span><span class="tn">${t.text.length} 字</span><button type="button" class="imgdel" data-txtdel="${i}" title="移除">×</button></div>`,
      )
      .join("");
}

function clearAttachments(): void {
  pendingImages = [];
  pendingTexts = [];
  renderImgBar();
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.addEventListener("load", () => resolve(String(r.result)));
    r.addEventListener("error", () => reject(r.error));
    r.readAsDataURL(file);
  });
}

/** 批量收图：超量/超尺寸整批拒收并提示（确定性优于部分收）。 */
function addImages(files: File[]): void {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (imgs.length === 0) return;
  if (pendingImages.length + imgs.length > MAX_IMAGES) {
    composerHintFlash(`每条消息最多 ${MAX_IMAGES} 张图`);
    return;
  }
  const oversize = imgs.find((f) => f.size > MAX_IMAGE_BYTES);
  if (oversize) {
    composerHintFlash(`单图不超过 4MB · 已拒收 ${oversize.name || "该图片"}`);
    return;
  }
  void Promise.all(imgs.map(readAsDataURL))
    .then((urls) => {
      urls.forEach((dataUrl, i) => pendingImages.push({ name: imgs[i].name, dataUrl }));
      renderImgBar();
    })
    .catch((e) => {
      console.warn("[chat] 图片读取失败", e);
      composerHintFlash("图片读取失败");
    });
}

/** 附件分型（R11-B U3）：image/* 走图片管线；文本白名单扩展名 ≤256K 读文本
    入待发资料；其余（二进制 / 超限文本）errline 拒收提示。 */
function addAttachments(files: File[]): void {
  const imgs: File[] = [];
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      imgs.push(f);
      continue;
    }
    if (!isTextFile(f.name)) {
      composerHintFlash(`不支持的附件类型 · ${f.name || "该文件"}（支持图片与文本文件）`);
      continue;
    }
    if (f.size > MAX_TEXT_BYTES) {
      composerHintFlash(`文本附件不超过 ${Math.round(MAX_TEXT_BYTES / 1024)}KB · 已拒收 ${f.name || "该文件"}`);
      continue;
    }
    void readFileText(f)
      .then((text) => {
        pendingTexts.push({ name: f.name, text });
        renderImgBar();
      })
      .catch((e) => {
        console.warn("[chat] 文本附件读取失败", e);
        composerHintFlash("文本附件读取失败");
      });
  }
  if (imgs.length > 0) addImages(imgs);
}

/* 窗口级拖放（R11-B U2）：document 级拦 dragover/drop（webview 不再跳转打开
   文件），drop 统一进附件管线；dragenter/dragleave 深度计数驱动 composer
   .dragging 高亮（子元素间移动不抖动）。模块级注册一次，重登重绘不重复挂。 */
let dragDepth = 0;
document.addEventListener("dragenter", () => {
  dragDepth += 1;
  document.getElementById("composer")?.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.getElementById("composer")?.classList.remove("dragging");
  }
});
document.addEventListener("dragover", (ev) => ev.preventDefault());
document.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  document.getElementById("composer")?.classList.remove("dragging");
  if (ev.dataTransfer) addAttachments([...ev.dataTransfer.files]);
});

/** 发送载荷：无图=纯 string（零变化）；有图=vision parts，空文字补「[图片]」占位。 */
function wireContent(text: string): string | ContentPart[] {
  if (pendingImages.length === 0) return text;
  return [
    { type: "text", text: text !== "" ? text : "[图片]" },
    ...pendingImages.map((p): ContentPart => ({ type: "image_url", image_url: { url: p.dataUrl } })),
  ];
}

/** 全屏图片预览 overlay（比新 webview 窗口轻；ESC/点击关闭）。 */
let imgviewEl: HTMLDivElement | null = null;

function openImageOverlay(src: string): void {
  if (imgviewEl === null) {
    imgviewEl = document.createElement("div");
    imgviewEl.className = "imgview";
    imgviewEl.hidden = true;
    imgviewEl.innerHTML = `<img alt="图片预览">`;
    imgviewEl.addEventListener("click", () => {
      if (imgviewEl) imgviewEl.hidden = true;
    });
    document.body.append(imgviewEl);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && imgviewEl && !imgviewEl.hidden) imgviewEl.hidden = true;
    });
  }
  const img = imgviewEl.querySelector("img");
  if (img) img.src = src;
  imgviewEl.hidden = false;
}

function renderChatShell(): string {
  return `
<section class="chatcol" aria-label="对话域">
  <div class="chats" id="chats"></div>
  <div class="chatmain">
    <div class="stream" id="stream"></div>
    <div class="imgbar" id="img-bar" hidden></div>
    <div class="composer" id="composer">
      <div class="atpanel" id="at-panel" hidden></div>
      <div class="atpanel ppanel" id="parallel-panel" hidden></div>
      <div class="atpanel ppanel" id="model-menu" hidden></div>
      <span class="hint" id="composer-hint" hidden></span>
      <button type="button" class="ptoggle" id="parallel-toggle" aria-pressed="false" title="多模型并答 · 2-4 路对照，关闭时零变化">并答</button>
      <button type="button" class="chip" id="model-chip" title="模型">…</button>
      <button type="button" class="attach" id="img-attach" title="附件（图片 / 文本文件 · 也可直接粘贴 / 拖放到窗口）">附件</button>
      <textarea id="composer-input" rows="1" placeholder="继续对话，或 @ 唤起工具 / 切换模型路由" aria-label="消息输入"></textarea>
      <button type="button" class="send" id="composer-send">发送</button>
      <span class="ckey">Enter 发送 · Shift+Enter 换行</span>
      <input type="file" id="img-file" accept="*/*" multiple hidden>
    </div>
  </div>
</section>`;
}

/* ── @ 补全面板（R6-B U1，拍板：@语法触发）─────────────
   输入以 @ 开头（首字符、未跟空格完成选择前）弹出候选；Esc 关；Enter 选首项
   （面板开着时 Enter 是选择不是发送）；点击直选。候选项静态起步，U2 接 @agent 行为。 */
interface AtItem {
  trigger: string;
  desc: string;
}

const AT_ITEMS: readonly AtItem[] = [
  { trigger: "@agent", desc: "自然语言发起 harness 任务" },
  { trigger: "@生图", desc: "素材生成 · 图" },
  { trigger: "@资料", desc: "本轮资料 · URL 抓取或粘贴文本" },
  { trigger: "@知识库", desc: "知识库检索 · 命中段落自动注入" },
];
const AT_TRIGGERS: readonly string[] = AT_ITEMS.map((i) => i.trigger);

/* U5 @技能补全：候选 = 静态 @agent + 记忆 workdir 下 .skills 扫描结果
   （Tauri 专属；浏览器降级仅 @agent）。按 workdir 缓存，发送分派同源。 */
let atSkillItems: AtItem[] = [];
let atSkillWorkdir: string | null = null;

/* R10-A A2 @提示词 动态项：提示词库每条一项（promptRows 模块态，设置页
   增删改与启动加载共用）；与内置触发词同名者让位——@知识库 等内置路由
   不被同名提示词劫持，发送路径零新增解析（提示词是插入不发送）。 */
let promptRows: PromptItem[] = [];

function atPromptItems(): AtItem[] {
  return promptRows
    .filter((p) => !AT_TRIGGERS.includes("@" + p.name))
    .map((p) => ({ trigger: "@" + p.name, desc: promptDesc(p.body) }));
}

async function refreshAtSkills(): Promise<void> {
  if (!inTauri) return;
  const workdir = await prefGet("chat.workdir").catch(() => null);
  if (!workdir || workdir === atSkillWorkdir) return;
  try {
    atSkillItems = (await skillsList(workdir)).map((s) => ({
      trigger: "@" + s.name,
      desc: "技能 · " + s.description,
    }));
    atSkillWorkdir = workdir;
  } catch (e) {
    console.warn("[chat] 技能扫描失败", e);
    return;
  }
  atPanelSync();
}

function atItems(): AtItem[] {
  return AT_ITEMS.concat(atSkillItems, atPromptItems());
}

function atPanelSync(): void {
  const panel = document.getElementById("at-panel");
  const input = document.getElementById("composer-input");
  if (!(panel instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement)) return;
  const v = input.value;
  if (v.startsWith("@") && !v.includes(" ")) {
    // @ 面板与并答选模/模型菜单同位（composer 左下），互斥避免叠层
    const ppanel = document.getElementById("parallel-panel");
    if (ppanel instanceof HTMLElement) ppanel.hidden = true;
    const mmenu = document.getElementById("model-menu");
    if (mmenu instanceof HTMLElement) mmenu.hidden = true;
    void refreshAtSkills();
    const q = v.slice(1).toLowerCase();
    const items = atItems().filter((i) => i.trigger.slice(1).startsWith(q));
    panel.hidden = items.length === 0;
    panel.innerHTML = items
      .map(
        (i, idx) =>
          `<div class="atitem${idx === 0 ? " cur" : ""}" data-at="${i.trigger}" role="button" tabindex="0"><b>${esc(i.trigger)}</b><span>${esc(i.desc)}</span></div>`,
      )
      .join("");
    return;
  }
  panel.hidden = true;
}

function atPanelAccept(trigger: string): void {
  const input = document.getElementById("composer-input");
  const panel = document.getElementById("at-panel");
  if (!(input instanceof HTMLTextAreaElement) || !(panel instanceof HTMLElement)) return;
  // @提示词：选中=插入不发送——body 替换整框 @token（面板只在输入=单个
  // @token 时弹，token 即全部内容），光标落 body 末尾供续写问题
  const body = atAcceptValue(trigger, promptRows, AT_TRIGGERS);
  input.value = body !== null ? body : `${trigger} `;
  panel.hidden = true;
  input.focus();
  if (body !== null) input.setSelectionRange(body.length, body.length);
}

/** 任务列（统一行混排五源；底部素材用量汇总行）。 */
function renderAsideLive(): string {
  return `
<aside aria-label="任务列">
  <h2>任务列</h2>
  <div class="grid" id="aside-grid"></div>
  <div class="mono usage-line" id="usage-line"></div>
  <div class="sysprobe" id="sysprobe" hidden></div>
</aside>`;
}

const logToneClass: Record<"ok" | "hold", string> = { ok: "ok", hold: "holdline" };

/* ── 任务域一级 tab：内置 | 素材 | Agent | 定时（PI/DSH 引擎在 Agent 面板内分段切换） ── */

type TaskTab = "builtin" | "material" | "agent" | "sched";

/** Agent 引擎两态注册表（形态分工，案 1）。 */
type AgentEngine = "pi" | "dsh";
const AGENT_ENGINES: { id: AgentEngine; label: string; desc: string }[] = [
  { id: "pi", label: "PI 会话式", desc: "交互会话 · 在场讨论式编码" },
  { id: "dsh", label: "DSH 任务式", desc: "一次性任务 · 跑完出终答" },
];

/** 当前 Agent 引擎（选择记忆 prefs agent.engine，默认 pi）。 */
let agentEngine: AgentEngine = "pi";

/** 分段控件与描述行随 agentEngine 重绘（模板初始钉 pi，恢复/切换后都经此同步，幂等）。 */
function syncEngineKind(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#eng-kind button")) {
    b.setAttribute("aria-selected", String(b.dataset.engine === agentEngine));
  }
  const desc = document.getElementById("eng-desc");
  if (desc) desc.textContent = AGENT_ENGINES.find((e) => e.id === agentEngine)?.desc ?? "";
}

/** 引擎面板互斥挂载（沿用 tab 切换模式：先卸对面引用再挂本面，innerHTML 整体重写）。 */
function mountAgentPanel(): void {
  const engineEl = document.getElementById("task-sidecar");
  if (!engineEl) return;
  if (agentEngine === "dsh") mountDshPanel(engineEl);
  else unmountDshPanel();
  if (agentEngine === "pi") mountEnginePanel(engineEl);
  else unmountEnginePanel();
}

/** 用户切换引擎：重挂面板 + 记忆选择（chat.workdir 同款尽力而为，浏览器态无本地库不写）。 */
function chooseAgentEngine(e: AgentEngine): void {
  if (e === agentEngine) return;
  agentEngine = e;
  syncEngineKind();
  mountAgentPanel();
  if (inTauri) {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("pref_set", { key: "agent.engine", value: e }))
      .catch((err) => console.warn("[agent] 引擎记忆写入失败", err));
  }
}

/** 启动恢复上次引擎：只落状态与控件；面板挂载仍随 Agent tab 选中发生（避免启动即
    订阅引擎事件）。 */
function restoreAgentEngine(): void {
  if (!inTauri) return;
  void prefGet("agent.engine")
    .then((v) => {
      if (v !== "pi" && v !== "dsh") return;
      agentEngine = v;
      syncEngineKind();
      if (document.getElementById("task-agent")?.hidden === false) mountAgentPanel();
    })
    .catch((err) => console.warn("[agent] 引擎记忆读取失败", err));
}

/** 任务域共享区显隐（T2）：详情区只属内置|素材两 tab 且仅列表态；看板任何 tab
    都可见（Agent/定时 tab 上看全局正是混跑场景）。切钮文案=目标视图。 */
function syncTaskPanes(): void {
  const detail = document.getElementById("task-detail");
  const board = document.getElementById("task-board");
  const toggle = document.getElementById("task-view-toggle");
  if (detail) detail.hidden = taskTabNow === "agent" || taskTabNow === "sched" || taskView === "board";
  if (board) board.hidden = taskView !== "board";
  if (toggle) {
    toggle.textContent = taskView === "board" ? "列表" : "看板";
    toggle.setAttribute("aria-pressed", String(taskView === "board"));
  }
}

/** 视图形态切换（列表 ⇄ 看板）：prefs "task.view" 记忆（agent.engine 同款尽力而为，
    浏览器态内存态即止）。 */
function setTaskView(mode: TaskViewMode): void {
  const changed = mode !== taskView;
  taskView = mode;
  syncTaskPanes();
  if (changed) {
    renderTaskDyn();
    if (inTauri) {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("pref_set", { key: "task.view", value: mode }))
        .catch((err) => console.warn("[tasks] 视图记忆写入失败", err));
    }
  }
}

/** 启动恢复上次视图形态（restoreAgentEngine 同款，浏览器态无本地库不读）。 */
function restoreTaskView(): void {
  if (!inTauri) return;
  void prefGet("task.view")
    .then((v) => {
      if (v === "board" || v === "list") setTaskView(v);
    })
    .catch((err) => console.warn("[tasks] 视图记忆读取失败", err));
}

/** 装配一级 tab（#task-tabs 由任务域模板提供）；Agent tab 顶部引擎分段控件，
    DSH 挂 dsh.ts 一次性任务面板、PI 挂 engine.ts 会话面板（浏览器内均自降级为提示行）。 */
function mountTaskTabs(): void {
  const bar = document.getElementById("task-tabs");
  if (!bar) return;
  const toggle = document.getElementById("task-view-toggle");
  if (toggle) toggle.addEventListener("click", () => setTaskView(taskView === "list" ? "board" : "list"));
  const tabs: { id: TaskTab; label: string }[] = [
    { id: "builtin", label: "内置" },
    { id: "material", label: "素材" },
    { id: "agent", label: "Agent" },
    { id: "sched", label: "定时" },
  ];
  const buttons = new Map<TaskTab, HTMLButtonElement>();
  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.addEventListener("click", () => select(t.id));
    bar.append(btn);
    buttons.set(t.id, btn);
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#eng-kind button")) {
    btn.addEventListener("click", () => {
      const e = btn.dataset.engine;
      if (e === "pi" || e === "dsh") chooseAgentEngine(e);
    });
  }
  const select = (id: TaskTab): void => {
    for (const [tid, btn] of buttons) btn.setAttribute("aria-selected", String(tid === id));
    taskTabNow = id;
    syncTaskPanes();
    const builtinEl = document.getElementById("task-builtin");
    if (builtinEl) builtinEl.hidden = id !== "builtin";
    const materialEl = document.getElementById("task-material");
    if (materialEl) materialEl.hidden = id !== "material";
    const agentEl = document.getElementById("task-agent");
    if (agentEl) {
      agentEl.hidden = id !== "agent";
      if (id === "agent") mountAgentPanel();
      else {
        unmountDshPanel();
        unmountEnginePanel();
      }
    }
    const schedEl = document.getElementById("task-sched");
    if (schedEl) schedEl.hidden = id !== "sched";
    schedTabShown = id === "sched";
    if (id === "sched") void refreshScheds();
  };
  syncEngineKind();
  restoreAgentEngine();
  restoreTaskView();
  select("builtin");
}

/* ── R10-B B2 定时任务 + B3 任务模板：schedules 走 Rust 命令（与 src-tauri 契约
     逐字一致，snake_case）；模板走 prefs "task.templates"（浏览器 localStorage 兜底，
     同 prompts 先例）。列表刷新取从简档：tab 进入 + 每次变更后 + 手动刷新钮，不做
     30s 轮询——轮询重绘会打断行内编辑表单，且最细计划粒度即 ≥1 分钟。 ── */

let schedRows: ScheduleRow[] = [];
let schedTabShown = false; // 当前一级 tab 是否定时（任务域重进入时补一次拉取）
let schedDelArm: ArmState = { sid: null, at: 0 };
let schedArmTimer: ReturnType<typeof setTimeout> | null = null;

let tplRows: TemplateItem[] = [];
let tplDelArm: ArmState = { sid: null, at: 0 };
let tplArmTimer: ReturnType<typeof setTimeout> | null = null;

const TPL_PREF_KEY = "task.templates";
const TPL_LS_KEY = "cp.taskTemplates";

async function loadTemplateStore(): Promise<string | null> {
  if (!inTauri) return localStorage.getItem(TPL_LS_KEY);
  return prefGet(TPL_PREF_KEY).catch(() => null);
}

/** 写穿：尽力而为（失败仅日志，内存态已是真源）。 */
function saveTemplateStore(value: string): void {
  if (!inTauri) {
    try {
      localStorage.setItem(TPL_LS_KEY, value);
    } catch (err) {
      console.warn("[templates] 存储写入失败", err);
    }
    return;
  }
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("pref_set", { key: TPL_PREF_KEY, value }))
    .catch((err) => console.warn("[templates] 存储写入失败", err));
}

/** 模板 chip 行（内置 tab 发起条下方）：点击回填表单，尾部 × 两步删除。 */
function renderTplRow(): void {
  const box = document.getElementById("tpl-row");
  if (!box) return;
  box.innerHTML = tplRows
    .map(
      (t) =>
        `<button type="button" class="mat-example" data-tpl="${esc(t.id)}" title="${esc(t.goal)}">${esc(t.name)}<span class="tpl-x${tplDelArm.sid === t.id ? " armed" : ""}" data-tpldel="${esc(t.id)}">${tplDelArm.sid === t.id ? "确认删" : "×"}</span></button>`,
    )
    .join("");
}

/** 自存储重读（启动与存/删后）；浏览器态 chip 行无落点（#tpl-row 不渲染），仅养内存态。 */
async function refreshTemplates(): Promise<void> {
  try {
    tplRows = parseTemplates(await loadTemplateStore());
  } catch (e) {
    console.warn("[templates] 读取失败", e);
    return;
  }
  renderTplRow();
}

/** 存为模板：当前表单值（goal+workdir）入模板库，名字取 goal 前 12 字；同内容不重复存。 */
function onTemplateSave(): void {
  const goalEl = document.getElementById("task-goal");
  const wdEl = document.getElementById("task-wd");
  const hint = document.getElementById("task-hint");
  if (
    !(goalEl instanceof HTMLInputElement) ||
    !(wdEl instanceof HTMLInputElement) ||
    !(hint instanceof HTMLElement)
  ) {
    return;
  }
  const goal = goalEl.value.trim();
  if (goal === "") {
    hint.textContent = "存模板需先填 goal";
    return;
  }
  const workdir = wdEl.value.trim();
  if (tplRows.some((t) => t.goal === goal && t.workdir === workdir)) {
    hint.textContent = "已有相同内容的模板";
    return;
  }
  hint.textContent = "";
  tplRows.unshift({ id: crypto.randomUUID(), name: templateNameOf(goal), goal, workdir });
  saveTemplateStore(serializeTemplates(tplRows));
  renderTplRow();
}

/** chip 点击回填发起条（只回填不自动发起，留人核对 goal/workdir）。 */
function fillTemplate(id: string): void {
  const t = tplRows.find((x) => x.id === id);
  if (t === undefined) return;
  const goalEl = document.getElementById("task-goal");
  const wdEl = document.getElementById("task-wd");
  if (goalEl instanceof HTMLInputElement) goalEl.value = t.goal;
  if (wdEl instanceof HTMLInputElement) wdEl.value = t.workdir;
  goalEl?.focus();
}

/** chip 尾部 ×：armClick 状态机两步确认（MCP/会话/知识库删除同款）；确认后写穿。 */
function onTemplateDeleteClick(id: string): void {
  if (tplArmTimer !== null) {
    clearTimeout(tplArmTimer);
    tplArmTimer = null;
  }
  const r = armClick(tplDelArm, id, Date.now());
  tplDelArm = r.next;
  if (!r.run) {
    tplArmTimer = setTimeout(() => {
      if (armExpired(tplDelArm, Date.now())) {
        tplDelArm = { sid: null, at: 0 };
        renderTplRow();
      }
    }, ARM_WINDOW_MS + 20);
    renderTplRow();
    return;
  }
  tplDelArm = { sid: null, at: 0 };
  tplRows = tplRows.filter((x) => x.id !== id);
  saveTemplateStore(serializeTemplates(tplRows));
  renderTplRow();
}

function schedHintFlash(text: string): void {
  const hint = document.getElementById("sched-hint");
  if (hint) hint.textContent = text;
}

function renderSchedArea(): void {
  const box = document.getElementById("sched-list");
  if (!box) return;
  if (schedRows.length === 0) {
    box.innerHTML = `<div class="bk-empty">暂无定时任务 · 上方添加</div>`;
    return;
  }
  box.innerHTML =
    `<div class="schedgrid sched-head"><span>状态</span><span>NAME</span><span>计划</span><span>下次</span><span>WORKDIR</span><span></span></div>` +
    schedRows.map((s) => schedRowHTML(s, schedDelArm.sid === s.id)).join("");
}

async function refreshScheds(): Promise<void> {
  if (!inTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    schedRows = decodeScheduleList(await invoke<unknown>("schedule_list"));
  } catch (e) {
    console.warn("[sched] 列表拉取失败", e);
    schedHintFlash(errText(e));
  }
  renderSchedArea();
}

/** 计划两态切换 value 输入域提示（校验域在 parseSchedValue 按 kind 定）。 */
function syncSchedValueField(): void {
  const kindEl = document.getElementById("sched-kind");
  const valEl = document.getElementById("sched-value");
  if (!(kindEl instanceof HTMLSelectElement) || !(valEl instanceof HTMLInputElement)) return;
  valEl.placeholder = kindEl.value === "daily" ? "每天时刻 HH:MM，如 09:30" : "分钟数，如 30";
}

/** 添加表单收集与校验：不合法回 null 并出 hint（value 域提示按 kind 切换，
    返回值已规整——契约 value 恒 string；webhook 可选，空=不推送）。 */
function schedFormValues(): {
  name: string;
  kind: SchedKind;
  value: string;
  goal: string;
  workdir: string;
  webhook: string;
} | null {
  const nameEl = document.getElementById("sched-name");
  const kindEl = document.getElementById("sched-kind");
  const valEl = document.getElementById("sched-value");
  const goalEl = document.getElementById("sched-goal");
  const wdEl = document.getElementById("sched-wd");
  const hookEl = document.getElementById("sched-hook");
  if (
    !(nameEl instanceof HTMLInputElement) ||
    !(kindEl instanceof HTMLSelectElement) ||
    !(valEl instanceof HTMLInputElement) ||
    !(goalEl instanceof HTMLInputElement) ||
    !(wdEl instanceof HTMLInputElement) ||
    !(hookEl instanceof HTMLInputElement)
  ) {
    return null;
  }
  if (nameEl.value.trim() === "") {
    schedHintFlash("名称必填");
    return null;
  }
  const kind: SchedKind = kindEl.value === "daily" ? "daily" : "interval";
  const value = parseSchedValue(kind, valEl.value);
  if (value === null) {
    schedHintFlash(kind === "daily" ? "value 须为 HH:MM（00:00-23:59）" : "value 须为 1-10080 的分钟数");
    return null;
  }
  if (goalEl.value.trim() === "") {
    schedHintFlash("goal 必填");
    return null;
  }
  if (wdEl.value.trim() === "") {
    schedHintFlash("信任目录必填");
    return null;
  }
  const webhook = parseSchedWebhook(hookEl.value);
  if (webhook === null) {
    schedHintFlash("webhook 须为 http(s):// URL 或留空");
    return null;
  }
  return {
    name: nameEl.value.trim(),
    kind,
    value,
    goal: goalEl.value.trim(),
    workdir: wdEl.value.trim(),
    webhook,
  };
}

async function onSchedSave(): Promise<void> {
  const v = schedFormValues();
  if (v === null) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("schedule_save", {
      s: {
        name: v.name,
        kind: v.kind,
        value: v.value,
        goal: v.goal,
        workdir: v.workdir,
        webhook_url: v.webhook,
        enabled: true,
      },
    });
    schedHintFlash("");
    for (const id of ["sched-name", "sched-value", "sched-goal", "sched-wd", "sched-hook"]) {
      const el = document.getElementById(id);
      if (el instanceof HTMLInputElement) el.value = "";
    }
    await refreshScheds();
  } catch (e) {
    schedHintFlash(errText(e));
  }
}

/** 启停开关：目标态取反当前行（invoke 载荷=目标态，与 Rust 契约一致）。 */
async function onSchedToggle(id: string): Promise<void> {
  const cur = schedRows.find((x) => x.id === id);
  if (cur === undefined) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("schedule_toggle", { id, enabled: !cur.enabled });
    await refreshScheds();
  } catch (e) {
    schedHintFlash(errText(e));
  }
}

/** 立即运行（R11-S2）：无确认直接跑一轮（忽略 next_run；running 占位由 Rust
    单并发守卫兜底，行内钮已按 running 禁用）。 */
async function onSchedFire(id: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("schedule_fire_now", { id });
    schedHintFlash("");
    await refreshScheds();
  } catch (e) {
    schedHintFlash(errText(e));
  }
}

/** 删除钮：armClick 状态机两步确认（模板/提示词删除同款）；确认后删行重拉。 */
function onSchedDeleteClick(id: string): void {
  if (schedArmTimer !== null) {
    clearTimeout(schedArmTimer);
    schedArmTimer = null;
  }
  const r = armClick(schedDelArm, id, Date.now());
  schedDelArm = r.next;
  if (!r.run) {
    schedArmTimer = setTimeout(() => {
      if (armExpired(schedDelArm, Date.now())) {
        schedDelArm = { sid: null, at: 0 };
        renderSchedArea();
      }
    }, ARM_WINDOW_MS + 20);
    renderSchedArea();
    return;
  }
  schedDelArm = { sid: null, at: 0 };
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("schedule_delete", { id }))
    .then(() => refreshScheds())
    .catch((e) => schedHintFlash(errText(e)));
}

/** 行内编辑（beginPromptEdit 同款 hub-edit 形态）：行原位换表单，Enter/保存提交、
    Esc/失焦取消；保存走 schedule_save 带 id 原位更新（enabled 不动，启停走行内开关）。 */
function beginSchedEdit(id: string): void {
  const box = document.getElementById("sched-list");
  if (!box || box.querySelector(".prompt-edit") !== null) return;
  const s = schedRows.find((x) => x.id === id);
  if (s === undefined) return;
  const row = box.querySelector(`.schedrow[data-sid="${CSS.escape(id)}"]`);
  if (!(row instanceof HTMLElement)) return;
  const form = document.createElement("form");
  form.className = "formgrid prompt-edit";
  form.noValidate = true;
  form.innerHTML = `
    <div class="fld"><label>NAME</label><input type="text" class="se-name" value="${esc(s.name)}"></div>
    <div class="fld"><label>计划</label><select class="se-kind"><option value="interval"${s.kind === "interval" ? " selected" : ""}>每 N 分钟</option><option value="daily"${s.kind === "daily" ? " selected" : ""}>每天 HH:MM</option></select></div>
    <div class="fld"><label>VALUE</label><input type="text" class="se-value" value="${esc(String(s.value))}"></div>
    <div class="fld"><label>GOAL</label><input type="text" class="se-goal" value="${esc(s.goal)}"></div>
    <div class="fld"><label>WORKDIR</label><input type="text" class="se-wd" value="${esc(s.workdir)}"></div>
    <div class="fld"><label>WEBHOOK</label><input type="text" class="se-hook" value="${esc(s.webhookUrl)}" placeholder="可选 · http(s):// URL"></div>
    <div class="formacts"><button type="button" class="btn pri se-save">保存</button><button type="button" class="btn sec se-cancel">取消</button></div>`;
  row.replaceWith(form);
  const nameEl = form.querySelector<HTMLInputElement>(".se-name");
  nameEl?.focus();
  let settled = false;
  const close = (): void => {
    if (settled) return;
    settled = true;
    renderSchedArea();
  };
  const commit = (): void => {
    if (settled) return;
    const kindEl = form.querySelector<HTMLSelectElement>(".se-kind");
    const valEl = form.querySelector<HTMLInputElement>(".se-value");
    const goalEl = form.querySelector<HTMLInputElement>(".se-goal");
    const wdEl = form.querySelector<HTMLInputElement>(".se-wd");
    const hookEl = form.querySelector<HTMLInputElement>(".se-hook");
    const kind: SchedKind = kindEl !== null && kindEl.value === "daily" ? "daily" : "interval";
    const value = parseSchedValue(kind, valEl?.value ?? "");
    const name = nameEl?.value.trim() ?? "";
    const goal = goalEl?.value.trim() ?? "";
    const workdir = wdEl?.value.trim() ?? "";
    const webhook = parseSchedWebhook(hookEl?.value ?? "");
    if (name === "") {
      schedHintFlash("名称必填");
      nameEl?.focus();
      return;
    }
    if (value === null) {
      schedHintFlash(kind === "daily" ? "value 须为 HH:MM（00:00-23:59）" : "value 须为 1-10080 的分钟数");
      return;
    }
    if (goal === "") {
      schedHintFlash("goal 必填");
      return;
    }
    if (workdir === "") {
      schedHintFlash("信任目录必填");
      return;
    }
    if (webhook === null) {
      schedHintFlash("webhook 须为 http(s):// URL 或留空");
      return;
    }
    settled = true;
    schedHintFlash("");
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("schedule_save", {
          s: { id: s.id, name, kind, value, goal, workdir, webhook_url: webhook, enabled: s.enabled },
        }),
      )
      .then(() => refreshScheds())
      .catch((e) => schedHintFlash(errText(e)));
  };
  form.querySelector(".se-save")?.addEventListener("mousedown", (ev) => ev.preventDefault());
  form.querySelector(".se-save")?.addEventListener("click", () => commit());
  form.querySelector(".se-cancel")?.addEventListener("click", () => close());
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    commit();
  });
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      // 输入法组词中的 Enter 是选字不是提交（beginPromptEdit 同款守卫）
      if (ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
  form.addEventListener("focusout", () => {
    // 焦点仍在表单内换栏不关（保存钮已吞 mousedown 焦点转移）
    if (!form.contains(document.activeElement)) close();
  });
}

/* ── 设置视图（rail 04，第三视图）：BYOK 模型管理 + hub 地址 ── */

/** 壳层一次渲染；BYOK 表区（#byok-list）与表单由 loadByok/事件驱动重填。 */
function renderSettings(): string {
  // 浏览器态顶部一条横幅声明桌面边界；各区块只留标题+说明文字，不再单独出 note
  const browserBanner = inTauri ? "" : desktopOnlyNote("BYOK 存储 · 软件更新 · 桌面集成");
  const byokArea = inTauri
    ? `
  <div class="seth">BYOK 模型</div>
  <div id="byok-list"></div>
  <div class="seth">新增 BYOK 模型</div>
  <form class="formgrid" id="byok-form" novalidate>
    <div class="fld"><label for="byok-name">NAME</label><input id="byok-name" type="text" placeholder="如 deepseek"></div>
    <div class="fld"><label for="byok-base">BASE_URL</label><input id="byok-base" type="text" placeholder="https://api.deepseek.com"></div>
    <div class="fld"><label for="byok-key">API_KEY</label><input id="byok-key" type="password" autocomplete="off" placeholder="仅存本机 keyring"></div>
    <div class="fld"><label for="byok-model">MODEL_ID</label><input id="byok-model" type="text" placeholder="如 deepseek-chat"></div>
    <div class="formacts"><button type="submit" class="btn pri" id="byok-save">保存</button><span class="hint" id="byok-hint"></span></div>
  </form>`
    : `
  <div class="seth">BYOK 模型</div>
  <div class="setd">条目存本机 OS keyring · 浏览器内不可增删</div>`;
  const updateArea = inTauri
    ? `
  <div class="seth">软件更新</div>
  <div class="hubline"><button type="button" class="btn sec" id="upd-check">检查更新</button><span class="mono" id="upd-result"></span><button type="button" class="btn pri" id="upd-relaunch" hidden>重启以完成更新</button></div>`
    : `
  <div class="seth">软件更新</div>
  <div class="setd">更新包下载与安装由桌面应用托管</div>`;
  // 环境分区（能力 tab）：壳层只出容器，检测卡由 loadEnv 异步填充
  const envArea = inTauri
    ? `
  <div class="seth">环境</div>
  <div id="env-list"></div>`
    : `
  <div class="seth">环境</div>
  <div class="setd">引擎检测 · 安装指引由桌面应用提供</div>`;
  // R9-C C3 MCP 分区（环境之后）：壳层只出容器，列表由 loadMcpArea 异步填充
  const mcpArea = `
  <div class="seth">MCP</div>
  <div id="mcp-list"><div class="setd">加载中…</div></div>`;
  // R9-D D2 知识库分区（MCP 之后）：列表容器异步填充；入库表单静态（不随列表
  // 重绘，输入不丢），类型三选切换 URL/粘贴/文件字段。R10-A A1 加 k 检索条数
  // 与重入更新 hint。
  const kbArea = `
  <div class="seth">知识库</div>
  <div id="kb-list"><div class="setd">加载中…</div></div>
  <div class="hubline"><button type="button" class="btn sec" id="kb-rebuild" data-kb-rebuild>重建索引</button><span class="mono" id="kb-rebuild-result">换 embedding 模型后使用 · 重建期间检索暂不可查</span></div>
  <div class="hubline"><span class="lbl">检索 k</span><input id="kb-k" type="number" min="1" max="10" step="1" value="4" aria-label="检索条数 k"><span class="mono">1-10 · @知识库 命中段落数</span></div>
  <form class="formgrid" id="kb-form" novalidate>
    <div class="fld"><label for="kb-title">TITLE</label><input id="kb-title" type="text" placeholder="可空 · 默认取来源"></div>
    <div class="fld"><label for="kb-type">类型</label><select id="kb-type" aria-label="入库类型"><option value="url">URL 抓取</option><option value="paste">粘贴文本</option><option value="file">文件 .txt / .md</option></select></div>
    <div class="fld" id="kb-url-fld"><label for="kb-url">URL</label><input id="kb-url" type="text" placeholder="https://example.com/article"></div>
    <div class="fld" id="kb-paste-fld" hidden><label for="kb-paste">TEXT</label><textarea id="kb-paste" rows="5" placeholder="粘贴文档全文"></textarea></div>
    <div class="fld" id="kb-file-fld" hidden><label for="kb-file">FILE</label><input id="kb-file" type="file" accept=".txt,.md,text/plain,text/markdown"></div>
    <div class="formacts"><button type="submit" class="btn pri" id="kb-save">入库</button><span class="hint" id="kb-hint">入库同步切块+索引 · 预计数秒 · 同来源（URL/文件名）再次入库将更新已有文档</span></div>
  </form>`;
  // R10-A A2 提示词分区（能力 tab 尾）：列表容器由 renderPromptArea 填充；行内
  // 编辑/添加共用 beginPromptEdit，存储 tasksdb prefs（浏览器 localStorage）
  const promptArea = `
  <div class="seth">提示词</div>
  <div id="prompt-list"></div>
  <div class="formacts prompt-acts"><button type="button" class="btn sec" id="prompt-add">添加提示词</button><span class="hint" id="prompt-hint"></span></div>`;
  const desktopArea = inTauri
    ? `
  <div class="seth">桌面</div>
  <div class="hubline"><span class="lbl">开机自启</span><span class="mono" id="auto-state">读取中…</span><button type="button" class="btn sec" id="auto-toggle" hidden>切换</button></div>
  <div class="hubline"><span class="lbl">全局快捷键</span><span class="mono">${TOGGLE_SHORTCUT} · 显示 / 隐藏主窗口</span></div>
  <div class="env-note">关闭窗口不退出应用 · 最小化到托盘（托盘菜单「退出」真正退出）</div>`
    : `
  <div class="seth">桌面</div>
  <div class="setd">开机自启 · 全局快捷键 · 托盘常驻</div>`;
  // 四 tab 分组（xyc 批准）：常规/接入/能力/用量；分区本体全部常驻 DOM 只切
  // hidden（同任务域一级 tab），wire 与异步填充一律不感知 tab
  return `
<section class="settings" aria-label="设置" id="settings-sec">
  <div class="phase">PLATFORM · SETTINGS</div>
  <h1>设置</h1>
  ${browserBanner}
  <div class="tabs" id="settings-tabs" role="tablist" aria-label="设置分区切换"></div>
  <div class="setpane" data-pane="general">
    <div class="seth">外观</div>
    <div class="hubline"><span class="lbl">主题</span><select id="theme-select" aria-label="主题"><option value="auto">跟随系统</option><option value="dark">深色</option><option value="light">浅色</option></select></div>
    ${desktopArea}
    ${updateArea}
  </div>
  <div class="setpane" data-pane="access">
    <div class="seth">HUB</div>
    <div class="hubline"><span class="mono" id="hub-url" data-hub-url>${esc(hubUrl())}</span><button type="button" class="btn sec" id="hub-edit">修改</button></div>
    ${byokArea}
  </div>
  <div class="setpane" data-pane="capability">
    ${envArea}
    ${mcpArea}
    ${kbArea}
    ${promptArea}
  </div>
  <div class="setpane" data-pane="usage">
    <div class="seth">用量</div>
    <div id="usage-dash"><div class="setd">加载中…</div></div>
  </div>
</section>`;
}

type SettingsTab = "general" | "access" | "capability" | "usage";

/** 装配设置页一级 tab（#settings-tabs 由壳层模板提供）：分区常驻 DOM，select
    只切 hidden——切视图回来 tab 态自然保持（mountTaskTabs 同款机制），且
    wireSettings 的委托监听与各 loader 的 getElementById 填充均不受影响。 */
function mountSettingsTabs(): void {
  const bar = document.getElementById("settings-tabs");
  if (!bar) return;
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "general", label: "常规" },
    { id: "access", label: "接入" },
    { id: "capability", label: "能力" },
    { id: "usage", label: "用量" },
  ];
  const buttons = new Map<SettingsTab, HTMLButtonElement>();
  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.addEventListener("click", () => select(t.id));
    bar.append(btn);
    buttons.set(t.id, btn);
  }
  const select = (id: SettingsTab): void => {
    for (const [tid, btn] of buttons) btn.setAttribute("aria-selected", String(tid === id));
    for (const pane of document.querySelectorAll<HTMLElement>("#settings-sec > .setpane")) {
      pane.hidden = pane.dataset.pane !== id;
    }
  };
  select("general");
}

/* ── 用量仪表盘（R9-B B3，用量 tab）：近 14 天纯 CSS 柱 + 按模型汇总 ── */

/** 仪表盘重绘：14 柱高度按窗口内最大天取百分比（hover title 出日期+¥）；
    模型汇总沿用 bkrow 形态。纯函数出数据（usagechart.ts），此处只做 DOM。 */
function renderUsageDash(rows: UsageRow[]): void {
  const box = document.getElementById("usage-dash");
  if (!box) return;
  const bars = usageBars(rows);
  const max = Math.max(1, ...bars.map((b) => b.cents));
  const barsHTML = bars
    .map((b) => `<i style="height:${Math.round((b.cents / max) * 100)}%" title="${b.date} · ¥${(b.cents / 100).toFixed(2)}"></i>`)
    .join("");
  const models = usageByModel(rows);
  const tableHTML =
    models.length === 0
      ? `<div class="setd">近 14 天无用量</div>`
      : `<div class="bkhead usage-head"><span>MODEL</span><span>REQ</span><span>COST</span></div>` +
        models
          .map(
            (m) =>
              `<div class="bkrow usage-row"><span class="n" title="${esc(m.model)}">${esc(m.model)}</span><span class="u">${m.requests}</span><span class="m">¥${(m.cents / 100).toFixed(2)}</span></div>`,
          )
          .join("");
  box.innerHTML = `<div class="ubars" role="img" aria-label="近 14 天每日成本">${barsHTML}</div>${tableHTML}`;
}

/** 拉近 14 天用量出仪表盘；进入设置页时触发（setView 钩子）。 */
async function loadUsageDash(): Promise<void> {
  const box = document.getElementById("usage-dash");
  if (!box) return;
  try {
    renderUsageDash(await fetchUsage(14));
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    box.innerHTML = `<div class="errline">${esc(errText(e))}</div>`;
  }
}

/** BYOK 表重绘（err 非空时只渲染错误行）。 */
function renderByokTable(err: string | null): void {
  const box = document.getElementById("byok-list");
  if (!box) return;
  if (err !== null) {
    box.innerHTML = `<div class="errline">${esc(err)}</div>`;
    return;
  }
  const rows = chatState.byok;
  box.innerHTML =
    rows.length === 0
      ? `<div class="bk-empty">暂无条目 · 下方新增</div>`
      : `<div class="bkhead"><span>NAME</span><span>BASE_URL</span><span>MODEL_ID</span><span></span></div>` +
        rows
          .map(
            (v) =>
              `<div class="bkrow"><span class="n" title="${esc(v.name)}">${esc(v.name)}</span><span class="u" title="${esc(v.baseUrl)}">${esc(v.baseUrl)}</span><span class="m" title="${esc(v.modelId)}">${esc(v.modelId || "—")}</span><button type="button" class="btn sec del" data-del="${esc(v.name)}">删除</button></div>`,
          )
          .join("");
}

async function onByokSave(): Promise<void> {
  const nameEl = document.getElementById("byok-name");
  const baseEl = document.getElementById("byok-base");
  const keyEl = document.getElementById("byok-key");
  const modelEl = document.getElementById("byok-model");
  const hint = document.getElementById("byok-hint");
  const btn = document.getElementById("byok-save");
  if (
    !(nameEl instanceof HTMLInputElement) ||
    !(baseEl instanceof HTMLInputElement) ||
    !(keyEl instanceof HTMLInputElement) ||
    !(modelEl instanceof HTMLInputElement) ||
    !(hint instanceof HTMLElement) ||
    !(btn instanceof HTMLButtonElement)
  ) {
    return;
  }
  const name = nameEl.value.trim();
  const baseUrl = baseEl.value.trim();
  const apiKey = keyEl.value.trim();
  const modelId = modelEl.value.trim();
  if (!name || !baseUrl || !apiKey) {
    hint.textContent = "name / base_url / api_key 必填（model_id 可空）";
    return;
  }
  hint.textContent = "";
  btn.disabled = true;
  try {
    await byokSave({ name, baseUrl, apiKey, modelId });
    for (const el of [nameEl, baseEl, keyEl, modelEl]) el.value = "";
  } catch (e) {
    hint.textContent = errText(e);
  } finally {
    btn.disabled = false;
  }
  await loadByok();
}

async function onByokDelete(name: string): Promise<void> {
  const hint = document.getElementById("byok-hint");
  try {
    await byokDelete(name);
  } catch (e) {
    if (hint) hint.textContent = `删除 '${name}' 失败 · ${errText(e)}`;
    return;
  }
  if (hint) hint.textContent = "";
  await loadByok();
}

/* ── 环境分区（HUB 之后）：PI/DSH 引擎检测卡 + 缺失时安装指引复制 ── */

let envReports: EngineEnvReport[] | null = null;
let envCopyTimer: number | undefined;
// 安装会话态：target 非空 = 安装进行中（前端互斥；Rust 侧 AtomicBool 是真闸）。
// 日志与失败尾行留在模块态里，renderEnvArea 整体重绘后仍能复原（检测中占位除外）。
let envLogLines: string[] = [];
let envInstallErr: string | null = null;
let envInstallTarget: string | null = null;

/** env_check 回包单行边界窄化：Rust 契约是嵌套 probe（{engine, probe:{available,
    path, version_hint}}，sidecar/mod.rs 测试钉死），snake_case 在此转 camelCase。 */
function decodeEnvRow(v: unknown): EngineEnvReport {
  if (!isObj(v)) throw new ProtocolError("bad env row");
  const probe = v.probe;
  if (!isObj(probe)) throw new ProtocolError("bad env probe");
  return {
    engine: fieldString(v, "engine") ?? "",
    available: probe.available === true,
    path: fieldString(probe, "path") ?? null,
    versionHint: fieldString(probe, "version_hint") ?? null,
  };
}

/** 检测区重绘（err 非空时只渲染错误行 + 重检入口，renderByokTable 同款惯例）。
    npmReady 从 envReports 现推（v2 起含 npm 条目）；安装日志/失败行随卡区复原。 */
function renderEnvArea(err: string | null): void {
  const box = document.getElementById("env-list");
  if (!box) return;
  if (err !== null) {
    box.innerHTML = `<div class="errline">${esc(err)}</div><div class="hubline"><button type="button" class="btn sec" id="env-recheck">重新检测</button></div>`;
    return;
  }
  const npmRow = (envReports ?? []).find((r) => r.engine === "npm");
  box.innerHTML =
    envAreaHTML(envReports, { npmReady: npmRow ? npmRow.available : undefined }) +
    (envInstallErr !== null ? `<div class="errline">${esc(envInstallErr)}</div>` : "") +
    (envLogLines.length > 0 ? `<div id="env-install-log">${envLogHTML(envLogLines)}</div>` : "");
}

/** 拉引擎检测（which + --version，桌面态专有）；失败渲染错误行，不阻塞其它分区。 */
async function loadEnv(): Promise<void> {
  if (!inTauri) return;
  const box = document.getElementById("env-list");
  if (box) box.innerHTML = envAreaHTML(null);
  let err: string | null = null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const rows = await invoke<unknown>("env_check");
    if (!Array.isArray(rows)) throw new ProtocolError("bad env list");
    envReports = rows.map(decodeEnvRow);
  } catch (e) {
    err = errText(e);
    console.warn("[env] 引擎检测失败", e);
  }
  renderEnvArea(err);
}

/** 复制反馈：按钮文案临时改写 2.5s 后还原（资产页复制路径反馈同款节律）。 */
function envCopyFlash(btn: HTMLElement, text: string): void {
  window.clearTimeout(envCopyTimer);
  btn.textContent = text;
  envCopyTimer = window.setTimeout(() => {
    btn.textContent = "复制";
  }, 2500);
}

/** 复制安装命令：cmd 取自 ENV_INSTALL_HINTS（不读按钮旁 DOM 文案，防串改）。 */
function onEnvCopy(engine: string, btn: HTMLElement): void {
  const hint = ENV_INSTALL_HINTS[engine];
  if (!hint) return;
  void navigator.clipboard
    .writeText(hint.cmd)
    .then(() => envCopyFlash(btn, "已复制"))
    .catch((e) => {
      console.warn("[env] 安装命令复制失败", e);
      envCopyFlash(btn, "复制失败");
    });
}

/** env_install / env_install_node 回包边界窄化：{ ok, output(尾若干行) }。 */
function decodeInstallOutcome(v: unknown): { ok: boolean; output: string } {
  if (!isObj(v) || typeof v.ok !== "boolean" || typeof v.output !== "string") {
    throw new ProtocolError("bad install outcome");
  }
  return { ok: v.ok, output: v.output };
}

/** 流式期间只重绘日志容器本身：整区重绘会把「安装中…」按钮复原成可点。 */
function redrawEnvLog(): void {
  const box = document.getElementById("env-install-log");
  if (box) box.innerHTML = envLogHTML(envLogLines);
}

/** 一键安装（v2）：按钮态 → 订阅 env://line（先订阅再 invoke，免丢早期行）→
    完成 unlisten；成功自动 loadEnv 重检（日志保留 +「已完成」），失败 errline 落
    output 尾行（ok=false）或 reject 文案（如「安装进行中」）并保留日志。 */
async function onEnvInstall(target: string): Promise<void> {
  if (!inTauri || envInstallTarget !== null) return;
  const btn = document.querySelector<HTMLButtonElement>(`[data-env-install="${CSS.escape(target)}"]`);
  if (btn === null || btn.disabled) return;
  envInstallTarget = target;
  envLogLines = [];
  envInstallErr = null;
  btn.disabled = true;
  btn.textContent = "安装中…";
  const box = document.getElementById("env-list");
  if (box !== null && document.getElementById("env-install-log") === null) {
    box.insertAdjacentHTML("beforeend", `<div id="env-install-log"></div>`);
  }
  let unlisten: (() => void) | null = null;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<unknown>("env://line", (ev) => {
      const p = ev.payload;
      if (!isObj(p) || typeof p.line !== "string") {
        console.warn("[env] 丢弃形状不符的 env://line", p);
        return;
      }
      if (p.target !== target) return;
      envLogLines.push(p.line);
      redrawEnvLog();
    });
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = target === "node" ? await invoke<unknown>("env_install_node") : await invoke<unknown>("env_install", { engine: target });
    const r = decodeInstallOutcome(raw);
    if (r.ok) {
      envLogLines.push("已完成");
      await loadEnv();
    } else {
      const tail = r.output.trim().split("\n").pop() ?? "";
      envInstallErr = tail === "" ? "安装失败" : `安装失败 · ${tail}`;
      renderEnvArea(null);
    }
  } catch (e) {
    envInstallErr = `安装失败 · ${errText(e)}`;
    console.warn("[env] 一键安装失败", e);
    renderEnvArea(null);
  } finally {
    envInstallTarget = null;
    if (unlisten !== null) unlisten();
  }
}

/** 检查更新：一键检查→有新版本直接下载安装；期间按钮禁用改文案，结果落 mono 行。 */
async function onUpdateCheck(): Promise<void> {
  const btn = document.getElementById("upd-check");
  const line = document.getElementById("upd-result");
  const rel = document.getElementById("upd-relaunch");
  if (
    !(btn instanceof HTMLButtonElement) ||
    !(line instanceof HTMLElement) ||
    !(rel instanceof HTMLButtonElement)
  ) {
    return;
  }
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "下载中…";
  line.textContent = "";
  rel.hidden = true;
  const r = await checkAndInstall();
  btn.disabled = false;
  btn.textContent = "检查更新";
  if (r.kind === "error") {
    line.className = "errline";
    line.textContent = r.message;
    return;
  }
  line.className = "mono";
  if (r.kind === "up-to-date") {
    line.textContent = "已是最新版本";
    return;
  }
  line.textContent = `v${r.version} 已安装 · 重启后生效`;
  rel.hidden = false;
}

async function onRelaunch(): Promise<void> {
  try {
    await relaunchApp();
  } catch (e) {
    const line = document.getElementById("upd-result");
    if (line instanceof HTMLElement) {
      line.className = "errline";
      line.textContent = `重启失败 · ${errText(e)}`;
    }
  }
}

/* ── 桌面块：开机自启行（回读 + 取反切换；注册表是权威状态，不在前端缓存） ── */

async function refreshAutostartRow(): Promise<void> {
  const state = document.getElementById("auto-state");
  const btn = document.getElementById("auto-toggle");
  if (!(state instanceof HTMLElement) || !(btn instanceof HTMLButtonElement)) return;
  let on: boolean | null;
  try {
    on = await autostartIsEnabled();
  } catch (e) {
    state.className = "errline";
    state.textContent = `读取失败 · ${errText(e)}`;
    btn.hidden = true;
    return;
  }
  if (on === null) return;
  state.className = "mono";
  state.textContent = on ? "已启用" : "已停用";
  btn.hidden = false;
  btn.textContent = on ? "停用" : "启用";
}

async function onAutostartToggle(): Promise<void> {
  const btn = document.getElementById("auto-toggle");
  const state = document.getElementById("auto-state");
  if (!(btn instanceof HTMLButtonElement) || !(state instanceof HTMLElement)) return;
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const current = await autostartIsEnabled();
    if (current !== null) await setAutostart(!current);
  } catch (e) {
    state.className = "errline";
    state.textContent = `切换失败 · ${errText(e)}`;
    btn.disabled = false;
    return;
  }
  await refreshAutostartRow();
  btn.disabled = false;
}

/* ── R9-C C3：设置页 MCP 分区（admin API 客户端化，零 hub 改动；
     列表全员可读，写路径 403 时整区降级只读——toC 单用户 admin 即本人） ── */

let mcpRowsList: McpUpstreamView[] = [];
let mcpAdmin = true; // 乐观起步；首次写失败 403 才降级（GET 分不出角色）
let mcpAddOpen = false; // 「添加」折叠表单开合
let mcpErr: string | null = null;
let mcpDelArm: ArmState = { sid: null, at: 0 }; // sid = upstream 名（会话删除同款两步确认）
let mcpArmTimer: ReturnType<typeof setTimeout> | null = null;

function renderMcpArea(): void {
  const box = document.getElementById("mcp-list");
  if (!box) return;
  // 表单开着时启停/删除会连带重拉重绘：先快照输入，重绘后回填，不吞半填内容
  const formIds = ["mcp-name", "mcp-url", "mcp-token", "mcp-tools"] as const;
  const snap = formIds.map((id) => {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el.value : null;
  });
  const list =
    mcpRowsList.length === 0
      ? `<div class="bk-empty">暂无 upstream${mcpAdmin ? " · 下方添加" : ""}</div>`
      : mcpRowsList
          .map((u): McpRowView => ({
            name: u.name,
            enabled: u.enabled,
            tools: u.allowedTools.length > 0 ? u.allowedTools.length : null,
            armed: mcpDelArm.sid === u.name,
          }))
          .map((r) => mcpRowHTML(r, mcpAdmin))
          .join("");
  const adminNote = mcpAdmin ? "" : `<div class="env-note">管理需管理员账号 · 当前只读</div>`;
  const errLine = mcpErr !== null ? `<div class="errline">${esc(mcpErr)}</div>` : "";
  // 添加表单字段照 server createUpstream 请求体（凭证只进 hub，不落本机）
  const addArea = !mcpAdmin
    ? ""
    : mcpAddOpen
      ? `
  <form class="formgrid" id="mcp-form" novalidate>
    <div class="fld"><label for="mcp-name">NAME</label><input id="mcp-name" type="text" placeholder="如 context7"></div>
    <div class="fld"><label for="mcp-url">BASE_URL</label><input id="mcp-url" type="text" placeholder="https://mcp.example.com/mcp"></div>
    <div class="fld"><label for="mcp-token">AUTH_TOKEN</label><input id="mcp-token" type="password" autocomplete="off" placeholder="可空 · 上游凭证仅存 hub"></div>
    <div class="fld"><label for="mcp-tools">ALLOWED_TOOLS</label><input id="mcp-tools" type="text" placeholder="可空 · 逗号分隔，空=全部工具"></div>
    <div class="formacts"><button type="submit" class="btn pri" id="mcp-save">保存</button><button type="button" class="btn sec" id="mcp-add">收起</button><span class="hint" id="mcp-hint"></span></div>
  </form>`
      : `<div class="hubline" style="margin-top:10px"><button type="button" class="btn sec" id="mcp-add">添加</button></div>`;
  box.innerHTML = adminNote + errLine + list + addArea;
  if (mcpAddOpen) {
    formIds.forEach((id, i) => {
      const el = document.getElementById(id);
      if (el instanceof HTMLInputElement && snap[i] !== null) el.value = snap[i];
    });
  }
}

async function loadMcpArea(): Promise<void> {
  const box = document.getElementById("mcp-list");
  if (!box) return;
  try {
    mcpRowsList = await fetchMcpUpstreams();
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    box.innerHTML = `<div class="errline">${esc(errText(e))}</div>`;
    return;
  }
  renderMcpArea();
}

/** 写路径失败提示：表单开着落 #mcp-hint（不重绘保输入），否则落分区 errline。 */
function mcpFail(msg: string): void {
  const hint = document.getElementById("mcp-hint");
  if (hint instanceof HTMLElement) {
    hint.textContent = msg;
    return;
  }
  mcpErr = msg;
  renderMcpArea();
}

/** 403 降级：整区只读 + 提示；武装态与表单一并复位。 */
function mcpDegradeReadonly(): void {
  mcpAdmin = false;
  mcpAddOpen = false;
  mcpErr = null;
  mcpDelArm = { sid: null, at: 0 };
  renderMcpArea();
}

async function onMcpSave(): Promise<void> {
  const nameEl = document.getElementById("mcp-name");
  const urlEl = document.getElementById("mcp-url");
  const tokenEl = document.getElementById("mcp-token");
  const toolsEl = document.getElementById("mcp-tools");
  const hint = document.getElementById("mcp-hint");
  const btn = document.getElementById("mcp-save");
  if (
    !(nameEl instanceof HTMLInputElement) ||
    !(urlEl instanceof HTMLInputElement) ||
    !(tokenEl instanceof HTMLInputElement) ||
    !(toolsEl instanceof HTMLInputElement) ||
    !(hint instanceof HTMLElement) ||
    !(btn instanceof HTMLButtonElement)
  ) {
    return;
  }
  const name = nameEl.value.trim();
  const baseUrl = urlEl.value.trim();
  const authToken = tokenEl.value.trim();
  const allowedTools = toolsEl.value
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (!name || !baseUrl) {
    hint.textContent = "name / base_url 必填";
    return;
  }
  hint.textContent = "";
  btn.disabled = true;
  let saved = false;
  try {
    await createMcpUpstream({ name, baseUrl, authToken, allowedTools });
    mcpAddOpen = false;
    mcpErr = null;
    saved = true;
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    if (e instanceof ApiError && e.status === 403) {
      mcpDegradeReadonly();
      return;
    }
    hint.textContent = errText(e);
  } finally {
    btn.disabled = false; // 成功路径表单已重绘，置回无害
  }
  if (saved) await loadMcpArea();
}

/** 启停开关：PATCH {enabled} 取反；成功重拉列表（PATCH 回包形状不依赖）。 */
async function onMcpToggle(name: string): Promise<void> {
  const row = mcpRowsList.find((u) => u.name === name);
  if (row === undefined) return;
  try {
    await setMcpUpstreamEnabled(name, !row.enabled);
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    if (e instanceof ApiError && e.status === 403) {
      mcpDegradeReadonly();
      return;
    }
    mcpFail(`启停 '${name}' 失败 · ${errText(e)}`);
    return;
  }
  mcpErr = null;
  await loadMcpArea();
}

/** 行删除：两步确认（sessions.armClick 状态机同款）；确认后删行重拉。 */
async function onMcpDeleteClick(name: string): Promise<void> {
  if (mcpArmTimer !== null) {
    clearTimeout(mcpArmTimer);
    mcpArmTimer = null;
  }
  const r = armClick(mcpDelArm, name, Date.now());
  mcpDelArm = r.next;
  if (!r.run) {
    mcpArmTimer = setTimeout(() => {
      if (armExpired(mcpDelArm, Date.now())) {
        mcpDelArm = { sid: null, at: 0 };
        renderMcpArea();
      }
    }, ARM_WINDOW_MS + 20);
    renderMcpArea();
    return;
  }
  mcpDelArm = { sid: null, at: 0 };
  try {
    await deleteMcpUpstream(name);
    mcpErr = null;
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    if (e instanceof ApiError && e.status === 403) {
      mcpDegradeReadonly();
      return;
    }
    mcpFail(`删除 '${name}' 失败 · ${errText(e)}`);
    return;
  }
  await loadMcpArea();
}

/* ── R9-D D2：设置页知识库分区（hub /kb/docs 入库/列表/删除；检索在对话域
     @知识库）。入库同步等 hub 切块+索引（2-10s 量级），按钮态「索引中…」。 ── */

let kbRows: KbDocRow[] = [];
let kbErr: string | null = null;
let kbDelArm: ArmState = { sid: null, at: 0 }; // sid = doc id（两步删除同款状态机）
let kbArmTimer: ReturnType<typeof setTimeout> | null = null;

/** 来源列：类型 + sourceRef（粘贴无 ref 只显类型；ref 超长由 ellipsis 收）。 */
function kbSourceLine(d: KbDocRow): string {
  if (d.sourceType === "url") return `URL · ${d.sourceRef}`;
  if (d.sourceType === "file") return `文件 · ${d.sourceRef}`;
  return "粘贴文本";
}

function renderKbArea(): void {
  const box = document.getElementById("kb-list");
  if (!box) return;
  const errLine = kbErr !== null ? `<div class="errline">${esc(kbErr)}</div>` : "";
  const list =
    kbRows.length === 0
      ? `<div class="bk-empty">知识库为空 · 下方入库</div>`
      : `<div class="bkhead"><span>TITLE</span><span>SOURCE</span><span>CHUNKS</span><span></span></div>` +
        kbRows
          .map(
            (d) =>
              `<div class="bkrow"><span class="n" title="${esc(d.title)}">${esc(d.title || "未命名")}</span><span class="u" title="${esc(kbSourceLine(d))}">${esc(kbSourceLine(d))}</span><span class="m">${d.chunkCount} chunks</span><button type="button" class="mop del${kbDelArm.sid === d.id ? " armed" : ""}" data-kbdel="${esc(d.id)}">${kbDelArm.sid === d.id ? "确认删" : "删除"}</button></div>`,
          )
          .join("");
  box.innerHTML = errLine + list;
}

async function loadKbArea(): Promise<void> {
  const box = document.getElementById("kb-list");
  if (!box) return;
  try {
    kbRows = await kbListDocs();
    kbErr = null;
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    kbRows = [];
    kbErr = errText(e);
  }
  renderKbArea();
}

/** 类型三选切换字段显隐（字段常驻 DOM 只藏不删，切换不丢已填内容）。 */
function kbFormSync(): void {
  const sel = document.getElementById("kb-type");
  const type = sel instanceof HTMLSelectElement ? sel.value : "url";
  const urlFld = document.getElementById("kb-url-fld");
  const pasteFld = document.getElementById("kb-paste-fld");
  const fileFld = document.getElementById("kb-file-fld");
  if (urlFld instanceof HTMLElement) urlFld.hidden = type !== "url";
  if (pasteFld instanceof HTMLElement) pasteFld.hidden = type !== "paste";
  if (fileFld instanceof HTMLElement) fileFld.hidden = type !== "file";
}

/** 文件读文本（FileReader，桌面/浏览器通用；知识库入库与文本附件共用）。 */
function readFileText(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error ?? new Error("文件读取失败"));
    r.readAsText(f);
  });
}

async function onKbSave(): Promise<void> {
  const titleEl = document.getElementById("kb-title");
  const typeEl = document.getElementById("kb-type");
  const urlEl = document.getElementById("kb-url");
  const pasteEl = document.getElementById("kb-paste");
  const fileEl = document.getElementById("kb-file");
  const hint = document.getElementById("kb-hint");
  const btn = document.getElementById("kb-save");
  if (
    !(titleEl instanceof HTMLInputElement) ||
    !(typeEl instanceof HTMLSelectElement) ||
    !(urlEl instanceof HTMLInputElement) ||
    !(pasteEl instanceof HTMLTextAreaElement) ||
    !(fileEl instanceof HTMLInputElement) ||
    !(hint instanceof HTMLElement) ||
    !(btn instanceof HTMLButtonElement)
  ) {
    return;
  }
  const title = titleEl.value.trim();
  const type = typeEl.value as KbSourceType;
  let content = "";
  let sourceRef = "";
  if (type === "url") {
    const url = urlEl.value.trim();
    if (!refIsUrl(url)) {
      hint.textContent = "请填单个 http(s) 链接";
      return;
    }
    if (!inTauri) {
      hint.textContent = "URL 抓取需桌面端 · 浏览器内请用粘贴文本或文件";
      return;
    }
    btn.textContent = "抓取中…";
    btn.disabled = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const page = await invoke<{ title: string; text: string }>("fetch_page", { url });
      content = page.text;
      sourceRef = url;
      hint.textContent = `已抓取 ${content.length} 字 · 索引中…`;
    } catch (e) {
      hint.textContent = `抓取失败 · ${errText(e)}`;
      return;
    } finally {
      btn.textContent = "入库";
      btn.disabled = false;
    }
  } else if (type === "paste") {
    content = pasteEl.value;
    if (content.trim() === "") {
      hint.textContent = "正文为空";
      return;
    }
  } else {
    const f = fileEl.files !== null ? fileEl.files[0] : null;
    if (!f) {
      hint.textContent = "选择 .txt / .md 文件";
      return;
    }
    try {
      content = await readFileText(f);
    } catch (e) {
      hint.textContent = errText(e);
      return;
    }
    if (content.trim() === "") {
      hint.textContent = "文件内容为空";
      return;
    }
    sourceRef = f.name;
  }
  btn.textContent = "索引中…";
  btn.disabled = true;
  let saved = false;
  try {
    const { doc, updated } = await kbCreateDoc({
      ...(title !== "" ? { title } : {}),
      sourceType: type,
      ...(sourceRef !== "" ? { sourceRef } : {}),
      content,
    });
    hint.textContent = `${updated ? "已更新既有文档" : "已入库"} · ${doc.chunkCount} chunks`;
    titleEl.value = "";
    urlEl.value = "";
    pasteEl.value = "";
    fileEl.value = "";
    saved = true;
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    hint.textContent = `入库失败 · ${errText(e)}`;
  } finally {
    btn.textContent = "入库";
    btn.disabled = false;
  }
  if (saved) await loadKbArea();
}

/** 文档删除：两步确认（armClick 状态机，MCP/会话删除同款）；确认后删行重拉。 */
async function onKbDeleteClick(id: string): Promise<void> {
  if (kbArmTimer !== null) {
    clearTimeout(kbArmTimer);
    kbArmTimer = null;
  }
  const r = armClick(kbDelArm, id, Date.now());
  kbDelArm = r.next;
  if (!r.run) {
    kbArmTimer = setTimeout(() => {
      if (armExpired(kbDelArm, Date.now())) {
        kbDelArm = { sid: null, at: 0 };
        renderKbArea();
      }
    }, ARM_WINDOW_MS + 20);
    renderKbArea();
    return;
  }
  kbDelArm = { sid: null, at: 0 };
  try {
    await kbDeleteDoc(id);
    kbErr = null;
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    kbErr = `删除失败 · ${errText(e)}`;
  }
  await loadKbArea();
}

/* ── R11-K1 重建索引：两步确认（armClick 状态机，删除同款）——不可查的
     代价文案进确认态钮文；结果 hint 三态文案在 api.kbRebuildHint（纯函数）。 ── */

let kbRebuildArm: ArmState = { sid: null, at: 0 };
let kbRebuildTimer: ReturnType<typeof setTimeout> | null = null;

async function onKbRebuildClick(): Promise<void> {
  const btn = document.getElementById("kb-rebuild");
  if (!(btn instanceof HTMLButtonElement) || btn.disabled) return;
  if (kbRebuildTimer !== null) {
    clearTimeout(kbRebuildTimer);
    kbRebuildTimer = null;
  }
  const r = armClick(kbRebuildArm, "kb-rebuild", Date.now());
  kbRebuildArm = r.next;
  if (!r.run) {
    btn.textContent = "确认重建（期间检索不可查）";
    kbRebuildTimer = setTimeout(() => {
      if (armExpired(kbRebuildArm, Date.now())) {
        kbRebuildArm = { sid: null, at: 0 };
        btn.textContent = "重建索引";
      }
    }, ARM_WINDOW_MS + 20);
    return;
  }
  kbRebuildArm = { sid: null, at: 0 };
  const result = document.getElementById("kb-rebuild-result");
  btn.textContent = "重建中…";
  btn.disabled = true;
  try {
    const res = await kbRebuild();
    if (result) result.textContent = kbRebuildHint(res);
    await loadKbArea();
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    if (result) result.textContent = `重建失败 · ${errText(e)}`;
  } finally {
    btn.textContent = "重建索引";
    btn.disabled = false;
  }
}

/* ── R10-A A1：@知识库 检索条数 k（prefs "kb.k" 本地，1-10 默认 4；浏览器态
     仅会话内生效不落盘，同 agent.engine 惯例）。 ── */

let kbK = KB_K_DEFAULT;

/** 启动恢复 k（脏值经 kbKOf 钳定）；设置页输入变更时写回。 */
function restoreKbK(): void {
  if (!inTauri) return;
  void prefGet("kb.k")
    .then((v) => {
      kbK = kbKOf(v);
    })
    .catch((err) => console.warn("[kb] k 读取失败", err));
}

/* ── R10-A A2：提示词库分区（能力 tab）。存储 tasksdb prefs "prompts"（Tauri，
     与 pi/dsh 同模式）；浏览器态 localStorage 兜底（同 cp.theme 惯例，纯客户端
     不落 hub）。列表行内编辑（hub-edit 形态）/删除两步确认（armClick 状态机）。 ── */

const PROMPT_PREF_KEY = "prompts";
const PROMPT_LS_KEY = "cp.prompts";

let promptDelArm: ArmState = { sid: null, at: 0 }; // sid = prompt id（两步删除同款状态机）
let promptArmTimer: ReturnType<typeof setTimeout> | null = null;

async function loadPromptStore(): Promise<string | null> {
  if (!inTauri) return localStorage.getItem(PROMPT_LS_KEY);
  return prefGet(PROMPT_PREF_KEY).catch(() => null);
}

/** 写穿：尽力而为（失败仅日志，列表态已是内存真源）。 */
function savePromptStore(value: string): void {
  if (!inTauri) {
    try {
      localStorage.setItem(PROMPT_LS_KEY, value);
    } catch (err) {
      console.warn("[prompts] 存储写入失败", err);
    }
    return;
  }
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("pref_set", { key: PROMPT_PREF_KEY, value }))
    .catch((err) => console.warn("[prompts] 存储写入失败", err));
}

function promptHintFlash(text: string): void {
  const hint = document.getElementById("prompt-hint");
  if (hint) hint.textContent = text;
}

function renderPromptArea(): void {
  const box = document.getElementById("prompt-list");
  if (!box) return;
  if (promptRows.length === 0) {
    box.innerHTML = `<div class="bk-empty">暂无提示词 · 对话输入 @ 可选用</div>`;
    return;
  }
  box.innerHTML =
    `<div class="bkhead"><span>NAME</span><span>BODY</span><span></span></div>` +
    promptRows
      .map(
        (p) =>
          `<div class="bkrow prompt-row" data-pid="${esc(p.id)}"><span class="n" title="${esc(p.name)}">${esc(p.name)}</span><span class="u" title="${esc(promptFirstLine(p.body))}">${esc(promptFirstLine(p.body))}</span><button type="button" class="mop" data-pedit="${esc(p.id)}">编辑</button><button type="button" class="mop del${promptDelArm.sid === p.id ? " armed" : ""}" data-pdel="${esc(p.id)}">${promptDelArm.sid === p.id ? "确认删" : "删除"}</button></div>`,
      )
      .join("");
}

/** 自存储重读（启动与进设置页两时机）；读到内存真源后同步 @面板缓存。 */
async function refreshPrompts(): Promise<void> {
  try {
    promptRows = parsePrompts(await loadPromptStore());
  } catch (e) {
    console.warn("[prompts] 读取失败", e);
    return;
  }
  renderPromptArea();
  atPanelSync();
}

/** 行内编辑（hub-edit 形态）：编辑=行内容原位换表单；添加=尾部追加同款表单。
    Enter（名栏）保存、Esc/失焦取消，「保存」钮 mousedown 吞焦点转移（点钮
    不先触发失焦取消，同 hub-edit）。名称不合法不关表单只出 hint。 */
function beginPromptEdit(pid: string | null): void {
  const box = document.getElementById("prompt-list");
  if (!box || box.querySelector(".prompt-edit") !== null) return;
  const p = pid !== null ? promptRows.find((x) => x.id === pid) : undefined;
  if (pid !== null && p === undefined) return;
  const row = pid !== null ? box.querySelector(`.prompt-row[data-pid="${CSS.escape(pid)}"]`) : null;
  const form = document.createElement("form");
  form.className = "formgrid prompt-edit";
  form.noValidate = true;
  form.innerHTML = `
    <div class="fld"><label>NAME</label><input type="text" class="pe-name" placeholder="如 翻译 / 周报" value="${p ? esc(p.name) : ""}"></div>
    <div class="fld"><label>BODY</label><textarea class="pe-body" rows="5" placeholder="提示词全文 · @面板选中即插入输入框光标处"></textarea></div>
    <div class="formacts"><button type="button" class="btn pri pe-save">保存</button><button type="button" class="btn sec pe-cancel">取消</button></div>`;
  const nameEl = form.querySelector<HTMLInputElement>(".pe-name");
  const bodyEl = form.querySelector<HTMLTextAreaElement>(".pe-body");
  if (p && bodyEl) bodyEl.value = p.body;
  if (row instanceof HTMLElement) row.replaceWith(form);
  else box.append(form);
  nameEl?.focus();
  let settled = false;
  const close = (): void => {
    if (settled) return;
    settled = true;
    renderPromptArea();
  };
  const commit = (): void => {
    if (settled || nameEl === null || bodyEl === null) return;
    if (!promptNameOk(nameEl.value)) {
      promptHintFlash("名称必填 · 不以 @ 开头");
      nameEl.focus();
      return;
    }
    settled = true;
    if (p === undefined) {
      promptRows.unshift({ id: crypto.randomUUID(), name: nameEl.value.trim(), body: bodyEl.value });
    } else {
      p.name = nameEl.value.trim();
      p.body = bodyEl.value;
    }
    savePromptStore(serializePrompts(promptRows));
    promptHintFlash("");
    renderPromptArea();
  };
  form.querySelector(".pe-save")?.addEventListener("mousedown", (ev) => ev.preventDefault());
  form.querySelector(".pe-save")?.addEventListener("click", () => commit());
  form.querySelector(".pe-cancel")?.addEventListener("click", () => close());
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    commit();
  });
  nameEl?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      if (ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
  bodyEl?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
  form.addEventListener("focusout", () => {
    // 焦点仍在表单内换栏不关（保存钮已吞 mousedown 焦点转移）
    if (!form.contains(document.activeElement)) close();
  });
}

/** 删除钮：armClick 状态机两步确认（MCP/会话/知识库删除同款）；确认后写穿。 */
function onPromptDeleteClick(pid: string): void {
  if (promptArmTimer !== null) {
    clearTimeout(promptArmTimer);
    promptArmTimer = null;
  }
  const r = armClick(promptDelArm, pid, Date.now());
  promptDelArm = r.next;
  if (!r.run) {
    promptArmTimer = setTimeout(() => {
      if (armExpired(promptDelArm, Date.now())) {
        promptDelArm = { sid: null, at: 0 };
        renderPromptArea();
      }
    }, ARM_WINDOW_MS + 20);
    renderPromptArea();
    return;
  }
  promptDelArm = { sid: null, at: 0 };
  promptRows = promptRows.filter((x) => x.id !== pid);
  savePromptStore(serializePrompts(promptRows));
  renderPromptArea();
}

function wireSettings(): void {
  const sec = document.getElementById("settings-sec");
  if (!sec) return;
  const themeSel = document.getElementById("theme-select");
  if (themeSel instanceof HTMLSelectElement) {
    themeSel.value = readTheme();
    themeSel.addEventListener("change", () => {
      const v = themeSel.value;
      if (v === "light" || v === "dark" || v === "auto") writeTheme(v);
    });
  }
  if (inTauri) {
    sec.addEventListener("submit", (ev) => {
      if (ev.target instanceof HTMLFormElement && ev.target.id === "byok-form") {
        ev.preventDefault();
        void onByokSave();
      }
    });
    void refreshAutostartRow();
  }
  // MCP 添加表单：浏览器态同样可用（hub API 不依赖桌面壳）
  sec.addEventListener("submit", (ev) => {
    if (ev.target instanceof HTMLFormElement && ev.target.id === "mcp-form") {
      ev.preventDefault();
      void onMcpSave();
    }
  });
  // 知识库入库表单（浏览器态可用；URL 形态 fetch_page 需桌面壳，onKbSave 内判）
  sec.addEventListener("submit", (ev) => {
    if (ev.target instanceof HTMLFormElement && ev.target.id === "kb-form") {
      ev.preventDefault();
      void onKbSave();
    }
  });
  const kbType = document.getElementById("kb-type");
  if (kbType instanceof HTMLSelectElement) kbType.addEventListener("change", kbFormSync);
  // 检索 k：变更即钳定回写（越界输入回显钳定值），Tauri 态记忆（chat.workdir 同款）
  const kbKInput = document.getElementById("kb-k");
  if (kbKInput instanceof HTMLInputElement) {
    kbKInput.value = String(kbK);
    kbKInput.addEventListener("change", () => {
      kbK = kbKOf(kbKInput.value);
      kbKInput.value = String(kbK);
      if (!inTauri) return;
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("pref_set", { key: "kb.k", value: String(kbK) }))
        .catch((err) => console.warn("[kb] k 记忆写入失败", err));
    });
  }
  sec.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "prompt-add") {
      beginPromptEdit(null);
      return;
    }
    const pedit = t.closest("[data-pedit]");
    if (pedit instanceof HTMLElement && pedit.dataset.pedit) {
      beginPromptEdit(pedit.dataset.pedit);
      return;
    }
    const pdel = t.closest("[data-pdel]");
    if (pdel instanceof HTMLElement && pdel.dataset.pdel) {
      onPromptDeleteClick(pdel.dataset.pdel);
      return;
    }
    if (t.id === "hub-edit") {
      const line = t.closest(".hubline");
      if (line instanceof HTMLElement) beginInlineHubEdit(line);
      return;
    }
    if (t.id === "mcp-add") {
      mcpAddOpen = !mcpAddOpen;
      renderMcpArea();
      return;
    }
    const mct = t.closest("[data-mcptoggle]");
    if (mct instanceof HTMLElement && mct.dataset.mcptoggle) {
      void onMcpToggle(mct.dataset.mcptoggle);
      return;
    }
    const mcd = t.closest("[data-mcpdel]");
    if (mcd instanceof HTMLElement && mcd.dataset.mcpdel) {
      void onMcpDeleteClick(mcd.dataset.mcpdel);
      return;
    }
    const kbd = t.closest("[data-kbdel]");
    if (kbd instanceof HTMLElement && kbd.dataset.kbdel) {
      void onKbDeleteClick(kbd.dataset.kbdel);
      return;
    }
    const kbr = t.closest("[data-kb-rebuild]");
    if (kbr instanceof HTMLElement) {
      void onKbRebuildClick();
      return;
    }
    if (t.id === "upd-check") {
      void onUpdateCheck();
      return;
    }
    if (t.id === "upd-relaunch") {
      void onRelaunch();
      return;
    }
    if (t.id === "auto-toggle") {
      void onAutostartToggle();
      return;
    }
    if (t.id === "env-recheck") {
      void loadEnv();
      return;
    }
    const ei = t.closest("[data-env-install]");
    if (ei instanceof HTMLElement && ei.dataset.envInstall) {
      void onEnvInstall(ei.dataset.envInstall);
      return;
    }
    const ec = t.closest("[data-env-copy]");
    if (ec instanceof HTMLElement && ec.dataset.envCopy) onEnvCopy(ec.dataset.envCopy, ec);
    const del = t.closest("[data-del]");
    if (del instanceof HTMLElement && del.dataset.del) void onByokDelete(del.dataset.del);
  });
}

/* ── 资产视图（rail 03，B5）：本地素材资产浏览/定位/复制路径 ── */

let assetRows: AssetRecord[] = [];

const ASSET_HINT_STANDBY = "succeeded 素材经「收进资产」落盘本地资产夹";
let assetHintRestoreTimer: number | undefined;

function renderAssetsSection(): string {
  return `
  <section class="assets" id="assets-sec" aria-label="本地资产">
    <div class="launch"><div class="fld grow"><label>ASSETS · 本地素材资产</label><span class="note" id="asset-hint">${esc(ASSET_HINT_STANDBY)}</span></div></div>
    <div class="asset-grid" id="asset-grid"><div class="task-empty">加载中…</div></div>
  </section>`;
}

/** 复制路径反馈：临时文案 2.5s 后还原常驻说明；连续点击重置计时。
    成功落 .note.ok（运行绿）、失败保持 .hint（危险红），还原回中性 .note。 */
function assetHintFlash(text: string, ok: boolean): void {
  const hint = document.getElementById("asset-hint");
  if (!hint) return;
  hint.className = ok ? "note ok" : "hint";
  hint.textContent = text;
  window.clearTimeout(assetHintRestoreTimer);
  assetHintRestoreTimer = window.setTimeout(() => {
    const h = document.getElementById("asset-hint");
    if (h) {
      h.className = "note";
      h.textContent = ASSET_HINT_STANDBY;
    }
  }, 2500);
}

async function refreshAssets(): Promise<void> {
  if (!inTauri) {
    const grid = document.getElementById("asset-grid");
    if (grid) grid.innerHTML = desktopOnlyNote("本地资产查看");
    return;
  }
  try {
    assetRows = await assetList();
    // 任务列 saved 标记回填：资产表 source_url 与素材 resultUrl 同源比对
    for (const a of assetRows) {
      for (const e of taskEntries.values()) {
        if (e.source === "material" && e.status === "succeeded" && e.resultUrl === a.sourceUrl) e.saved = true;
      }
    }
    renderTaskDyn();
    await renderAssetGrid();
  } catch (err) {
    console.warn("[assets] 列表加载失败", err);
    const grid = document.getElementById("asset-grid");
    if (grid) grid.innerHTML = `<div class="task-empty">资产列表加载失败 · 重进资产页重试</div>`;
  }
}

async function renderAssetGrid(): Promise<void> {
  const grid = document.getElementById("asset-grid");
  if (!grid) return;
  if (assetRows.length === 0) {
    // R6-C#1：空态给行动指引而非被动文案（视觉终审遗留）
    grid.innerHTML = `<div class="assets-empty"><div class="phase">MATERIAL · ASSETS</div><h2>还没有资产</h2><p>素材任务完成后点「收进资产」落盘本地，或直接去生成一张</p><button type="button" class="btn pri" id="assets-go-material">去生成素材</button></div>`;
    const go = document.getElementById("assets-go-material");
    if (go) {
      go.addEventListener("click", () => {
        setView("task");
        const tabs = [...document.querySelectorAll("#task-tabs button")];
        const m = tabs.find((t) => t.textContent === "素材");
        if (m instanceof HTMLButtonElement) m.click();
      });
    }
    return;
  }
  grid.innerHTML = assetRows
    .map((a) => {
      const title = assetTitle(a.prompt);
      const d = new Date(a.createdAt);
      const t = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const thumb =
        a.kind === "image"
          ? `<img class="asset-thumb" data-src="${esc(a.path)}" alt="${esc(title)}">`
          : `<div class="asset-thumb vid">VIDEO</div>`;
      return `<div class="asset-card">
      ${thumb}
      <div class="ttl">${esc(title)}</div>
      <div class="cnt">${a.kind === "image" ? "图" : "视频"} · ${t}</div>
      <div class="acts"><button type="button" class="btn sec" data-reveal="${esc(a.path)}">定位</button><button type="button" class="btn sec" data-copy="${esc(a.path)}">复制路径</button></div>
    </div>`;
    })
    .join("");
  // 缩略图惰性转换：asset 协议 URL 需 runtime 转换；不支持的环境缩略位留白不阻塞
  for (const img of grid.querySelectorAll<HTMLImageElement>("img.asset-thumb[data-src]")) {
    const src = img.dataset.src;
    if (!src) continue;
    try {
      img.src = await assetSrc(src);
    } catch {
      img.removeAttribute("data-src");
    }
  }
}

/** 素材结果收进本地资产：下载落盘 app_data/assets/ + 索引入 assets 表（B5）。 */
async function onAssetSave(id: string): Promise<void> {
  const e = taskEntries.get(id);
  if (e === undefined || e.source !== "material" || e.status !== "succeeded" || !e.resultUrl || e.saved) return;
  try {
    await assetSaveFromUrl(e.resultUrl, e.kind, materialTitle(e.prompt));
    e.saved = true;
    renderTaskDyn();
    if (document.getElementById("main")?.dataset.view === "assets") void refreshAssets();
  } catch (err) {
    console.warn("[assets] 收进资产失败", err);
    const hint = document.getElementById("task-hint");
    if (hint) hint.textContent = `收进资产失败：${errText(err)}`;
  }
}

function wireAssetsSection(): void {
  const sec = document.getElementById("assets-sec");
  if (!sec) return;
  sec.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const rv = t.closest("[data-reveal]");
    if (rv instanceof HTMLElement && rv.dataset.reveal) {
      void assetReveal(rv.dataset.reveal).catch((e) => console.warn("[assets] 定位失败", e));
      return;
    }
    const cp = t.closest("[data-copy]");
    if (cp instanceof HTMLElement && cp.dataset.copy) {
      const p = cp.dataset.copy;
      void navigator.clipboard
        .writeText(p)
        .then(() => assetHintFlash("路径已复制到剪贴板", true))
        .catch((e) => {
          console.warn("[assets] 复制失败", e);
          assetHintFlash(`复制失败 · 请手动复制：${p}`, false);
        });
    }
  });
}

function setView(view: DomainId): void {
  const main = document.getElementById("main");
  if (!main) return;
  main.dataset.view = view;
  for (const d of domains) {
    document.getElementById(`btn-${d.id}`)?.setAttribute("aria-pressed", String(d.id === view));
  }
  // 进入任务域即拉一次素材用量（60s 定时刷新兜底）；进入资产域即刷新列表；
  // 进入设置域即刷用量仪表盘（R9-B B3）与 MCP 分区（R9-C C3）与知识库分区
  // （R9-D D2）与提示词分区（R10-A A2）
  if (view === "task") {
    void refreshMaterialUsage();
    // 统一任务列随任务域进入拉一次（T1：10s 轮询兜底、material 轮询回调重拉）
    if (inTauri) void refreshUnifiedTasks();
    // 定时 tab 在选时任务域重进入也补一次拉取（离开期间调度线程可能已触发过）
    if (schedTabShown) void refreshScheds();
  }
  if (view === "assets") void refreshAssets();
  if (view === "settings") {
    void loadUsageDash();
    void loadMcpArea();
    void loadKbArea();
    void refreshPrompts();
  }
}

function renderShell(): void {
  app.innerHTML = `
${renderHeader(chatState.nickname || "…")}
<main id="main" data-view="task">
  ${renderRail()}
  ${renderTaskSection()}
  ${renderChatShell()}
  ${renderAssetsSection()}
  ${renderSettings()}
  ${renderAsideLive()}
</main>`;
  app.querySelectorAll<HTMLButtonElement>("[data-domain]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.domain;
      if (raw !== "chat" && raw !== "task" && raw !== "assets" && raw !== "settings") return;
      setView(raw);
    });
  });
  wireComposer();
  wireChatList();
  wireSettings();
  wireAssetsSection();
  wireTaskDomain();
  wireTaskBadge();
  mountTaskTabs();
  mountSettingsTabs();
  // 登录成功后直接落对话域（spec #2）；任务 / 设置 04 仍可随时切换
  setView("chat");
}

/* ── 对话域数据流 ── */

function currentModel(): ModelRef | null {
  return chatState.modelSeq.length > 0 ? chatState.modelSeq[chatState.modelIdx] : null;
}

/** 序列元素的唯一键：托管=模型名，BYOK=`byok:名字`（与消息 model_name 一致）。 */
function modelKey(m: ModelRef): string {
  return m.kind === "hosted" ? m.model.name : `byok:${m.view.name}`;
}

/** 重建 chip 序列（托管 + BYOK），保持当前选择不动（被删则回 0）。 */
function rebuildModelSeq(): void {
  const prev = currentModel();
  const prevKey = prev ? modelKey(prev) : "";
  chatState.modelSeq = [
    ...chatState.models.map((model): ModelRef => ({ kind: "hosted", model })),
    ...chatState.byok.map((view): ModelRef => ({ kind: "byok", view })),
  ];
  const idx = chatState.modelSeq.findIndex((m) => modelKey(m) === prevKey);
  chatState.modelIdx = idx >= 0 ? idx : 0;
  renderChip();
}

function renderChip(): void {
  const chip = document.getElementById("model-chip");
  if (!chip) return;
  if (parallelOn) {
    // 并答态 chip 是选模计数入口（点击开面板），不再是单选轮换
    chip.textContent = `并答 ${parallelPickedRefs().length}/${PARALLEL_MAX}`;
    chip.title = `并答模式 · 点选 ${PARALLEL_MIN}-${PARALLEL_MAX} 个模型（托管池 + BYOK 混选）`;
    renderRouteInfo();
    return;
  }
  const m = currentModel();
  chip.textContent = m ? modelKey(m) : "byok:";
  chip.title = !m
    ? "无可用模型 · 设置（rail 04）中可配 BYOK 直连"
    : m.kind === "byok"
      ? `${m.view.baseUrl} · BYOK 直连`
      : chatState.modelSeq.length > 1
        ? "点击选择模型"
        : `${m.model.provider} · 托管池`;
  // ROUTE 行与 chip 同源同状态（同一 modelSeq 两处视图），一并重绘
  renderRouteInfo();
}

/** 普通态模型菜单（R11-B U1）：单选浮层，行态复用 @/并答面板的 atitem/cur
    语言（ppanel 取 phint 样式）；与 chip 文案同源 modelSeq，点选即切
    modelIdx。并答态 chip 仍走并答选模面板（多选），不进此菜单。 */
function setChipMenu(open: boolean): void {
  const menu = document.getElementById("model-menu");
  if (!(menu instanceof HTMLElement)) return;
  if (open) {
    // 与 @ 面板同位（composer 左下），互斥避免叠层
    const at = document.getElementById("at-panel");
    if (at instanceof HTMLElement) at.hidden = true;
    renderChipMenu();
  }
  menu.hidden = !open;
}

function renderChipMenu(): void {
  const menu = document.getElementById("model-menu");
  if (!(menu instanceof HTMLElement)) return;
  const cm = currentModel();
  const curKey = cm ? modelKey(cm) : "";
  const rows = chatState.modelSeq
    .map((m) => {
      const key = modelKey(m);
      const on = key === curKey;
      const desc = m.kind === "byok" ? `${m.view.baseUrl} · BYOK 直连` : `${m.model.provider} · 托管池`;
      return `<div class="atitem${on ? " cur" : ""}" data-mkey="${esc(key)}" role="button" tabindex="0"${on ? ' aria-selected="true"' : ""}><b>${esc(key)}</b><span>${esc(desc)}</span></div>`;
    })
    .join("");
  menu.innerHTML = rows !== "" ? rows : `<div class="phint mono">无可用模型 · 设置（rail 04）中可配 BYOK 直连</div>`;
}

async function loadModels(): Promise<void> {
  chatState.models = decodeModels(await api("/api/v1/models")).filter((m) => m.enabled);
  chatState.modelsLoaded = true;
  rebuildModelSeq();
}

/** 拉 BYOK 列表（keyring→索引→逐条），失败告警并按空表处理（不阻塞对话域）。 */
async function loadByok(): Promise<void> {
  if (!inTauri) return;
  let err: string | null = null;
  try {
    chatState.byok = await byokList();
  } catch (e) {
    chatState.byok = [];
    err = errText(e);
    console.warn("[byok] 列表读取失败", e);
  }
  rebuildModelSeq();
  renderByokTable(err);
}

async function loadSessions(): Promise<void> {
  chatState.sessions = decodeSessions(await api("/api/v1/sessions?limit=50"));
  chatState.currentId = null;
  resetArm();
  renderSessionList();
  const first = chatState.sessions[0];
  if (first) {
    await selectSession(first.id);
  } else {
    // 零会话首登：没有 selectSession 路径会触达 renderMessages，
    // 补一次让空态引导可见（2026-11-12 评审邻接缺口）。
    renderMessages();
  }
}

/* ── R9-C C2：会话列表头搜索（防抖 300ms / trim ≥2 字触发 / 序号竞态守卫） ── */

const SESS_DEBOUNCE_MS = 300;
const SESS_QUERY_MIN = 2;
const SESS_QUERY_MAX = 100;

let sessQuery = "";
let sessResults: SessionSearchRow[] | null = null;
let sessResultsErr = "";
let sessSearchSeq = 0;
let sessDebounce: number | undefined;

/** 搜索框随列表重绘（值取模块态，中途重绘不丢输入）；浮层单独填。 */
function sessSearchHTML(): string {
  return `<div class="sess-search"><input type="search" id="sess-q" placeholder="搜索会话标题与消息…" value="${esc(sessQuery)}" aria-label="搜索会话"><div class="sresults" id="sess-results" hidden></div></div>`;
}

/** 结果浮层：标题+片段命中 <mark> 高亮（高亮纯函数在 parallel.ts）；
    空结果一行占位；错误一行（不吞不闪）。 */
function renderSessResults(): void {
  const box = document.getElementById("sess-results");
  if (!(box instanceof HTMLElement)) return;
  if (sessResults === null) {
    if (sessResultsErr === "") {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    box.innerHTML = `<div class="srow off">${esc(sessResultsErr)}</div>`;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    sessResults.length === 0
      ? `<div class="srow off">无匹配会话</div>`
      : sessResults
          .map(
            (r) =>
              `<div class="srow" data-ssid="${esc(r.sessionId)}" role="button" tabindex="0"><span class="st">${highlightSnippet(r.title || "未命名会话", sessQuery)}</span><span class="ss">${highlightSnippet(r.snippet, sessQuery)}</span><span class="tm">${esc(sessionTime(r.createdAt))}</span></div>`,
          )
          .join("");
}

/** 防抖触发：每次输入重置；<2 字立即清浮层并作废在途请求。 */
function sessSearchKick(): void {
  window.clearTimeout(sessDebounce);
  sessDebounce = window.setTimeout(() => void runSessSearch(), SESS_DEBOUNCE_MS);
}

async function runSessSearch(): Promise<void> {
  const q = sessQuery.trim().slice(0, SESS_QUERY_MAX);
  if (q.length < SESS_QUERY_MIN) {
    sessSearchSeq++;
    sessResults = null;
    sessResultsErr = "";
    renderSessResults();
    return;
  }
  const seq = ++sessSearchSeq;
  try {
    const rows = await searchSessions(q);
    if (seq !== sessSearchSeq) return; // 旧响应丢弃（竞态守卫）
    sessResults = rows;
    sessResultsErr = "";
  } catch (e) {
    if (seq !== sessSearchSeq) return;
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    sessResults = null;
    sessResultsErr = errText(e);
  }
  renderSessResults();
}

/** Esc / 选中后清空：复位输入、浮层与在途请求，重绘列表回常态。 */
function clearSessSearch(): void {
  sessQuery = "";
  sessResults = null;
  sessResultsErr = "";
  sessSearchSeq++;
  window.clearTimeout(sessDebounce);
  renderSessionList();
}

function renderSessionList(): void {
  const box = document.getElementById("chats");
  if (!box) return;
  const search = sessSearchHTML();
  if (chatState.sessions.length === 0) {
    box.innerHTML = `${search}
    <h2>会话</h2>
    <div class="empty"><p>暂无会话</p><button type="button" class="btn sec" id="new-session">新建</button></div>`;
    renderSessResults();
    return;
  }
  // 列表按 updated_at 倒序（server 保证）；编号沿用原型习惯：最新的号最大
  const total = chatState.sessions.length;
  const groups: { label: string; rows: { s: SessionRow; no: string }[] }[] = [];
  chatState.sessions.forEach((s, i) => {
    const label = dayLabel(s.createdAt);
    const last = groups[groups.length - 1];
    const row = { s, no: String(total - i).padStart(2, "0") };
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  });
  box.innerHTML =
    search +
    groups
      .map(
        (g, gi) => `
    <h2${gi > 0 ? ' style="margin-top:14px"' : ""}>${esc(g.label)}</h2>
    ${g.rows
      .map(
        ({ s, no }) =>
          `<div class="crow${s.id === chatState.currentId ? " cur" : ""}" data-sid="${esc(s.id)}" role="button" tabindex="0"><span class="no">${no}</span><span class="nm">${esc(s.title || "未命名会话")}</span><span class="tm">${esc(sessionTime(s.updatedAt))}</span>${sessionOpsHTML(s.id)}</div>`,
      )
      .join("")}`,
      )
      .join("");
  renderSessResults();
}

/* ── 会话行操作：行内改名 + 两步删除（武装态存模块状态，跨 innerHTML 重绘保持） ── */

let delArm: ArmState = { sid: null, at: 0 };
let delArmTimer: ReturnType<typeof setTimeout> | null = null;

function resetArm(): void {
  delArm = { sid: null, at: 0 };
  if (delArmTimer !== null) {
    clearTimeout(delArmTimer);
    delArmTimer = null;
  }
}

/** 行尾操作钮（CSS hover 显形；武装中的删除钮常显并改文案——对话框的两步钮替代）。 */
function sessionOpsHTML(sid: string): string {
  const armed = delArm.sid === sid;
  return `<span class="rowops"><button type="button" class="rop" data-rename="${esc(sid)}">改名</button><button type="button" class="rop" data-export="${esc(sid)}">导出</button><button type="button" class="rop del${armed ? " armed" : ""}" data-del="${esc(sid)}">${armed ? "确认删" : "删除"}</button></span>`;
}

/** 行内改名：标题位换 input；Enter/失焦提交、Esc 取消，提交与否走 renameDecision 纯判定。 */
function beginRename(sid: string): void {
  const open = document.querySelector<HTMLInputElement>(".chats .rn");
  if (open) open.blur(); // 已有编辑行先失焦提交（同步重绘后再取新行节点）
  const s = chatState.sessions.find((x) => x.id === sid);
  const row = document.querySelector(`.crow[data-sid="${CSS.escape(sid)}"]`);
  const nm = row instanceof HTMLElement ? row.querySelector(".nm") : null;
  if (!s || !(nm instanceof HTMLElement)) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "rn";
  input.value = s.title;
  nm.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const settle = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    renderSessionList();
    if (commit && renameDecision(s.title, input.value) === "submit") void commitRename(s.id, input.value.trim());
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      if (ev.isComposing || ev.keyCode === 229) return;
      ev.preventDefault();
      settle(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      settle(false);
    }
  });
  input.addEventListener("blur", () => settle(true));
}

async function commitRename(sid: string, title: string): Promise<void> {
  try {
    const saved = await renameSession(sid, title);
    const cur = chatState.sessions.find((x) => x.id === sid);
    if (cur) cur.title = saved.title;
    // 已有另一处编辑行打开时跳过重绘，避免 innerHTML 拆掉它；该行 settle 时自然刷新
    if (document.querySelector(".chats .rn") === null) renderSessionList();
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(`改名失败 · ${errText(e)}`);
  }
}

/** 删除钮：armClick 状态机两步确认；确认后删行，删的是当前会话则清消息区回空态。 */
async function onDeleteClick(sid: string): Promise<void> {
  if (delArmTimer !== null) {
    clearTimeout(delArmTimer);
    delArmTimer = null;
  }
  const r = armClick(delArm, sid, Date.now());
  delArm = r.next;
  if (!r.run) {
    // +20ms 余量：到点判定含端点（<=窗口可执行），计时器须落在窗口外
    delArmTimer = setTimeout(() => {
      if (armExpired(delArm, Date.now())) {
        resetArm();
        renderSessionList();
      }
    }, ARM_WINDOW_MS + 20);
    renderSessionList();
    return;
  }
  if (chatState.streaming && sid === chatState.currentId) {
    resetArm();
    renderSessionList();
    showStreamErr("流式生成中 · 完成后再删当前会话");
    return;
  }
  try {
    await deleteSession(sid);
    resetArm();
    chatState.sessions = chatState.sessions.filter((x) => x.id !== sid);
    if (chatState.currentId === sid) {
      chatState.currentId = null;
      chatState.messages = [];
      renderMessages();
    }
    renderSessionList();
  } catch (e) {
    resetArm();
    renderSessionList();
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(`删除失败 · ${errText(e)}`);
  }
}

/** 会话导出（R10-A A3）：fetchMessagesPage 游标拉全（exportFoldPage 折叠成
    旧→新）→ sessionToMarkdown → Blob 落盘「会话名.md」（webview 原生下载）。
    并答/资料折叠条是本地渲染态不落库，导出即 hub 落库内容。 */
async function onSessionExport(sid: string): Promise<void> {
  const s = chatState.sessions.find((x) => x.id === sid);
  if (!s) return;
  try {
    let acc: MessageRow[] = [];
    let cursor: number | undefined = undefined;
    for (;;) {
      const page = await fetchMessagesPage(sid, cursor);
      const r = exportFoldPage(acc, page);
      acc = r.rows;
      if (r.nextCursor === undefined) break;
      cursor = r.nextCursor;
    }
    const title = s.title || "未命名会话";
    const url = URL.createObjectURL(new Blob([sessionToMarkdown(title, acc)], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(s.title);
    document.body.append(a);
    a.click();
    a.remove();
    // 下载已由 click 同步启动，下一拍 revoke 防 URL 泄漏（WKWebView 兼容不即撤）
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(`导出失败 · ${errText(e)}`);
  }
}

async function selectSession(id: string): Promise<void> {
  if (chatState.streaming || chatState.currentId === id) return;
  chatState.currentId = id;
  renderSessionList();
  try {
    const page = await fetchMessagesPage(id);
    chatState.messages = page.rows;
    chatState.msgHasMore = page.hasMore;
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    chatState.messages = [];
    renderMessages();
    showStreamErr(errText(e));
    return;
  }
  renderMessages();
}

/** MessageRow.meta 的本地扩展位（R9-D @资料/@知识库）：refLen（折叠条字数）/
    refText（资料全文，URL 形态=抓取结果）/kbHits（@知识库 命中段落）仅本地
    渲染态，不落 hub（meta 白名单在 api.ts，读侧以交集类型取用）。 */
type RefMeta = NonNullable<MessageRow["meta"]> & { refLen?: number; refText?: string; kbHits?: KbHit[] };

/** @资料/@知识库 折叠条展开态（@资料 按资料全文、@知识库 按 kbHitsKey 为键）：
    renderMessages 整体重绘（任务事件/素材轮询触发的同步重绘）不丢用户正在
    展开阅读的状态。 */
const refOpen = new Set<string>();

function messageHTML(m: MessageRow, idx: number): string {
  if (m.meta?.parallelId !== undefined) return parallelBlockHTML(m.meta.parallelId, textOfContent(m.content));
  if (m.meta?.materialTaskId !== undefined)
    return materialMsgCardHTML(m.meta.materialTaskId, m.meta.kind ?? "image", textOfContent(m.content));
  const rm = m.meta as RefMeta | undefined;
  if (rm?.refLen !== undefined) return refMsgHTML(m, rm.refText ?? "", rm.refLen, idx);
  if (rm?.kbHits !== undefined) return kbMsgHTML(m, rm.kbHits, idx);
  if (m.meta !== undefined) return taskCardHTML(m.meta.taskId ?? "", textOfContent(m.content));
  const mine = m.role === "user";
  const who = mine ? chatState.nickname : m.modelName || "assistant";
  const roleLabel = mine ? "操作者" : m.modelName.startsWith("byok:") ? "BYOK 直连" : "托管池";
  /* hover 操作：复制（全文原文）+ 重发（仅 user；hub 无消息替换 API，
     重发=以原问重开一轮追加新答，不是原地替换） */
  const ops = `<div class="mops"><button type="button" class="mop" data-mcopy="${idx}">复制</button>${
    mine ? `<button type="button" class="mop" data-mresend="${idx}">重发</button>` : ""
  }</div>`;
  return `
  <div class="bubble ${mine ? "me" : "ai"}">
    <div class="who"><span class="n">${esc(who)}</span><span class="role">${roleLabel}</span></div>
    <div class="b">${renderContentHTML(m.content)}</div>
    ${ops}
  </div>`;
}

/** @资料 user 消息（R9-D D1）：折叠条（资料全文在 meta.refText 本地态，展开态
    由 refOpen 集合跨重绘保持）+ 问题正文（自原文重新解析）；气泡骨架与 hover
    操作（复制/重发）同普通 user 消息。重载 hub 后无 meta，走普通气泡。 */
function refMsgHTML(m: MessageRow, refText: string, refLen: number, idx: number): string {
  const raw = textOfContent(m.content);
  const question = parseAtRef(raw)?.question ?? raw;
  const ops = `<div class="mops"><button type="button" class="mop" data-mcopy="${idx}">复制</button><button type="button" class="mop" data-mresend="${idx}">重发</button></div>`;
  return `
  <div class="bubble me">
    <div class="who"><span class="n">${esc(chatState.nickname)}</span><span class="role">操作者</span></div>
    <div class="b">${refCollapsedHTML(refText, refLen, refOpen.has(refText))}${renderContentHTML(question)}</div>
    ${ops}
  </div>`;
}

/** @知识库 user 消息（R9-D D2）：命中段落折叠条（meta.kbHits 本地态，展开态
    以 kbHitsKey 跨重绘保持）+ 问题正文（自原文重新解析）；气泡骨架与 hover
    操作同 @资料。重载 hub 后无 meta（hub 落库的是注入后的完整 content），走
    普通气泡。 */
function kbMsgHTML(m: MessageRow, hits: KbHit[], idx: number): string {
  const raw = textOfContent(m.content);
  const question = parseAtKb(raw)?.question ?? raw;
  const ops = `<div class="mops"><button type="button" class="mop" data-mcopy="${idx}">复制</button><button type="button" class="mop" data-mresend="${idx}">重发</button></div>`;
  return `
  <div class="bubble me">
    <div class="who"><span class="n">${esc(chatState.nickname)}</span><span class="role">操作者</span></div>
    <div class="b">${kbCollapsedHTML(hits, refOpen.has(kbHitsKey(hits)))}${renderContentHTML(question)}</div>
    ${ops}
  </div>`;
}

/** 加载更早消息（R5-B#2）：以最旧服务端 id 为游标前翻；本地临时消息 id=0
    不能作游标。重渲染后按高度差锚定视口（顶置内容不跳屏）。 */
async function onLoadEarlier(): Promise<void> {
  const stream = document.getElementById("stream");
  if (!(stream instanceof HTMLElement) || chatState.currentId === null) return;
  const cursor = chatState.messages.find((m) => m.id > 0)?.id;
  if (cursor === undefined) return;
  const btn = document.getElementById("load-earlier");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  const prevTop = stream.scrollTop;
  const prevHeight = stream.scrollHeight;
  try {
    const page = await fetchMessagesPage(chatState.currentId, cursor);
    chatState.messages = [...page.rows, ...chatState.messages];
    chatState.msgHasMore = page.hasMore;
    renderMessages();
    stream.scrollTop = stream.scrollHeight - prevHeight + prevTop;
  } catch (err) {
    if (err instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(errText(err));
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
}

/** 消息区空态文案：按是否已有选中会话分叉——无会话时发送才建会话；
    已选中（新建或历史空会话）时承诺的是「继续」，不再是「自动建立」。 */
function streamEmptyHTML(currentId: string | null): string {
  return currentId === null
    ? "在下方输入即可开始对话 · 发送将自动建立会话"
    : "该会话还没有消息 · 在下方输入即可继续";
}

function renderMessages(): void {
  const stream = document.getElementById("stream");
  if (!stream) return;
  if (chatState.messages.length === 0) {
    stream.innerHTML = `<div class="stream-empty">${streamEmptyHTML(chatState.currentId)}</div>`;
    return;
  }
  stream.innerHTML =
    (chatState.msgHasMore
      ? `<div class="load-earlier"><button type="button" class="btn sec" id="load-earlier">加载更早消息</button></div>`
      : "") + chatState.messages.map((m, i) => messageHTML(m, i)).join("");
  scrollStreamBottom();
}

function appendStreamingMsg(modelName: string, roleLabel: string): { p: HTMLElement; err: HTMLElement } {
  const p = document.createElement("div");
  p.className = "b streaming";
  const err = document.createElement("div");
  err.className = "errline";
  err.hidden = true;
  const who = document.createElement("div");
  who.className = "who";
  who.innerHTML = `<span class="n">${esc(modelName)}</span><span class="role">${esc(roleLabel)}</span>`;
  const msg = document.createElement("div");
  msg.className = "bubble ai";
  msg.append(who, p, err);
  const stream = document.getElementById("stream");
  if (stream) stream.append(msg);
  scrollStreamBottom();
  return { p, err };
}

async function createSession(title: string): Promise<string> {
  const model = currentModel();
  const sess = decodeSessionCreated(
    await api("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ title, model_name: model ? modelKey(model) : "" }),
    }),
  );
  chatState.sessions.unshift(sess);
  chatState.currentId = sess.id;
  chatState.messages = [];
  renderSessionList();
  renderMessages();
  return sess.id;
}

function setComposerBusy(busy: boolean): void {
  const btn = document.getElementById("composer-send");
  if (btn instanceof HTMLButtonElement) btn.disabled = busy;
}

function showStreamErr(text: string): void {
  const stream = document.getElementById("stream");
  if (!stream) return;
  const el = document.createElement("div");
  el.className = "errline";
  el.textContent = text;
  stream.append(el);
  scrollStreamBottom();
}

function scrollStreamBottom(): void {
  const stream = document.getElementById("stream");
  if (stream) stream.scrollTop = stream.scrollHeight;
}

/** 本页内存消息（BYOK 直连不落 hub 会话，user/assistant 追加共用；parts 随内容携带）。
    meta：harness 任务卡 {taskId} / @生图卡 {materialTaskId,kind}（R9-B，本地态）/
    @资料折叠条 {refLen,refText} / @知识库折叠条 {kbHits}（R9-D，本地态）。 */
function pushLocalMessage(
  role: "user" | "assistant",
  content: string | ContentPart[],
  modelName: string,
  meta?: RefMeta,
): void {
  chatState.messages.push({
    id: 0,
    role,
    content,
    modelName,
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
    createdAt: new Date().toISOString(),
    ...(meta !== undefined ? { meta } : {}),
  });
}

/** 历史消息 + 本条 user 请求（托管/BYOK 两条发送路径共用）。
    历史原样透传：纯文本消息保持 string，带图消息保持 parts（vision 模型
    可见历史图；无图会话与旧会话零变化）。并答块不回灌（R9-C 取舍：
    并答是对照视图；单列转成的普通消息对无 meta，自然进历史）。
    @资料 消息（meta.refLen 标记）与 @知识库 消息（meta.kbHits 标记）只回灌
    问题段——资料与检索命中段单轮即弃，追问不带（R9-D 语义，refQuestionOf
    断言钉住）。 */
function historyWith(content: string | ContentPart[]): ChatMessageWire[] {
  const h: ChatMessageWire[] = chatState.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.meta?.parallelId === undefined)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? refQuestionOf(m.content, m.meta as RefMeta | undefined) : m.content,
    }));
  h.push({ role: "user", content });
  return h;
}

async function onSend(): Promise<void> {
  const input = document.getElementById("composer-input");
  if (!(input instanceof HTMLTextAreaElement) || chatState.streaming) return;
  const text = input.value.trim();
  if (!text && pendingImages.length === 0 && pendingTexts.length === 0) return;
  const isAgentRoute =
    text.startsWith("@agent") ||
    text.startsWith("@生图") ||
    text.startsWith("@资料") ||
    text.startsWith("@知识库") ||
    atSkillItems.some((i) => i.trigger !== "@agent" && text.startsWith(i.trigger + " "));
  // 附件只走对话模型；带附件误触 @agent/@技能/@生图/@资料/@知识库 明确拒收，不静默降级成普通消息
  if ((pendingImages.length > 0 || pendingTexts.length > 0) && isAgentRoute) {
    composerHintFlash("带附件消息走对话模型 · 不支持 @agent / @技能 / @生图 / @资料 / @知识库");
    return;
  }
  if (text.startsWith("@agent")) {
    await onAgentSend(text, input);
    return;
  }
  if (text.startsWith("@生图")) {
    await onAtImageSend(text, input);
    return;
  }
  if (text.startsWith("@资料")) {
    await onAtRefSend(text, input);
    return;
  }
  if (text.startsWith("@知识库")) {
    await onAtKbSend(text, input);
    return;
  }
  const skill = atSkillItems.find((i) => i.trigger !== "@agent" && text.startsWith(i.trigger + " "));
  if (skill !== undefined) {
    await onSkillSend(skill.trigger.slice(1), text.slice(skill.trigger.length + 1), text, input);
    return;
  }
  // 并答分派在 @ 路由之后：@agent/@技能/@生图 在并答开启时仍按原路由走
  if (parallelOn) {
    await onParallelSend(text, input);
    return;
  }
  const model = currentModel();
  if (!model) {
    showStreamErr("无可用模型 · 设置（rail 04）中可配 BYOK 直连");
    return;
  }
  // R11-B U3：文本附件作为本轮资料前缀并入线上载荷（@资料 同形态）；
  // 本地视图存原文 + meta 折叠条（refQuestionOf 回灌时自动只带问题段）
  const refFiles = pendingTexts.length > 0 ? refFilesPayload(pendingTexts, text) : null;
  const content = wireContent(refFiles ? refFiles.content : text);
  const localView = refFiles
    ? { content: wireContent(text), meta: { refLen: refFiles.refText.length, refText: refFiles.refText } }
    : undefined;
  if (model.kind === "byok") {
    await sendByok(model.view, content, input, localView);
    return;
  }
  await sendHosted(model.model.name, content, input, historyWith(content), localView);
}

/** @agent 发起（R6-B 拍板：@语法/拒绝指路/hub meta 溯源）。
    @消息本体作为 user 消息落库；任务卡作为 assistant 消息带 meta 落库；
    BYOK 无 hub 会话时双消息仅本地呈现。workdir 取会话记忆（U4 pref）。 */
async function onAgentSend(text: string, input: HTMLTextAreaElement): Promise<void> {
  const goal = text.slice("@agent".length).trim();
  if (!goal) {
    showStreamErr("@agent 目标为空 · 用法：@agent <自然语言目标>");
    return;
  }
  await agentSendCore(goal, text, input);
}

/** @技能 发送（U5）：goal 展开为技能指令（harness 系统提示已列技能，
    agent 会按名 load_skill），其余与 @agent 同路径。 */
async function onSkillSend(name: string, args: string, text: string, input: HTMLTextAreaElement): Promise<void> {
  const rest = args.trim();
  const goal = rest !== "" ? `使用技能 ${name}：${rest}` : `使用技能 ${name}`;
  await agentSendCore(goal, text, input);
}

/** @agent/@技能 共用发起核心（单活跃/模型/workdir 三前置 + 落库 + 任务卡）。 */
async function agentSendCore(goal: string, text: string, input: HTMLTextAreaElement): Promise<void> {
  for (const e of taskEntries.values()) {
    if (e.source === "harness" && taskLive(e)) {
      showStreamErr("已有任务在跑 · 任务中心查看（顶栏徽标）");
      return;
    }
  }
  const model = chatState.models.find((m) => m.enabled);
  if (!model) {
    showStreamErr("@agent 需要托管池模型（BYOK key 不出本机）· 设置中确认模型池");
    return;
  }
  const workingDir = inTauri ? await prefGet("chat.workdir").catch(() => null) : null;
  if (!workingDir) {
    showStreamErr("@agent 需要工作目录 · 先在任务域发起一次任务以记忆目录");
    return;
  }
  input.value = "";
  if (chatState.currentId !== null) {
    try {
      await appendMessage(chatState.currentId, "user", text);
    } catch {
      /* 落库尽力而为：本地呈现继续，重载后由会话真源对齐 */
    }
  }
  pushLocalMessage("user", text, model.name);
  renderMessages();
  try {
    const id = await harnessRun({ goal, workingDir, model: model.name, hubUrl: hubUrl(), token: await getToken() });
    const key = String(id);
    taskEntries.set(key, {
      source: "harness",
      id: key,
      goal,
      model: model.name,
      state: null,
      lastStep: 0,
      tokensIn: 0,
      tokensOut: 0,
      logs: [],
      startedAt: Date.now(),
      endedAt: null,
      holdErr: "",
    });
    taskSelected = key;
    taskSelKind = "harness";
    const cardMeta = { taskId: `h${id}` };
    if (chatState.currentId !== null) {
      try {
        await appendMessage(chatState.currentId, "assistant", goal, cardMeta);
      } catch {
        /* 同上：尽力而为 */
      }
    }
    pushLocalMessage("assistant", goal, model.name, cardMeta);
    renderMessages();
    updateTaskBadge();
  } catch (err) {
    if (err instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(errText(err));
  }
}

/** @生图 发起（R9-B B1）：前缀解析 → createMaterial → 任务列登记（轮询/任务域
    共用）+ 对话流插本地卡消息。卡不落 hub（重启消失）——任务域有全量任务与
    结果，不重复持久化（设计取舍）。 */
async function onAtImageSend(text: string, input: HTMLTextAreaElement): Promise<void> {
  const cmd = parseAtImage(text);
  if (cmd === null) return; // onSend 前缀分支已保证命中，防御
  if (cmd.prompt === "") {
    showStreamErr(`@生图${cmd.kind === "video" ? "视频" : ""} 描述为空 · 用法：@生图 <描述>（@生图视频 走视频）`);
    return;
  }
  input.value = "";
  try {
    const t = await createMaterial(cmd.kind, cmd.prompt);
    const entry = materialEntryOf(t);
    taskEntries.set(t.id, entry);
    persistMaterial(entry);
    updateTaskBadge();
    renderTaskDyn();
    pushLocalMessage("user", text, "material", { materialTaskId: t.id, kind: t.kind });
    renderMessages();
  } catch (err) {
    if (err instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(errText(err));
  }
}

/** @资料 发送（R9-D D1）：前缀解析 → URL 形态走 Rust fetch_page 抓取（按钮态
    「抓取中…」，失败 errline 不发送、草稿保留）/ 纯文本直接采用 → 资料以
    「以下是一份参考资料：」前缀并入本轮 user content，走当前模型路由的现有
    发送管线（sendHosted/sendByok 同构）；本地消息存原文 + meta 折叠条（hub
    落库的是并入后的完整 content，meta 不持久）。 */
async function onAtRefSend(text: string, input: HTMLTextAreaElement): Promise<void> {
  const parsed = parseAtRef(text);
  if (parsed === null) {
    showStreamErr("@资料 用法：@资料 <URL 或粘贴文本>，空行后写问题");
    return;
  }
  let refText = parsed.ref;
  if (refIsUrl(refText)) {
    if (!inTauri) {
      showStreamErr("URL 抓取需桌面端 · 浏览器内请直接粘贴文本");
      return;
    }
    const btn = document.getElementById("composer-send");
    const prev = btn instanceof HTMLButtonElement ? btn.textContent : null;
    if (btn instanceof HTMLButtonElement) {
      btn.textContent = "抓取中…";
      btn.disabled = true;
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const page = await invoke<{ title: string; text: string }>("fetch_page", { url: refText });
      refText = page.text;
    } catch (e) {
      showStreamErr(`资料抓取失败 · ${errText(e)}`);
      return;
    } finally {
      if (btn instanceof HTMLButtonElement && prev !== null) btn.textContent = prev;
      if (btn instanceof HTMLButtonElement) btn.disabled = false;
    }
  }
  if (refOverLimit(refText)) {
    showStreamErr(`资料超长（上限 ${Math.round(REF_MAX_BYTES / 1024)}K 字节）· 请精简或改用链接`);
    return;
  }
  const model = currentModel();
  if (!model) {
    showStreamErr("无可用模型 · 设置（rail 04）中可配 BYOK 直连");
    return;
  }
  const content = `以下是一份参考资料：\n${refText}\n\n${parsed.question}`;
  const localView = { content: text, meta: { refLen: refText.length, refText } };
  if (model.kind === "byok") {
    await sendByok(model.view, content, input, localView);
    return;
  }
  await sendHosted(model.model.name, content, input, historyWith(content), localView);
}

/** @知识库 发送（R9-D D2）：前缀解析出问题 → hub kb/search 取 top-k（R10-A：
    k 走设置页记忆，默认 4）→ 命中段落以「以下是从知识库检索的参考段落：」前缀
    并入本轮 user content（同
    @资料 单轮语义，命中段不回灌追问），走当前模型路由的现有发送管线；
    本地消息存原文 + meta.kbHits 折叠条。无命中提示一行后仍发（模型自然
    回答，此时无折叠条）。检索失败 errline 不发送、草稿保留。 */
async function onAtKbSend(text: string, input: HTMLTextAreaElement): Promise<void> {
  const parsed = parseAtKb(text);
  if (parsed === null) {
    showStreamErr("@知识库 用法：@知识库 <问题>（空格后写问题）");
    return;
  }
  const model = currentModel();
  if (!model) {
    showStreamErr("无可用模型 · 设置（rail 04）中可配 BYOK 直连");
    return;
  }
  const btn = document.getElementById("composer-send");
  const prev = btn instanceof HTMLButtonElement ? btn.textContent : null;
  if (btn instanceof HTMLButtonElement) {
    btn.textContent = "检索中…";
    btn.disabled = true;
  }
  let hits: KbHit[] = [];
  let expired = false;
  try {
    hits = await kbSearch(parsed.question, kbK);
  } catch (e) {
    if (e instanceof SessionExpired) expired = true;
    else showStreamErr(`知识库检索失败 · ${errText(e)}`);
  } finally {
    if (btn instanceof HTMLButtonElement && prev !== null) btn.textContent = prev;
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
  if (expired) {
    renderLogin();
    return;
  }
  if (hits.length === 0) {
    composerHintFlash("知识库无命中 · 已按普通提问发送");
    await (model.kind === "byok"
      ? sendByok(model.view, parsed.question, input)
      : sendHosted(model.model.name, parsed.question, input, historyWith(parsed.question)));
    return;
  }
  const paras = hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n");
  const content = `以下是从知识库检索的参考段落：\n${paras}\n\n${parsed.question}`;
  const localView = { content: text, meta: { kbHits: hits } satisfies RefMeta };
  if (model.kind === "byok") {
    await sendByok(model.view, content, input, localView);
    return;
  }
  await sendHosted(model.model.name, content, input, historyWith(content), localView);
}

/** 任务卡消息（R6-B U3）：meta.taskId 命中本地任务 → 活卡（状态/迷你遥测/
    HOLD 内嵌/终态摘要）；未命中（他机历史）→ 降级卡。data-htask 供审批委托定位。 */
function taskCardHTML(taskId: string, goal: string): string {
  const key = taskId.startsWith("h") ? taskId.slice(1) : taskId;
  const e = taskEntries.get(key);
  if (e === undefined || e.source !== "harness") {
    return `<div class="taskcard off" data-htask="${esc(key)}"><span class="st dn">TASK</span><span class="tc-goal">${esc(goal)}</span><span class="tc-meta">任务 ${esc(taskId)} · 本机无记录</span></div>`;
  }
  const b = statusBadge(e);
  const live = taskLive(e);
  const tele = `STEPS ${e.lastStep} · TOKENS ${e.tokensIn + e.tokensOut} · ${mmss(elapsedMs(e))}`;
  const done =
    e.state?.type === "done"
      ? `<div class="tc-done">${esc(e.state.summary || "完成")}</div>`
      : e.state?.type === "failed"
        ? `<div class="tc-fail">${esc(e.state.error || "失败")}</div>`
        : "";
  return `<div class="taskcard${live ? " live" : ""}" data-htask="${esc(key)}"><span class="st ${b.cls}">${b.word}</span><span class="tc-goal">${esc(goal)}</span><span class="tc-meta mono${live ? " readout" : ""}">${esc(tele)}</span>${renderHoldHTML(e)}${done}</div>`;
}

/** @生图 任务卡消息（R9-B B1）：meta.materialTaskId 命中本地任务列 → 三态卡
    （RUN 轮询占位 / DONE 图直显·视频外链 / FAIL 失败行）+「任务域查看」；
    未命中（重启后本地消息本已消失，防御）→ 降级卡。resultUrl 是 hub URL，
    直显不走 assetSrc（那是本地资产协议专用）。 */
function materialMsgCardHTML(taskId: string, kind: MaterialKind, prompt: string): string {
  const e = taskEntries.get(taskId);
  if (e === undefined || e.source !== "material") {
    return `<div class="taskcard off"><span class="st dn">MAT</span><span class="tc-goal">${esc(materialTitle(prompt))}</span><span class="tc-meta">素材任务（${kind === "video" ? "视频" : "图"}）· 本机无记录 · 任务域可查全量</span></div>`;
  }
  const b = materialBadge(e.status);
  const title = esc(materialTitle(e.prompt));
  const view = `<button type="button" class="mop" data-mat-view="${esc(e.id)}">任务域查看</button>`;
  if (e.status === "succeeded" && e.resultUrl) {
    const href = safeUrl(e.resultUrl);
    const body = href
      ? e.kind === "image"
        ? `<img class="mat-img" src="${esc(href)}" alt="${title}" loading="lazy">`
        : `<a class="mat-link" href="${esc(href)}" target="_blank" rel="noreferrer">打开视频 · 新窗口</a>`
      : `<div class="errline">结果 URL 协议不受支持 · ${esc(e.resultUrl)}</div>`;
    return `<div class="taskcard"><span class="st ${b.cls}">${b.word}</span><span class="tc-goal">${title}</span>${body}${view}</div>`;
  }
  if (e.status === "failed") {
    return `<div class="taskcard"><span class="st ${b.cls}">${b.word}</span><span class="tc-goal">${title}</span><div class="tc-fail">${esc(materialErrLine(e.error) || "生成失败")}</div>${view}</div>`;
  }
  return `<div class="taskcard live"><span class="st ${b.cls}">${b.word}</span><span class="tc-goal">${title}</span><span class="tc-meta mono readout">生成中 · 每 5s 轮询</span>${view}</div>`;
}

/** 重发某条 user 消息：借输入框走 onSend 原路径（托管/BYOK 分支、流式、
    防抖全复用）；草稿暂存回填，不吞用户未发文字。原消息带图时 dataURL
    图片还原回预览条一并重发。 */
async function onMessageResend(idx: number): Promise<void> {
  const m = chatState.messages[idx];
  const input = document.getElementById("composer-input");
  if (!m || m.role !== "user" || !(input instanceof HTMLTextAreaElement) || chatState.streaming) return;
  const draft = input.value;
  const draftImgs = pendingImages;
  input.value = textOfContent(m.content);
  pendingImages =
    typeof m.content === "string"
      ? []
      : m.content
          .filter((p) => p.type === "image_url" && p.image_url.url.startsWith("data:"))
          .map((p) => ({ name: "", dataUrl: p.type === "image_url" ? p.image_url.url : "" }));
  renderImgBar();
  await onSend();
  input.value = draft;
  if (pendingImages.length > 0 && draftImgs.length > 0 && draftImgs !== pendingImages) {
    // 重发未清空（如被拒收/仍在流式中）时还原原草稿图，避免静默吞图
    pendingImages = draftImgs;
    renderImgBar();
  }
}

/** BYOK 直连发送：key 在发送瞬间取自 keyring，请求只进 base_url，绝不发往 hub。
    localView（R9-D @资料）：本地消息显示原文 + 折叠条 meta，线上载荷仍是并入资料后的 content。 */
async function sendByok(
  view: ByokView,
  content: string | ContentPart[],
  input: HTMLTextAreaElement,
  localView?: { content: string | ContentPart[]; meta?: RefMeta },
): Promise<void> {
  const history = historyWith(content); // 先取历史再落 user 消息，避免双份
  input.value = "";
  clearAttachments();
  const modelName = `byok:${view.name}`;
  pushLocalMessage("user", localView?.content ?? content, modelName, localView?.meta);
  renderMessages();
  const node = appendStreamingMsg(modelName, "BYOK 直连");
  chatState.streaming = true;
  setComposerBusy(true);
  let acc = "";
  try {
    const secret = await byokGetSecret(view.name);
    await chatStream(
      { model: secret.modelId, messages: history },
      (delta) => {
        acc += delta;
        node.p.innerHTML = renderContentHTML(acc);
        scrollStreamBottom();
      },
      () => {},
      { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
    );
    node.p.classList.remove("streaming");
    pushLocalMessage("assistant", acc, modelName);
  } catch (e) {
    node.p.classList.remove("streaming");
    node.err.textContent =
      e instanceof ApiError && e.code === "NETWORK" ? `上游不可达 · ${view.baseUrl}` : errText(e);
    node.err.hidden = false;
  } finally {
    chatState.streaming = false;
    setComposerBusy(false);
  }
}

/** 托管池发送：走 hub 会话（无会话则先建）。localView（R9-D @资料）：本地消息
    显示原文 + 折叠条 meta，会话标题取原文（hub 落库的仍是并入资料后的 content）。 */
async function sendHosted(
  modelName: string,
  content: string | ContentPart[],
  input: HTMLTextAreaElement,
  history: ChatMessageWire[],
  localView?: { content: string | ContentPart[]; meta?: RefMeta },
): Promise<void> {
  let sessionId = chatState.currentId;
  try {
    if (!sessionId) sessionId = await createSession(titleFrom(textOfContent(localView?.content ?? content)));
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    showStreamErr(errText(e));
    return;
  }

  input.value = "";
  clearAttachments();
  pushLocalMessage("user", localView?.content ?? content, modelName, localView?.meta);
  renderMessages();

  const node = appendStreamingMsg(modelName, "托管池");
  chatState.streaming = true;
  setComposerBusy(true);
  let acc = "";
  try {
    await chatStream(
      { model: modelName, session_id: sessionId, messages: history },
      (delta) => {
        acc += delta;
        node.p.innerHTML = renderContentHTML(acc);
        scrollStreamBottom();
      },
      () => {},
    );
    node.p.classList.remove("streaming");
    pushLocalMessage("assistant", acc, modelName);
  } catch (e) {
    node.p.classList.remove("streaming");
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    node.err.textContent = errText(e);
    node.err.hidden = false;
  } finally {
    chatState.streaming = false;
    setComposerBusy(false);
  }
}

/* ── R9-C C1：多模型并答（本地对照视图；不落 hub、上下文不回灌） ── */

interface ParallelBlock {
  question: string;
  cells: ParallelCellView[];
}

const parallelBlocks = new Map<number, ParallelBlock>();
let parallelSeq = 0;
let parallelOn = false;
let parallelPickNote = "";
const parallelPicked = new Set<string>();

function parallelPickedRefs(): ModelRef[] {
  return chatState.modelSeq.filter((m) => parallelPicked.has(modelKey(m)));
}

/** 并答开合的 UI 同步：toggle 态 + 发送钮文案 + chip（关闭即回现状）。 */
function syncParallelUI(): void {
  const t = document.getElementById("parallel-toggle");
  if (t) t.setAttribute("aria-pressed", String(parallelOn));
  const send = document.getElementById("composer-send");
  if (send) send.textContent = parallelOn ? "并答发送" : "发送";
  renderChip();
}

function setParallelPanel(open: boolean): void {
  const panel = document.getElementById("parallel-panel");
  if (!(panel instanceof HTMLElement)) return;
  if (open) parallelPickNote = "";
  panel.hidden = !open;
  if (open) renderParallelPanel();
}

/** 选模面板：托管池 + BYOK 混选；行态复用 @ 面板的 atitem/cur 语言。 */
function renderParallelPanel(): void {
  const panel = document.getElementById("parallel-panel");
  if (!(panel instanceof HTMLElement)) return;
  const n = parallelPickedRefs().length;
  const note = parallelPickNote !== "" ? parallelPickNote : `已选 ${n} · 限 ${PARALLEL_MIN}-${PARALLEL_MAX} 个`;
  const rows = chatState.modelSeq
    .map((m) => {
      const key = modelKey(m);
      const on = parallelPicked.has(key);
      const desc = m.kind === "byok" ? "BYOK 直连" : `${m.model.provider} · 托管池`;
      return `<div class="atitem${on ? " cur" : ""}" data-pkey="${esc(key)}" role="button" tabindex="0"><b>${esc(key)}</b><span>${esc(desc)}</span><span class="pmark">${on ? "已选" : ""}</span></div>`;
    })
    .join("");
  panel.innerHTML = `<div class="phint mono">${esc(note)}</div>${rows}`;
}

function onParallelPickToggle(key: string): void {
  if (parallelPicked.has(key)) parallelPicked.delete(key);
  else if (parallelPicked.size >= PARALLEL_MAX) parallelPickNote = `最多 ${PARALLEL_MAX} 个 · 先取消一个`;
  else parallelPicked.add(key);
  renderParallelPanel();
  renderChip();
}

/** 并答块消息渲染：列头模型名 + 流式正文（bubble.b 管线复用）+ errline/脚注。
    块不在 parallelBlocks（重启后）时降级说明卡。 */
function parallelBlockHTML(id: number, question: string): string {
  const block = parallelBlocks.get(id);
  if (block === undefined) {
    return `<div class="taskcard off"><span class="st dn">并答</span><span class="tc-goal">${esc(titleFrom(question))}</span><span class="tc-meta">本机无记录 · 并答块不落 hub，重启后消失</span></div>`;
  }
  const cells = block.cells
    .map((c, i) => parallelCellHTML(c, id, i, renderContentHTML(c.answer)))
    .join("");
  return `<div class="pblock"><div class="phead-q"><span class="st hd">并答</span><span class="pq">${esc(block.question)}</span></div><div class="pgrid ${parallelColClass(block.cells.length)}">${cells}</div></div>`;
}

/** 单列流式/终态重绘：按 data-pcell 定位（renderMessages 重排后仍可寻址）。 */
function paintParallelCell(blockId: number, idx: number): void {
  const cell = parallelBlocks.get(blockId)?.cells[idx];
  if (cell === undefined) return;
  const el = document.querySelector(`[data-pcell="${blockId}-${idx}"]`);
  if (el === null) return; // 块已不在 DOM（登录视图切换/降级卡）
  el.outerHTML = parallelCellHTML(cell, blockId, idx, renderContentHTML(cell.answer));
  scrollStreamBottom();
}

/** 并答发送：每选中模型独立一路并发流式——托管池各建一次性会话即弃
    （gateway 拒绝空 session_id，hub 侧自然留痕，不进当前会话）、BYOK 各直连。
    最小单轮形态：不带历史不带图；IME 保护沿用 onSend 入口。 */
async function onParallelSend(text: string, input: HTMLTextAreaElement): Promise<void> {
  if (pendingImages.length > 0 || pendingTexts.length > 0) {
    composerHintFlash("并答为纯文本单轮 · 先移除附件或关闭并答");
    return;
  }
  const refs = parallelPickedRefs();
  if (refs.length < PARALLEL_MIN || refs.length > PARALLEL_MAX) {
    composerHintFlash(`并答需选 ${PARALLEL_MIN}-${PARALLEL_MAX} 个模型`);
    return;
  }
  input.value = "";
  setParallelPanel(false);
  const id = ++parallelSeq;
  parallelBlocks.set(id, {
    question: text,
    cells: refs.map(
      (m): ParallelCellView => ({
        key: modelKey(m),
        status: "streaming",
        answer: "",
        error: "",
        usage: null,
        startedAt: Date.now(),
        endedAt: null,
      }),
    ),
  });
  pushLocalMessage("user", text, "并答", { parallelId: id });
  renderMessages();
  chatState.streaming = true;
  setComposerBusy(true);
  let live = refs.length;
  const settle = (): void => {
    live -= 1;
    if (live === 0) {
      chatState.streaming = false;
      setComposerBusy(false);
    }
  };
  refs.forEach((m, i) => {
    void runParallelCell(id, i, m, text).finally(settle);
  });
}

/** 单列请求：列内失败只落列 errline，不塌整块、不中断兄弟列。 */
async function runParallelCell(blockId: number, idx: number, m: ModelRef, text: string): Promise<void> {
  const cell = parallelBlocks.get(blockId)?.cells[idx];
  if (cell === undefined) return;
  const paint = (): void => paintParallelCell(blockId, idx);
  try {
    const onDelta = (d: string): void => {
      cell.answer += d;
      paint();
    };
    const onDone = (u: StreamUsage | null): void => {
      cell.usage = u;
    };
    if (m.kind === "byok") {
      const secret = await byokGetSecret(m.view.name);
      await chatStream(
        { model: secret.modelId, messages: [{ role: "user", content: text }] },
        onDelta,
        onDone,
        { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
      );
    } else {
      const sess = decodeSessionCreated(
        await api("/api/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ title: titleFrom(text), model_name: m.model.name }),
        }),
      );
      await chatStream({ model: m.model.name, session_id: sess.id, messages: [{ role: "user", content: text }] }, onDelta, onDone);
    }
    cell.status = "done";
    cell.endedAt = Date.now();
  } catch (e) {
    cell.status = "error";
    cell.endedAt = Date.now();
    if (e instanceof SessionExpired) {
      cell.error = "登录已过期 · 请重新登录";
      if (document.getElementById("stream")) renderLogin();
      paint();
      return;
    }
    cell.error =
      e instanceof ApiError && e.code === "NETWORK" && m.kind === "byok"
        ? `上游不可达 · ${m.view.baseUrl}`
        : errText(e);
  }
  paint();
}

/** 列头「转入对话」：该列问答转普通本地消息对（可续聊、随后续历史回灌）；
    其余列留在并答块继续流式（renderMessages 重排后按 data-pcell 续绘）。 */
function onParallelPromote(spec: string): void {
  const [idRaw, idxRaw] = spec.split(":");
  const id = Number(idRaw);
  const idx = Number(idxRaw);
  const block = parallelBlocks.get(id);
  const cell = block?.cells[idx];
  if (block === undefined || cell === undefined || cell.status !== "done") return;
  const at = new Date().toISOString();
  const pair: MessageRow[] = [
    { id: 0, role: "user", content: block.question, modelName: cell.key, tokensIn: 0, tokensOut: 0, costCents: 0, createdAt: at },
    { id: 0, role: "assistant", content: cell.answer, modelName: cell.key, tokensIn: cell.usage?.promptTokens ?? 0, tokensOut: cell.usage?.completionTokens ?? 0, costCents: 0, createdAt: at },
  ];
  const mIdx = chatState.messages.findIndex((m) => m.meta?.parallelId === id);
  block.cells.splice(idx, 1);
  if (mIdx >= 0) {
    if (block.cells.length === 0) {
      chatState.messages.splice(mIdx, 1, ...pair);
      parallelBlocks.delete(id);
    } else {
      chatState.messages.splice(mIdx, 0, ...pair);
    }
  }
  renderMessages();
}

/* ── 接线 ── */

/** 代码块复制反馈：按钮文案临时改写 2.5s 后还原（env 复制反馈同款节律）。 */
function copyCodeFlash(btn: HTMLElement, text: string): void {
  btn.textContent = text;
  window.setTimeout(() => {
    btn.textContent = "复制";
  }, 2500);
}

function wireComposer(): void {
  /* 消息 hover 操作（复制/重发）+ 代码块复制 + 图片放大：容器级委托，
     索引随 renderMessages 全量重排刷新 */
  const streamEl = document.getElementById("stream");
  if (streamEl) {
    streamEl.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      if (t.id === "load-earlier") {
        void onLoadEarlier();
        return;
      }
      const cc = t.closest("[data-copy-code]");
      if (cc instanceof HTMLElement) {
        // 高亮 span 的 textContent 即原始代码（hljs 只包 span 不改字）
        const code = cc.closest(".codeblk")?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard
          .writeText(code)
          .then(() => copyCodeFlash(cc, "已复制"))
          .catch(() => copyCodeFlash(cc, "复制失败"));
        return;
      }
      if (t instanceof HTMLImageElement && t.classList.contains("msg-img") && t.src) {
        openImageOverlay(t.src);
        return;
      }
      const mv = t.closest("[data-mat-view]");
      if (mv instanceof HTMLElement && mv.dataset.matView) {
        // @生图卡「任务域查看」：选中该任务 + 切任务域素材 tab（资产空态 CTA 同款跳法）
        const id = mv.dataset.matView;
        if (taskEntries.has(id)) {
          taskSelected = id;
          taskSelKind = taskEntries.get(id)?.source ?? "material";
        }
        setView("task");
        const mtab = [...document.querySelectorAll("#task-tabs button")].find((x) => x.textContent === "素材");
        if (mtab instanceof HTMLButtonElement) mtab.click();
        renderTaskDyn();
        return;
      }
      const pp = t.closest("[data-ppromote]");
      if (pp instanceof HTMLElement && pp.dataset.ppromote) {
        onParallelPromote(pp.dataset.ppromote);
        return;
      }
      const rt = t.closest("[data-ref-toggle]");
      if (rt instanceof HTMLElement) {
        // @资料/@知识库折叠条：就近翻容器的 hidden + op 文案；展开态记 refOpen
        // 集合跨重绘保持（@资料 键=资料全文，@知识库 键=bar 上的 data-refkey）
        const pre = rt.parentElement?.querySelector(".refpre") ?? null;
        if (pre instanceof HTMLElement) {
          const key = rt.dataset.refkey || pre.textContent || "";
          const open = pre.hasAttribute("hidden");
          if (open) {
            pre.removeAttribute("hidden");
            refOpen.add(key);
          } else {
            pre.setAttribute("hidden", "");
            refOpen.delete(key);
          }
          const op = rt.querySelector(".refop");
          if (op !== null) op.textContent = open ? "收起" : "展开";
        }
        return;
      }
      const cp = t.closest("[data-mcopy]");
      if (cp instanceof HTMLElement && cp.dataset.mcopy !== undefined) {
        const m = chatState.messages[Number(cp.dataset.mcopy)];
        if (m)
          void navigator.clipboard
            .writeText(textOfContent(m.content))
            .catch(() => showStreamErr("复制失败 · 剪贴板不可用"));
        return;
      }
      const rs = t.closest("[data-mresend]");
      if (rs instanceof HTMLElement && rs.dataset.mresend !== undefined) void onMessageResend(Number(rs.dataset.mresend));
      return;
    });
  }
  /* 任务卡 HOLD 审批（R6-B U3）：卡内 data-approve 委托，任务经卡上的 data-htask 定位 */
  if (streamEl) {
    streamEl.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const ap = t.closest("[data-approve]");
      if (ap === null) return;
      const card = t.closest("[data-htask]");
      if (!(card instanceof HTMLElement) || card.dataset.htask === undefined) return;
      void onApprove(Number(card.dataset.htask), ap.getAttribute("data-approve") === "1");
    });
  }
  const btn = document.getElementById("composer-send");
  if (btn) btn.addEventListener("click", () => void onSend());
  const input = document.getElementById("composer-input");
  if (input instanceof HTMLTextAreaElement) {
    input.addEventListener("input", atPanelSync);
    input.addEventListener("compositionend", atPanelSync);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const ppanel = document.getElementById("parallel-panel");
        if (ppanel instanceof HTMLElement && !ppanel.hidden) {
          ppanel.hidden = true;
          e.preventDefault();
          return;
        }
        const panel = document.getElementById("at-panel");
        if (panel instanceof HTMLElement && !panel.hidden) {
          panel.hidden = true;
          e.preventDefault();
        }
        return;
      }
      if (e.key === "Enter") {
        if (e.isComposing || e.keyCode === 229) return;
        // Shift+Enter 放行为换行（textarea 原生），仅裸 Enter 是发送/选择
        if (e.shiftKey) return;
        const panel = document.getElementById("at-panel");
        if (panel instanceof HTMLElement && !panel.hidden) {
          e.preventDefault();
          const first = panel.querySelector<HTMLElement>(".atitem");
          if (first !== null && first.dataset.at) atPanelAccept(first.dataset.at);
          return;
        }
        e.preventDefault();
        void onSend();
      }
    });
  }
  const atPanel = document.getElementById("at-panel");
  if (atPanel) {
    atPanel.addEventListener("mousedown", (e) => {
      const t = e.target;
      const item = t instanceof Element ? t.closest(".atitem") : null;
      if (item instanceof HTMLElement && item.dataset.at) {
        e.preventDefault();
        atPanelAccept(item.dataset.at);
      }
    });
  }
  const chip = document.getElementById("model-chip");
  if (chip) {
    chip.addEventListener("click", () => {
      // 并答态 chip 是选模面板入口（chip 文案已是计数，不再是当前模型）
      if (parallelOn) {
        const panel = document.getElementById("parallel-panel");
        setParallelPanel(!(panel instanceof HTMLElement) || panel.hidden);
        return;
      }
      // 普通态（R11-B U1）：单选菜单弹出/再点收起（取代旧的循环轮换）
      const menu = document.getElementById("model-menu");
      setChipMenu(!(menu instanceof HTMLElement) || menu.hidden);
    });
  }
  /* R11-B U1 模型菜单：行点选即切（mousedown 抢先 + preventDefault 防焦点抖动） */
  const mmenu = document.getElementById("model-menu");
  if (mmenu) {
    mmenu.addEventListener("mousedown", (e) => {
      const t = e.target;
      const item = t instanceof Element ? t.closest(".atitem") : null;
      if (item instanceof HTMLElement && item.dataset.mkey) {
        e.preventDefault();
        const idx = chatState.modelSeq.findIndex((m) => modelKey(m) === item.dataset.mkey);
        if (idx >= 0 && idx !== chatState.modelIdx) {
          chatState.modelIdx = idx;
          renderChip();
        }
        setChipMenu(false);
      }
    });
  }
  document.addEventListener("click", (ev) => {
    const menu = document.getElementById("model-menu");
    if (!(menu instanceof HTMLElement) || menu.hidden) return;
    const t = ev.target;
    if (t instanceof Node && (menu.contains(t) || (t instanceof Element && t.closest("#model-chip") !== null))) {
      return;
    }
    setChipMenu(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const menu = document.getElementById("model-menu");
    if (menu instanceof HTMLElement && !menu.hidden) {
      setChipMenu(false);
      ev.preventDefault();
    }
  });
  /* R9-C C1 并答：toggle 开合 + 选模面板行点选 + 点外关闭 */
  const ptoggle = document.getElementById("parallel-toggle");
  if (ptoggle) {
    ptoggle.addEventListener("click", () => {
      parallelOn = !parallelOn;
      if (!parallelOn) setParallelPanel(false);
      syncParallelUI();
    });
  }
  const ppanel = document.getElementById("parallel-panel");
  if (ppanel) {
    ppanel.addEventListener("mousedown", (e) => {
      const t = e.target;
      const item = t instanceof Element ? t.closest(".atitem") : null;
      if (item instanceof HTMLElement && item.dataset.pkey) {
        e.preventDefault();
        onParallelPickToggle(item.dataset.pkey);
      }
    });
  }
  document.addEventListener("click", (ev) => {
    const panel = document.getElementById("parallel-panel");
    if (!(panel instanceof HTMLElement) || panel.hidden) return;
    const t = ev.target;
    if (
      t instanceof Node &&
      (panel.contains(t) || (t instanceof Element && t.closest("#model-chip,#parallel-toggle") !== null))
    ) {
      return;
    }
    setParallelPanel(false);
  });
  /* 附件入口（R9-A A1 图片 / R11-B U3 通用）：拖放已上移窗口级（document），
     此处按钮选文件 + 预览条删除；粘贴仍只收剪贴板图片 */
  const attach = document.getElementById("img-attach");
  const imgFile = document.getElementById("img-file");
  if (attach && imgFile instanceof HTMLInputElement) {
    attach.addEventListener("click", () => imgFile.click());
    imgFile.addEventListener("change", () => {
      addAttachments([...imgFile.files ?? []]);
      imgFile.value = ""; // 同文件可重复选择
    });
  }
  const imgBar = document.getElementById("img-bar");
  if (imgBar) {
    imgBar.addEventListener("click", (ev) => {
      const del = ev.target instanceof Element ? ev.target.closest("[data-imgdel]") : null;
      if (del instanceof HTMLElement && del.dataset.imgdel !== undefined) {
        pendingImages.splice(Number(del.dataset.imgdel), 1);
        renderImgBar();
        return;
      }
      const tdel = ev.target instanceof Element ? ev.target.closest("[data-txtdel]") : null;
      if (tdel instanceof HTMLElement && tdel.dataset.txtdel !== undefined) {
        pendingTexts.splice(Number(tdel.dataset.txtdel), 1);
        renderImgBar();
      }
    });
  }
  if (input instanceof HTMLInputElement) {
    input.addEventListener("paste", (ev) => {
      const files = [...(ev.clipboardData?.items ?? [])]
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        ev.preventDefault(); // 不把图片文件名粘进输入框
        addImages(files);
      }
    });
  }
}

function wireChatList(): void {
  const box = document.getElementById("chats");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === "new-session") {
      void createSession("").catch((err: unknown) => {
        if (err instanceof SessionExpired) renderLogin();
        else showStreamErr(errText(err));
      });
      return;
    }
    // 搜索结果行：清搜索态后复用 selectSession（v1 不做消息滚动定位）
    const sr = t.closest(".srow[data-ssid]");
    if (sr instanceof HTMLElement && sr.dataset.ssid) {
      const sid = sr.dataset.ssid;
      sessQuery = "";
      sessResults = null;
      sessResultsErr = "";
      sessSearchSeq++;
      window.clearTimeout(sessDebounce);
      renderSessionList();
      if (chatState.currentId !== sid) void selectSession(sid);
      return;
    }
    const rop = t.closest("[data-rename],[data-export],[data-del]");
    if (rop instanceof HTMLElement) {
      const rs = rop.dataset.rename;
      const es = rop.dataset.export;
      if (rs !== undefined) beginRename(rs);
      else if (es !== undefined) void onSessionExport(es);
      else {
        const ds = rop.dataset.del;
        if (ds !== undefined) void onDeleteClick(ds);
      }
      return;
    }
    if (t instanceof HTMLInputElement) return; // 行内改名编辑中，点击输入框不切换会话
    const row = t.closest(".crow");
    if (row instanceof HTMLElement && row.dataset.sid) void selectSession(row.dataset.sid);
  });
  box.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.id === "sess-q") {
      if (e.key === "Escape") {
        e.preventDefault();
        clearSessSearch();
      }
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    if (!(t instanceof HTMLElement) || !t.classList.contains("crow")) return;
    e.preventDefault();
    if (t.dataset.sid) void selectSession(t.dataset.sid);
  });
  // 搜索输入：防抖在 sessSearchKick；浮层由 runSessSearch 回填
  box.addEventListener("input", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.id === "sess-q") {
      sessQuery = t.value;
      sessSearchKick();
    }
  });
}

/* ── 登录视图（无 token 或 401 时的主区） ── */

function renderLogin(err?: string): void {
  // 回到登录主区即拆掉 harness 订阅与计时器；重进工作区时按需重建
  if (unlistenHarness !== null) {
    unlistenHarness();
    unlistenHarness = null;
  }
  stopTick();
  stopMaterialPoll();
  stopUsageTimer();
  app.innerHTML = `
<header><span class="brand">${brand}</span><span class="spacer"></span></header>
<section class="login" aria-label="登录">
  <form class="panel" id="login-form" novalidate>
    <div class="phase">ACCESS · HUB LOGIN</div>
    <h1>登录</h1>
    <label for="login-email">EMAIL</label>
    <input id="login-email" type="email" autocomplete="username" placeholder="you@example.com" required>
    <label for="login-pass">PASSWORD</label>
    <input id="login-pass" type="password" autocomplete="current-password" placeholder="输入密码" required>
    <div class="errline" id="login-err"${err ? "" : " hidden"}>${err ? esc(err) : ""}</div>
    <button type="submit" class="btn pri" id="login-submit">登录</button>
    <div class="hubline"><span class="hub">HUB</span><span class="mono" data-hub-url>${esc(hubUrl())}</span><button type="button" class="btn sec" id="login-hub-edit">修改</button></div>
  </form>
</section>`;
  document.getElementById("login-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitLogin();
  });
  // 首装自托管者的地址入口：设置页在登录后才可达，登录页必须能改
  // hub 地址（2026-11-12 首装卡死修复），交互与设置页「修改」同款（行内编辑）。
  const hubEditBtn = document.getElementById("login-hub-edit");
  const hubLine = hubEditBtn?.closest(".hubline");
  if (hubEditBtn && hubLine instanceof HTMLElement) {
    hubEditBtn.addEventListener("click", () => beginInlineHubEdit(hubLine));
  }
}

async function submitLogin(): Promise<void> {
  const emailEl = document.getElementById("login-email");
  const passEl = document.getElementById("login-pass");
  const errEl = document.getElementById("login-err");
  const btn = document.getElementById("login-submit");
  if (
    !(emailEl instanceof HTMLInputElement) ||
    !(passEl instanceof HTMLInputElement) ||
    !(errEl instanceof HTMLElement) ||
    !(btn instanceof HTMLButtonElement)
  ) {
    return;
  }
  const email = emailEl.value.trim();
  const password = passEl.value;
  if (!email || !password) {
    errEl.textContent = "邮箱与密码必填";
    errEl.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = "登录中…";
  errEl.hidden = true;
  try {
    await setToken(await login(email, password));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "登录";
    errEl.textContent = errText(e);
    errEl.hidden = false;
    return;
  }
  await enterWorkspace();
}

/* ── 全局快捷小窗（R9-B B2，URL hash #quick）：极简单轮问答，不进壳层四视图。
   桌面专属入口（Rust 侧 Alt+Shift+K 建 quickask 窗口，并行实现）；浏览器打开
   #quick 只是普通 hash，同样可用但无入口。单轮即弃：不复用会话 UI——托管池
   先建一次性会话即弃（gateway 拒绝空 session_id），BYOK 直连天然无痕；
   模型取默认路由（与主窗 chip 序列同源，托管池首选）。 ── */

const QUICK_HANDOFF_KEY = "cp.quickHandoff";
const QUICK_HANDOFF_TTL_MS = 5 * 60_000;

let quickBusy = false;
let quickLast: { q: string; a: string; model: string } | null = null;

async function mountQuickAsk(): Promise<void> {
  app.style.minWidth = "0"; // #app 全局 1180px 最小宽是主窗壳层的，小窗约 480px 须解除
  app.innerHTML = `
<section class="quick" aria-label="随手问">
  <div class="quick-head"><span class="brand">望舒 · 随手问</span><span class="quick-model mono" id="quick-model">…</span></div>
  <div class="quick-ans" id="quick-ans"><div class="quick-empty">输入问题 · Enter 发送 · 单轮即弃</div></div>
  <div class="quick-bar">
    <input type="text" id="quick-input" placeholder="随手问一句…" aria-label="问题输入">
    <button type="button" class="send" id="quick-send">发送</button>
  </div>
  <div class="quick-foot">
    <button type="button" class="btn sec" id="quick-main">转入主窗</button>
    <button type="button" class="btn sec" id="quick-close">关闭</button>
  </div>
</section>`;
  const input = document.getElementById("quick-input");
  if (input instanceof HTMLInputElement) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (e.isComposing || e.keyCode === 229) return; // IME 组合保护（composer 同款）
        e.preventDefault();
        void onQuickSend();
      }
    });
    input.focus();
  }
  document.getElementById("quick-send")?.addEventListener("click", () => void onQuickSend());
  document.getElementById("quick-main")?.addEventListener("click", () => void quickToMain());
  document.getElementById("quick-close")?.addEventListener("click", () => void quickClose());
  // Esc 清空/关闭：输入有文字先清空，已空则关窗
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (input instanceof HTMLInputElement && input.value !== "") {
      input.value = "";
      return;
    }
    void quickClose();
  });
  // 默认路由：与主窗 chip 序列同源（loadModels/loadByok 的渲染落点在小窗均空操作）
  let loadErr = false;
  try {
    await loadModels();
  } catch (e) {
    if (e instanceof SessionExpired) {
      const m = document.getElementById("quick-model");
      if (m) m.textContent = "未登录 · 请在主窗登录";
      return;
    }
    loadErr = true;
    console.warn("[quick] 模型列表拉取失败", e);
  }
  if (inTauri) await loadByok();
  const label = document.getElementById("quick-model");
  if (label) label.textContent = loadErr ? "模型加载失败 · 检查 hub" : currentModel() ? modelKey(currentModel()!) : "无可用模型";
}

async function onQuickSend(): Promise<void> {
  const input = document.getElementById("quick-input");
  const ans = document.getElementById("quick-ans");
  if (!(input instanceof HTMLInputElement) || !(ans instanceof HTMLElement) || quickBusy) return;
  const text = input.value.trim();
  if (!text) return;
  const model = currentModel();
  if (!model) {
    ans.innerHTML = `<div class="errline">无可用模型 · 请在主窗设置（rail 04）配置</div>`;
    return;
  }
  quickBusy = true;
  const btn = document.getElementById("quick-send");
  if (btn instanceof HTMLButtonElement) btn.disabled = true;
  input.value = "";
  ans.innerHTML = `<div class="q-q">${esc(text)}</div><div class="q-a streaming" id="q-live"></div>`;
  let acc = "";
  const paint = (): void => {
    const el = document.getElementById("q-live");
    if (el) {
      el.innerHTML = renderRich(acc);
      ans.scrollTop = ans.scrollHeight;
    }
  };
  try {
    if (model.kind === "byok") {
      const secret = await byokGetSecret(model.view.name);
      await chatStream(
        { model: secret.modelId, messages: [{ role: "user", content: text }] },
        (delta) => {
          acc += delta;
          paint();
        },
        () => {},
        { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
      );
    } else {
      // 一次性会话即弃：gateway 拒绝空 session_id，建后不再引用（hub 侧自然留痕）
      const sess = decodeSessionCreated(
        await api("/api/v1/sessions", {
          method: "POST",
          body: JSON.stringify({ title: titleFrom(text), model_name: model.model.name }),
        }),
      );
      await chatStream(
        { model: model.model.name, session_id: sess.id, messages: [{ role: "user", content: text }] },
        (delta) => {
          acc += delta;
          paint();
        },
        () => {},
      );
    }
    quickLast = { q: text, a: acc, model: modelKey(model) };
  } catch (e) {
    const msg =
      e instanceof SessionExpired
        ? "登录已过期 · 请在主窗重新登录"
        : e instanceof ApiError && e.code === "NETWORK" && model.kind === "byok"
          ? `上游不可达 · ${model.view.baseUrl}`
          : errText(e);
    ans.insertAdjacentHTML("beforeend", `<div class="errline">${esc(msg)}</div>`);
  } finally {
    const el = document.getElementById("q-live");
    if (el) el.classList.remove("streaming");
    quickBusy = false;
    if (btn instanceof HTMLButtonElement) btn.disabled = false;
  }
}

/** 转入主窗：最后问答写 localStorage（主窗获焦/启动时消费后清除），再
    focus_main_window（Rust 命令，热键侧并行实现；浏览器态退化为回主界面）。 */
async function quickToMain(): Promise<void> {
  if (quickLast !== null) {
    localStorage.setItem(QUICK_HANDOFF_KEY, JSON.stringify({ ...quickLast, at: Date.now() }));
  }
  if (!inTauri) {
    location.hash = "";
    location.reload();
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("focus_main_window").catch((e: unknown) => console.warn("[quick] focus_main_window 失败", e));
}

async function quickClose(): Promise<void> {
  if (inTauri) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  }
  window.close();
}

/** 小窗→主窗上下文接力（从简取舍）：落地为两条本地消息（不落 hub）——视觉
    即时可见、下轮发送随 history 带上模型上下文；页面刷新后消失。主窗在
    获焦（focus_main_window 之后）与工作区就绪两个时机消费；超窗只清不注入。 */
function consumeQuickHandoff(): void {
  const raw = localStorage.getItem(QUICK_HANDOFF_KEY);
  if (raw === null) return;
  let h: { q: string; a: string; model: string; at: number } | null = null;
  try {
    h = JSON.parse(raw);
  } catch {
    h = null;
  }
  if (h === null || typeof h.q !== "string" || Date.now() - h.at > QUICK_HANDOFF_TTL_MS) {
    localStorage.removeItem(QUICK_HANDOFF_KEY);
    return;
  }
  if (document.getElementById("stream") === null) return; // 工作区未挂载：留待挂载后消费
  localStorage.removeItem(QUICK_HANDOFF_KEY);
  pushLocalMessage("user", h.q, "随手问");
  pushLocalMessage("assistant", h.a, h.model || "随手问");
  renderMessages();
}

/* ── 启动 ── */

async function enterWorkspace(): Promise<void> {
  renderShell();
  restoreKbK();
  void refreshPrompts();
  void refreshTemplates();
  if (inTauri) {
    startTick();
    void bindHarness();
    void loadTaskHistory();
    void silentUpdateCheck();
    void refreshUnifiedTasks();
    startUnifiedPoll();
  }
  mountHubProbe();
  onHubHealth((ok) => setTrayState(ok ? "normal" : "warn"));
  startMaterialPoll();
  startUsageTimer();
  try {
    const me = decodeMe(await api("/api/v1/me"));
    chatState.nickname = me.nickname || me.email.split("@")[0] || me.id || "user";
    const slot = document.getElementById("user-slot");
    if (slot) slot.textContent = chatState.nickname;
    await Promise.all([loadModels(), loadSessions(), loadByok(), loadEnv()]);
    consumeQuickHandoff();
    void recoverMaterialTasks();
    // 模型列表到位后补一次任务域渲染（发起条的模型下拉依赖 chatState.models）
    if (inTauri) renderTaskDyn();
  } catch (e) {
    if (e instanceof SessionExpired) {
      renderLogin();
      return;
    }
    renderLogin(errText(e));
  }
}

/** 托盘状态（R6-A#5）：updater 出新版→update 橙方；hubProbe 连续失联→warn 红方。 */
function setTrayState(state: "normal" | "update" | "warn"): void {
  if (!inTauri) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("tray_set_state", { state }))
    .catch((e) => console.warn("[desktop] 托盘状态设置失败", e));
}

/** 启动静默检查（只报告不安装）：有新版时在 04 设置分区点亮信号橙点，
    并在设置页预填提示——橙色只出现在「需要人处置」处，符合信号纪律。 */
async function silentUpdateCheck(): Promise<void> {
  const r = await checkOnly();
  if (r.kind !== "available") return;
  setTrayState("update");
  const railBtn = document.querySelector('.rail .sec.platform:last-of-type');
  if (railBtn && !railBtn.querySelector(".updot")) {
    const dot = document.createElement("span");
    dot.className = "updot";
    dot.title = `有新版本 v${r.version}`;
    railBtn.append(dot);
  }
  const line = document.getElementById("upd-result");
  if (line) line.textContent = `有新版本 v${r.version} · 点击检查更新安装`;
}

initTheme();
void (async () => {
  // 启动分支（R9-B B2）：hash #quick = 全局快捷小窗（极简单轮，不进壳层四视图）
  if (location.hash === "#quick") {
    void mountQuickAsk();
    return;
  }
  // 小窗「转入主窗」接力消费：主窗获焦（focus_main_window 之后）与工作区就绪两个时机
  window.addEventListener("focus", () => consumeQuickHandoff());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) consumeQuickHandoff();
  });
  // 登录态判定走 keyring invoke（异步），照旧不闪工作区
  if (!(await getToken())) renderLogin();
  else void enterWorkspace();
})();
