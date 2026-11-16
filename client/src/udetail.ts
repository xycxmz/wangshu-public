/* 统一详情引擎行（dsh/pi）状态机与只读渲染
   归约器与日志行渲染
   复用 dsh.ts/engine.ts（applyDshEvent/applyEvent + dshRowHTML/engRowHTML）；
   本模块只加「按 engine 会话号 keyed 的多行状态」——Agent tab 面板是单实例
   写入口，统一详情是任意行的只读重放视图，写交互（续跑/续聊）回 Agent tab。
   状态生命周期：事件到达（unified 快照能定 kind/起始时刻时）即建并续灌，
   点击前的日志也已积累；点击行时若无状态则从点击时刻起建；条目上限 8
   防长页面积累。dsh 终态行（Rust 环形驻留队列）无日志可放——只出终态摘要。
   无 DOM 依赖，node 断言脚本直跑（scripts/pure.test.ts 惯例）。 */

import {
  applyDshEvent,
  dshRowHTML,
  newDshPanelState,
} from "./dsh";
import type { DshPanelState } from "./dsh";
import {
  abbrevTokens,
  applyEvent,
  engRowHTML,
  newEnginePanelState,
} from "./engine";
import type { EngineEvent, EnginePanelState } from "./engine";
import { fmtElapsed } from "./tasksview";
import type { UnifiedRow } from "./tasksview";

/* ── 状态（模块级，同 dsh/engine 面板惯例：切走不回收，重进同任务日志仍在） ── */

const dshStates = new Map<string, DshPanelState>();
const piStates = new Map<string, EnginePanelState>();
const MAX_ENGINE_DETAILS = 8;

function prune(map: Map<string, unknown>): void {
  for (const key of map.keys()) {
    if (map.size <= MAX_ENGINE_DETAILS) break;
    map.delete(key);
  }
}

/** 打开/事件到达时确保状态在场：已有则不动（积累的日志不丢）；无则落位
    （seed=Agent tab 面板快照，同任务时连历史日志一起带过来；空起建锚定
    任务起始时刻，T+ 时间戳真实）。 */
export function ensureDshDetail(id: string, startedAt: number, seed: DshPanelState | null): void {
  if (dshStates.has(id)) return;
  const st = seed ?? newDshPanelState();
  if (seed === null) st.startedAt = startedAt;
  dshStates.set(id, st);
  prune(dshStates);
}

export function ensurePiDetail(id: string, startedAt: number, seed: EnginePanelState | null): void {
  if (piStates.has(id)) return;
  const st = seed ?? newEnginePanelState();
  if (seed === null) st.startedAt = startedAt;
  piStates.set(id, st);
  prune(piStates);
}

export function dshDetailState(id: string): DshPanelState | null {
  return dshStates.get(id) ?? null;
}

export function piDetailState(id: string): EnginePanelState | null {
  return piStates.get(id) ?? null;
}

/** 事件喂给 keyed 状态（接线层 engine://update 订阅逐事件调用）：已有态直接
    归约；未知 id 且 unified 快照能定位（refOf 回查）则先建再归约。回是否
    有状态消费（选中行详情 repaint 的判定）。 */
export function feedEngineUpdate(
  id: number,
  ev: EngineEvent,
  refOf: (id: string) => { kind: "dsh" | "pi"; startedAt: number } | null,
): boolean {
  const key = String(id);
  const dsh = dshStates.get(key);
  if (dsh !== undefined) {
    applyDshEvent(dsh, ev);
    return true;
  }
  const pi = piStates.get(key);
  if (pi !== undefined) {
    applyEvent(pi, ev);
    return true;
  }
  const ref = refOf(key);
  if (ref === null) return false;
  if (ref.kind === "dsh") {
    ensureDshDetail(key, ref.startedAt, null);
    const st = dshStates.get(key);
    if (st !== undefined) applyDshEvent(st, ev);
  } else {
    ensurePiDetail(key, ref.startedAt, null);
    const st = piStates.get(key);
    if (st !== undefined) applyEvent(st, ev);
  }
  return true;
}

/* ── 渲染（纯函数，只读重放） ── */

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

function metaLine(row: UnifiedRow, tokens: number, extra: string): string {
  const parts = [`#${row.id}`];
  if (extra !== "") parts.push(extra);
  if (tokens > 0) parts.push(`TOKENS ${abbrevTokens(tokens)}`);
  return parts.join(" · ");
}

/** 等待/未记录占位行（harness 详情「等待首个事件」同形）。 */
function waitRow(text: string): string {
  return `<div class="row"><span class="tstamp">--:--</span><span class="evt"><b>SYS</b> ${esc(text)}</span></div>`;
}

/** dsh 详情体：meta（#id · SESSION 短码 · TOKENS）→ FINAL 终答 → 日志流；
    终态且无积累日志（环形驻留行点击/终态后打开）只出终态摘要注记——在跑期
    打开过、已有日志的行收割后保持日志视图（连续性优先）。sessionId 有则出
    续跑钮（data-udsh-resume 由接线层切 Agent tab 回填）。 */
export function dshDetailBodyHTML(row: UnifiedRow, st: DshPanelState | null): string {
  const live = row.status === "run";
  const hasLog = st !== null && st.rows.length > 0;
  const meta = metaLine(
    row,
    st === null ? 0 : st.tokensIn + st.tokensOut,
    st !== null && st.sessionId !== null ? `SESSION ${st.sessionId.slice(0, 16)}` : "",
  );
  let body: string;
  if (!live && !hasLog) {
    body = `<div class="task-empty">${row.status === "done" ? "已完成" : "失败"} · 耗时 ${fmtElapsed(row.elapsed_ms)} · 终态为进程内驻留摘要（重启即清），飞行日志与会话号不保留</div>`;
  } else {
    const finalBlock =
      st !== null && st.finalText !== ""
        ? `<div class="dsh-final"><div class="dsh-flabel">FINAL · 终答</div><div class="dsh-fbody">${esc(st.finalText)}</div></div>`
        : "";
    const placeholder = waitRow(live ? "等待事件…（打开前已发事件不回放，终态时以摘要呈现）" : "本页未记录到日志");
    const rows =
      st !== null && st.rows.length > 0
        ? st.rows.map(dshRowHTML).join("")
        : placeholder;
    body = `${finalBlock}
    <div class="log sc-out">${rows}</div>`;
  }
  const resume =
    st !== null && st.sessionId !== null
      ? `<div class="mat-save"><button type="button" class="btn sec" data-udsh-resume="${esc(st.sessionId)}">Agent tab 续跑</button></div>`
      : "";
  return `<div class="ud-body"><div class="eng-meta">${esc(meta)}</div>
    ${body}
    ${resume}</div>`;
}

/** pi 详情体：meta（#id · 会话 uuid 短码 · TOKENS）→ 会话式日志流；续聊回
    Agent tab（单实例面板是唯一写入口，data-upi-open 由接线层切 tab）。 */
export function piDetailBodyHTML(row: UnifiedRow, st: EnginePanelState | null): string {
  const meta = metaLine(
    row,
    st === null ? 0 : st.tokensIn + st.tokensOut,
    st !== null && st.sessionUuid !== null ? `SESSION ${st.sessionUuid.slice(0, 8)}` : "",
  );
  const rows =
    st !== null && st.rows.length > 0
      ? st.rows.map(engRowHTML).join("")
      : waitRow(row.status === "run" ? "等待事件…（打开前已发事件不回放）" : "本页未记录到日志");
  return `<div class="ud-body"><div class="eng-meta">${esc(meta)}</div>
    <div class="log sc-out">${rows}</div>
    <div class="mat-save"><button type="button" class="btn sec" data-upi-open="1">Agent tab 续聊</button></div></div>`;
}
