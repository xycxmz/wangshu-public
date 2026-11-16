/* harness 桥接层：对 src-tauri/src/harness 的命令与事件做 TS 侧精确建模。
   serde tag 形态（state.rs #[serde(tag = "type", rename_all = "snake_case")]）：
   {"type":"running","step":1} / {"type":"awaiting_approval","step":1,"tool":…,"preview":…} /
   {"type":"done","summary":…} / {"type":"failed","error":…} / {"type":"aborted"}
   事件 harness://task-update payload = { id, state, log, tokens_in, tokens_out }
   （累计用量；旧版事件缺 tokens 字段时按 0 容错）。
   @tauri-apps/api 一律动态 import：非 Tauri 环境静态引入会破坏浏览器降级路径。 */

import { ProtocolError, fieldNumber, fieldString, isObj } from "./api";

/* isTauri 定义已移至 api.ts（token 存储需在 api 层判运行形态）；
   此处转口导出，既有 import { isTauri } from "./harness" 不动。 */
export { isTauri } from "./api";

/* ── TaskState 判别联合（与 state.rs 逐变体对齐） ── */

export type HarnessToolCall =
  | { type: "read_file"; path: string }
  | { type: "write_file"; path: string; content: string }
  | { type: "list_dir"; path: string }
  /** 技能正文加载（免审批，不进 HOLD；进联合是为与 state.rs 逐变体对齐）。 */
  | { type: "load_skill"; name: string }
  /** MCP 面板发现（免审批，治理在 hub 侧；同上仅为联合对齐）。 */
  | { type: "mcp_list_upstreams" }
  /** 经 hub 代理调 MCP 工具（免审批，治理在 hub 侧）。 */
  | { type: "mcp_call"; upstream: string; tool: string; arguments: string }
  /** 派生同步子任务（免审批的编排动作；深度限 1，子任务不能再派生）。 */
  | { type: "spawn_subtask"; goal: string };

export type HarnessTaskState =
  | { type: "running"; step: number }
  | { type: "awaiting_approval"; step: number; tool: HarnessToolCall; preview: string }
  | { type: "done"; summary: string }
  | { type: "failed"; error: string }
  | { type: "aborted" };

export interface HarnessTaskUpdate {
  id: number;
  state: HarnessTaskState;
  log: string;
  /** 累计 token 用量（事件快照；COST 格按 /models 价本地估算，见 cost.ts） */
  tokensIn: number;
  tokensOut: number;
}

/* ── 边界解析（事件/invoke 回包是外部数据，先窄化再入内域） ── */

function decodeToolCall(v: unknown): HarnessToolCall {
  if (!isObj(v)) throw new ProtocolError("bad harness tool call");
  const type = fieldString(v, "type");
  if (type === "read_file" || type === "list_dir") {
    const path = fieldString(v, "path");
    if (path === undefined) throw new ProtocolError("harness tool call missing path");
    return { type, path };
  }
  if (type === "write_file") {
    const path = fieldString(v, "path");
    const content = fieldString(v, "content");
    if (path === undefined) throw new ProtocolError("write_file missing path");
    if (content === undefined) throw new ProtocolError("write_file missing content");
    return { type, path, content };
  }
  if (type === "load_skill") {
    const name = fieldString(v, "name");
    if (name === undefined) throw new ProtocolError("load_skill missing name");
    return { type, name };
  }
  if (type === "mcp_list_upstreams") return { type };
  if (type === "mcp_call") {
    const upstream = fieldString(v, "upstream");
    const tool = fieldString(v, "tool");
    const args = fieldString(v, "arguments");
    if (upstream === undefined) throw new ProtocolError("mcp_call missing upstream");
    if (tool === undefined) throw new ProtocolError("mcp_call missing tool");
    if (args === undefined) throw new ProtocolError("mcp_call missing arguments");
    return { type, upstream, tool, arguments: args };
  }
  if (type === "spawn_subtask") {
    const goal = fieldString(v, "goal");
    if (goal === undefined) throw new ProtocolError("spawn_subtask missing goal");
    return { type, goal };
  }
  throw new ProtocolError(`unknown harness tool call type: ${type ?? "?"}`);
}

export function decodeTaskState(v: unknown): HarnessTaskState {
  if (!isObj(v)) throw new ProtocolError("bad harness task state");
  const type = fieldString(v, "type");
  if (type === "running") return { type, step: fieldNumber(v, "step") ?? 0 };
  if (type === "awaiting_approval") {
    return {
      type,
      step: fieldNumber(v, "step") ?? 0,
      tool: decodeToolCall(v.tool),
      preview: fieldString(v, "preview") ?? "",
    };
  }
  if (type === "done") return { type, summary: fieldString(v, "summary") ?? "" };
  if (type === "failed") return { type, error: fieldString(v, "error") ?? "" };
  if (type === "aborted") return { type };
  throw new ProtocolError(`unknown harness task state type: ${type ?? "?"}`);
}

export function decodeTaskUpdate(v: unknown): HarnessTaskUpdate {
  if (!isObj(v)) throw new ProtocolError("bad harness event payload");
  const id = fieldNumber(v, "id");
  if (id === undefined) throw new ProtocolError("harness event missing id");
  return {
    id,
    state: decodeTaskState(v.state),
    log: fieldString(v, "log") ?? "",
    tokensIn: fieldNumber(v, "tokens_in") ?? 0,
    tokensOut: fieldNumber(v, "tokens_out") ?? 0,
  };
}

/* ── 命令封装（Tauri v2：JS camelCase 参数映射 Rust snake_case 形参） ── */

export interface HarnessRunArgs {
  goal: string;
  workingDir: string;
  model: string;
  hubUrl: string;
  token: string;
}

export async function harnessRun(args: HarnessRunArgs): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("harness_run", {
    goal: args.goal,
    workingDir: args.workingDir,
    model: args.model,
    hubUrl: args.hubUrl,
    token: args.token,
  });
}

export async function harnessApprove(taskId: number, approved: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("harness_approve", { taskId, approved });
}

export async function harnessAbort(taskId: number): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("harness_abort", { taskId });
}

/** 查询任务状态快照；Rust 侧 Option<TaskState> → null 表示任务不在注册表。 */
export async function harnessStatus(taskId: number): Promise<HarnessTaskState | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw: unknown = await invoke("harness_status", { taskId });
  return raw === null ? null : decodeTaskState(raw);
}

/* ── 事件订阅 ── */

/** 订阅 harness://task-update；返回反订阅函数。形状不符的事件告警并丢弃，不中断 UI。 */
export async function listenHarnessTaskUpdate(cb: (u: HarnessTaskUpdate) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<unknown>("harness://task-update", (ev) => {
    try {
      cb(decodeTaskUpdate(ev.payload));
    } catch (e) {
      console.warn("[harness] 丢弃形状不符的事件", e);
    }
  });
  return unlisten;
}

/** 拉取进程内最近 task_update 载荷（旧→新，至多 200 条）。重载后的前端
    订阅事件成功即调用重放，恢复重载窗口内丢失的在跑/HOLD 任务（R5-A-①）。 */
export async function harnessRecentEvents(): Promise<unknown[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw: unknown = await invoke("harness_recent_events");
  return Array.isArray(raw) ? raw : [];
}

/* ── 任务历史（本地 sqlite，src-tauri/src/tasksdb.rs） ── */

/** 历史记录来源（对齐任务列两类条目）。 */
export type TaskHistorySource = "harness" | "material";

/** 一条终态历史记录（snake_case 对齐 Rust TaskRecord 序列化）。 */
export interface TaskHistoryRecord {
  /** harness "h<n>"（n 即任务列键）/ material 任务 uuid */
  id: string;
  source: TaskHistorySource;
  title: string;
  /** harness done|failed|aborted / material succeeded|failed */
  status: string;
  detail: string;
  createdAt: number;
  finishedAt: number;
}

function decodeTaskHistoryRecord(v: unknown): TaskHistoryRecord {
  if (!isObj(v)) throw new ProtocolError("bad task history record");
  const id = fieldString(v, "id");
  const source = fieldString(v, "source");
  if (!id) throw new ProtocolError("task history missing id");
  if (source !== "harness" && source !== "material") {
    throw new ProtocolError(`unknown task history source: ${source ?? "?"}`);
  }
  return {
    id,
    source,
    title: fieldString(v, "title") ?? "",
    status: fieldString(v, "status") ?? "",
    detail: fieldString(v, "detail") ?? "",
    createdAt: fieldNumber(v, "created_at") ?? 0,
    finishedAt: fieldNumber(v, "finished_at") ?? 0,
  };
}

/** 读最近终态历史（finished_at 倒序，上限 50）；坏行告警丢弃，不整表失败。 */
/** 技能视图（R6-B U5 @技能补全）：skills_list 命令的 wire 形状。 */
export interface SkillView {
  name: string;
  description: string;
}

export async function skillsList(workingDir: string): Promise<SkillView[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw: unknown = await invoke("skills_list", { workingDir });
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    if (isObj(v)) {
      const n = fieldString(v, "name");
      const d = fieldString(v, "description");
      return n !== undefined ? [{ name: n, description: d ?? "" }] : [];
    }
    return [];
  });
}

export async function taskHistoryList(): Promise<TaskHistoryRecord[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw: unknown = await invoke("task_history_list");
  return (Array.isArray(raw) ? raw : []).flatMap((r) => {
    try {
      return [decodeTaskHistoryRecord(r)];
    } catch (e) {
      console.warn("[tasks] 丢弃形状不符的历史记录", e);
      return [];
    }
  });
}

export interface TaskHistorySaveArgs {
  id: string;
  source: TaskHistorySource;
  title: string;
  status: string;
  detail: string;
}

/** 写一条终态记录（素材任务轮询到终态时调用；created/finished 由 Rust 侧取当前时刻）。 */
export async function taskHistorySave(args: TaskHistorySaveArgs): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("task_history_save", { ...args });
}
