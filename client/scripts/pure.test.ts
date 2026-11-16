/* sessions / material / desktop-only / env 四纯模块的 node 断言（node 24 原生剥类型直跑，
   同 reload.test.ts 惯例）：把模块头注释声称的「可断言复用」落成实有覆盖，
   钉的是可观察行为（输出与边界），不钉实现。 */

import assert from "node:assert/strict";
import {
  armClick,
  armExpired,
  ARM_WINDOW_MS,
  renameDecision,
  sessionTime,
} from "../src/sessions.ts";
import {
  materialBadge,
  materialErrLine,
  materialExampleChipsHTML,
  materialTime,
  materialTitle,
  materialUsageLine,
  materialUsageOf,
  parseAtImage,
} from "../src/material.ts";
import { usageBars, usageByModel } from "../src/usagechart.ts";
import { asideEmptyText, demoTagHTML, desktopOnlyNote } from "../src/desktop-only.ts";
import { ENV_INSTALL_HINTS, envAreaHTML, envCardHTML, envLogHTML } from "../src/env.ts";
import {
  fenceLanguage,
  highlightCode,
  renderCodeBlock,
  renderRich,
} from "../src/markdown.ts";
import type { UsageRow } from "../src/api.ts";
import {
  PARALLEL_MAX,
  PARALLEL_MIN,
  highlightSnippet,
  mcpRowHTML,
  parallelCellHTML,
  parallelColClass,
  parallelFootLine,
} from "../src/parallel.ts";
import type { ParallelCellView } from "../src/parallel.ts";
import {
  KB_K_DEFAULT,
  REF_MAX_BYTES,
  isTextFile,
  kbCollapsedHTML,
  kbHitGroups,
  kbKOf,
  parseAtKb,
  parseAtRef,
  refCollapsedHTML,
  refFilesPayload,
  refIsUrl,
  refOverLimit,
  refQuestionOf,
} from "../src/refdoc.ts";
import {
  atAcceptValue,
  parsePrompts,
  promptDesc,
  promptFirstLine,
  promptNameOk,
  serializePrompts,
} from "../src/prompts.ts";
import { exportFilename, exportFoldPage, sessionToMarkdown } from "../src/exportmd.ts";
import type { MessageRow } from "../src/api.ts";
import {
  decodeScheduleList,
  fmtSchedulePlan,
  parseSchedValue,
  parseSchedWebhook,
  parseTemplates,
  schedBadge,
  schedDetailBodyHTML,
  schedRowHTML,
  schedTime,
  serializeTemplates,
  templateNameOf,
} from "../src/sched.ts";
import type { ScheduleRow } from "../src/sched.ts";
import {
  BOARD_COLUMNS,
  badgeCountsOf,
  boardColumnOf,
  boardHTML,
  decodeTasksUnified,
  fmtElapsed,
  harnessRowOf,
  kindBadge,
  materialRowOf,
  mergeUnifiedRows,
  unifiedLiveBadge,
  unifiedRowHTML,
  unifiedStatusBadge,
  unifiedTime,
  unifiedTitle,
} from "../src/tasksview.ts";
import type { UnifiedRow, UnifiedStatus } from "../src/tasksview.ts";
import { kbRebuildHint } from "../src/api.ts";
import { costCellText, estimateCostCents } from "../src/cost.ts";

/* ── sessions.renameDecision：trim 非空且与原标题不同才提交 ── */
assert.equal(renameDecision("旧名", "新名"), "submit");
assert.equal(renameDecision("旧名", ""), "cancel", "清空取消");
assert.equal(renameDecision("旧名", "   "), "cancel", "纯空白取消");
assert.equal(renameDecision("旧名", "旧名"), "cancel", "未改动取消");
assert.equal(renameDecision("旧名", " 旧名 "), "cancel", "trim 后未变取消");
assert.equal(renameDecision("旧名", " 新名 "), "submit", "trim 后有变提交");

/* ── sessions.sessionTime：今天 HH:MM，跨天 MM-DD，非法回落占位 ── */
const NOW = new Date(2026, 10, 14, 20, 0); // 2026-11-14 20:00 本地
assert.equal(sessionTime("2026-11-14T09:05:00", NOW), "09:05", "同天只显时分");
assert.equal(sessionTime("2026-11-13T23:59:00", NOW), "11-13", "跨天只显月日");
assert.equal(sessionTime("not-a-date", NOW), "--:--", "非法输入占位");

/* ── sessions 两步删除状态机：首点武装、窗口内再点执行、换行/出窗重武装 ── */
const idle = { sid: null, at: 0 };
const a1 = armClick(idle, "s1", 1000);
assert.equal(a1.run, false, "空闲首点只武装");
assert.deepEqual(a1.next, { sid: "s1", at: 1000 });
const a2 = armClick(a1.next, "s1", 1000 + ARM_WINDOW_MS);
assert.equal(a2.run, true, "同行窗口内再点执行");
assert.deepEqual(a2.next, idle, "执行后复位");
const b1 = armClick(a1.next, "s2", 1500);
assert.equal(b1.run, false, "换行重新武装不执行");
assert.deepEqual(b1.next, { sid: "s2", at: 1500 });
const c1 = armClick(a1.next, "s1", 1000 + ARM_WINDOW_MS + 1);
assert.equal(c1.run, false, "出窗后重武装");

/* armExpired 与 armClick 窗口边界一致（含端点：差恰等于窗口仍在窗内） */
assert.equal(armExpired(idle, 0), true, "空态恒真");
assert.equal(armExpired({ sid: "s1", at: 1000 }, 1000 + ARM_WINDOW_MS), false, "端点在窗内");
assert.equal(armExpired({ sid: "s1", at: 1000 }, 1000 + ARM_WINDOW_MS + 1), true, "超窗出");

/* ── material 展示面 ── */
assert.deepEqual(materialBadge("succeeded"), { word: "DONE", cls: "dn" });
assert.deepEqual(materialBadge("failed"), { word: "FAIL", cls: "fl" });
assert.deepEqual(materialBadge("pending"), { word: "RUN", cls: "run" });
assert.deepEqual(materialBadge("running"), { word: "RUN", cls: "run" });

const LONG_PROMPT = "冷白纸面上的任务报告封面设计与信号橙细节渲染";
assert.equal(LONG_PROMPT.length, 22, "测试串自身超 20 字");
assert.equal(materialTitle(LONG_PROMPT), LONG_PROMPT.slice(0, 20) + "…", "超 20 字截断");
assert.equal(materialTitle("短题"), "短题");
assert.equal(materialTitle("  多   空白\n折叠  "), "多 空白 折叠", "空白折叠");

assert.equal(materialErrLine("line1\nline2"), "line1", "多行取首行");
assert.equal(materialErrLine("x".repeat(60)), "x".repeat(48) + "…", "首行截 48");

assert.equal(materialTime("2026-11-14T08:30:00", NOW), "08:30", "同天 HH:MM");
assert.equal(materialTime("2026-11-12T08:30:00", NOW), "11-12 08:30", "跨天 MM-DD HH:MM");
assert.equal(materialTime("bad", NOW), "--:--");

/* ── material usage 聚合：material:* 各计 requests，cost 累计，其余 model 忽略 ── */
const row = (modelName: string, requests: number, costCents: number): UsageRow =>
  ({ modelName, requests, costCents }) as UsageRow;
const u = materialUsageOf([
  row("material:image", 2, 14),
  row("material:video", 1, 70),
  row("qwen3.7-plus", 9, 33), // 非 material 忽略（连 cost 也不计）
]);
assert.deepEqual(u, { imageReqs: 2, videoReqs: 1, costCents: 84 });
assert.equal(materialUsageLine(u), "素材 · 图 2 / 视频 1 · ¥0.84", "分转元两位小数");
assert.equal(materialUsageLine({ imageReqs: 0, videoReqs: 0, costCents: 7 }), "素材 · 图 0 / 视频 0 · ¥0.07");

const chips = materialExampleChipsHTML();
assert.equal((chips.match(/data-mat-example=/g) ?? []).length, 3, "三条示例 chip");
assert.ok(chips.includes("信号橙仪表盘特写"), "chip 含原文");

/* ── desktop-only 文案层 ── */
assert.equal(desktopOnlyNote("DSH 引擎"), '<div class="env-note">桌面应用 · DSH 引擎</div>');
assert.equal(
  desktopOnlyNote("资产", "本地目录"),
  '<div class="env-note">桌面应用 · 资产 · 本地目录</div>',
);
assert.equal(
  desktopOnlyNote('a<b>&c"'),
  '<div class="env-note">桌面应用 · a&lt;b&gt;&amp;c&quot;</div>',
  "feature 转义",
);
assert.equal(desktopOnlyNote("x", ""), '<div class="env-note">桌面应用 · x</div>', "空 hint 不留尾缀");
assert.equal(demoTagHTML(), '<span class="demo-tag">示例 · 不可交互</span>');
assert.equal(asideEmptyText(true), "尚未发起任务");
assert.equal(asideEmptyText(false), "尚未发起任务（示例数据不进任务列）");

/* ── env 检测卡：三态渲染 / 分区占位与重检 / hint 注入 ── */
const readyCard = envCardHTML({ engine: "pi", available: true, path: "C:\\tools\\pi.cmd", versionHint: "1.6.2" });
assert.ok(readyCard.includes('<span class="st dn mono">READY</span>'), "可用卡 READY 徽标");
assert.ok(readyCard.includes('<span class="lbl">pi</span>'), "可用卡含引擎名");
assert.ok(readyCard.includes('<span class="mono">1.6.2</span>'), "可用卡版本显原文");
assert.ok(readyCard.includes("C:\\tools\\pi.cmd"), "可用卡路径 mono 小字");
assert.ok(!readyCard.includes("data-env-copy"), "可用卡不出复制钮");
assert.ok(!readyCard.includes("npm install"), "可用卡不出安装命令");

const missCard = envCardHTML({ engine: "dsh", available: false, path: null, versionHint: null });
assert.ok(missCard.includes('<span class="st fl mono">MISS</span>'), "缺失卡 MISS 徽标");
assert.ok(missCard.includes("<span class=\"mono\">—</span>"), "缺失卡缺版本显 —");
assert.ok(missCard.includes("npm install -g @deepseek-ai/dsh"), "缺失卡注入 dsh 安装命令");
assert.ok(missCard.includes('data-env-copy="dsh"'), "复制钮 data 属性带引擎名");
assert.ok(missCard.includes(">复制</button>"), "缺失卡出复制钮");
assert.ok(missCard.includes("prerelease 渠道 · node ≥24.9"), "缺失卡出门槛说明");

const readyNoVersion = envCardHTML({ engine: "pi", available: true, path: null, versionHint: null });
assert.ok(readyNoVersion.includes("READY"), "已装但拿不到版本仍 READY");
assert.ok(readyNoVersion.includes("<span class=\"mono\">—</span>"), "缺 versionHint 显 — 占位");
assert.equal((readyNoVersion.match(/class="hubline"/g) ?? []).length, 1, "缺路径只出徽标一行");
assert.ok(!readyNoVersion.includes("npm install"), "可用卡不出安装命令");

const piMiss = envCardHTML({ engine: "pi", available: false, path: null, versionHint: null });
assert.ok(piMiss.includes("npm install -g @mariozechner/pi-coding-agent"), "pi 缺失卡注入 pi 命令");

const unknownMiss = envCardHTML({ engine: "nope", available: false, path: null, versionHint: null });
assert.ok(unknownMiss.includes("MISS"), "未知引擎缺失仍出徽标");
assert.ok(!unknownMiss.includes("data-env-copy"), "无指引引擎不出安装命令");

const escCard = envCardHTML({ engine: "a<b>&", available: true, path: 'x"y', versionHint: "1.6<script>" });
assert.ok(escCard.includes('<span class="lbl">a&lt;b&gt;&amp;</span>'), "引擎名转义");
assert.ok(escCard.includes("x&quot;y"), "路径转义");
assert.ok(escCard.includes("1.6&lt;script&gt;"), "版本转义");
assert.ok(!escCard.includes("<script>"), "版本无原生注入");

assert.equal(envAreaHTML(null), '<div class="setd">检测中…</div>', "null 出检测中占位");
const envArea = envAreaHTML([
  { engine: "pi", available: true, path: "C:\\pi.cmd", versionHint: "1.6.2" },
  { engine: "dsh", available: false, path: null, versionHint: null },
]);
assert.equal((envArea.match(/<span class="lbl">/g) ?? []).length, 2, "数组态两引擎各一卡");
assert.ok(envArea.includes('id="env-recheck"'), "数组态尾部重检按钮");
assert.ok(envArea.includes("重新检测"), "重检按钮文案");
assert.ok(envArea.includes("npm install -g @deepseek-ai/dsh"), "分区注入缺失引擎安装命令");
assert.ok(!envArea.includes("@mariozechner/pi-coding-agent"), "可用引擎不出安装命令");

assert.equal(ENV_INSTALL_HINTS.pi.cmd, "npm install -g @mariozechner/pi-coding-agent", "pi 指引命令");
assert.equal(ENV_INSTALL_HINTS.dsh.cmd, "npm install -g @deepseek-ai/dsh", "dsh 指引命令");
assert.ok(ENV_INSTALL_HINTS.pi.note.includes("≥1.5"), "pi 门槛说明带版本要求");
assert.ok(ENV_INSTALL_HINTS.dsh.note.includes("node ≥24.9"), "dsh 门槛说明带 node 版本");

/* ── env 一键安装（v2）：安装钮 / npm 未就绪置灰 / npm 卡装 Node / 日志块上限 ── */
assert.ok(missCard.includes('data-env-install="dsh"'), "引擎缺失卡出一键安装钮");
assert.ok(missCard.includes(">安装</button>"), "安装钮文案");
assert.ok(!missCard.includes("disabled"), "npm 就绪未知时不置灰安装钮");
assert.ok(readyCard.includes("READY") && !readyCard.includes("data-env-install"), "READY 卡不出安装钮");

const piBlocked = envCardHTML({ engine: "pi", available: false, path: null, versionHint: null }, { npmReady: false });
assert.ok(piBlocked.includes('data-env-install="pi"'), "置灰卡仍带安装钮 data 属性");
assert.ok(piBlocked.includes("disabled"), "npm 未就绪安装钮置灰");
assert.ok(piBlocked.includes('title="先安装 Node"'), "置灰钮 title 说明前置条件");
const piOpen = envCardHTML({ engine: "pi", available: false, path: null, versionHint: null }, { npmReady: true });
assert.ok(!piOpen.includes("disabled"), "npm 就绪安装钮可点");

const npmMiss = envCardHTML({ engine: "npm", available: false, path: null, versionHint: null });
assert.ok(npmMiss.includes('data-env-install="node"'), "npm 缺失卡装的是 Node");
assert.ok(npmMiss.includes(">安装 Node</button>"), "npm 卡安装钮文案");
assert.ok(!npmMiss.includes("data-env-copy"), "npm 卡无命令可复制");
assert.ok(npmMiss.includes("Node.js ≥24.9"), "npm 卡带私有目录说明");
assert.ok(!npmMiss.includes("disabled"), "npm 卡安装钮不受 npmReady 影响");
assert.equal(ENV_INSTALL_HINTS.npm.cmd, "", "npm 条目无命令");
assert.ok(ENV_INSTALL_HINTS.npm.note.includes("私有目录"), "npm 条目说明私有目录");
assert.equal(ENV_INSTALL_HINTS.pi.pkg, "@mariozechner/pi-coding-agent", "pi 代装包名");
assert.equal(ENV_INSTALL_HINTS.dsh.pkg, "@deepseek-ai/dsh", "dsh 代装包名");

assert.equal(envLogHTML([]), '<div class="env-log mono"></div>', "空日志出空容器");
const log60 = envLogHTML(Array.from({ length: 60 }, (_, i) => `line-${i}`));
assert.equal((log60.match(/<div>/g) ?? []).length, 50, "60 行只保留末 50 行");
assert.ok(!log60.includes(">line-0<"), "最早 10 行被截掉");
assert.ok(log60.includes(">line-10<"), "第 11 行起保留");
assert.ok(log60.includes(">line-59<"), "末行保留");
const escLog = envLogHTML(["a<b>&c"]);
assert.ok(escLog.includes("a&lt;b&gt;&amp;c"), "日志行转义");

/* ── markdown 富渲染（R9-A A2）：XSS 双层 / 语言剥离与高亮回落 / 基本面 ── */

/* XSS 第一层：原始 HTML 不直出（script 注入、带事件属性的 img 都转义为可见文本） */
assert.ok(!renderRich("hi <script>alert(1)</script> ok").includes("<script>"), "script 注入无活标签");
assert.ok(renderRich("hi <script>alert(1)</script> ok").includes("&lt;script&gt;"), "script 以转义文本可见");
assert.ok(!renderRich('<img src=x onerror="alert(1)">').includes("<img"), "原始 img 不直出");
/* XSS 第二层（承重墙，marked 18 实测不拦 javascript:）：输出层剥危险协议；
   on* 事件属性即便混进真标签也被剥掉 */
assert.ok(!renderRich("[x](javascript:alert(1))").includes('href="javascript:'), "javascript: 链接被剥 href");
assert.ok(!renderRich("[x](JAVASCRIPT:alert(1))").includes("JAVASCRIPT:"), "协议大小写不绕过");
assert.ok(!renderRich("[d](data:text/html,x)").includes('href="data:'), "data: 链接被剥 href");
assert.ok(renderRich("![i](data:image/png;base64,AA)").includes('src="data:image/png;base64,AA'), "img 的 data: 放行");
assert.ok(renderRich("[z](https://a.b/z)").includes('href="https://a.b/z"'), "正常 https 链接保留");
assert.ok(renderRich("[z](https://a.b/z)").includes('target="_blank"'), "外链统一新窗口");
assert.ok(!renderRich("![i](javascript:alert(1))").includes('src="javascript:'), "markdown 图的 javascript: 也被剥");

/* 围栏语言标记：短标识认领并小写，其余（含自然语言句子）不算语言 */
assert.equal(fenceLanguage("js"), "js");
assert.equal(fenceLanguage("TypeScript"), "typescript");
assert.equal(fenceLanguage("c++"), "c++");
assert.equal(fenceLanguage("python3.12"), "python3.12");
assert.equal(fenceLanguage(""), "");
assert.equal(fenceLanguage("not a language"), "");
assert.equal(fenceLanguage("这行太长不是语言标记这行太长不是语言标记这行太长不是"), "", "超 20 字符不认");

/* 高亮：已注册语言出 hljs span；未注册语言回落纯转义文本 */
assert.ok(highlightCode("const x = 1", "ts").includes('class="hljs-keyword"'), "ts 高亮出 keyword span");
assert.ok(highlightCode("def f(): pass", "python").includes("hljs-"), "python 高亮");
assert.ok(highlightCode("a < b & c", "klingon").includes("a &lt; b &amp; c"), "未注册语言回落转义纯文本");
assert.ok(!highlightCode("a < b", "klingon").includes("hljs-"), "回落不含高亮 span");

/* 代码块容器：语言标签 + 复制钮 + 高亮 pre；无语言标签显 text */
const blk = renderCodeBlock("const x = 1;", "TS");
assert.ok(blk.includes('class="cb-lang">ts</span>'), "语言标签小写展示");
assert.ok(blk.includes('data-copy-code'), "复制钮委托属性");
assert.ok(blk.includes("<pre") && blk.includes('class="hljs-keyword"'), "高亮 pre 在场");
const blkPlain = renderCodeBlock("plain < text");
assert.ok(blkPlain.includes('class="cb-lang">text</span>'), "无语言显 text");
assert.ok(blkPlain.includes("plain &lt; text"), "纯文本代码转义");

/* renderRich 基本面：粗体/行内码/标题/列表/表格/引用 */
const rich = renderRich("## 标题\n\n**粗** 与 `码`\n\n- 项一\n- 项二\n\n| a | b |\n|---|---|\n| 1 | 2 |");
assert.ok(rich.includes("<h2>标题</h2>"), "标题");
assert.ok(rich.includes("<strong>粗</strong>"), "粗体");
assert.ok(rich.includes("<code>码</code>"), "行内码");
assert.ok(rich.includes("<ul>") && rich.includes("<li>项一</li>"), "无序列表");
assert.ok(rich.includes("<table>") && rich.includes("<td>1</td>"), "GFM 表格");
assert.ok(renderRich("> 引用").includes("<blockquote>"), "引用");
assert.ok(renderRich("第一行\n第二行").includes("<br>"), "聊天断行（breaks）");

/* ── R9-B B1 parseAtImage：@生图前缀路由（视频先判/缺描述/非本路由） ── */
assert.deepEqual(parseAtImage("@生图 冷白纸面封面"), { kind: "image", prompt: "冷白纸面封面" });
assert.deepEqual(parseAtImage("@生图视频 5 秒夜景航拍"), { kind: "video", prompt: "5 秒夜景航拍" }, "视频前缀先判（@生图是其前缀）");
assert.deepEqual(parseAtImage("@生图  多空格  描述"), { kind: "image", prompt: "多空格  描述" }, "仅 trim 两端，内部空白保留");
assert.deepEqual(parseAtImage("@生图"), { kind: "image", prompt: "" }, "缺描述出空 prompt 由调用方提示");
assert.deepEqual(parseAtImage("@生图视频"), { kind: "video", prompt: "" });
assert.equal(parseAtImage("@agent 目标"), null, "@agent 非本路由");
assert.equal(parseAtImage("普通消息"), null, "无前缀非本路由");
assert.equal(parseAtImage(""), null, "空串非本路由");

/* ── R9-B B3 usagechart：14 天零补齐 / 同天聚合 / 跨月窗口 / 模型降序 ── */
const urow = (date: string, modelName: string, requests: number, costCents: number): UsageRow =>
  ({ date, modelName, requests, costCents, tokensIn: 0, tokensOut: 0 });
const NOW14 = new Date(2026, 10, 14, 9, 0); // 2026-11-14 本地
const empty = usageBars([], NOW14);
assert.equal(empty.length, 14, "空数据仍 14 天");
assert.ok(empty.every((b) => b.cents === 0), "零天补 0");
assert.equal(empty[13].date, "2026-11-14", "末柱是今天");
assert.equal(empty[0].date, "2026-11-01", "首柱 13 天前");
const bars = usageBars(
  [
    urow("2026-11-14", "qwen3.7-plus", 3, 41),
    urow("2026-11-14", "material:image", 1, 14), // 同天跨模型聚合
    urow("2026-11-12", "qwen3.7-plus", 1, 7),
    urow("2026-10-20", "qwen3.7-plus", 9, 99), // 窗口外忽略
  ],
  NOW14,
);
assert.equal(bars[13].cents, 55, "同天多行 cents 聚合");
assert.equal(bars[11].cents, 7, "单天落位正确（11-12 = 窗口第 12 柱）");
assert.equal(bars.reduce((s, b) => s + b.cents, 0), 62, "窗口外行不计入");
const NOWMonthEdge = new Date(2026, 10, 1, 23, 59); // 11-01 深夜，窗口跨月回退到 10 月
const barsEdge = usageBars(
  [urow("2026-10-18", "m", 1, 99), urow("2026-10-31", "m", 1, 5), urow("2026-11-01", "m", 2, 9)],
  NOWMonthEdge,
);
assert.equal(barsEdge[0].date, "2026-10-19", "跨月窗口首柱正确");
assert.equal(barsEdge[12].cents, 5, "10-31 落在窗内 index 12");
assert.equal(barsEdge[13].cents, 9, "当天柱计 11-01");
assert.equal(barsEdge.reduce((s, b) => s + b.cents, 0), 14, "窗外行（10-18）不计");
const models = usageByModel([
  urow("2026-11-14", "qwen3.7-plus", 3, 41),
  urow("2026-11-13", "qwen3.7-plus", 2, 10),
  urow("2026-11-14", "deepseek-v4-pro", 5, 30),
  urow("2026-11-12", "material:video", 1, 70),
]);
assert.deepEqual(models[0], { model: "material:video", requests: 1, cents: 70 }, "cents 降序 top1");
assert.deepEqual(models.map((m) => m.model), ["material:video", "qwen3.7-plus", "deepseek-v4-pro"], "降序排列");
assert.deepEqual(models[1], { model: "qwen3.7-plus", requests: 5, cents: 51 }, "跨天同模型聚合");
assert.deepEqual(usageByModel([]), [], "空数据空表");

/* ── R9-C C1 并答列渲染：N 列类名 / 转入钮 data 属性 / 失败列不塌块 ── */
assert.equal(PARALLEL_MIN, 2, "并答下限 2 路");
assert.equal(PARALLEL_MAX, 4, "并答上限 4 路");
assert.equal(parallelColClass(2), "pcols-2", "2 列类名");
assert.equal(parallelColClass(3), "pcols-3", "3 列类名");
assert.equal(parallelColClass(4), "pcols-4", "4 列类名");
assert.equal(parallelColClass(1), "pcols-1", "转入后剩 1 列不占 2 列空槽");
assert.equal(parallelColClass(9), "pcols-4", "越界钳到 4 列");

const cellBase = { key: "qwen3.7-plus", answer: "答", error: "", usage: null, startedAt: 1000, endedAt: null };
const cellDone: ParallelCellView = {
  ...cellBase,
  status: "done",
  endedAt: 4200,
  usage: { promptTokens: 1234, completionTokens: 567 },
};
const doneHTML = parallelCellHTML(cellDone, 7, 1, "<p>答</p>");
assert.ok(doneHTML.includes('data-pcell="7-1"'), "列带块内寻址 data 属性");
assert.ok(doneHTML.includes('data-ppromote="7:1"'), "完成列出转入对话钮");
assert.ok(doneHTML.includes(">转入对话</button>"), "转入钮文案");
assert.ok(!doneHTML.includes("streaming"), "完成列去流式光标");
assert.ok(doneHTML.includes("3.2s · 1.2k+567 tk"), "脚注出耗时与 tokens");
assert.equal(parallelFootLine(cellDone), "3.2s · 1.2k+567 tk", "脚注纯函数同源");
assert.equal(
  parallelFootLine({ ...cellBase, status: "done", endedAt: 1500 }),
  "0.5s",
  "无 usage 只出耗时",
);

const cellStream: ParallelCellView = { ...cellBase, status: "streaming" };
const streamHTML = parallelCellHTML(cellStream, 7, 0, "");
assert.ok(streamHTML.includes("pbody streaming"), "流式列出光标类");
assert.ok(!streamHTML.includes("data-ppromote"), "流式列不出转入钮");
assert.ok(streamHTML.includes(">…</div>"), "空正文流式占位");
assert.equal(parallelFootLine(cellStream), "", "流式无脚注");

const cellErr: ParallelCellView = { ...cellBase, status: "error", error: "上游不可达 · https://x" };
const errHTML = parallelCellHTML(cellErr, 7, 2, "");
assert.ok(errHTML.includes('class="errline"'), "失败列出 errline");
assert.ok(errHTML.includes("上游不可达 · https://x"), "errline 载错误原文");
assert.ok(!errHTML.includes("data-ppromote"), "失败列不出转入钮");
assert.ok(errHTML.includes('data-pcell="7-2"'), "失败列仍在块内（不塌块）");
assert.equal(parallelFootLine(cellErr), "", "失败无脚注");
const escCell = parallelCellHTML({ ...cellErr, error: "<script>&" }, 7, 0, "");
assert.ok(escCell.includes("&lt;script&gt;&amp;"), "errline 转义");

/* ── R9-C C2 搜索高亮：单命中 / 多命中 / 无命中 / 特殊字符 ── */
assert.equal(highlightSnippet("hello world", "world"), "hello <mark>world</mark>", "单命中");
assert.equal(highlightSnippet("AbC def", "abc"), "<mark>AbC</mark> def", "大小写不敏感保留原文");
assert.equal(
  highlightSnippet("axb axb axb", "X"),
  "a<mark>x</mark>b a<mark>x</mark>b a<mark>x</mark>b",
  "多命中逐段标记（非重叠）",
);
assert.ok(!highlightSnippet("完全无关文本", "zzz").includes("<mark>"), "无命中不出 mark");
assert.equal(highlightSnippet("plain", ""), "plain", "空关键词纯转义直出");
assert.equal(
  highlightSnippet("a.b(c) ok", "a.b(c)"),
  "<mark>a.b(c)</mark> ok",
  "正则元字符按字面匹配",
);
const inject = highlightSnippet("<script>alert(1)</script>", "script");
assert.ok(inject.includes("&lt;<mark>script</mark>&gt;"), "命中段外全文转义");
assert.ok(!inject.includes("<script>"), "无原生注入");
assert.equal(
  highlightSnippet("a&a a", "a"),
  "<mark>a</mark>&amp;<mark>a</mark> <mark>a</mark>",
  "转义与命中共存不重影",
);

/* ── R9-C C3 MCP 行三态：admin 启用 / admin 停用 / 非 admin 只读 ── */
const onRow = mcpRowHTML({ name: "context7", enabled: true, tools: null }, true);
assert.ok(onRow.includes('class="dot"'), "启用行状态点亮绿");
assert.ok(!onRow.includes("dot off"), "启用行无 off 类");
assert.ok(onRow.includes('data-mcptoggle="context7"'), "行带启停 data 属性");
assert.ok(onRow.includes(">停用</button>"), "启用行操作是停用");
assert.ok(onRow.includes(">删除</button>"), "admin 行出删除");
assert.ok(onRow.includes("全部工具"), "空白名单显全部工具");

const offRow = mcpRowHTML({ name: "filesystem", enabled: false, tools: 3 }, true);
assert.ok(offRow.includes('class="dot off"'), "停用行状态点熄灭");
assert.ok(offRow.includes(">启用</button>"), "停用行操作是启用");
assert.ok(offRow.includes("3 工具"), "白名单显工具数");

const roRow = mcpRowHTML({ name: "context7", enabled: true, tools: null }, false);
assert.ok(!roRow.includes("data-mcptoggle"), "只读行无启停钮");
assert.ok(!roRow.includes("data-mcpdel"), "只读行无删除钮");
assert.ok(roRow.includes("context7"), "只读行仍显名称");

const armedRow = mcpRowHTML({ name: "x", enabled: true, tools: null, armed: true }, true);
assert.ok(armedRow.includes(">确认删</button>"), "武装态删除钮改文案");
assert.ok(armedRow.includes("del armed"), "武装态红显");
const escRow = mcpRowHTML({ name: 'a<b>"c', enabled: true, tools: null }, true);
assert.ok(escRow.includes("data-mcpdel="), "转义名行仍可寻址");
assert.ok(!escRow.includes('a<b>"c'), "名称转义无原生注入");

/* ── R9-D D1 parseAtRef：@资料 前缀路由（URL/多行/无空行/空问题/近撞词） ── */
assert.deepEqual(
  parseAtRef("@资料 https://example.com/a\n\n这份资料说了什么"),
  { ref: "https://example.com/a", question: "这份资料说了什么" },
  "URL 形态",
);
assert.deepEqual(
  parseAtRef("@资料 第一行\n第二行\n第三行\n\n问题一\n问题二"),
  { ref: "第一行\n第二行\n第三行", question: "问题一\n问题二" },
  "资料段跨行、问题段跨行",
);
assert.deepEqual(
  parseAtRef("@资料   多空格文本  \n\n  问题  "),
  { ref: "多空格文本", question: "问题" },
  "两段 trim 两端",
);
assert.deepEqual(
  parseAtRef("@资料 资料\n \t \n问题"),
  { ref: "资料", question: "问题" },
  "只含空白的行也算空行分隔",
);
assert.equal(parseAtRef("@资料 只有资料段"), null, "无空行 → null（提示补问题）");
assert.equal(parseAtRef("@资料 资料\n\n"), null, "空问题段 → null");
assert.equal(parseAtRef("@资料 资料\n\n   "), null, "纯空白问题段 → null");
assert.equal(parseAtRef("@资料 \n\n问题"), null, "空资料段 → null");
assert.equal(parseAtRef("@资料\n\n问题"), null, "首行即空行的空资料段 → null");
assert.equal(parseAtRef("@生图 画一张图\n\n问题"), null, "@生图 不误判");
assert.equal(parseAtRef("@agent 目标\n\n问题"), null, "@agent 不误判");
assert.equal(parseAtRef("@资料库是什么\n\n问题"), null, "前缀后非空白（近撞词）不误吞");
assert.equal(parseAtRef("普通消息"), null, "无前缀非本路由");
assert.equal(parseAtRef(""), null, "空串非本路由");

/* ── refIsUrl：URL 形态判定 = trim 后单个 http(s) 链接 ── */
assert.equal(refIsUrl("https://example.com/a"), true, "https 单链接");
assert.equal(refIsUrl("http://example.com"), true, "http 单链接");
assert.equal(refIsUrl("HTTPS://Example.com/a"), true, "协议大小写不敏感");
assert.equal(refIsUrl("  https://example.com/a  "), true, "trim 后判定");
assert.equal(refIsUrl("https://example.com/a b"), false, "含空白不是单链接");
assert.equal(refIsUrl("看这段文本 https://x"), false, "文本起头不算 URL");
assert.equal(refIsUrl("ftp://example.com/a"), false, "非 http(s) 协议不算");
assert.equal(refIsUrl(""), false, "空串不算");

/* ── refOverLimit：256K 字节上限（UTF-8 计，边界含端点） ── */
assert.equal(REF_MAX_BYTES, 256 * 1024, "上限常量与 Rust 同限");
assert.equal(refOverLimit("a".repeat(REF_MAX_BYTES)), false, "恰 256K 字节不超");
assert.equal(refOverLimit("a".repeat(REF_MAX_BYTES + 1)), true, "超一字节即超");
assert.equal(refOverLimit("汉".repeat(Math.floor(REF_MAX_BYTES / 3))), false, "87381 汉字 = 262143B 不超（按字节非字符）");
assert.equal(refOverLimit("汉".repeat(Math.floor(REF_MAX_BYTES / 3) + 1)), true, "87382 汉字 = 262146B 超");

/* ── refCollapsedHTML：折叠条（默认收起 / 展开态 / 转义） ── */
const refbar = refCollapsedHTML("资料全文", 4);
assert.ok(refbar.includes("[资料 · 4 字]"), "折叠条字数标签");
assert.ok(refbar.includes('data-ref-toggle="1"'), "toggle 委托属性在场");
assert.ok(refbar.includes('<pre class="refpre" hidden>'), "默认收起 pre 带 hidden");
assert.ok(refbar.includes("资料全文"), "pre 载资料全文");
assert.ok(refbar.includes(">展开</span>"), "收起态 op 文案是展开");
const refbarOpen = refCollapsedHTML("x", 1, true);
assert.ok(!refbarOpen.includes(" hidden"), "展开态 pre 不带 hidden");
assert.ok(refbarOpen.includes("收起"), "展开态 op 文案是收起");
const refbarEsc = refCollapsedHTML('<b>&"\'', 5);
assert.ok(refbarEsc.includes("&lt;b&gt;&amp;&quot;&#39;"), "资料全文转义");
assert.ok(!refbarEsc.includes("<b>"), "无原生注入");

/* ── refQuestionOf：historyWith 回灌降级（资料单轮即弃，追问不带） ── */
const REF_RAW = "@资料 https://example.com/a\n\n这份资料说了什么";
assert.equal(refQuestionOf(REF_RAW, { refLen: 22 }), "这份资料说了什么", "meta.refLen 标记消息只回灌问题段");
assert.equal(refQuestionOf("普通历史消息", undefined), "普通历史消息", "无 meta 原样透传");
assert.equal(refQuestionOf("普通历史消息", {}), "普通历史消息", "meta 无 refLen 原样透传");
assert.equal(refQuestionOf("非 @资料 前缀原文", { refLen: 3 }), "非 @资料 前缀原文", "解析失败回退原文");

/* ── R11-B U3 isTextFile：文本附件扩展名白名单（大小写不敏感 / 无扩展名 /
     点文件 / 双扩展名取末段 / 尾点不算） ── */
assert.equal(isTextFile("a.txt"), true, "txt 白名单");
assert.equal(isTextFile("Notes.MD"), true, "大小写不敏感");
assert.equal(isTextFile("main.tsx"), true, "tsx 白名单");
assert.equal(isTextFile("app.JSX"), true, "大写 JSX 白名单");
assert.equal(isTextFile("脚本.ps1"), true, "ps1 与非 ASCII 主名");
for (const ext of ["json", "csv", "log", "ts", "js", "py", "go", "rs", "java", "c", "cpp", "h", "html", "css", "xml", "yml", "yaml", "toml", "ini", "sh", "bat"]) {
  assert.equal(isTextFile(`x.${ext}`), true, `${ext} 白名单`);
}
assert.equal(isTextFile("noext"), false, "无扩展名非文本");
assert.equal(isTextFile(""), false, "空名非文本");
assert.equal(isTextFile(".gitignore"), false, "点文件（无扩展名语义）非文本");
assert.equal(isTextFile("archive.tar.gz"), false, "双扩展名取末段 gz 不在白名单");
assert.equal(isTextFile("trailing."), false, "尾点不算扩展名");
assert.equal(isTextFile("a.exe"), false, "exe 二进制拒收");
assert.equal(isTextFile("photo.png"), false, "png 走图片管线不走文本");

/* ── R11-B U3 refFilesPayload：文本附件 → 本轮资料前缀（@资料 同形态，
     多文件多段 [文件名] 空行拼接；refText 供折叠条，refLen=refText.length） ── */
const single = refFilesPayload([{ name: "a.md", text: "内容A" }], "问题Q");
assert.equal(single.content, "以下是一份参考资料：\n[a.md]\n内容A\n\n问题Q", "单文件：头 + 段 + 空行 + 问题");
assert.equal(single.refText, "[a.md]\n内容A", "单文件 refText 即该段");
assert.equal(single.refText.length, 10, "refLen 取 refText 字符数（meta.refLen 同源）");
const multi = refFilesPayload(
  [
    { name: "a.md", text: "A1" },
    { name: "b 目录.txt", text: "B1" },
  ],
  "问",
);
assert.equal(multi.refText, "[a.md]\nA1\n\n[b 目录.txt]\nB1", "多文件段间空行拼接");
assert.equal(
  multi.content,
  "以下是一份参考资料：\n[a.md]\nA1\n\n[b 目录.txt]\nB1\n\n问",
  "多文件完整载荷形态",
);
assert.equal(refFilesPayload([{ name: "空.txt", text: "" }], "").content, "以下是一份参考资料：\n[空.txt]\n\n\n", "空内容/空问题不炸（边界形态）");
assert.equal(refFilesPayload([], "只有问题").content, "以下是一份参考资料：\n\n\n只有问题", "零文件退化为头 + 问题（调用方不传空表，防御）");

/* ── R9-D D2 parseAtKb：@知识库 前缀路由（问题跨行/空问题/近撞词） ── */
assert.deepEqual(parseAtKb("@知识库 这份文档讲了什么"), { question: "这份文档讲了什么" });
assert.deepEqual(
  parseAtKb("@知识库  问题一\n问题二\n问题三  "),
  { question: "问题一\n问题二\n问题三" },
  "问题跨行且两端 trim",
);
assert.equal(parseAtKb("@知识库"), null, "缺问题 → null（提示用法）");
assert.equal(parseAtKb("@知识库 "), null, "仅空白问题 → null");
assert.equal(parseAtKb("@知识库x 是什么"), null, "前缀后非空白（近撞词）不误吞");
assert.equal(parseAtKb("@知识库检索怎么用"), null, "近撞长词不误吞");
assert.equal(parseAtKb("@资料 资料\n\n问题"), null, "@资料 非本路由");
assert.equal(parseAtKb("普通消息"), null, "无前缀非本路由");
assert.equal(parseAtKb(""), null, "空串非本路由");

/* ── kbCollapsedHTML（R10-A 分组）：按文档聚组，组头 title + 组内段落
     text/score；多文档两组、空命中空容器。 ── */
const kbHits = [
  { docId: "d1", title: "架构决策", seq: 3, text: "PG 存 BYTEA，hub 内存暴力扫。", score: 0.5 },
  { docId: "d1", title: "架构决策", seq: 7, text: "chunk 超 5 万迁 pgvector。", score: 0.876 },
  { docId: "d2", title: "使用手记", seq: 1, text: "删除即级联清 chunks。", score: 1 },
];
assert.deepEqual(
  kbHitGroups(kbHits).map((g) => [g.docId, g.title, g.hits.length] as const),
  [
    ["d1", "架构决策", 2],
    ["d2", "使用手记", 1],
  ],
  "docId 首见序分组，组内保持命中序",
);
assert.deepEqual(kbHitGroups([]), [], "空命中零组");
assert.deepEqual(
  kbHitGroups([kbHits[2], kbHits[0]]).map((g) => g.docId),
  ["d2", "d1"],
  "交错命中仍按首见序出组",
);
const kbbar = kbCollapsedHTML(kbHits);
assert.ok(kbbar.includes("[知识库 · 命中 3 段]"), "折叠条命中段数标签");
assert.ok(kbbar.includes('data-ref-toggle="1"'), "toggle 委托属性在场（复用 @资料 处理器）");
assert.ok(kbbar.includes('class="refpre kbhits" hidden'), "默认收起容器带 hidden");
assert.equal((kbbar.match(/class="kbhit"/g) ?? []).length, 3, "展开态每命中一段一行");
assert.equal((kbbar.match(/class="kbdoc-h"/g) ?? []).length, 2, "两篇文档两个组头（title 不逐段重复）");
assert.equal(kbbar.split("架构决策").length - 1, 1, "同文档多段只出一个组头");
assert.ok(kbbar.includes('class="kbdoc-h">架构决策</div>'), "组头载文档名");
assert.ok(kbbar.includes("PG 存 BYTEA，hub 内存暴力扫。"), "段落原文在场");
assert.ok(kbbar.includes(">0.50</div>"), "score 两位小数（0.5 → 0.50）");
assert.ok(kbbar.includes(">0.88</div>"), "score 两位舍入（0.876 → 0.88）");
assert.ok(kbbar.includes(">1.00</div>"), "整数 score 也两位（1 → 1.00）");
assert.ok(!kbbar.includes("架构决策 · "), "出处不再逐段拼在 score 行");
assert.ok(kbbar.includes(">展开</span>"), "收起态 op 文案是展开");
const kbbarEmpty = kbCollapsedHTML([]);
assert.ok(kbbarEmpty.includes("[知识库 · 命中 0 段]"), "空命中折叠条仍出 0 段标签");
assert.ok(!kbbarEmpty.includes("kbdoc"), "空命中不出组");
const kbbarOpen = kbCollapsedHTML([kbHits[0]], true);
assert.ok(!kbbarOpen.includes(" hidden"), "展开态容器不带 hidden");
assert.ok(kbbarOpen.includes("收起"), "展开态 op 文案是收起");
assert.ok(kbbarOpen.includes('data-refkey="d1:3"'), "展开态键挂 data-refkey（docId:seq）");
const kbbarEsc = kbCollapsedHTML([
  { docId: 'a<b"', title: "<t>&", seq: 0, text: "<script>&'x", score: 0 },
]);
assert.ok(!kbbarEsc.includes("<script>"), "段落文本无原生注入");
assert.ok(!kbbarEsc.includes("<t>"), "组头标题转义");
assert.ok(kbbarEsc.includes("data-refkey="), "键含尖括号也以属性形态在场（属性值转义）");

/* ── kbKOf（R10-A）：k 读取边界——缺失/空/非数回默认 4，越界钳 1-10 ── */
assert.equal(KB_K_DEFAULT, 4, "默认 k=4（与设计一致）");
assert.equal(kbKOf(null), 4, "缺失回默认");
assert.equal(kbKOf(""), 4, "空串回默认（未设置态）");
assert.equal(kbKOf("  "), 4, "纯空白回默认");
assert.equal(kbKOf("abc"), 4, "非数回默认");
assert.equal(kbKOf("4"), 4, "正常值直通");
assert.equal(kbKOf("1"), 1, "下端点");
assert.equal(kbKOf("10"), 10, "上端点");
assert.equal(kbKOf("0"), 1, "低于下限钳到 1");
assert.equal(kbKOf("99"), 10, "高于上限钳到 10");
assert.equal(kbKOf("-3"), 1, "负数钳到 1");
assert.equal(kbKOf("6.4"), 6, "小数取整（round）");

/* ── R10-A A2 提示词库纯逻辑：解析边界 / 首行预览 / 名称判定 / 面板选中 ── */
assert.deepEqual(parsePrompts(null), [], "null 空库");
assert.deepEqual(parsePrompts(""), [], "空串空库");
assert.deepEqual(parsePrompts("not json"), [], "坏 JSON 空库");
assert.deepEqual(parsePrompts('{"a":1}'), [], "非数组空库");
assert.deepEqual(parsePrompts('[{"id":"p1","name":"翻译","body":"译为英文"}]'), [
  { id: "p1", name: "翻译", body: "译为英文" },
], "正常单条");
assert.deepEqual(
  parsePrompts('[{"id":"p1","name":"  周报  ","body":"b"},{"id":"p2","name":"  ","body":"b"},{"name":"无id","body":"b"}]'),
  [{ id: "p1", name: "周报", body: "b" }],
  "name trim 入列；空白名/缺字段行丢弃不炸整库",
);
assert.equal(
  serializePrompts([{ id: "p1", name: "翻译", body: "译为英文" }]),
  '[{"id":"p1","name":"翻译","body":"译为英文"}]',
  "序列化往返",
);
assert.deepEqual(parsePrompts(serializePrompts(parsePrompts('[{"id":"p1","name":"a","body":"b"}]'))), [
  { id: "p1", name: "a", body: "b" },
], "parse→serialize→parse 幂等",
);

assert.equal(promptFirstLine("第一行\n第二行"), "第一行", "首行");
assert.equal(promptFirstLine("\n\n  \n正文明文\n续"), "正文明文", "跳过空行取首个非空行");
assert.equal(promptFirstLine("   "), "", "全空白出空串");
assert.equal(promptDesc("译为英文\n保持术语"), "本地提示词 · 译为英文", "desc 带本地标注与首行");
assert.equal(promptDesc(""), "本地提示词", "空 body 只出本地标注");
assert.equal(promptDesc("x".repeat(31)), `本地提示词 · ${"x".repeat(30)}…`, "首行截 30 字加省略号");
assert.equal(promptDesc("x".repeat(30)), "本地提示词 · " + "x".repeat(30), "恰 30 字不截");

assert.equal(promptNameOk("翻译"), true, "正常名");
assert.equal(promptNameOk("  周报  "), true, "首尾空白仍有效（trim 入列）");
assert.equal(promptNameOk(""), false, "空名拒");
assert.equal(promptNameOk("   "), false, "纯空白拒");
assert.equal(promptNameOk("@知识库"), false, "@ 起头拒（防 @@ 触发词）");

const PROMPTS = [
  { id: "p1", name: "翻译", body: "译为英文\n保持术语" },
  { id: "p2", name: "知识库", body: "劫持体" },
];
const BUILTIN = ["@agent", "@生图", "@资料", "@知识库"];
assert.equal(atAcceptValue("@翻译", PROMPTS, BUILTIN), "译为英文\n保持术语", "命中提示词返回 body（插入不发送）");
assert.equal(atAcceptValue("@翻译学", PROMPTS, BUILTIN), null, "近撞词不命中（精确等值）");
assert.equal(atAcceptValue("@知识库", PROMPTS, BUILTIN), null, "内置触发词优先，同名提示词不劫持");
assert.equal(atAcceptValue("@agent", [], BUILTIN), null, "内置项恒走默认路径");
assert.equal(atAcceptValue("@周报", PROMPTS, BUILTIN), null, "未命中返回 null");

/* ── R10-A A3 对话导出：翻页折叠 / md 成文 / 文件名 ── */
const mrow = (over: Partial<MessageRow>): MessageRow =>
  ({
    id: 0,
    role: "user",
    content: "",
    modelName: "",
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
    createdAt: "",
    ...over,
  }) as MessageRow;
/* 实际拉取序：首拉无 cursor=最新一页（hasMore=true）→ 以最旧 id 为游标拉更早页 */
const newestPage = {
  rows: [mrow({ id: 4, role: "user", content: "问二" }), mrow({ id: 5, modelName: "qwen", role: "assistant", content: "答二" })],
  hasMore: true,
};
const oldestPage = {
  rows: [mrow({ id: 1, role: "user", content: "问一" }), mrow({ id: 2, modelName: "qwen", role: "assistant", content: "答一" })],
  hasMore: false,
};
const f1 = exportFoldPage([], newestPage);
assert.equal(f1.nextCursor, 4, "翻页游标=当前最旧服务端 id（页内升序 rows[0]）");
const fAll = exportFoldPage(f1.rows, oldestPage);
assert.deepEqual(
  fAll.rows.map((m) => m.id),
  [1, 2, 4, 5],
  "多页折叠成旧→新（更早页垫前）",
);
assert.equal(fAll.nextCursor, undefined, "hasMore=false 终止");
assert.deepEqual(exportFoldPage([], { rows: newestPage.rows, hasMore: false }), { rows: newestPage.rows, nextCursor: undefined }, "单页即全量");
assert.deepEqual(exportFoldPage([oldestPage.rows[0]], { rows: [], hasMore: true }), { rows: [oldestPage.rows[0]], nextCursor: undefined }, "空页防御性终止");

const EXPORT_NOW = new Date(2026, 10, 15, 9, 5);
const md = sessionToMarkdown("项目讨论", fAll.rows, EXPORT_NOW);
assert.ok(md.startsWith("# 项目讨论\n"), "标题行开头");
assert.ok(md.includes("> 导出于 2026-11-15 09:05"), "导出时间行");
assert.equal((md.match(/^## /gm) ?? []).length, 4, "每条消息一个角色标题");
assert.ok(md.includes("## 我\n\n问一\n\n## qwen\n\n答一\n\n## 我\n\n问二\n\n## qwen\n\n答二"), "角色交替：user=我、模型名原样、content 原文、多页拼接有序");
assert.equal(sessionToMarkdown("空会话", [], EXPORT_NOW), "# 空会话\n\n> 导出于 2026-11-15 09:05\n", "空会话仅标题与时间");
const mdNoModel = sessionToMarkdown("t", [mrow({ id: 1, role: "assistant", content: "答", modelName: "" })], EXPORT_NOW);
assert.ok(mdNoModel.includes("## assistant\n\n答"), "空模型名回落 assistant");
const mdImg = sessionToMarkdown(
  "t",
  [mrow({ id: 1, role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] })],
  EXPORT_NOW,
);
assert.ok(mdImg.includes("看图\n\n[图片]"), "图片 parts 出占位不嵌 base64");
assert.ok(!mdImg.includes("base64,AAAA"), "dataURL 不泄漏进导出");

assert.equal(exportFilename("项目讨论"), "项目讨论.md", "正常名直通");
assert.equal(exportFilename('a/b\\c:d*e?f"g<h>|i'), "a_b_c_d_e_f_g_h__i.md", "Windows 非法字符替换");
assert.equal(exportFilename("  "), "未命名会话.md", "空名回落");
assert.equal(exportFilename("会话/名"), "会话_名.md", "路径分隔符不越级");

/* ── refQuestionOf 对 @知识库 的降级（命中段落不回灌追问） ── */
const KB_RAW = "@知识库 这份文档讲了什么";
assert.equal(refQuestionOf(KB_RAW, { kbHits: [kbHits[0]] }), "这份文档讲了什么", "meta.kbHits 标记只回灌问题段");
assert.equal(refQuestionOf(KB_RAW, { kbHits: [] }), "这份文档讲了什么", "空命中标记同样降级");
assert.equal(refQuestionOf("普通历史消息", { kbHits: [] }), "普通历史消息", "kbHits 标记但非 @知识库 原文回退原样");
assert.equal(refQuestionOf(REF_RAW, { refLen: 22, kbHits: [] }), "这份资料说了什么", "双标记时 refLen 先判（@资料 原文配 @资料 标记）");

/* ── R10-B B2 定时任务纯逻辑：计划 fmt / 状态徽标 / 时刻 fmt / value 域校验 ── */
assert.equal(fmtSchedulePlan("interval", 30), "每 30 分钟");
assert.equal(fmtSchedulePlan("interval", 1), "每 1 分钟");
assert.equal(fmtSchedulePlan("daily", "09:30"), "每天 09:30");
assert.equal(fmtSchedulePlan("daily", "00:00"), "每天 00:00");

assert.deepEqual(schedBadge("ok"), { word: "OK", cls: "run" }, "ok 绿 run");
assert.deepEqual(schedBadge("fail"), { word: "FAIL", cls: "fl" }, "fail 红 fl");
assert.deepEqual(schedBadge("running"), { word: "RUN", cls: "hd" }, "running 橙 hd");
assert.deepEqual(schedBadge("idle"), { word: "IDLE", cls: "dn" }, "idle 灰 dn");

const SCHED_NOW = new Date(2026, 10, 15, 20, 0); // 2026-11-15 20:00 本地
const schedSec = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000);
assert.equal(schedTime(schedSec(2026, 10, 15, 21, 30), SCHED_NOW), "21:30", "同天 HH:MM");
assert.equal(schedTime(schedSec(2026, 10, 16, 9, 5), SCHED_NOW), "11-16 09:05", "跨天 MM-DD HH:MM");
assert.equal(schedTime(null, SCHED_NOW), "—", "null（未排/未跑）占位");
assert.equal(schedTime(Number.NaN, SCHED_NOW), "—", "非数占位");

assert.equal(parseSchedValue("interval", "30"), "30");
assert.equal(parseSchedValue("interval", " 30 "), "30", "trim 后判定");
assert.equal(parseSchedValue("interval", "030"), "30", "前导零归一");
assert.equal(parseSchedValue("interval", "1"), "1", "分钟下端点");
assert.equal(parseSchedValue("interval", "999999999"), "999999999", "大值直通（Rust 侧无上限）");
assert.equal(parseSchedValue("interval", "0"), null, "0 拒");
assert.equal(parseSchedValue("interval", "99999999999999999999"), null, "超安全整数拒（浮点精度防线）");
assert.equal(parseSchedValue("interval", "abc"), null, "非数拒");
assert.equal(parseSchedValue("interval", "3.5"), null, "非整数拒");
assert.equal(parseSchedValue("daily", "09:30"), "09:30", "正常直通");
assert.equal(parseSchedValue("daily", "9:5"), "09:05", "单位数补零归一");
assert.equal(parseSchedValue("daily", "23:59"), "23:59", "上端点");
assert.equal(parseSchedValue("daily", "00:00"), "00:00", "下端点");
assert.equal(parseSchedValue("daily", "24:00"), null, "时越界拒");
assert.equal(parseSchedValue("daily", "12:60"), null, "分越界拒");
assert.equal(parseSchedValue("daily", "0930"), null, "缺冒号拒");
assert.equal(parseSchedValue("daily", ""), null, "空串拒");

/* ── decodeScheduleList：坏行丢弃 / 可选数值缺失落 null / 未知状态落 idle ── */
const schRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "s1",
  name: "周报",
  kind: "interval",
  value: "30",
  goal: "梳理 docs 生成周报",
  workdir: "H:\\proj",
  enabled: true,
  webhook_url: "https://hook.example/w",
  next_run: 1763000000,
  last_run: 1762990000,
  last_status: "ok",
  last_task_id: "h7",
  ...over,
});
assert.deepEqual(decodeScheduleList([schRow({})]), [
  {
    id: "s1",
    name: "周报",
    kind: "interval",
    value: "30",
    goal: "梳理 docs 生成周报",
    workdir: "H:\\proj",
    enabled: true,
    webhookUrl: "https://hook.example/w",
    next_run: 1763000000,
    last_run: 1762990000,
    last_status: "ok",
    last_task_id: "h7",
  },
], "正常行全字段直通");
const dailyDecoded = decodeScheduleList([schRow({ kind: "daily", value: "09:30" })])[0];
assert.equal(dailyDecoded.kind, "daily", "daily kind 直通");
assert.equal(dailyDecoded.value, "09:30", "daily 行 string value 直通");
assert.equal(decodeScheduleList([schRow({ id: 7 })]).length, 0, "id 非串丢行");
assert.equal(decodeScheduleList([schRow({ kind: "cron" })]).length, 0, "未知 kind 丢行");
assert.equal(decodeScheduleList([schRow({ value: 30 })]).length, 0, "value 数字丢行（契约恒 string）");
assert.equal(decodeScheduleList([schRow({ value: null })]).length, 0, "value null 丢行");
const sparse = decodeScheduleList([schRow({ next_run: undefined, last_run: undefined, last_status: "weird", last_task_id: undefined, enabled: undefined })])[0];
assert.equal(sparse.next_run, null, "next_run 缺失落 null");
assert.equal(sparse.last_run, null, "last_run 缺失落 null");
assert.equal(sparse.last_status, "idle", "未知状态落 idle");
assert.equal(sparse.last_task_id, null, "last_task_id 缺失落 null");
assert.equal(sparse.enabled, false, "enabled 缺失按停用");
assert.deepEqual(decodeScheduleList(null), [], "非数组空表");

/* ── schedDetailBodyHTML（统一详情体）：计划信息 + 下次触发 + 上次状态 +
     关联 DSH 任务块（uuid 即续跑句柄）；立即运行钮 running 占位禁用 ── */
const schedDet = (over: Partial<ScheduleRow>): ScheduleRow => ({
  id: "s1",
  name: "周报",
  kind: "interval",
  value: "30",
  goal: "梳理 docs 生成周报",
  workdir: "H:\proj",
  enabled: true,
  webhookUrl: "",
  next_run: schedSec(2026, 10, 15, 21, 30),
  last_run: schedSec(2026, 10, 15, 20, 0),
  last_status: "ok",
  last_task_id: "",
  ...over,
});
const detOk = schedDetailBodyHTML(schedDet({ last_task_id: "session-abc123" }), null);
assert.ok(detOk.includes("每 30 分钟 · 启用"), "计划行（无 webhook 不带标注）");
assert.ok(detOk.includes("梳理 docs 生成周报"), "GOAL 行");
assert.ok(detOk.includes("H:\proj"), "WORKDIR 行");
assert.ok(detOk.includes("21:30"), "下次触发时刻");
assert.ok(detOk.includes('<span class="st run">OK</span>'), "上次状态徽标");
assert.ok(detOk.includes('data-udsh-resume="session-abc123"'), "关联任务续跑钮带 uuid");
assert.ok(detOk.includes("session-abc1"), "历史未命中时 uuid 短码兜底");
assert.ok(!detOk.includes("disabled"), "非占位态立即运行可点");
const detResolved = schedDetailBodyHTML(
  schedDet({ last_task_id: "session-abc123", webhookUrl: "https://h.example/x" }),
  { task: "梳理 docs 生成周报", at: schedSec(2026, 10, 15, 20, 0) * 1000 },
);
assert.ok(detResolved.includes("·webhook"), "webhook 标注随计划行");
assert.ok(detResolved.includes("梳理 docs 生成周报</span>"), "历史命中的上次任务用任务标签");
assert.ok(!detResolved.includes("session-abc1<"), "命中时不再显 uuid 短码");
const detNever = schedDetailBodyHTML(schedDet({ last_run: null, last_status: "idle" }), null);
assert.ok(detNever.includes("未跑过"), "未跑过占位");
assert.ok(!detNever.includes("data-udsh-resume"), "无关联任务不出续跑钮");
const detRunning = schedDetailBodyHTML(schedDet({ last_status: "running", last_task_id: "session-abc123" }), null);
assert.ok(detRunning.includes('data-sched-fire="s1" disabled'), "running 占位立即运行禁用");
assert.deepEqual(decodeScheduleList([]), [], "空数组空表");

/* ── schedRowHTML：徽标/计划/启停/武装/停用/转义 ── */
const ROW_BASE: ScheduleRow = {
  id: "s1",
  name: "周报",
  kind: "interval",
  value: "30",
  goal: "g",
  workdir: "H:\\proj",
  enabled: true,
  webhookUrl: "",
  next_run: schedSec(2026, 10, 15, 21, 30),
  last_run: schedSec(2026, 10, 15, 8, 0),
  last_status: "ok",
  last_task_id: null,
};
const rowOK = schedRowHTML(ROW_BASE);
assert.ok(rowOK.includes('class="schedrow schedgrid"'), "启用行无 off");
assert.ok(rowOK.includes('class="st run"') && rowOK.includes(">OK</span>"), "ok 徽标绿");
assert.ok(rowOK.includes('>每 30 分钟</span>'), "计划人类可读");
assert.ok(rowOK.includes('>21:30</span>'), "下次时刻同天 HH:MM");
assert.ok(rowOK.includes('title="上次 08:00"'), "上次时刻进 title");
assert.ok(rowOK.includes('data-schtoggle="s1"'), "启停钮寻址");
assert.ok(rowOK.includes(">停用</button>"), "启用行操作是停用");
assert.ok(rowOK.includes('data-schedit="s1"') && rowOK.includes('data-schdel="s1"'), "编辑/删除寻址");
assert.ok(!rowOK.includes("确认删"), "未武装不出确认删");

const rowOff = schedRowHTML({ ...ROW_BASE, enabled: false, next_run: null, last_status: "fail" });
assert.ok(rowOff.includes("schedrow schedgrid off"), "停用行 off 降透明");
assert.ok(rowOff.includes('class="st fl"') && rowOff.includes(">FAIL</span>"), "fail 徽标红");
assert.ok(rowOff.includes(">—</span>"), "停用未排时刻占位");
assert.ok(rowOff.includes(">启用</button>"), "停用行操作是启用");

const rowArmed = schedRowHTML(ROW_BASE, true);
assert.ok(rowArmed.includes(">确认删</button>"), "武装态改文案");
assert.ok(rowArmed.includes("del armed"), "武装态红显");

const rowRun = schedRowHTML({ ...ROW_BASE, last_status: "running" });
assert.ok(rowRun.includes('class="st hd"') && rowRun.includes(">RUN</span>"), "running 徽标橙");
const rowIdle = schedRowHTML({ ...ROW_BASE, last_status: "idle", last_run: null });
assert.ok(rowIdle.includes('class="st dn"') && rowIdle.includes(">IDLE</span>"), "idle 徽标灰");
assert.ok(rowIdle.includes('title="上次 —"'), "未跑过上次占位");

const rowEsc = schedRowHTML({ ...ROW_BASE, name: 'a<b>"&', workdir: "<w>" });
assert.ok(rowEsc.includes("a&lt;b&gt;&quot;&amp;"), "名称转义");
assert.ok(!rowEsc.includes("<w>"), "workdir 无原生注入");

/* ── R11-S1/S2 定时二期：webhook 域校验 / 行标注与立即运行钮 / decode 透传 ── */
assert.equal(parseSchedWebhook(""), "", "空串合法（不推送）");
assert.equal(parseSchedWebhook("   "), "", "纯空白按空（不推送）");
assert.equal(parseSchedWebhook("https://hooks.example/w"), "https://hooks.example/w", "https 直通");
assert.equal(parseSchedWebhook("  http://a.b/h?k=1  "), "http://a.b/h?k=1", "trim 后判定并规整返回");
assert.equal(parseSchedWebhook("HTTPS://Example.com/w"), "HTTPS://Example.com/w", "协议大小写不敏感");
assert.equal(parseSchedWebhook("ftp://a.b/w"), null, "非 http(s) 协议拒");
assert.equal(parseSchedWebhook("https://a.b/w x"), null, "含空白拒");
assert.equal(parseSchedWebhook("https:/a.b"), null, "缺斜杠拒");
assert.equal(parseSchedWebhook("https://"), null, "裸协议无主机拒");
assert.equal(parseSchedWebhook("a.b/w"), null, "无协议拒");

assert.equal(decodeScheduleList([schRow({ webhook_url: 7 })])[0].webhookUrl, "", "webhook 非串回空不丢行");
assert.equal(decodeScheduleList([schRow({ webhook_url: undefined })])[0].webhookUrl, "", "webhook 缺失回空");

assert.ok(rowOK.includes('data-sched-fire="s1"'), "立即运行钮寻址");
assert.ok(rowOK.includes(">立即运行</button>"), "立即运行钮文案");
assert.ok(!rowOK.includes('data-sched-fire="s1" disabled'), "非 running 行立即运行可点");
const rowFiring = schedRowHTML({ ...ROW_BASE, last_status: "running" });
assert.ok(rowFiring.includes('data-sched-fire="s1" disabled'), "running 占位行立即运行禁用");
const rowHook = schedRowHTML({ ...ROW_BASE, webhookUrl: "https://h.example/w" });
assert.ok(rowHook.includes(">每 30 分钟 ·webhook</span>"), "webhook 行计划尾标注");
assert.ok(!rowOK.includes("·webhook"), "无 webhook 行不标注");

/* ── R11-K1 重建结果 hint 三态（空库 / 全原文 / 含近似） ── */
assert.equal(kbRebuildHint({ rebuilt: 0, approximated: 0, dim: 0 }), "重建完成 · 库为空", "空库不出维度");
assert.equal(
  kbRebuildHint({ rebuilt: 3, approximated: 0, dim: 1536 }),
  "重建完成 · 3 篇 · 维度 1536",
  "全原文出篇数与维度",
);
assert.ok(!kbRebuildHint({ rebuilt: 3, approximated: 0, dim: 1536 }).includes("近似"), "全原文不出近似提示");
assert.equal(
  kbRebuildHint({ rebuilt: 5, approximated: 2, dim: 1024 }),
  "重建完成 · 5 篇 · 维度 1024 · 2 篇旧档为近似重建（无原文），建议删除重入",
  "含近似加删除重入建议",
);

/* ── R10-B B3 任务模板纯逻辑：解析边界 / 序列化往返 / 自动取名 ── */
assert.deepEqual(parseTemplates(null), [], "null 空库");
assert.deepEqual(parseTemplates(""), [], "空串空库");
assert.deepEqual(parseTemplates("not json"), [], "坏 JSON 空库");
assert.deepEqual(parseTemplates('{"a":1}'), [], "非数组空库");
assert.deepEqual(
  parseTemplates('[{"id":"t1","name":"周报","goal":"梳理 docs","workdir":"H:\\\\proj"}]'),
  [{ id: "t1", name: "周报", goal: "梳理 docs", workdir: "H:\\proj" }],
  "正常单条",
);
assert.deepEqual(
  parseTemplates('[{"id":"t1","name":"  周报  ","goal":"g","workdir":"w"},{"id":"t2","name":" ","goal":"g","workdir":"w"},{"id":"t3","name":"缺wd","goal":"g"}]'),
  [{ id: "t1", name: "周报", goal: "g", workdir: "w" }],
  "name trim 入列；空白名/缺字段行丢弃不炸整库",
);
assert.equal(
  serializeTemplates([{ id: "t1", name: "周报", goal: "g", workdir: "w" }]),
  '[{"id":"t1","name":"周报","goal":"g","workdir":"w"}]',
  "序列化往返",
);
assert.deepEqual(
  parseTemplates(serializeTemplates(parseTemplates('[{"id":"t1","name":"a","goal":"g","workdir":"w"}]'))),
  [{ id: "t1", name: "a", goal: "g", workdir: "w" }],
  "parse→serialize→parse 幂等",
);

assert.equal(templateNameOf("梳理 docs"), "梳理 docs", "短 goal 原样");
assert.equal(templateNameOf("a\nb  c"), "a b c", "空白折叠");
assert.equal(templateNameOf("一二三四五六七八九十一二"), "一二三四五六七八九十一二", "恰 12 字不截");
assert.equal(templateNameOf("一二三四五六七八九十一二三"), "一二三四五六七八九十一二…", "13 字截 12 加省略号");
assert.equal(templateNameOf(""), "", "空 goal 出空串");

/* ── P2 COST 本地估算（cost.ts）：分/百万 token 计价 → COST 格文案 ── */
assert.equal(estimateCostCents(1_000_000, 0, 300, 0), 300, "入向单价：1M × 300 分/M = 300 分");
assert.equal(estimateCostCents(0, 500_000, 300, 1200), 600, "出向单价：0.5M × 1200 分/M = 600 分");
assert.equal(estimateCostCents(2_500_000, 500_000, 400, 1200), 1600, "大数：1e9+6e8 分 ÷ 1e6 精确");
assert.equal(estimateCostCents(12345, 6789, 0, 0), 0, "未定价两价 0 → 0 分");
assert.equal(costCellText(12345, 6789, 0, 0), "—", "0 价显占位 —");
assert.equal(costCellText(1_000_000, 0, 300, 0), "≈¥3.00", "分元换算：300 分 = ¥3.00");
assert.equal(costCellText(123456, 789, 850, 1700), "≈¥1.06", "两位舍入：106.2789 分 → ¥1.06");
assert.equal(costCellText(1000, 0, 100, 0), "≈¥0.00", "分以下金额舍为 ¥0.00");
assert.equal(costCellText(0, 0, 850, 0), "≈¥0.00", "零 token 已定价仍走估算路径");

/* ── R11 T1/T2 统一任务中心：kind 徽标 / 状态徽标 / 列分类边界 / 三源合并 / 行与看板 ── */
assert.equal(kindBadge("harness"), "H");
assert.equal(kindBadge("material"), "M");
assert.equal(kindBadge("dsh"), "D");
assert.equal(kindBadge("pi"), "P");
assert.equal(kindBadge("sched"), "S");

assert.deepEqual(unifiedStatusBadge("run"), { word: "RUN", cls: "run" });
assert.deepEqual(unifiedStatusBadge("hold"), { word: "HOLD", cls: "hd" });
assert.deepEqual(unifiedStatusBadge("done"), { word: "DONE", cls: "dn" });
assert.deepEqual(unifiedStatusBadge("fail"), { word: "FAIL", cls: "fl" });
assert.deepEqual(unifiedStatusBadge("pending"), { word: "WAIT", cls: "dn" }, "pending 待触发灰 WAIT");

assert.deepEqual(
  BOARD_COLUMNS.map((c) => c.label),
  ["待触发", "运行中", "待审批", "已完成", "失败"],
  "五列列序",
);
assert.equal(boardColumnOf("pending"), "pending", "pending 落首列待触发");
assert.equal(boardColumnOf("hold"), "hold");
assert.equal(boardColumnOf("run"), "run");
assert.equal(boardColumnOf("done"), "done");
assert.equal(boardColumnOf("fail"), "fail");
assert.equal(boardColumnOf("weird" as UnifiedStatus), "run", "未知态防御归运行中列");

assert.deepEqual(decodeTasksUnified(null), [], "非数组空表");
assert.deepEqual(decodeTasksUnified({}), [], "对象非数组空表");
assert.deepEqual(decodeTasksUnified("x"), [], "字符串非数组空表");
const uniRaw = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: "dsh",
  id: "d1",
  title: "梳理 docs",
  status: "run",
  started_at: 1763000000000,
  elapsed_ms: 65000,
  ...over,
});
assert.deepEqual(decodeTasksUnified([uniRaw({})]), [
  { kind: "dsh", id: "d1", title: "梳理 docs", status: "run", started_at: 1763000000000, elapsed_ms: 65000 },
], "正常行全字段直通");
assert.deepEqual(
  decodeTasksUnified([uniRaw({ started_at: "2026-11-15T09:00:00" })])[0].started_at,
  new Date(2026, 10, 15, 9, 0).getTime(),
  "ISO 串 started_at 转 epoch（防御形态漂移）",
);
assert.equal(decodeTasksUnified([uniRaw({ elapsed_ms: null })])[0].elapsed_ms, null, "elapsed 缺失落 null");
assert.equal(decodeTasksUnified([uniRaw({ kind: "material" })]).length, 0, "rust 回包 material 行丢弃（前端为素材真源）");
assert.equal(decodeTasksUnified([uniRaw({ kind: "nope" })]).length, 0, "未知 kind 丢行");
assert.equal(decodeTasksUnified([uniRaw({ status: "running" })]).length, 0, "契约外状态丢行");
assert.equal(decodeTasksUnified([uniRaw({ id: 7 })]).length, 0, "id 非串丢行");
assert.equal(decodeTasksUnified([uniRaw({ title: null })]).length, 0, "title 非串丢行");
assert.equal(decodeTasksUnified([uniRaw({ started_at: Number.NaN })]).length, 0, "NaN started_at 丢行");
assert.equal(decodeTasksUnified([uniRaw({ started_at: "not-a-date" })]).length, 0, "不可解析串丢行");
assert.equal(decodeTasksUnified([uniRaw({ started_at: undefined })]).length, 0, "缺失 started_at 丢行");
assert.equal(decodeTasksUnified([uniRaw({ status: "done" }), uniRaw({ id: "d2", status: "fail" })]).length, 2, "dsh 终态行（环形驻留源 done/fail）直通");

const MAT_AT = new Date(2026, 10, 15, 9, 0).getTime();
assert.deepEqual(
  materialRowOf({ id: "m1", prompt: "封面图", status: "running", createdAt: "2026-11-15T09:00:00" }, MAT_AT + 30000),
  { kind: "material", id: "m1", title: "封面图", status: "run", started_at: MAT_AT, elapsed_ms: 30000 },
  "running → run 且 elapsed=now-started",
);
assert.equal(materialRowOf({ id: "m2", prompt: "p", status: "pending", createdAt: "2026-11-15T09:00:00" }, MAT_AT + 1000).status, "run", "pending → run");
assert.equal(materialRowOf({ id: "m3", prompt: "p", status: "succeeded", createdAt: "2026-11-15T09:00:00" }).status, "done", "succeeded → done");
const matFail = materialRowOf({ id: "m4", prompt: "p", status: "failed", createdAt: "2026-11-15T09:00:00" });
assert.equal(matFail.status, "fail", "failed → fail");
assert.equal(matFail.elapsed_ms, null, "终态无结束时刻 elapsed=null");
assert.equal(materialRowOf({ id: "m5", prompt: "p", status: "succeeded", createdAt: "bad" }).started_at, 0, "坏 createdAt 落 0 排尾");

const hBase = { id: "3", goal: "修登录 bug", startedAt: 1000, endedAt: null as number | null };
assert.equal(harnessRowOf({ ...hBase, state: null }, 5000).status, "run", "已发起未到首事件按 run");
assert.equal(harnessRowOf({ ...hBase, state: { type: "running" } }, 5000).status, "run");
assert.equal(harnessRowOf({ ...hBase, state: { type: "awaiting_approval" } }, 5000).status, "hold", "HOLD 映射待审批");
assert.equal(harnessRowOf({ ...hBase, state: { type: "done" } }, 5000).status, "done");
assert.equal(harnessRowOf({ ...hBase, state: { type: "aborted" } }, 5000).status, "done", "aborted 归 done（非失败）");
assert.equal(harnessRowOf({ ...hBase, state: { type: "failed" } }, 5000).status, "fail");
assert.equal(harnessRowOf({ ...hBase, state: null }, 5000).elapsed_ms, 4000, "在走 elapsed=now-started");
assert.equal(harnessRowOf({ ...hBase, state: { type: "done" }, endedAt: 2500 }, 99999).elapsed_ms, 1500, "终态 elapsed 定格");

const uniRow = (over: Partial<UnifiedRow>): UnifiedRow => ({
  kind: "dsh",
  id: "d1",
  title: "t",
  status: "run",
  started_at: 1000,
  elapsed_ms: null,
  ...over,
});
const localHarness = [
  uniRow({ kind: "harness", id: "3", title: "本地鲜活", status: "hold", started_at: 3000, elapsed_ms: 10 }),
  uniRow({ kind: "harness", id: "4", title: "快照外新任务", status: "run", started_at: 5000 }),
];
const materialRows = [uniRow({ kind: "material", id: "m1", title: "封面", status: "done", started_at: 4000 })];
assert.deepEqual(
  mergeUnifiedRows(null, localHarness, materialRows).map((r) => r.id),
  ["4", "m1", "3"],
  "rust 缺席回退本地 harness+material，按 started_at 降序",
);
const rustRows = [
  uniRow({ kind: "harness", id: "3", title: "快照旧题", status: "run", started_at: 3000 }),
  uniRow({ kind: "dsh", id: "d1", title: "DSH 任务", status: "run", started_at: 2000, elapsed_ms: 65000 }),
  uniRow({ kind: "pi", id: "p1", title: "PI 会话", status: "run", started_at: 1000 }),
];
const merged = mergeUnifiedRows(rustRows, localHarness, materialRows);
assert.deepEqual(
  merged.map((r) => `${r.kind}:${r.id}`),
  ["harness:4", "material:m1", "harness:3", "dsh:d1", "pi:p1"],
  "三源混排降序",
);
assert.equal(merged.find((r) => r.id === "3")?.title, "本地鲜活", "同 id harness 以本地事件流覆盖（快照滞后不显旧态）");
assert.equal(merged.find((r) => r.id === "3")?.status, "hold", "覆盖含状态");
assert.equal(merged.find((r) => r.id === "d1")?.title, "DSH 任务", "dsh/pi 快照直通");
const tieA = uniRow({ kind: "harness", id: "a", started_at: 100 });
const tieM = uniRow({ kind: "material", id: "b", started_at: 100 });
assert.deepEqual(
  mergeUnifiedRows(null, [tieA], [tieM]).map((r) => r.id),
  ["a", "b"],
  "同刻排序稳定（本地 harness 在 material 前）",
);

/* 徽标计数（统一列表口径）：run/hold 全类型计，pending/done/fail 不计 */
assert.deepEqual(badgeCountsOf([]), { run: 0, hold: 0 }, "空表零计数");
assert.deepEqual(
  badgeCountsOf([
    uniRow({ kind: "dsh", id: "d1", status: "run" }),
    uniRow({ kind: "pi", id: "p1", status: "run" }),
    uniRow({ kind: "harness", id: "h1", status: "hold" }),
    uniRow({ kind: "sched", id: "s1", status: "pending" }),
    uniRow({ kind: "dsh", id: "d2", status: "done" }),
    uniRow({ kind: "material", id: "m1", status: "fail" }),
  ]),
  { run: 2, hold: 1 },
  "dsh/pi run 与 harness hold 计入，pending/done/fail 不计",
);
assert.deepEqual(
  badgeCountsOf([uniRow({ kind: "harness", id: "h2", status: "hold" })]),
  { run: 0, hold: 1 },
  "仅 hold 时 RUN 段不显",
);

/* 详情 kicker 大徽标：五态色语言（liveBadge 形态） */
assert.deepEqual(unifiedLiveBadge("run"), { word: "RUNNING", cls: "live" });
assert.deepEqual(unifiedLiveBadge("hold"), { word: "HOLD", cls: "live warn" });
assert.deepEqual(unifiedLiveBadge("done"), { word: "DONE", cls: "live off" });
assert.deepEqual(unifiedLiveBadge("fail"), { word: "FAILED", cls: "live fail" });
assert.deepEqual(unifiedLiveBadge("pending"), { word: "WAIT", cls: "live off" });

assert.equal(unifiedTitle("短题"), "短题");
assert.equal(unifiedTitle("  多   空白\n折叠  "), "多 空白 折叠", "空白折叠");
assert.equal(unifiedTitle("一".repeat(24)), "一".repeat(24), "恰 24 字不截");
assert.equal(unifiedTitle("一".repeat(25)), "一".repeat(24) + "…", "25 字截 24 加省略号");

const UNI_NOW = new Date(2026, 10, 15, 20, 0);
assert.equal(unifiedTime(new Date(2026, 10, 15, 9, 5).getTime(), UNI_NOW), "09:05", "同天 HH:MM");
assert.equal(unifiedTime(new Date(2026, 10, 14, 23, 59).getTime(), UNI_NOW), "11-14 23:59", "跨天 MM-DD HH:MM");
assert.equal(unifiedTime(0, UNI_NOW), "—", "0 占位");
assert.equal(unifiedTime(Number.NaN, UNI_NOW), "—", "非数占位");

assert.equal(fmtElapsed(null), "—", "终态未知显 —");
assert.equal(fmtElapsed(0), "00:00");
assert.equal(fmtElapsed(65000), "01:05");
assert.equal(fmtElapsed(3661000), "61:01", "不折小时（ELAPSED 遥测同形）");
assert.equal(fmtElapsed(-5), "—", "负值占位");

const rowHTML = unifiedRowHTML(
  { kind: "sched", id: "s1", title: "每 30 分钟周报", status: "pending", started_at: new Date(2026, 10, 15, 9, 5).getTime(), elapsed_ms: null },
  false,
  UNI_NOW,
);
assert.ok(rowHTML.includes('data-uid="s1"') && rowHTML.includes('data-ukind="sched"'), "行带委托寻址 data 属性");
assert.ok(rowHTML.includes('<span class="kb mono">S</span>'), "kind 徽标单字母");
assert.ok(rowHTML.includes('<span class="st dn">WAIT</span>'), "pending 行 WAIT 徽标");
assert.ok(rowHTML.includes("每 30 分钟周报"), "标题在场");
assert.ok(rowHTML.includes(">09:05</div>"), "时刻 HH:MM");
assert.ok(!rowHTML.includes(" cur"), "非选中无 cur");
const uniRowEsc = unifiedRowHTML({ kind: "dsh", id: 'a"b', title: "<script>&", status: "fail", started_at: 1, elapsed_ms: 1 }, true, UNI_NOW);
assert.ok(uniRowEsc.includes('data-uid="a&quot;b"'), "id 属性转义");
assert.ok(uniRowEsc.includes("&lt;script&gt;&amp;"), "标题转义无原生注入");
assert.ok(uniRowEsc.includes(" cur"), "选中行 cur 类");
assert.ok(uniRowEsc.includes('<span class="st fl">FAIL</span>'), "fail 红徽标");

const boardRows: UnifiedRow[] = [
  { kind: "sched", id: "s1", title: "待触发排程", status: "pending", started_at: 900, elapsed_ms: null },
  { kind: "dsh", id: "d1", title: "跑着的 DSH 任务", status: "run", started_at: 800, elapsed_ms: 65000 },
  { kind: "harness", id: "h1", title: "等审批", status: "hold", started_at: 700, elapsed_ms: 20000 },
  { kind: "material", id: "m1", title: "完成的封面", status: "done", started_at: 600, elapsed_ms: null },
  { kind: "pi", id: "p1", title: "失败的会话", status: "fail", started_at: 500, elapsed_ms: 3000 },
];
const board = boardHTML(boardRows, { kind: "material", id: "m1" });
const cols = board.split('class="kbcol"').slice(1);
assert.equal(cols.length, 5, "五列恒在场");
assert.ok(cols[0].includes("待触发") && cols[0].includes('data-uid="s1"') && cols[0].includes('<span class="kb mono">S</span>'), "待触发列载 sched pending 卡");
assert.ok(cols[1].includes("运行中") && cols[1].includes('data-uid="d1"') && cols[1].includes(">01:05<"), "运行中列载 dsh 卡与耗时");
assert.ok(cols[2].includes("待审批") && cols[2].includes('data-uid="h1"'), "待审批列载 hold 卡");
assert.ok(cols[3].includes("已完成") && cols[3].includes('data-uid="m1"'), "已完成列载 material 卡");
assert.ok(cols[4].includes("失败") && cols[4].includes('data-uid="p1"'), "失败列载 fail 卡");
assert.equal((board.match(/kbcard cur/g) ?? []).length, 1, "仅选中卡 cur（material m1）");
const longBoard = boardHTML([{ kind: "dsh", id: "d9", title: "一".repeat(30), status: "run", started_at: 1, elapsed_ms: null }], null);
assert.ok(longBoard.includes("一".repeat(24) + "…"), "卡标题同截断口径");
assert.ok(cols[1].includes('<span class="n">1</span>'), "列头计数");
const boardEmpty = boardHTML([], null);
assert.equal((boardEmpty.match(/class="kbcol"/g) ?? []).length, 5, "空数据五列仍在（列不塌）");
assert.equal((boardEmpty.match(/class="kbph"/g) ?? []).length, 5, "空列各出淡占位");
assert.ok(boardEmpty.includes("运行中 · 空"), "占位载列标题");
assert.ok(!boardEmpty.includes("data-uid"), "空板不出卡");

console.log("pure.test.ts: all assertions passed");
