/* 提示词库（R10-A A2）纯逻辑：存储是 tasksdb prefs（Tauri）/localStorage
   （浏览器）里的 JSON `[{id,name,body}]`，存取适配在 main.ts；此处只有
   解析/序列化/展示与面板选中判定。无 DOM、无运行时 import，node 断言
   脚本直跑（同 sessions.ts 惯例）。 */

export interface PromptItem {
  id: string;
  name: string;
  body: string;
}

/** 读侧边界解析：null/空/坏 JSON/非数组 → []；元素须三字段皆 string 且
   name trim 非空（trim 后的 name 即列表名），坏行丢弃不炸整库。 */
export function parsePrompts(raw: string | null): PromptItem[] {
  if (raw === null || raw.trim() === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: PromptItem[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.body !== "string") continue;
    const name = r.name.trim();
    if (name === "") continue;
    out.push({ id: r.id, name, body: r.body });
  }
  return out;
}

export function serializePrompts(list: PromptItem[]): string {
  return JSON.stringify(list);
}

/** body 首个非空行（trim）：列表预览与面板 desc 同源，全空白 body 出空串。 */
export function promptFirstLine(body: string): string {
  return body.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

/** @面板 desc：本地提示词 · 首行截 30 字（区别于 @技能 的 load_skill 机制，
   面板即注明是本地纯文本展开）。 */
export function promptDesc(body: string): string {
  const line = promptFirstLine(body);
  if (line === "") return "本地提示词";
  return `本地提示词 · ${line.slice(0, 30)}${line.length > 30 ? "…" : ""}`;
}

/** 添加/编辑提交判定：name trim 非空且不以 @ 起（@ 由面板拼，名字自带会
   产出 @@x 触发词）。 */
export function promptNameOk(name: string): boolean {
  const t = name.trim();
  return t !== "" && !t.startsWith("@");
}

/** @面板选中落值（R10-A：@提示词 项=插入不发送）：trigger 精确命中提示词 →
    返回 body（整框 @token 被 body 替换——面板只在输入=单个 @token 时弹，
    token 即全部内容——光标落 body 末尾续写）；内置触发词优先（同名提示词
   不劫持 @知识库 等路由）；未命中返回 null，走默认 trigger+空格。近撞词
   纪律同 @资料：精确等值比较，"@翻译学" 不命中提示词 "翻译"。 */
export function atAcceptValue(
  trigger: string,
  prompts: PromptItem[],
  builtinTriggers: readonly string[],
): string | null {
  if (builtinTriggers.includes(trigger)) return null;
  const p = prompts.find((x) => `@${x.name}` === trigger);
  return p === undefined ? null : p.body;
}
