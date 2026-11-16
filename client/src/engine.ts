/* PI 引擎会话桥接层：对 src-tauri/src/engine（R3 adapter）的命令与事件做 TS 侧
   精确建模。事件 engine://update payload {id, event}，event 判别联合 tag="type"
   camelCase（engine/mod.rs #[serde(tag="type", rename_all="camelCase")]）。
   面板为单会话卡：会话头部（PROVIDER/MODEL/WORKDIR+启停）→ 飞行日志流 →
   HOLD 审批卡 → 自适应发送区（settled→prompt / 流式中→steer 一键两义）。
   事件归约 applyEvent 是纯内存操作（node 断言脚本直接测）；DOM 只做重放视图。
   模块级状态同 sidecar 惯例：tab 切走仅卸 DOM 引用，切回重放。
   @tauri-apps/api 一律动态 import：非 Tauri 环境静态引入会破坏浏览器降级路径。 */

import { ProtocolError, fieldNumber, fieldString, isObj } from "./api";
import { desktopOnlyNote } from "./desktop-only";
import { isTauri } from "./harness";

/* ── 边界窄化（事件 payload 与 invoke 回包是外部数据，先窄化再入内域） ── */

export type EngineEvent =
  | { type: "textDelta"; text: string }
  | { type: "thinkingDelta"; text: string }
  | { type: "toolStart"; name: string; argsJson: string }
  | { type: "toolEnd"; name: string; isError: boolean }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "confirmRequest"; id: string; title: string; message: string }
  | { type: "settled" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string }
  | { type: "logLine"; text: string }
  | { type: "sessionStarted"; sessionId: string }
  | { type: "dshSession"; sessionId: string };

export interface EngineUpdate {
  id: number;
  event: EngineEvent;
}

function decodeEngineEvent(v: unknown): EngineEvent {
  if (!isObj(v)) throw new ProtocolError("bad engine event");
  const type = fieldString(v, "type");
  if (type === "textDelta" || type === "thinkingDelta" || type === "logLine") {
    const text = fieldString(v, "text");
    if (text === undefined) throw new ProtocolError(`engine ${type} missing text`);
    return { type, text };
  }
  if (type === "toolStart") {
    const name = fieldString(v, "name");
    const argsJson = fieldString(v, "argsJson");
    if (name === undefined || argsJson === undefined) {
      throw new ProtocolError("engine toolStart missing fields");
    }
    return { type, name, argsJson };
  }
  if (type === "toolEnd") {
    const name = fieldString(v, "name");
    if (name === undefined) throw new ProtocolError("engine toolEnd missing name");
    return { type, name, isError: v.isError === true };
  }
  if (type === "usage") {
    const tokensIn = fieldNumber(v, "tokensIn");
    const tokensOut = fieldNumber(v, "tokensOut");
    if (tokensIn === undefined || tokensOut === undefined) {
      throw new ProtocolError("engine usage missing fields");
    }
    return { type, tokensIn, tokensOut };
  }
  if (type === "confirmRequest") {
    const id = fieldString(v, "id");
    const title = fieldString(v, "title");
    const message = fieldString(v, "message");
    if (id === undefined || title === undefined || message === undefined) {
      throw new ProtocolError("engine confirmRequest missing fields");
    }
    return { type, id, title, message };
  }
  if (type === "settled") return { type };
  if (type === "sessionStarted" || type === "dshSession") {
    const sessionId = fieldString(v, "sessionId");
    if (sessionId === undefined) {
      throw new ProtocolError(`engine ${type} missing sessionId`);
    }
    return { type, sessionId };
  }
  if (type === "exit") {
    const raw = v.code;
    if (raw !== null && typeof raw !== "number") {
      throw new ProtocolError("engine exit bad code");
    }
    return { type, code: raw };
  }
  if (type === "error") {
    const message = fieldString(v, "message");
    if (message === undefined) throw new ProtocolError("engine error missing message");
    return { type, message };
  }
  throw new ProtocolError(`unknown engine event type: ${type ?? "?"}`);
}

export function decodeEngineUpdate(v: unknown): EngineUpdate {
  if (!isObj(v)) throw new ProtocolError("bad engine update payload");
  const id = fieldNumber(v, "id");
  if (id === undefined) throw new ProtocolError("engine update missing id");
  return { id, event: decodeEngineEvent(v.event) };
}

/* ── 偏好记忆（B6①：PI 面板上次成功组合存本地 prefs KV，挂载时预填。
   非 Tauri 环境/断连静默降级——只影响便利性，不阻塞会话本身） ── */

const PI_PREF = { provider: "pi.provider", model: "pi.model", cwd: "pi.cwd" } as const;
/* R5-B#5 会话恢复：current=面板重启自动续的 uuid；sessions=历史列表 JSON。 */
const PI_SESSION_PREF = { current: "pi.session.current", list: "pi.sessions" } as const;

/** 面板持有的 pi 会话 uuid：null=尚未起过（裸起后由 sessionStarted 事件采纳
    pi 实铸的 uuid——自铸的 uuid 永远匹配不到 pi 的 <ts>_<uuid>.jsonl 文件）。 */
let piSessionId: string | null = null;

/** 最近一次启动的标签（provider/model 组合），sessionStarted 记历史时用。 */
let lastStartLabel = "默认 pi 配置";

interface PiSessionEntry {
  id: string;
  label: string;
  at: number;
}

function mergePiHistory(prev: string | null, entry: PiSessionEntry): string {
  let list: PiSessionEntry[] = [];
  try {
    list = prev !== null ? (JSON.parse(prev) as PiSessionEntry[]) : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list = list.filter((e) => e.id !== entry.id);
  list.unshift(entry);
  list = list.slice(0, 20);
  return JSON.stringify(list);
}

async function prefSet(key: string, value: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("pref_set", { key, value });
}

export async function prefGet(key: string): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const v = await invoke<unknown>("pref_get", { key });
  return typeof v === "string" ? v : null;
}

/** 启动成功后保存组合（provider 可为空串=显式回到「默认 pi 配置」）。尽力而为。 */
function savePiPrefs(provider: string, model: string, cwd: string): void {
  void (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pref_set", { key: PI_PREF.provider, value: provider });
    await invoke("pref_set", { key: PI_PREF.model, value: model });
    await invoke("pref_set", { key: PI_PREF.cwd, value: cwd });
  })().catch((e) => console.warn("[engine] 偏好保存失败", e));
}

/* ── 命令封装（Tauri v2：JS camelCase 参数映射 Rust snake_case 形参） ── */

export interface EngineStartArgs {
  /** pi CLI 约束：provider 必须与 model 同传；model 可单独用（支持 "provider/id"）。 */
  provider?: string;
  model?: string;
  cwd: string;
  /** R5-B#5 会话恢复：命中 session-dir 既有会话文件才续接；未命中/缺省=pi
      裸起新会话，实铸 uuid 经 sessionStarted 事件回传。 */
  sessionId?: string;
}

export async function engineStart(args: EngineStartArgs): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("engine_start", {
    provider: args.provider ?? null,
    model: args.model ?? null,
    cwd: args.cwd,
    sessionId: args.sessionId ?? null,
  });
}

export async function enginePrompt(id: number, text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("engine_prompt", { id, text });
}

export async function engineSteer(id: number, text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("engine_steer", { id, text });
}

export async function engineAbort(id: number): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("engine_abort", { id });
}

export interface EngineConfirmArgs {
  id: number;
  reqId: string;
  confirmed: boolean;
  value?: string;
}

export async function engineConfirm(args: EngineConfirmArgs): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("engine_confirm", {
    id: args.id,
    reqId: args.reqId,
    confirmed: args.confirmed,
    value: args.value ?? null,
  });
}

export async function engineStop(id: number): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("engine_stop", { id });
}

/* ── 会话域模型（纯内存，node 断言脚本直接覆盖） ── */

export type EnginePhase = "idle" | "live" | "settled" | "exited";

/** 发送钮一键两义：引擎静止（含启动后未发首问）→ prompt；流式中 → steer；
    无会话/已退出 → null（禁用）。若静止误判，prompt 会被引擎拒并回流 error 行。 */
export function sendMode(phase: EnginePhase): "prompt" | "steer" | null {
  if (phase === "settled") return "prompt";
  if (phase === "live") return "steer";
  return null;
}

/** token 累计缩写（同任务域 tokenValue 习惯）：不足 1k 原样；以上一位小数 + k/M。 */
export function abbrevTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export type EngRow =
  | { kind: "in"; stamp: string; text: string }
  | { kind: "text"; stamp: string; text: string }
  | { kind: "think"; stamp: string; text: string }
  | { kind: "tool"; stamp: string; name: string; args: string; isError: boolean }
  | { kind: "settled"; stamp: string }
  | { kind: "exit"; stamp: string; text: string }
  | { kind: "err"; stamp: string; text: string }
  | { kind: "sys"; stamp: string; text: string };

export interface ConfirmCard {
  reqId: string;
  title: string;
  message: string;
}

export interface EnginePanelState {
  phase: EnginePhase;
  sessionId: number | null;
  /** 面板当前 pi 会话 uuid（sessionStarted 事件回传，裸起新会话时由 pi 实铸）。 */
  sessionUuid: string | null;
  startedAt: number;
  rows: EngRow[];
  tokensIn: number;
  tokensOut: number;
  confirms: ConfirmCard[];
}

export const MAX_ROWS = 500;

export function newEnginePanelState(): EnginePanelState {
  return {
    phase: "idle",
    sessionId: null,
    sessionUuid: null,
    startedAt: Date.now(),
    rows: [],
    tokensIn: 0,
    tokensOut: 0,
    confirms: [],
  };
}

function stampOf(st: EnginePanelState): string {
  const s = Math.max(0, Math.floor((Date.now() - st.startedAt) / 1000));
  return `T+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 事件归约：text/think 增量续写末行；同一调用的两次 ToolStart（toolcall_start
    无参 → execution_start 带参）就近合并为一行，ToolEnd 落 ERR 后缀；usage 为
    引擎累计值直接覆盖；exit 清空待响应审批卡（引擎已死，回写必失败）。 */
export function applyEvent(st: EnginePanelState, ev: EngineEvent): void {
  const last = st.rows[st.rows.length - 1];
  switch (ev.type) {
    case "textDelta":
    case "thinkingDelta": {
      const kind = ev.type === "textDelta" ? "text" : "think";
      if (last !== undefined && last.kind === kind) last.text += ev.text;
      else st.rows.push({ kind, stamp: stampOf(st), text: ev.text });
      break;
    }
    case "toolStart":
      if (last !== undefined && last.kind === "tool" && last.name === ev.name && last.args === "") {
        last.args = ev.argsJson;
      } else {
        st.rows.push({
          kind: "tool",
          stamp: stampOf(st),
          name: ev.name,
          args: ev.argsJson,
          isError: false,
        });
      }
      break;
    case "toolEnd":
      if (last !== undefined && last.kind === "tool" && last.name === ev.name) {
        last.isError = last.isError || ev.isError;
      } else {
        st.rows.push({
          kind: "tool",
          stamp: stampOf(st),
          name: ev.name,
          args: "",
          isError: ev.isError,
        });
      }
      break;
    case "usage":
      st.tokensIn = ev.tokensIn;
      st.tokensOut = ev.tokensOut;
      break;
    case "confirmRequest":
      st.confirms.push({ reqId: ev.id, title: ev.title, message: ev.message });
      break;
    case "settled":
      if (st.phase !== "exited") st.phase = "settled";
      st.rows.push({ kind: "settled", stamp: stampOf(st) });
      break;
    case "exit":
      st.phase = "exited";
      st.confirms = [];
      st.rows.push({ kind: "exit", stamp: stampOf(st), text: String(ev.code ?? "未知") });
      break;
    case "error":
      st.rows.push({ kind: "err", stamp: stampOf(st), text: ev.message });
      break;
    case "logLine":
      // DSH turn/step 结构事件的日志行（PI 会话不产此事件）：淡色进度条目，
      // DSH 侧归约在 dsh.ts（此处仅保 PI 归约器对联合类型完备）
      st.rows.push({ kind: "think", stamp: stampOf(st), text: ev.text });
      break;
    case "sessionStarted":
      st.sessionUuid = ev.sessionId;
      break;
    case "dshSession":
      // DSH 会话 uuid 只进 dsh 侧状态（统一详情续跑句柄）；PI 会话不产此事件
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

/** 飞行日志行（.log/.sc-out 体系）：TOOL 行合并参数、isError 红色 ERR 后缀；
    think/settled 淡色；exit 按 code 0 绿 / 非 0 红。 */
export function engRowHTML(r: EngRow): string {
  let evt: string;
  switch (r.kind) {
    case "in":
      evt = `<span class="evt sc-in">&gt; ${esc(r.text)}</span>`;
      break;
    case "text":
      evt = `<span class="evt">${esc(r.text)}</span>`;
      break;
    case "think":
      evt = `<span class="evt sc-think">· ${esc(r.text)}</span>`;
      break;
    case "tool":
      evt = `<span class="evt"><b>TOOL</b> ${esc(r.name)}${r.args ? ` ${esc(r.args)}` : ""}${r.isError ? ` <b class="sc-err">ERR</b>` : ""}</span>`;
      break;
    case "settled":
      evt = `<span class="evt sc-think">— 本轮完成 —</span>`;
      break;
    case "exit":
      evt = `<span class="evt${r.text === "0" ? " ok" : " sc-err"}"><b>EXIT</b> ${esc(r.text)}</span>`;
      break;
    case "err":
      evt = `<span class="evt sc-err">${esc(r.text)}</span>`;
      break;
    case "sys":
      evt = `<span class="evt"><b>${esc(r.text)}</b></span>`;
      break;
  }
  return `<div class="row"><span class="tstamp">${esc(r.stamp)}</span>${evt}</div>`;
}

/** 审批卡（复用 HOLD 形态）。事件不区分 confirm/input 型（method 只登记在 Rust
    侧待响应表），故恒带可选输入框：留空批准 = confirmed，填值批准 = value。 */
function confirmCardHTML(c: ConfirmCard): string {
  const desc = c.title || "引擎请求确认";
  return `<div class="hold" data-req="${esc(c.reqId)}">
  <div class="bar"><span class="tag">HOLD</span><span class="desc">${esc(desc)}${c.message ? ` · ${esc(c.message)}` : ""}</span></div>
  <div class="eng-cwrap"><input class="eng-cin" type="text" spellcheck="false" placeholder="回复值 · input 型请求时填写，确认型留空"></div>
  <div class="acts"><button type="button" class="btn pri" data-ok="1">批准</button><button type="button" class="btn sec" data-ok="0">拒绝</button></div>
</div>`;
}

function panelHTML(): string {
  if (!isTauri()) {
    return desktopOnlyNote("PI 引擎会话");
  }
  return `
  <div class="eng-panel">
    <div class="launch">
      <div class="fld"><label for="eng-provider">PROVIDER</label><input id="eng-provider" type="text" spellcheck="false" placeholder="默认 pi 配置"></div>
      <div class="fld"><label for="eng-model">MODEL</label><input id="eng-model" type="text" spellcheck="false" placeholder="默认 pi 配置"></div>
      <div class="fld grow"><label for="eng-cwd">WORKDIR</label><input id="eng-cwd" type="text" spellcheck="false" placeholder="F:\\code-glm\\demo"></div>
      <button type="button" class="btn pri" id="eng-start">启动</button>
      <button type="button" class="btn sec" id="eng-stop" disabled>停止</button>
    </div>
    <div class="eng-meta" id="eng-meta"></div>
    <div class="log sc-out" id="eng-out" aria-label="PI 引擎输出流"></div>
    <div id="eng-hold"></div>
    <div class="dsh-hist pi-hist" id="pi-hist" hidden></div>
    <div class="eng-send">
      <textarea id="eng-input" rows="2" spellcheck="false" placeholder="输入任务 · 回车发送 / Shift+回车换行" aria-label="PI 引擎输入"></textarea>
      <button type="button" class="btn pri" id="eng-send" disabled>发送</button>
      <button type="button" class="btn sec" id="eng-abort" hidden>中止</button>
    </div>
  </div>`;
}

/* ── 面板状态（模块级：tab 切换重挂 DOM 也不丢会话与日志缓冲） ── */

let panelState: EnginePanelState = newEnginePanelState();
let pane: HTMLElement | null = null;
let listenersReady = false;
let repaintScheduled = false;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function metaText(st: EnginePanelState): string {
  const uuidPart = st.sessionUuid === null ? "" : ` · ${st.sessionUuid.slice(0, 8)}`;
  const idPart = st.sessionId === null ? "未启动" : `#${st.sessionId}${uuidPart}`;
  return `${idPart} · TOKENS ${abbrevTokens(st.tokensIn + st.tokensOut)}`;
}

function pushLocal(kind: "in" | "err" | "sys", text: string): void {
  panelState.rows.push({ kind, stamp: stampOf(panelState), text });
  if (panelState.rows.length > MAX_ROWS) {
    panelState.rows.splice(0, panelState.rows.length - MAX_ROWS);
  }
  scheduleRepaint();
}

/** 重放视图：日志流高频 delta 经 rAF 合并为一帧一绘（同任务域全量重绘习惯）。 */
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
  const out = pane.querySelector("#eng-out");
  if (out) out.innerHTML = st.rows.map(engRowHTML).join("");
  const meta = pane.querySelector("#eng-meta");
  if (meta) {
    meta.textContent = metaText(st);
    meta.setAttribute("title", `输入 ${st.tokensIn} · 输出 ${st.tokensOut}`);
  }
  const hold = pane.querySelector("#eng-hold");
  if (hold) hold.innerHTML = st.confirms.map(confirmCardHTML).join("");
  refreshControls();
  if (out) out.scrollTop = out.scrollHeight;
}

function refreshControls(): void {
  if (!pane) return;
  const st = panelState;
  const alive = st.phase === "live" || st.phase === "settled";
  const start = pane.querySelector<HTMLButtonElement>("#eng-start");
  const stop = pane.querySelector<HTMLButtonElement>("#eng-stop");
  const send = pane.querySelector<HTMLButtonElement>("#eng-send");
  const abort = pane.querySelector<HTMLButtonElement>("#eng-abort");
  if (start) start.disabled = alive;
  if (stop) stop.disabled = !alive;
  for (const id of ["#eng-provider", "#eng-model", "#eng-cwd"]) {
    const el = pane.querySelector<HTMLInputElement>(id);
    if (el) el.disabled = alive;
  }
  const mode = sendMode(st.phase);
  if (send) {
    send.disabled = mode === null;
    send.textContent = mode === "steer" ? "转向" : "发送";
    send.title =
      mode === "steer" ? "流式中插话：本轮工具执行完、下次调模型前投递" : "发起任务";
  }
  if (abort) abort.hidden = st.phase !== "live";
}

/* ── 事件订阅（模块级一次；形状不符的事件告警并丢弃，不中断 UI） ── */

/** sessionStarted 采纳：pi 实铸的 uuid 落为续会目标并记历史（同值幂等）。 */
function adoptPiSession(uuid: string): void {
  if (piSessionId === uuid) return;
  piSessionId = uuid;
  void prefSet(PI_SESSION_PREF.current, uuid).catch(() => undefined);
  void (async () => {
    const list = await prefGet(PI_SESSION_PREF.list).catch(() => null);
    await prefSet(PI_SESSION_PREF.list, mergePiHistory(list, { id: uuid, label: lastStartLabel, at: Date.now() })).catch(
      () => undefined,
    );
    if (pane) void renderPiHistory();
  })().catch(() => undefined);
  pushLocal("sys", `SESSION · pi 会话 ${uuid.slice(0, 8)}`);
}

function ensureListeners(): void {
  if (!isTauri() || listenersReady) return;
  listenersReady = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) => {
      void listen<unknown>("engine://update", (ev) => {
        try {
          const u = decodeEngineUpdate(ev.payload);
          // sessionStarted 不按会话号过滤：它可能在 engineStart 返回与面板换态的
          // 间隙到达，而它是「自动续上次」的数据源，丢了就续不上
          if (u.event.type === "sessionStarted") {
            applyEvent(panelState, u.event);
            adoptPiSession(u.event.sessionId);
            scheduleRepaint();
            return;
          }
          if (u.id !== panelState.sessionId) return;
          applyEvent(panelState, u.event);
          scheduleRepaint();
        } catch (err) {
          console.warn("[engine] 丢弃形状不符的事件", err);
        }
      });
    })
    .catch((err: unknown) => console.warn("[engine] 事件订阅失败", err));
}

/** 历史会话列表（R5-B#5）：pref 存的最近 20 条，点选换续会目标。 */
async function renderPiHistory(): Promise<void> {
  const box = pane === null ? null : pane.querySelector<HTMLElement>("#pi-hist");
  if (box === null) return;
  let list: PiSessionEntry[] = [];
  try {
    const raw = await prefGet(PI_SESSION_PREF.list);
    if (raw !== null) list = JSON.parse(raw) as PiSessionEntry[];
  } catch {
    box.hidden = true;
    return;
  }
  if (!Array.isArray(list) || list.length === 0) {
    box.hidden = true;
    return;
  }
  const fmt = (at: number): string => {
    const d = new Date(at);
    return (
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      " " +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  };
  const esc = (v: string): string => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  box.hidden = false;
  box.innerHTML =
    '<div class="dsh-hist-h">历史会话 · 点击续接</div>' +
    list
      .slice(0, 8)
      .map(
        (e) =>
          '<div class="dsh-hist-row" data-sid="' + esc(e.id) + '" role="button" tabindex="0"><span class="t">' + esc(e.label || "(未命名)") + '</span><span class="m">' + esc(fmt(e.at)) + '</span><span class="i">' + esc(e.id.slice(0, 8)) + "</span></div>",
      )
      .join("");
}

/* ── 面板行为 ── */

async function onStart(): Promise<void> {
  if (!pane || panelState.phase === "live" || panelState.phase === "settled") return;
  const providerEl = pane.querySelector<HTMLInputElement>("#eng-provider");
  const modelEl = pane.querySelector<HTMLInputElement>("#eng-model");
  const cwdEl = pane.querySelector<HTMLInputElement>("#eng-cwd");
  if (!providerEl || !modelEl || !cwdEl) return;
  const provider = providerEl.value.trim();
  const model = modelEl.value.trim();
  const cwd = cwdEl.value.trim();
  if (!cwd) {
    pushLocal("err", "ERR · workdir 不能为空");
    return;
  }
  if (provider && !model) {
    pushLocal("err", "ERR · provider 需与 model 同传（pi CLI 约束；model 可单独用）");
    return;
  }
  try {
    // 恢复链：优先用面板已持 uuid（切 tab 重挂续会）；否则读 pref 续上次；都
    // 没有则裸起，pi 铸新 uuid 经 sessionStarted 事件回传并采纳（onStart 不再
    // 自铸——自铸 uuid 匹配不到 pi 的会话文件，后端会当未命中裸起）。
    if (piSessionId === null) {
      piSessionId = await prefGet(PI_SESSION_PREF.current).catch(() => null);
    }
    lastStartLabel = [provider, model].filter((v) => v !== "").join("/") || "默认 pi 配置";
    const id = await engineStart({
      provider: provider || undefined,
      model: model || undefined,
      cwd,
      sessionId: piSessionId ?? undefined,
    });
    savePiPrefs(provider, model, cwd);
    panelState = newEnginePanelState();
    panelState.sessionId = id;
    // 启动即静止：引擎空闲等待首问，发送钮走 prompt 语义
    panelState.phase = "settled";
    const idPart = provider ? `${provider}/${model}` : model || "默认 pi 配置";
    panelState.rows.push({
      kind: "sys",
      stamp: stampOf(panelState),
      text: `START · pi #${id} · ${idPart} · cwd ${cwd}`,
    });
    paintAll();
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}

async function onStop(): Promise<void> {
  const st = panelState;
  if (st.sessionId === null || st.phase === "exited") return;
  try {
    await engineStop(st.sessionId);
    pushLocal("sys", "SYS · 停止请求已发出 · 等待引擎退出");
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}

async function onSend(): Promise<void> {
  if (!pane) return;
  const st = panelState;
  const mode = sendMode(st.phase);
  const ta = pane.querySelector<HTMLTextAreaElement>("#eng-input");
  if (mode === null || st.sessionId === null || !ta) return;
  const text = ta.value.trim();
  if (!text) return;
  try {
    if (mode === "prompt") {
      await enginePrompt(st.sessionId, text);
      // 乐观置 live：若引擎其实在流式（静止误判），prompt 被拒后 error 行会回流纠正
      st.phase = "live";
    } else {
      await engineSteer(st.sessionId, text);
    }
    pushLocal("in", text);
    ta.value = "";
    refreshControls();
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}

async function onAbort(): Promise<void> {
  const st = panelState;
  if (st.phase !== "live" || st.sessionId === null) return;
  try {
    await engineAbort(st.sessionId);
    pushLocal("sys", "SYS · 中止请求已发出");
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}

async function onConfirm(reqId: string, confirmed: boolean): Promise<void> {
  const st = panelState;
  if (st.sessionId === null) return;
  let value: string | undefined;
  if (confirmed && pane) {
    const input = pane.querySelector<HTMLInputElement>(
      `.hold[data-req="${CSS.escape(reqId)}"] .eng-cin`,
    );
    value = input?.value.trim() || undefined;
  }
  // 先摘卡再回写：Rust 侧待响应表是一次性的，失败也不再可响应
  st.confirms = st.confirms.filter((c) => c.reqId !== reqId);
  scheduleRepaint();
  try {
    await engineConfirm({ id: st.sessionId, reqId, confirmed, value });
    pushLocal("sys", `SYS · ${confirmed ? "已批准" : "已拒绝"} ${reqId}`);
  } catch (e) {
    pushLocal("err", `ERR · ${errText(e)}`);
  }
}

/** 挂载 PI 会话面板（tab 切换即重挂，会话与日志缓冲经模块级状态延续）。 */
export function mountEnginePanel(container: HTMLElement): void {
  pane = container;
  container.innerHTML = panelHTML();
  if (!isTauri()) return;
  ensureListeners();

  container.querySelector("#eng-start")?.addEventListener("click", () => void onStart());
  container.querySelector("#eng-stop")?.addEventListener("click", () => void onStop());
  // 历史会话行：点选=续会目标换人（写 current + 面板回空闲态，点启动即以该 id 续）
  container.querySelector("#pi-hist")?.addEventListener("click", (ev) => {
    const row = ev.target instanceof Element ? ev.target.closest(".dsh-hist-row") : null;
    if (!(row instanceof HTMLElement) || row.dataset.sid === undefined) return;
    piSessionId = row.dataset.sid;
    void prefSet(PI_SESSION_PREF.current, piSessionId).catch(() => undefined);
    if (panelState.phase === "live" || panelState.phase === "settled") {
      pushLocal("sys", "SYS · 已选历史会话，停止当前后点「启动会话」续接 " + piSessionId.slice(0, 8));
    } else {
      pushLocal("sys", "SYS · 将续接会话 " + piSessionId.slice(0, 8) + " · 点「启动会话」");
    }
  });
  void renderPiHistory();
  container.querySelector("#eng-send")?.addEventListener("click", () => void onSend());
  container.querySelector("#eng-abort")?.addEventListener("click", () => void onAbort());
  container.querySelector<HTMLTextAreaElement>("#eng-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  });
  // 审批卡随事件重绘，按钮/输入框经 #eng-hold 委托（每次挂载新建，不累积监听）
  const hold = container.querySelector<HTMLElement>("#eng-hold");
  hold?.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("[data-ok]");
    if (!(btn instanceof HTMLElement)) return;
    const card = btn.closest(".hold[data-req]");
    const reqId = card instanceof HTMLElement ? card.dataset.req : undefined;
    if (reqId !== undefined) void onConfirm(reqId, btn.dataset.ok === "1");
  });
  hold?.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (
      ev.key === "Enter" &&
      t instanceof HTMLInputElement &&
      t.classList.contains("eng-cin")
    ) {
      ev.preventDefault();
      const card = t.closest(".hold[data-req]");
      const reqId = card instanceof HTMLElement ? card.dataset.req : undefined;
      if (reqId !== undefined) void onConfirm(reqId, true);
    }
  });

  // B6①：挂载即预填上次成功组合（读回空串则不填，保持「默认 pi 配置」占位）
  void (async () => {
    const [provider, model, cwd] = await Promise.all([
      prefGet(PI_PREF.provider),
      prefGet(PI_PREF.model),
      prefGet(PI_PREF.cwd),
    ]);
    if (!pane) return; // 期间 tab 切走：丢弃即可，下次挂载再读
    const fill = (id: string, v: string | null) => {
      if (v) {
        const el = pane?.querySelector<HTMLInputElement>(id);
        if (el && !el.value) el.value = v;
      }
    };
    fill("#eng-provider", provider);
    fill("#eng-model", model);
    fill("#eng-cwd", cwd);
  })().catch((e) => console.warn("[engine] 偏好预填失败", e));

  paintAll();
}

/** 一级 tab 切离 PI 面板时由 main.ts 调用：清面板引用；会话与日志缓冲经
    模块级状态延续，切回重挂即恢复。 */
export function unmountEnginePanel(): void {
  pane = null;
}

/** 面板当前会话态的只读快照（统一详情 seeding 用）：无活动会话返回 null。
    拷贝 rows 防两路消费互相踩（详情侧自行归约后续事件）。 */
export function enginePanelSnapshot(): EnginePanelState | null {
  if (panelState.sessionId === null) return null;
  return { ...panelState, rows: panelState.rows.slice(), confirms: panelState.confirms.slice() };
}
