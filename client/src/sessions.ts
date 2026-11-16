/* 会话行操作的纯逻辑：行内改名提交判定 + 两步删除确认状态机。
   无 DOM、无运行时 import，node 断言脚本可直接编译复用（同 material.ts 惯例）。 */

/** 行内改名判定：trim 后非空且与原标题不同才提交；清空/纯空白/未改动一律取消。 */
export function renameDecision(original: string, input: string): "submit" | "cancel" {
  const t = input.trim();
  return t !== "" && t !== original ? "submit" : "cancel";
}

/** 两步删除确认状态：sid=null 空闲；武装行记 sid 与武装时刻。 */
export interface ArmState {
  sid: string | null;
  at: number;
}

/** 行尾更新时刻短格式（P2-14）：今天 HH:MM，其他天只示 MM-DD
    （列表已按天分组带日期头，且 materialTime 的跨天全宽 MM-DD HH:MM 塞不进 264px 行）；
    非法/缺失输入回落既有缺时占位。 */
export function sessionTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const ARM_WINDOW_MS = 3000;

/** 删除钮点击转移：未武装/已出窗/换行 → 武装该行（不执行）；同行窗口内再点 → 执行并复位。 */
export function armClick(
  s: ArmState,
  sid: string,
  now: number,
  windowMs = ARM_WINDOW_MS,
): { run: boolean; next: ArmState } {
  const live = s.sid === sid && now - s.at <= windowMs;
  return live ? { run: true, next: { sid: null, at: 0 } } : { run: false, next: { sid, at: now } };
}

/** 武装是否已出窗（计时器到点判定；空态恒真，复位幂等）。与 armClick 的窗口边界一致（含端点）。 */
export function armExpired(s: ArmState, now: number, windowMs = ARM_WINDOW_MS): boolean {
  return s.sid === null || now - s.at > windowMs;
}
