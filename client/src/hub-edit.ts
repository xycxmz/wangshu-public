/* HUB 地址内联编辑（ui-review 2026-11-12 P1-10），替代 window.prompt——
   macOS WKWebView 的 prompt 静默返回 null，两处入口直接失效。
   设置页与登录页共用：行内 URL 文本（[data-hub-url]）原位换 mono 输入 +
   「保存」小钮；Enter/保存提交 setHubUrl 后整页重载，Esc/失焦取消还原。
   提交判定 hubEditDecision 为纯函数，node 原生剥类型断言直接覆盖
   （scripts/reload.test.ts 惯例；对 ./api.ts 用显式后缀导入正是为此）。 */

import { hubUrl, setHubUrl } from "./api.ts";

/** 提交判定：空白或与当前同值 → skip（不重载），仅实际不同的值 apply。 */
export function hubEditDecision(current: string, next: string): "apply" | "skip" {
  const v = next.trim();
  return v !== "" && v !== current ? "apply" : "skip";
}

/** 开始行内编辑。line = .hubline 行容器（内含 [data-hub-url] 与「修改」钮）。 */
export function beginInlineHubEdit(line: HTMLElement): void {
  const urlEl = line.querySelector<HTMLElement>("[data-hub-url]");
  if (!(urlEl instanceof HTMLElement) || line.querySelector(".hub-edit-in") !== null) return;
  const current = hubUrl();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "hub-edit-in";
  input.value = current;
  input.setAttribute("aria-label", "HUB 地址（含协议与端口）");
  input.spellcheck = false;
  // 同宽：量被替换文本的渲染宽，下限 260 保证长地址可编辑
  input.style.width = `${Math.max(260, Math.round(urlEl.getBoundingClientRect().width))}px`;
  const editBtn = line.querySelector<HTMLButtonElement>("button");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn sec";
  save.textContent = "保存";
  // mousedown 吞默认焦点转移：点「保存」不先触发输入框失焦取消
  save.addEventListener("mousedown", (ev) => ev.preventDefault());
  save.addEventListener("click", () => commit());
  urlEl.replaceWith(input);
  if (editBtn) editBtn.hidden = true;
  editBtn?.after(save);
  input.focus();
  input.select();
  let settled = false;
  const restore = (): void => {
    if (settled) return;
    settled = true;
    input.replaceWith(urlEl);
    save.remove();
    if (editBtn) editBtn.hidden = false;
  };
  const commit = (): void => {
    if (settled) return;
    if (hubEditDecision(current, input.value) === "skip") {
      restore();
      return;
    }
    settled = true;
    setHubUrl(input.value.trim());
    location.reload();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      restore();
    }
  });
  input.addEventListener("blur", () => restore());
}
