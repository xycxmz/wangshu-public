/* 消息正文富渲染（R9-A A2）：marked + highlight.js 按需子集。
   纯字符串进出、无 DOM 依赖，node 断言脚本可直接复用（纪律同 material.ts）。
   XSS 双层防护：渲染层把 markdown 里的原始 HTML 转义成可见文本（不给可执行
   标签留直出通道）；输出层再逐标签滤 on* 事件属性与 javascript:/vbscript:
   及非 img 的 data: 协议——marked 18 实测不拦 javascript: 链接，第二层是
   承重墙不是保险带。 */

import { Marked } from "marked";
import type { Tokens } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cppLang from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

/* 12 常用语言按需注册（ts/js/py/rs/sh/html/c++ 等别名由语言定义自带，
   shell 显式补注）。未注册语言回落纯文本。 */
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cppLang);
hljs.registerAliases(["shell"], { languageName: "bash" });

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

/** hljs 高亮：返回带 span 的 HTML（代码本体已转义）；未注册语言回落纯转义文本。 */
export function highlightCode(code: string, lang?: string): string {
  const name = (lang ?? "").trim().toLowerCase();
  if (name !== "" && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch {
      // 语法文件对个别输入抛错时回落纯文本，不让流式渲染断流
    }
  }
  return escapeHTML(code);
}

/** 围栏首行语言标记：短标识（字母数字与 _ + . -）才认，返回小写；空串=无语言。 */
export function fenceLanguage(line: string): string {
  return /^[A-Za-z0-9_+.-]{1,20}$/.test(line) ? line.toLowerCase() : "";
}

/** 围栏代码块容器：语言标签 + hljs 高亮 pre + 复制钮（main.ts 以 data-copy-code 委托）。 */
export function renderCodeBlock(code: string, lang?: string): string {
  const label = (lang ?? "").trim().toLowerCase();
  return `<div class="codeblk"><div class="cb-bar"><span class="cb-lang">${escapeHTML(label || "text")}</span><button type="button" class="cb-copy" data-copy-code>复制</button></div><pre class="cb-pre"><code>${highlightCode(code, label)}</code></pre></div>`;
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // 第一层防护：markdown 里的原始 HTML（含 <script>/<img onerror>）一律转义为可见文本
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHTML(text);
    },
  },
});

/** 第二层防护：逐标签剥 on* 事件属性与危险协议 URL；<a> 统一补新窗口语义
    （防 Tauri 主 webview 被带离应用）。只动真标签内部，可见文本不受影响。 */
function sanitizeTags(html: string): string {
  return html.replace(/<([a-zA-Z][^\s/>]*)([^>]*)>/g, (tag, name: string, attrs: string) => {
    const cleaned = attrs
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(\s(?:href|src)\s*=\s*)("[^"]*"|'[^']*')/gi, (attr, _lead: string, quoted: string) => {
        const url = quoted.slice(1, -1).trim();
        if (/^(?:javascript|vbscript):/i.test(url)) return "";
        // data: 仅图片放行（正文里图片内联 dataURL 是 A1 形态；其余 data: 载荷不给入口）
        if (/^data:/i.test(url) && name.toLowerCase() !== "img") return "";
        return attr;
      });
    if (cleaned === attrs && name.toLowerCase() !== "a") return tag;
    const anchorAttrs =
      name.toLowerCase() === "a" && !/\starget\s*=/i.test(cleaned)
        ? `${cleaned} target="_blank" rel="noreferrer"`
        : cleaned;
    return `<${name}${anchorAttrs}>`;
  });
}

/** 正文富渲染入口：text 段经 marked（GFM 表格/列表），双层防护后输出 HTML。 */
export function renderRich(content: string): string {
  return sanitizeTags(md.parse(content, { async: false }));
}
