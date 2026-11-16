/* 系统遥测（右栏心跳条）：5s 轮询 hub /healthz 测 RTT，20 样本环形缓冲。
   aside 每次重渲染都会重建容器，探针每 tick 用 getElementById 重挂，不做状态耦合。 */

import { hubUrl } from "./api";

const SAMPLES = 20;
const POLL_MS = 5000;
const RTT_CAP_MS = 400;

let ring: number[] = [];
let lastRtt = -1;
let timer: number | undefined;
/* 健康钩子（R6-A#5）：连续 5 次探测失败 → outage 上抛 false；恢复 → true。
   消费方（main.ts）据此驱动托盘 warn 态。 */
let consecutiveFails = 0;
let outage = false;
let healthHook: ((ok: boolean) => void) | null = null;

export function onHubHealth(fn: (ok: boolean) => void): void {
  healthHook = fn;
}

function barHeight(rtt: number): number {
  if (rtt < 0) return 3;
  return Math.max(3, Math.round((Math.min(rtt, RTT_CAP_MS) / RTT_CAP_MS) * 100));
}

function render(): void {
  const el = document.getElementById("sysprobe");
  if (!el) return;
  el.hidden = false;
  const bars = ring
    .map((r) => `<i style="height:${barHeight(r)}%"></i>`)
    .join("");
  const cap = lastRtt >= 0 ? `hub ${lastRtt}ms` : "hub 不可达";
  el.innerHTML =
    `<h4>系统遥测 · SYSTEM</h4>` +
    `<div class="bars">${bars}</div>` +
    `<div class="cap"><span>轮询 5s</span><b>${cap}</b></div>`;
}

async function probe(): Promise<void> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${hubUrl()}/healthz`, { cache: "no-store" });
    lastRtt = res.ok ? Math.round(performance.now() - t0) : -1;
  } catch {
    lastRtt = -1;
  }
  consecutiveFails = lastRtt >= 0 ? 0 : consecutiveFails + 1;
  if (outage && lastRtt >= 0) {
    outage = false;
    healthHook?.(true);
  } else if (!outage && consecutiveFails >= 5) {
    outage = true;
    healthHook?.(false);
  }
  ring.push(lastRtt);
  if (ring.length > SAMPLES) ring.shift();
  render();
}

export function mountHubProbe(): void {
  if (timer !== undefined) return;
  timer = window.setInterval(() => void probe(), POLL_MS);
  void probe();
}
