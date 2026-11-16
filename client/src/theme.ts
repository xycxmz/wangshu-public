/* 主题（浅色拍板：Flight Console 浅色版 + 跟随系统可覆盖）。
   cp.theme: "light"|"dark"|缺省=auto（prefers-color-scheme）。
   localStorage 同步读，启动期先于渲染应用避免闪色。 */

export type ThemeChoice = "auto" | "light" | "dark";
const KEY = "cp.theme";

export function readTheme(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

export function writeTheme(t: ThemeChoice): void {
  if (t === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, t);
  applyTheme();
}

const mq = window.matchMedia("(prefers-color-scheme: light)");

function resolved(): "light" | "dark" {
  const t = readTheme();
  return t === "auto" ? (mq.matches ? "light" : "dark") : t;
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = resolved();
}

/** 启动调用一次：立即应用 + auto 态跟随系统变化。 */
export function initTheme(): void {
  applyTheme();
  mq.addEventListener("change", () => {
    if (readTheme() === "auto") applyTheme();
  });
}
