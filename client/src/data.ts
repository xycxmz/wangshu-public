/* 壳层静态数据 + 任务域演示数据。
   对话域走 hub 实数据（api.ts / main.ts）；任务域在 Tauri 内走 harness 实数据、
   素材走 hub 实数据（main.ts）。本文件的任务域导出（taskHeader / telemetry /
   flightLog / hold / holdActions）仅作为非 Tauri 环境「内置」tab 的静态示例。 */

/** 顶栏 A/B 只用 chat|task；settings 是 rail 04 的第三视图（非对话域）。 */
export type DomainId = "chat" | "task" | "assets" | "settings";

export interface DomainSwitch {
  id: Exclude<DomainId, "settings">;
  label: string;
}

export interface RailSection {
  no: string;
  name: string;
  // 工作域分区（01/02）带域归属并参与联动；04=设置视图（平台组）；03 暂无目标视图
  domain: DomainId | null;
  group: "work" | "platform";
}

export interface TelemetryCell {
  label: string;
  value: string;
  unit?: string; // 遥测大数字的单位小字（如 k）
  readout?: boolean; // 在走的量才有闪烁光标
  compact?: boolean; // 非量值长串（AGENT 格）降字号对齐
}

export interface LogRow {
  stamp: string;
  event: string; // 状态词加粗
  rest: string;
  tone?: "ok" | "hold"; // read 免批绿 / write 橙；缺省墨色
}

export interface DiffLine {
  kind: "add" | "del";
  text: string;
}

export interface HoldBlock {
  desc: string;
  diff: DiffLine[];
}

export const brand = "望舒";

export const domains: DomainSwitch[] = [
  { id: "chat", label: "对话" },
  { id: "task", label: "任务" },
];

export const railFoot = "MISSION LOG · CP-0031";

export const railSections: RailSection[] = [
  { no: "01", name: "对话", domain: "chat", group: "work" },
  { no: "02", name: "任务", domain: "task", group: "work" },
  { no: "03", name: "资产", domain: "assets", group: "platform" },
  { no: "04", name: "设置", domain: "settings", group: "platform" },
];

export const taskHeader = {
  phase: "PHASE 2/4 · COLLECT",
  title: "梳理 docs 并生成周报",
  live: "RUNNING",
};

export const telemetry: TelemetryCell[] = [
  { label: "STEPS", value: "14", readout: true },
  { label: "TOKENS", value: "38.2", unit: "k", readout: true },
  { label: "COST", value: "¥0.42", readout: true },
  { label: "ELAPSED", value: "04:12", readout: true },
  { label: "AGENT", value: "assistant-rs", compact: true },
];

export const flightLog: LogRow[] = [
  { stamp: "T+00:00", event: "TASK START", rest: " · 输入：汇总本周 docs 变更，产出周报草稿" },
  { stamp: "T+00:41", event: "PLAN", rest: " · 4 阶段计划已登记：collect → draft → review → deliver" },
  { stamp: "T+01:02", event: "TOOL read", rest: " docs/*.md · 23 文件 · 免批（信任目录）", tone: "ok" },
  { stamp: "T+03:44", event: "TOOL write", rest: " docs/roadmap.md · 写操作 · 进入 HOLD 待审批", tone: "hold" },
];

export const hold: HoldBlock = {
  desc: "写 docs/roadmap.md · 1 处变更 · 写前备份已建立",
  diff: [
    { kind: "del", text: "里程碑：M2 素材生成接入（P2）" },
    { kind: "add", text: "里程碑：M2 素材生成接入（P2，改走 REST 消费方方案）" },
    { kind: "add", text: "预算：素材生成走独立预算池，与对话用量分账" },
  ],
};

export const holdActions = ["批准写入", "拒绝"];
