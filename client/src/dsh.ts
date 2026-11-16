/* DSH headless 任务桥接层：对 src-tauri/src/engine/dsh.rs（R3 adapter）的命令
   与事件做 TS 侧建模。形态与 engine.ts 的 PI 会话面板相反——spawn-per-task
   一次性进程：dsh_run 起任务、engine_stop 停、答完即退；无 steer/confirm 桥。
   事件走 engine://update 与 PI 共用 id 空间与 decodeEngineUpdate 窄化；
   日志行渲染直接复用 engRowHTML（EngRow 联合补一个 usage 累计行）。
   归约 applyDshEvent 是纯内存操作（node 断言脚本直接测）；DOM 只做重放视图。
   模块级状态同 engine 惯例：tab 切走仅卸 DOM 引用，切回重放。
   DEEPSEEK_API_KEY 会话内记忆（keyMemory），明文不回显、只进运行时 env。
   @tauri-apps/api 一律动态 import：非 Tauri 环境静态引入会破坏浏览器降级路径。 */

import {
  MAX_ROWS,
  abbrevTokens,
  decodeEngineUpdate,
  engineStop,
  engRowHTML,
} from "./engine";
import type { EngineEvent, EngRow } from "./engine";
import { desktopOnlyNote } from "./desktop-only";
import { isTauri } from "./harness";

/* ── 命令封装（Tauri v2：JS camelCase 参数映射 Rust snake_case 形参） ── */

export interface DshRunArgs {
  cwd: string;
  task: string;
  deepseekApiKey: string;
  /** 续跑会话（dsh session 事件的 uuid）；空串视同未传（开新会话）。 */
  sessionId?: string;
}

/** 发起一次 DSH headless 任务，立即返回任务 id（engine 注册表 id 空间）。 */
export async function dshRun(args: DshRunArgs): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("dsh_run", {
    cwd: args.cwd,
    task: args.task,
    deepseekApiKey: args.deepseekApiKey,
    sessionId: args.sessionId ?? null,
  });
}

/** 最近一次 DSH 任务的 sessionId（无则 null；面板挂载/任务收尾时预填续跑输入）。 */
/** DSH 会话历史条目（R5-B#5）：dsh_session_list 的 wire 形状。 */
export interface DshSessionEntry {
  id: string;
  task: string;
  at: number; // unix ms
}

export async function dshSessionList(): Promise<DshSessionEntry[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  const raw: unknown = await invoke("dsh_session_list");
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    if (typeof v === "object" && v !== null && "id" in v && typeof (v as { id: unknown }).id === "string") {
      const o = v as { id: string; task?: unknown; at?: unknown };
      return [{ id: o.id, task: typeof o.task === "string" ? o.task : "", at: typeof o.at === "number" ? o.at : 0 }];
    }
    return [];
  });
}

export async function dshLastSession(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("dsh_last_session");
}

/* ── 任务域模型（纯内存，node 断言脚本直接覆盖） ── */

/** live 到 done 只认 exit 事件：settled 与 exit 之间进程仍在收尾，停止钮须可用。 */
export type DshPhase = "idle" | "live" | "done";

/** engine.ts 的日志行联合 + usage 累计行（DSH step_end 携带引擎累计值）。 */
export type DshRow = EngRow | { kind: "usage"; stamp: string; text: string };

export interface DshPanelState {
  phase: DshPhase;
  runId: number | null;
  startedAt: number;
  rows: DshRow[];
  tokensIn: number;
  tokensOut: number;
  /** 终答全文（headless 一次性任务的核心产出；textDelta 整段快照的最新值）。 */
  finalText: string;
  /** 本任务的 dsh 会话 uuid（dshSession 事件首见即到；统一详情的续跑句柄）。 */
  sessionId: string | null;
}

export function newDshPanelState(): DshPanelState {
  return {
    phase: "idle",
    runId: null,
    startedAt: Date.now(),
    rows: [],
    tokensIn: 0,
    tokensOut: 0,
    finalText: "",
    sessionId: null,
  };
}

/** 运行态切换：live 禁运行钮、显示停止钮；静止态反向。 */
export function runControls(phase: DshPhase): { runDisabled: boolean; stopHidden: boolean } {
  const live = phase === "live";
  return { runDisabled: live, stopHidden: !live };
}

/** SESSION-ID 预填：有最近会话则覆盖填入（挂载预填/收尾更新共用）；无则不动现值。 */
export function sessionPrefill(current: string, last: string | null): string {
  return last ?? current;
}

function stampOf(st: DshPanelState): string {
  const s = Math.max(0, Math.floor((Date.now() - st.startedAt) / 1000));
  return `T+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 整段快照语义（dsh.rs：headless 无流式 delta，text 事件与 final 各带全文）：
    答案是单条不断被最新快照覆盖的记录——找到最近一条 text 行原地覆盖（final 的
    重复全文不二次成行），没有则新起一行。 */
function applyTextSnapshot(st: DshPanelState, text: string): void {
  for (let i = st.rows.length - 1; i >= 0; i--) {
    const row = st.rows[i];
    if (row.kind === "text") {
      st.rows[i] = { kind: "text", stamp: row.stamp, text };
      return;
    }
  }
  st.rows.push({ kind: "text", stamp: stampOf(st), text });
}

/** 事件归约：logLine/thinking 淡行、text 整段快照、usage 累计覆盖、error/settled/
    exit 常规落行、dshSession 记续跑句柄。toolStart/toolEnd/confirmRequest/
    sessionStarted 是 PI 会话形态事件，DSH adapter 永不发（忽略，保 reducer
    对联合完备不写死分支）。 */
export function applyDshEvent(st: DshPanelState, ev: EngineEvent): void {
  switch (ev.type) {
    case "dshSession":
      st.sessionId = ev.sessionId;
      break;
    case "textDelta":
      if (ev.text !== "") {
        applyTextSnapshot(st, ev.text);
        st.finalText = ev.text;
      }
      break;
    case "thinkingDelta":
      // 不做快照覆盖：think 行同时承载 logLine 进度行，覆盖会吃掉进度记录
      if (ev.text !== "") st.rows.push({ kind: "think", stamp: stampOf(st), text: ev.text });
      break;
    case "logLine":
      st.rows.push({ kind: "think", stamp: stampOf(st), text: ev.text });
      break;
    case "usage":
      st.tokensIn = ev.tokensIn;
      st.tokensOut = ev.tokensOut;
      st.rows.push({
        kind: "usage",
        stamp: stampOf(st),
        text: `IN ${abbrevTokens(ev.tokensIn)} · OUT ${abbrevTokens(ev.tokensOut)}`,
      });
      break;
    case "error":
      st.rows.push({ kind: "err", stamp: stampOf(st), text: ev.message });
      break;
    case "settled":
      st.rows.push({ kind: "settled", stamp: stampOf(st) });
      break;
    case "exit":
      st.phase = "done";
      st.rows.push({ kind: "exit", stamp: stampOf(st), text: String(ev.code ?? "未知") });
      break;
    default:
      break;
  }
  if (st.rows.length > MAX_ROWS) st.rows.splice(0, st.rows.length - MAX_ROWS);
}

/* ── 渲染 ── */

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

/** 飞行日志行：EngRow 直接复用 engine.ts 的 engRowHTML，仅 usage 累计行自绘。 */
export function dshRowHTML(r: DshRow): string {
  return r.kind === "usage"
    ? `<div class="row"><span class="tstamp">${esc(r.stamp)}</span><span class="evt"><b>USAGE</b> ${esc(r.text)}</span></div>`
    : engRowHTML(r);
}

function panelHTML(): string {
  if (!isTauri()) {
    return desktopOnlyNote("DSH headless 任务");
  }
  return `
  <div class="dsh-panel">
    <div class="launch">
      <div class="fld grow dsh-task"><label for="dsh-task">TASK</label><textarea id="dsh-task" rows="3" spellcheck="false" placeholder="一次性任务 · 回车运行 / Shift+回车换行"></textarea></div>
      <div class="fld wd"><label for="dsh-key">DEEPSEEK_API_KEY</label><input id="dsh-key" type="password" autocomplete="off" spellcheck="false" placeholder="只进运行时 env 不落盘" title="首次输入后本会话内记忆（不回显）；输入新值可覆盖"></div>
      <div class="fld grow"><label for="dsh-cwd">WORKDIR</label><input id="dsh-cwd" type="text" spellcheck="false" placeholder="F:\\code-glm\\demo"></div>
      <div class="fld md"><label for="dsh-session">SESSION-ID</label><input id="dsh-session" type="text" spellcheck="false" placeholder="空 = 新会话 · 自动预填上次"></div>
      <button type="button" class="btn pri" id="dsh-run">运行</button>
      <button type="button" class="btn sec" id="dsh-stop" hidden>停止</button>
    </div>
    <div class="eng-meta" id="dsh-meta"></div>
    <div class="dsh-final" id="dsh-final" hidden>
      <div class="dsh-flabel">FINAL · 终答</div>
      <div class="dsh-fbody" id="dsh-fbody"></div>
    </div>
    <div class="log sc-out" id="dsh-out" aria-label="DSH 任务输出流"></div>
  </div>`;
}

/* ── 面板状态（模块级：tab 切换重挂 DOM 也不丢任务与日志缓冲） ── */

let panelState: DshPanelState = newDshPanelState();
let keyMemory = "";
let pane: HTMLElement | null = null;
let listenersReady = false;
let repaintScheduled = false;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function metaText(st: DshPanelState): string {
  const idPart = st.runId === null ? "未启动" : `#${st.runId}`;
  return `${idPart} · TOKENS ${abbrevTokens(st.tokensIn + st.tokensOut)}`;
}

function pushLocal(kind: "in" | "err" | "sys", text: string): void {
  panelState.rows.push({ kind, stamp: stampOf(panelState), text });
  if (panelState.rows.length > MAX_ROWS) {
    panelState.rows.splice(0, panelState.rows.length - MAX_ROWS);
  }
  scheduleRepaint();
}

/** 重放视图：日志流高频事件经 rAF 合并为一帧一绘（同 engine.ts 习惯）。 */
function scheduleRepaint(): void {
  if (repaintScheduled || !pane || !isTauri()) return;
  repaintScheduled = true;
  requestAnimationFrame(() => {
    repaintScheduled = false;
    paintAll();
  });
}

function paintAll(): void {
  if (!pane) return;
  const st = panelState;
  const out = pane.querySelector("#dsh-out");
  if (out) out.innerHTML = st.rows.map(dshRowHTML).join("");
  const meta = pane.querySelector("#dsh-meta");
  if (meta) {
    meta.textContent = metaText(st);
    meta.setAttribute("title", `输入 ${st.tokensIn} · 输出 ${st.tokensOut}`);
  }
  // 终答是核心产出：textContent 直写（无 innerHTML，不经 esc）
  const finalArea = pane.querySelector<HTMLElement>("#dsh-final");
  const fbody = pane.querySelector("#dsh-fbody");
  if (finalArea && fbody) {
    finalArea.hidden = st.finalText === "";
    fbody.textContent = st.finalText;
  }
  refreshControls();
  if (out) out.scrollTop = out.scrollHeight;
}

function refreshControls(): void {
  if (!pane) return;
  const { runDisabled, stopHidden } = runControls(panelState.phase);
  const run = pane.querySelector<HTMLButtonElement>("#dsh-run");
  const stop = pane.querySelector<HTMLButtonElement>("#dsh-stop");
  if (run) run.disabled = runDisabled;
  if (stop) stop.hidden = stopHidden;
  for (const id of ["#dsh-task", "#dsh-key", "#dsh-cwd", "#dsh-session"]) {
    const el = pane.querySelector<HTMLInputElement | HTMLTextAreaElement>(id);
    if (el) el.disabled = runDisabled;
  }
}

/* ── 事件订阅（模块级一次；形状不符的事件告警并丢弃，不中断 UI） ── */

function ensureListeners(): void {
  if (!isTauri() || listenersReady) return;
  listenersReady = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => {
      void listen<unknown>("engine://update", (ev) => {
        try {
          const u = decodeEngineUpdate(ev.payload);
          if (u.id !== panelState.runId) return;
          applyDshEvent(panelState, u.event);
          // 事件流不携带 sessionId（adapter 在 Rust 侧记录）：收尾后拉最近会话预填
          if (u.event.type === "exit") {
            void refreshSessionInput();
            void renderHistory();
          }
          scheduleRepaint();
        } catch (err) {
          console.warn("[dsh] 丢弃形状不符的事件", err);
        }
      });
    })
    .catch((err: unknown) => console.warn("[dsh] 事件订阅失败", err));
}

/** 拉最近 DSH 会话填入续跑输入（挂载预填与任务收尾更新共用）。 */
async function refreshSessionInput(): Promise<void> {
  if (!pane) return;
  try {
    const last = await dshLastSession();
    const input = pane.querySelector<HTMLInputElement>("#dsh-session");
    if (input) input.value = sessionPrefill(input.value, last);
  } catch (err) {
    console.warn("[dsh] 最近会话读取失败", err);
  }
}

/* ── 面板行为 ── */

async function onRun(): Promise<void> {
  if (!pane || panelState.phase === "live") return;
  const taskEl = pane.querySelector<HTMLTextAreaElement>("#dsh-task");
  const keyEl = pane.querySelector<HTMLInputElement>("#dsh-key");
  const cwdEl = pane.querySelector<HTMLInputElement>("#dsh-cwd");
  const sessionEl = pane.querySelector<HTMLInputElement>("#dsh-session");
  if (!taskEl || !keyEl || !cwdEl || !sessionEl) return;
  const task = taskEl.value.trim();
  const cwd = cwdEl.value.trim();
  if (!task) {
    pushLocal("err", "ERR · task 不能为空");
    return;
  }
  if (!cwd) {
    pushLocal("err", "ERR · workdir 不能为空");
    return;
  }
  const resume = sessionEl.value.trim();
  const key = keyEl.value.trim() || keyMemory;
  try {
    const id = await dshRun({ cwd, task, deepseekApiKey: key, sessionId: resume || undefined });
    panelState = newDshPanelState();
    panelState.runId = id;
    panelState.phase = "live";
    keyMemory = key;
    // 明文不回显：key 已进会话内存，输入框即清（重填新值可覆盖）
    keyEl.value = "";
    pushLocal("sys", `START · dsh #${id} · ${resume ? `续会话 ${resume}` : "新会话"} · cwd ${cwd}`);
    pushLocal("in", task);
    paintAll();
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}

async function onStop(): Promise<void> {
  const st = panelState;
  if (st.phase !== "live" || st.runId === null) return;
  try {
    // 复用 engine_stop（DSH 与 PI 共用 engine 注册表；stdin 弃用，走进程树收割）
    await engineStop(st.runId);
    pushLocal("sys", "SYS · 停止请求已发出 · 等待进程退出");
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}


/** 历史会话列表（R5-B#5）：点击行回填 SESSION-ID 即续跑。收尾后也刷新
    （新会话进历史）。时间本地短格式。 */
async function renderHistory(): Promise<void> {
  const box = pane === null ? null : pane.querySelector<HTMLElement>("#dsh-hist");
  if (box === null) return;
  let list: DshSessionEntry[] = [];
  try {
    list = await dshSessionList();
  } catch {
    box.hidden = true;
    return;
  }
  if (list.length === 0) {
    box.hidden = true;
    return;
  }
  const fmt = (at: number): string => {
    const d = new Date(at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const md = String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    return md + " " + hh + ":" + mm;
  };
  box.hidden = false;
  box.innerHTML =
    '<div class="dsh-hist-h">历史会话 · 点击续跑</div>' +
    list
      .slice(0, 8)
      .map(
        (e) =>
          '<div class="dsh-hist-row" data-sid="' + escHtml(e.id) + '" role="button" tabindex="0"><span class="t">' + escHtml(e.task || "(无标题)") + '</span><span class="m">' + escHtml(fmt(e.at)) + '</span><span class="i">' + escHtml(e.id.slice(0, 8)) + "</span></div>",
      )
      .join("");
}

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** 挂载 DSH 任务面板（tab 切换即重挂，任务与日志缓冲经模块级状态延续）。 */
export function mountDshPanel(container: HTMLElement): void {
  pane = container;
  container.innerHTML = panelHTML();
  if (!isTauri()) return;
  ensureListeners();

  container.querySelector("#dsh-run")?.addEventListener("click", () => void onRun());
  container.querySelector("#dsh-stop")?.addEventListener("click", () => void onStop());
  container
    .querySelector<HTMLTextAreaElement>("#dsh-task")
    ?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onRun();
      }
    });

  paintAll();
  void refreshSessionInput();
}

/** 一级 tab 切离 DSH 面板时由 main.ts 调用：清面板引用；任务与日志缓冲经
    模块级状态延续，切回重挂即恢复。 */
export function unmountDshPanel(): void {
  pane = null;
}

/** 面板当前任务态的只读快照（统一详情 seeding 用）：无任务或已收尾返回 null。
    拷贝 rows 防两路消费互相踩（详情侧自行归约后续事件）。 */
export function dshPanelSnapshot(): DshPanelState | null {
  if (panelState.runId === null) return null;
  return { ...panelState, rows: panelState.rows.slice() };
}

/** 统一详情「续跑」回填：面板已挂载时把 sessionId 写入输入框（未挂载静默
    no-op——接线层先切 Agent tab 再调用）。 */
export function dshPrefillSession(sessionId: string): void {
  if (!pane) return;
  const input = pane.querySelector<HTMLInputElement>("#dsh-session");
  if (input) input.value = sessionId;
}
