/* 用量仪表盘纯数据模块（R9-B B3）：无 DOM、无运行时 import（api 仅 type import），
   node 断言脚本可直接编译复用。行形状 = api.ts UsageRow（hub /usage 的
   date 为 YYYY-MM-DD，与本地日字符串等值即同天）。 */

import type { UsageRow } from "./api";

export interface UsageDayBar {
  date: string;
  cents: number;
}

export interface UsageModelRow {
  model: string;
  requests: number;
  cents: number;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 近 14 天（含今天）按天聚合 cents，零天补 0；顺序旧→新（柱图左→右）。
    now 可注入，跨天/跨月边界可断言。 */
export function usageBars(rows: UsageRow[], now = new Date()): UsageDayBar[] {
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (r.date === "") continue;
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.costCents);
  }
  const out: UsageDayBar[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    out.push({ date, cents: byDate.get(date) ?? 0 });
  }
  return out;
}

/** 按模型聚合 requests/cents，cents 降序（并列按 requests 降序、模型名升序，
    排序确定可断言）。 */
export function usageByModel(rows: UsageRow[]): UsageModelRow[] {
  const byModel = new Map<string, UsageModelRow>();
  for (const r of rows) {
    if (r.modelName === "") continue;
    const cur = byModel.get(r.modelName) ?? { model: r.modelName, requests: 0, cents: 0 };
    cur.requests += r.requests;
    cur.cents += r.costCents;
    byModel.set(r.modelName, cur);
  }
  return [...byModel.values()].sort(
    (a, b) => b.cents - a.cents || b.requests - a.requests || (a.model < b.model ? -1 : 1),
  );
}
