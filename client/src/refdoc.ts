/* @资料（R9-D D1）/@知识库（R9-D D2）的纯解析/渲染逻辑：无 DOM、无 import，
   node 断言脚本直跑（同 material.ts 惯例）。@资料 消息形态：`@资料 <URL 或
   文本段>` + 空行 + 问题段，资料段含跨行（粘贴长文）；URL 形态 = 整段 trim 后
   单个 http(s) 链接。@知识库 消息形态：`@知识库 <问题>`（资料在 hub，发送时
   检索注入，本地只存问题）。KbHit 形状即 hub /kb/search 契约，api.ts 引用。 */

/** 与 Rust fetch_page 同限：资料段（含抓取结果）256K 字节上限。 */
export const REF_MAX_BYTES = 256 * 1024;

export interface AtRefCommand {
  ref: string;
  question: string;
}

/** @资料 前缀解析：无 @资料 前缀、或前缀后不是空白（@生图/@资料库 等近撞词）
    返回 null 交回原路径。资料段 = 首行 @资料 后内容到首个空行（含跨行），
    空行后全部 = 问题段；无空行、问题段空或资料段空 → null（调用方出用法提示）。 */
export function parseAtRef(text: string): AtRefCommand | null {
  if (!text.startsWith("@资料")) return null;
  const rest = text.slice(3);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const sep = /\n[ \t]*\n/.exec(rest);
  if (sep === null) return null;
  const ref = rest.slice(0, sep.index).trim();
  const question = rest.slice(sep.index + sep[0].length).trim();
  if (ref === "" || question === "") return null;
  return { ref, question };
}

/** 资料段是否 URL 形态：整段 trim 后单个 http(s) 链接（无空白）→ 走 fetch_page。 */
export function refIsUrl(ref: string): boolean {
  return /^https?:\/\/\S+$/i.test(ref.trim());
}

/** 资料段是否超 256K 字节（UTF-8 计）：粘贴文本拒发提示；抓取结果 Rust 侧已
    截断，此处同规则兜底。 */
export function refOverLimit(s: string): boolean {
  return new TextEncoder().encode(s).length > REF_MAX_BYTES;
}

/** 文本附件扩展名白名单（R11-B U3 通用附件）：仅按扩展名分型（MIME 在拖放
    场景常缺失），大小写不敏感；未列出/无扩展名/点文件 → 二进制拒收路径。 */
const TEXT_FILE_EXTS: ReadonlySet<string> = new Set(
  ["txt", "md", "json", "csv", "log", "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "h", "html", "css", "xml", "yml", "yaml", "toml", "ini", "sh", "ps1", "bat"].map((e) => e.toUpperCase()),
);

export function isTextFile(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return false;
  return TEXT_FILE_EXTS.has(name.slice(i + 1).toUpperCase());
}

/** 待发文本附件（读成字符串，发送时并入本轮资料前缀）。 */
export interface RefFile {
  name: string;
  text: string;
}

/** 文本附件 → 本轮资料前缀（R11-B U3）：与 @资料 同头「以下是一份参考
    资料：」，多文件多段 `[文件名]\n内容` 以空行拼接，空行后接问题段；
    refText 供折叠条（meta.refLen = refText.length，@资料 同语义）。 */
export function refFilesPayload(files: RefFile[], question: string): { content: string; refText: string } {
  const refText = files.map((f) => `[${f.name}]\n${f.text}`).join("\n\n");
  return { content: `以下是一份参考资料：\n${refText}\n\n${question}`, refText };
}

/** @知识库 前缀解析（R9-D D2）：`@知识库 <问题>`，问题可跨行。无前缀、前缀后
    不是空白（@知识库x 等近撞词）或问题空 → null 交回原路径。 */
export interface AtKbCommand {
  question: string;
}

export function parseAtKb(text: string): AtKbCommand | null {
  if (!text.startsWith("@知识库")) return null;
  const rest = text.slice(4);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  const question = rest.trim();
  if (question === "") return null;
  return { question };
}

/** /kb/search 命中段（与 hub 契约逐字一致，api.ts decode 后透传到渲染层）。 */
export interface KbHit {
  docId: string;
  title: string;
  seq: number;
  text: string;
  score: number;
}

/** @知识库 检索条数 k（R10-A A1）：prefs "kb.k" 存字符串，1-10 默认 4。 */
export const KB_K_DEFAULT = 4;

/** k 读取边界：缺失/空/非数回默认；越界钳到 1-10 端点（存侧脏值不炸发送路径）。 */
export function kbKOf(raw: string | null): number {
  if (raw === null || raw.trim() === "") return KB_K_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return KB_K_DEFAULT;
  return Math.min(10, Math.max(1, Math.round(n)));
}

/** 命中分组（R10-A A1）：docId 首见序为组序，组内保持命中序（score 降序由
    hub 检索保证，此处不重排）；title 取组内首段（同文档 title 相同）。 */
export interface KbHitGroup {
  docId: string;
  title: string;
  hits: KbHit[];
}

export function kbHitGroups(hits: KbHit[]): KbHitGroup[] {
  const out: KbHitGroup[] = [];
  const byId = new Map<string, KbHitGroup>();
  for (const h of hits) {
    let g = byId.get(h.docId);
    if (g === undefined) {
      g = { docId: h.docId, title: h.title, hits: [] };
      byId.set(h.docId, g);
      out.push(g);
    }
    g.hits.push(h);
  }
  return out;
}

/** 展开态跨重绘保持的键（docId:seq 列表）：折叠条 data-refkey 与渲染层查
    refOpen 集合同源，不依赖 DOM textContent 拼接。 */
export function kbHitsKey(hits: KbHit[]): string {
  return hits.map((h) => `${h.docId}:${h.seq}`).join("|");
}

/** historyWith 回灌降级（R9-D 语义：资料/检索段单轮即弃）：meta.refLen 标记的
    @资料 与 meta.kbHits 标记的 @知识库 消息只回灌问题段（命中段落不回灌）；
    非标记或解析失败原样返回。 */
export function refQuestionOf(content: string, meta?: { refLen?: number; kbHits?: KbHit[] }): string {
  if (meta?.refLen !== undefined) return parseAtRef(content)?.question ?? content;
  if (meta?.kbHits !== undefined) return parseAtKb(content)?.question ?? content;
  return content;
}

const REF_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** @资料 折叠条（克制风文字不用 emoji）：`[资料 · N 字]` + data-ref-toggle
    展开/收起；展开态 <pre> 载资料全文（转义，mono 由样式层挂）。 */
export function refCollapsedHTML(ref: string, n: number, open = false): string {
  const body = ref.replace(/[&<>"']/g, (c) => REF_ESC[c]);
  return `<div class="refmsg"><div class="refbar" data-ref-toggle="1" role="button" tabindex="0">[资料 · ${n} 字] <span class="refop">${open ? "收起" : "展开"}</span></div><pre class="refpre"${open ? "" : " hidden"}>${body}</pre></div>`;
}

/** @知识库 折叠条（R9-D D2 起，R10-A A1 升级分组）：`[知识库 · 命中 N 段]`，
    展开按文档聚组——组头 title + 组内段落行（text + score 两位小数，全文
    转义；title 不再逐段重复）。容器沿用 refpre 类，data-ref-toggle 处理器零
    改动即可开合；键挂 data-refkey（见 kbHitsKey）。 */
export function kbCollapsedHTML(hits: KbHit[], open = false): string {
  const groups = kbHitGroups(hits)
    .map(
      (g) =>
        `<div class="kbdoc"><div class="kbdoc-h">${g.title.replace(/[&<>"']/g, (c) => REF_ESC[c])}</div>${g.hits
          .map(
            (h) =>
              `<div class="kbhit"><div class="kbtext">${h.text.replace(/[&<>"']/g, (c) => REF_ESC[c])}</div><div class="kbsrc">${h.score.toFixed(2)}</div></div>`,
          )
          .join("")}</div>`,
    )
    .join("");
  return `<div class="refmsg"><div class="refbar" data-ref-toggle="1" data-refkey="${kbHitsKey(hits).replace(/[&<>"']/g, (c) => REF_ESC[c])}" role="button" tabindex="0">[知识库 · 命中 ${hits.length} 段] <span class="refop">${open ? "收起" : "展开"}</span></div><div class="refpre kbhits"${open ? "" : " hidden"}>${groups}</div></div>`;
}
