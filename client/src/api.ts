/* hub API 客户端。契约对齐 server/internal/api/*.go 与
   server/internal/gateway/gateway.go（前端只读对齐，不反向约束 server）。
   R9-D D2 知识库四端点契约对齐 hub internal/kb（camelCase 视图）。 */

import type { KbHit } from "./refdoc";

const TOKEN_KEY = "cp.token";
const HUB_URL_KEY = "cp.hubUrl";
// 首装默认指向生产（toC 单用户）；自托管者经登录页/设置页「修改」切换
// （2026-11-12 首装卡死修复：旧默认 127.0.0.1:10440 让新装机无法登录）。
const DEFAULT_HUB_URL = "https://platform.secai.fun";

export function hubUrl(): string {
  return localStorage.getItem(HUB_URL_KEY) || DEFAULT_HUB_URL;
}

export function setHubUrl(url: string): void {
  localStorage.setItem(HUB_URL_KEY, url);
}

/* token 存储（P1 清偿 api.ts 旧 TODO）：桌面态落 OS keyring（src-tauri/src/token.rs，
   Windows Credential Manager），浏览器态降级 localStorage 不动。
   读取路径顺带迁移：发现 localStorage 残留旧 token 即写入 keyring 并移除明文键；
   写入失败保留原值下次再迁，收敛幂等。
   红线不变：token 只进 hub 请求头，不发往其他任何端。 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** 当前页面是否运行在 Tauri 桌面壳内（Rust 命令与事件可用）。
    定义自 harness.ts 移入：api 层判形态不能反向依赖 harness（其依赖 api，会成环）。 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export async function getToken(): Promise<string> {
  if (!isTauri()) return localStorage.getItem(TOKEN_KEY) ?? "";
  const { invoke } = await import("@tauri-apps/api/core");
  // keyring 读失败按未登录降级（凭据服务异常时用户仍可重登，不卡死启动）
  const stored: unknown = await invoke("token_get").catch((e: unknown) => {
    console.warn("[api] token_get 失败，按未登录处理", e);
    return "";
  });
  if (typeof stored === "string" && stored !== "") return stored;
  const legacy = localStorage.getItem(TOKEN_KEY);
  if (!legacy) return "";
  try {
    await invoke("token_set", { token: legacy });
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    console.warn("[api] 旧 token 迁移 keyring 失败，保留 localStorage 待下次", e);
  }
  return legacy;
}

export async function setToken(token: string): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem(TOKEN_KEY, token);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("token_set", { token });
  // 写成功即清明文残留（迁移反复失败的窗口期内旧值可能仍在）
  localStorage.removeItem(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // 清 keyring 失败不阻断登出（下次登录覆盖写会收敛）
    await invoke("token_clear").catch((e: unknown) => console.warn("[api] token_clear 失败", e));
  }
  localStorage.removeItem(TOKEN_KEY);
}

export class SessionExpired extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpired";
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message || `${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 响应形状与契约不符（server 升级或代理被换时的兜底信号）。 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/* ── JSON 窄化（边界解析，内部类型可信） ── */

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function fieldString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

export function fieldNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function fieldBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  return typeof v === "boolean" ? v : undefined;
}

function fieldArray(o: Record<string, unknown>, key: string): unknown[] | undefined {
  const v = o[key];
  return Array.isArray(v) ? v : undefined;
}

export interface MeInfo {
  id: string;
  email: string;
  nickname: string;
}

export interface HostedModel {
  name: string;
  provider: string;
  upstreamModel: string;
  protocol: string;
  enabled: boolean;
  /** 单价（分/百万 token）；未定价或旧 hub 缺字段 → 0（COST 本地估算用） */
  priceIn: number;
  priceOut: number;
}

export interface SessionRow {
  id: string;
  title: string;
  modelName: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: number;
  role: string;
  /** 纯文本=string；带图消息=vision parts（hub 读侧兼容旧文本，R9-A） */
  content: string | ContentPart[];
  modelName: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  createdAt: string;
  /** R6-B 溯源：hub 落库消息带 {task_id}（白名单字段，decode 只填 taskId）；
      R9-B @生图本地卡消息带 {materialTaskId, kind}（不落 hub，重启即失）；
      R9-C 并答块消息带 {parallelId}（本地态，不落 hub、上下文不回灌）。 */
  meta?: { taskId?: string; materialTaskId?: string; kind?: MaterialKind; parallelId?: number };
}

/** vision 消息内容分段（R9-A A1，OpenAI 形态）：text 文本段 / image_url 图片段（dataURL 内联）。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessageWire {
  role: string;
  /** 纯文本=string（无图路径零变化）；带图=parts（vision 形态） */
  content: string | ContentPart[];
}

export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
}

export function decodeMe(v: unknown): MeInfo {
  if (!isObj(v)) throw new ProtocolError("bad /me response");
  return {
    id: fieldString(v, "id") ?? "",
    email: fieldString(v, "email") ?? "",
    nickname: fieldString(v, "nickname") ?? "",
  };
}

export function decodeModels(v: unknown): HostedModel[] {
  const arr = isObj(v) ? fieldArray(v, "models") : undefined;
  if (!arr) throw new ProtocolError("bad /models response");
  return arr.map((m): HostedModel => {
    if (!isObj(m)) throw new ProtocolError("bad model row");
    return {
      name: fieldString(m, "name") ?? "",
      provider: fieldString(m, "provider") ?? "",
      upstreamModel: fieldString(m, "upstream_model") ?? "",
      protocol: fieldString(m, "protocol") ?? "",
      enabled: fieldBool(m, "enabled") ?? false,
      priceIn: fieldNumber(m, "price_in") ?? 0,
      priceOut: fieldNumber(m, "price_out") ?? 0,
    };
  });
}

function sessionRowOf(s: Record<string, unknown>): SessionRow {
  return {
    id: fieldString(s, "id") ?? "",
    title: fieldString(s, "title") ?? "",
    modelName: fieldString(s, "model_name") ?? "",
    createdAt: fieldString(s, "created_at") ?? "",
    updatedAt: fieldString(s, "updated_at") ?? "",
  };
}

export function decodeSessions(v: unknown): SessionRow[] {
  const arr = isObj(v) ? fieldArray(v, "sessions") : undefined;
  if (!arr) throw new ProtocolError("bad /sessions response");
  return arr.map((s): SessionRow => {
    if (!isObj(s)) throw new ProtocolError("bad session row");
    return sessionRowOf(s);
  });
}

export function decodeSessionCreated(v: unknown): SessionRow {
  if (!isObj(v) || !isObj(v.session)) throw new ProtocolError("bad session response");
  return sessionRowOf(v.session);
}

/** 分页取会话消息（R5-B#2）：无 beforeId=最新一页；hasMore=还有更早。
    响应 {messages, has_more}。 */
export async function fetchMessagesPage(
  sessionId: string,
  beforeId?: number,
): Promise<{ rows: MessageRow[]; hasMore: boolean }> {
  const q = beforeId !== undefined && beforeId > 0 ? `?before_id=${beforeId}` : "";
  const v = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages${q}`);
  const rows = decodeMessages(v);
  const hasMore = isObj(v) ? fieldBool(v, "has_more") === true : false;
  return { rows, hasMore };
}

/** 消息 content 窄化：字符串原样；数组必须每个元素都形似 ContentPart，否则按契约漂移抛错。 */
function decodeContent(v: unknown): string | ContentPart[] {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v.map((p): ContentPart => {
      if (isObj(p) && p.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
      if (
        isObj(p) &&
        p.type === "image_url" &&
        isObj(p.image_url) &&
        typeof p.image_url.url === "string"
      ) {
        return { type: "image_url", image_url: { url: p.image_url.url } };
      }
      throw new ProtocolError("bad content part");
    });
  }
  throw new ProtocolError("bad message content");
}

export function decodeMessages(v: unknown): MessageRow[] {
  const arr = isObj(v) ? fieldArray(v, "messages") : undefined;
  if (!arr) throw new ProtocolError("bad messages response");
  return arr.map((m): MessageRow => {
    if (!isObj(m)) throw new ProtocolError("bad message row");
    const raw = m["meta"];
    const taskId = isObj(raw) ? fieldString(raw, "task_id") : undefined;
    return {
      id: fieldNumber(m, "id") ?? 0,
      role: fieldString(m, "role") ?? "",
      content: decodeContent(m.content),
      modelName: fieldString(m, "model_name") ?? "",
      tokensIn: fieldNumber(m, "tokens_in") ?? 0,
      tokensOut: fieldNumber(m, "tokens_out") ?? 0,
      costCents: fieldNumber(m, "cost_cents") ?? 0,
      createdAt: fieldString(m, "created_at") ?? "",
      ...(taskId !== undefined && taskId !== "" ? { meta: { taskId } } : {}),
    };
  });
}

/** 独立消息追加（R6-B U0 端点）：任务卡等非 LLM 回合消息落库。
    meta 白名单 {task_id:"h<n>"} 由 hub 校验；调用方尽力而为（失败不阻断 UI）。 */
export async function appendMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  meta?: { taskId: string },
): Promise<void> {
  await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ role, content, ...(meta !== undefined ? { meta } : {}) }),
  });
}

/* ── 素材生成与用量（server/internal/material/api.go、api/sessions.go）── */

export type MaterialKind = "image" | "video";
export type MaterialStatus = "pending" | "running" | "succeeded" | "failed";

export interface MaterialTask {
  id: string;
  kind: MaterialKind;
  prompt: string;
  status: MaterialStatus;
  resultUrl: string;
  error: string;
  createdAt: string;
}

function materialKindOf(v: unknown): MaterialKind {
  if (v === "image" || v === "video") return v;
  throw new ProtocolError(`unknown material kind: ${typeof v === "string" ? v : "?"}`);
}

function materialStatusOf(v: unknown): MaterialStatus {
  if (v === "pending" || v === "running" || v === "succeeded" || v === "failed") return v;
  throw new ProtocolError(`unknown material status: ${typeof v === "string" ? v : "?"}`);
}

/** POST/GET /material/generations 共用视图：{task:{id,kind,prompt,status,result_url,error,created_at}}。 */
export function decodeMaterialTask(v: unknown): MaterialTask {
  if (!isObj(v) || !isObj(v.task)) throw new ProtocolError("bad material task response");
  return materialTaskFields(v.task);
}

/** GET /material/generations?limit= 列表视图：{tasks:[taskView…]}（R5-A-① 重载恢复用）。 */
export function decodeMaterialTaskList(v: unknown): MaterialTask[] {
  const arr = isObj(v) ? fieldArray(v, "tasks") : undefined;
  if (!arr) throw new ProtocolError("bad material task list response");
  return arr.map((t): MaterialTask => {
    if (!isObj(t)) throw new ProtocolError("bad material task list row");
    return materialTaskFields(t);
  });
}

function materialTaskFields(t: Record<string, unknown>): MaterialTask {
  const id = fieldString(t, "id");
  if (!id) throw new ProtocolError("material task missing id");
  return {
    id,
    kind: materialKindOf(t.kind),
    prompt: fieldString(t, "prompt") ?? "",
    status: materialStatusOf(t.status),
    resultUrl: fieldString(t, "result_url") ?? "",
    error: fieldString(t, "error") ?? "",
    createdAt: fieldString(t, "created_at") ?? "",
  };
}

export interface UsageRow {
  date: string;
  modelName: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  requests: number;
}

export function decodeUsage(v: unknown): UsageRow[] {
  const arr = isObj(v) ? fieldArray(v, "usage") : undefined;
  if (!arr) throw new ProtocolError("bad /usage response");
  return arr.map((r): UsageRow => {
    if (!isObj(r)) throw new ProtocolError("bad usage row");
    return {
      date: fieldString(r, "date") ?? "",
      modelName: fieldString(r, "model_name") ?? "",
      tokensIn: fieldNumber(r, "tokens_in") ?? 0,
      tokensOut: fieldNumber(r, "tokens_out") ?? 0,
      costCents: fieldNumber(r, "cost_cents") ?? 0,
      requests: fieldNumber(r, "requests") ?? 0,
    };
  });
}

/** GET /usage?days=N：按天×模型用量行（设置页用量仪表盘与素材用量汇总共用）。 */
export async function fetchUsage(days: number): Promise<UsageRow[]> {
  return decodeUsage(await api(`/api/v1/usage?days=${days}`));
}

/** POST /material/generations：发起图/视频生成，返回任务视图（与 GET 单任务同形）。 */
export async function createMaterial(kind: MaterialKind, prompt: string): Promise<MaterialTask> {
  return decodeMaterialTask(
    await api("/api/v1/material/generations", {
      method: "POST",
      body: JSON.stringify({ kind, prompt }),
    }),
  );
}

/* ── HTTP ── */

async function apiErrorOf(res: Response): Promise<ApiError> {
  let code = "";
  let message = "";
  try {
    const body: unknown = await res.json();
    if (isObj(body) && isObj(body.error)) {
      code = typeof body.error.code === "string" ? body.error.code : "";
      message = typeof body.error.message === "string" ? body.error.message : "";
    }
  } catch {
    // 网关透传的上游错误体不是 JSON：退回 HTTP 状态
  }
  return new ApiError(res.status, code || "HTTP_ERROR", message || `HTTP ${res.status}`);
}

async function fetchOrNetworkError(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(hubUrl() + path, init);
  } catch (e) {
    throw new ApiError(0, "NETWORK", e instanceof Error ? e.message : "network error");
  }
}

async function authHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${await getToken()}`);
  return headers;
}

/** 带 Bearer 的统一入口；401 清 token 并抛 SessionExpired，其余非 2xx 抛 ApiError。 */
export async function api(path: string, init?: RequestInit): Promise<unknown> {
  const headers = await authHeaders(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetchOrNetworkError(path, { ...init, headers });
  if (res.status === 401) {
    await clearToken();
    throw new SessionExpired();
  }
  if (!res.ok) throw await apiErrorOf(res);
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new ProtocolError(`non-JSON response from ${path}`);
  }
}

/* ── 会话管理命令（PATCH/DELETE /sessions/:id，对齐 server/internal/api/sessions.go） ── */

/** 改标题（服务端无重名/非空约束，客户端先行判定）→ 200 {session}（与 POST 创建同形，复用窄化）。 */
export async function renameSession(id: string, title: string): Promise<SessionRow> {
  return decodeSessionCreated(
    await api(`/api/v1/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  );
}

/** 删除会话（服务端级联删消息）→ 200 {status:"ok"}；形状不符按契约漂移抛 ProtocolError。 */
export async function deleteSession(id: string): Promise<void> {
  const v = await api(`/api/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!isObj(v) || v.status !== "ok") throw new ProtocolError("bad session delete response");
}

/* ── R9-C C2 会话搜索 + C3 MCP 治理面（server/internal/api/sessions.go、internal/mcp/api.go） ── */

export interface SessionSearchRow {
  sessionId: string;
  title: string;
  snippet: string;
  createdAt: string;
}

/** GET /sessions/search?q=：本用户会话标题+消息内容匹配（hub 限 20 条），
    返回 {results:[{sessionId,title,snippet,createdAt}]}；空 q 由调用方拦不下发。 */
export async function searchSessions(q: string): Promise<SessionSearchRow[]> {
  const v = await api(`/api/v1/sessions/search?q=${encodeURIComponent(q)}`);
  const arr = isObj(v) ? fieldArray(v, "results") : undefined;
  if (!arr) throw new ProtocolError("bad session search response");
  return arr.map((r): SessionSearchRow => {
    if (!isObj(r)) throw new ProtocolError("bad session search row");
    return {
      sessionId: fieldString(r, "sessionId") ?? "",
      title: fieldString(r, "title") ?? "",
      snippet: fieldString(r, "snippet") ?? "",
      createdAt: fieldString(r, "createdAt") ?? "",
    };
  });
}

/** MCP upstream 视图（server upstreamView 形状，凭证只有存在性没有值）。 */
export interface McpUpstreamView {
  name: string;
  baseUrl: string;
  hasToken: boolean;
  allowedTools: string[]; // 空 = 全部工具可见
  enabled: boolean;
  createdAt: string;
}

function mcpUpstreamOf(u: Record<string, unknown>): McpUpstreamView {
  return {
    name: fieldString(u, "name") ?? "",
    baseUrl: fieldString(u, "base_url") ?? "",
    hasToken: u.has_token === true,
    allowedTools: (fieldArray(u, "allowed_tools") ?? []).filter((t): t is string => typeof t === "string"),
    enabled: u.enabled === true,
    createdAt: fieldString(u, "created_at") ?? "",
  };
}

/** GET /mcp/upstreams（全员可读）→ {upstreams:[upstreamView…]}。 */
export async function fetchMcpUpstreams(): Promise<McpUpstreamView[]> {
  const v = await api("/api/v1/mcp/upstreams");
  const arr = isObj(v) ? fieldArray(v, "upstreams") : undefined;
  if (!arr) throw new ProtocolError("bad mcp upstreams response");
  return arr.map((u): McpUpstreamView => {
    if (!isObj(u)) throw new ProtocolError("bad mcp upstream row");
    return mcpUpstreamOf(u);
  });
}

export interface McpUpstreamInput {
  name: string;
  baseUrl: string;
  authToken: string;
  allowedTools: string[];
}

/** POST /mcp/upstreams（admin）→ 201 {upstream}；403 = 非管理员（调用方降级只读）。 */
export async function createMcpUpstream(input: McpUpstreamInput): Promise<McpUpstreamView> {
  const v = await api("/api/v1/mcp/upstreams", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      base_url: input.baseUrl,
      auth_token: input.authToken,
      allowed_tools: input.allowedTools,
    }),
  });
  if (!isObj(v) || !isObj(v.upstream)) throw new ProtocolError("bad mcp upstream response");
  return mcpUpstreamOf(v.upstream);
}

/** DELETE /mcp/upstreams/:name（admin）→ 200 {status:"ok"}。 */
export async function deleteMcpUpstream(name: string): Promise<void> {
  const v = await api(`/api/v1/mcp/upstreams/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!isObj(v) || v.status !== "ok") throw new ProtocolError("bad mcp upstream delete response");
}

/** PATCH /mcp/upstreams/:name（admin）body {enabled}；回包形状不依赖（成功后调用方重拉列表）。 */
export async function setMcpUpstreamEnabled(name: string, enabled: boolean): Promise<void> {
  await api(`/api/v1/mcp/upstreams/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

/* ── R9-D D2 知识库（POST/GET/DELETE /kb/docs、POST /kb/search，全走 auth） ── */

export type KbSourceType = "url" | "paste" | "file";

/** 文档元数据行（GET /kb/docs 与 POST /kb/docs 回包的 doc 同形）。 */
export interface KbDocRow {
  id: string;
  title: string;
  sourceType: KbSourceType;
  sourceRef: string;
  chunkCount: number;
  createdAt: string;
}

function kbSourceTypeOf(v: unknown): KbSourceType {
  if (v === "url" || v === "paste" || v === "file") return v;
  throw new ProtocolError(`unknown kb source type: ${typeof v === "string" ? v : "?"}`);
}

function kbDocOf(d: Record<string, unknown>): KbDocRow {
  const id = fieldString(d, "id");
  if (!id) throw new ProtocolError("kb doc missing id");
  return {
    id,
    title: fieldString(d, "title") ?? "",
    sourceType: kbSourceTypeOf(d.sourceType),
    sourceRef: fieldString(d, "sourceRef") ?? "",
    chunkCount: fieldNumber(d, "chunkCount") ?? 0,
    createdAt: fieldString(d, "createdAt") ?? "",
  };
}

/** POST /kb/docs：同步切块+embedding 入库（hub 侧 2-10s 量级，调用方按钮态等待）。
    URL 形态由客户端 fetch_page 抓好剥净后传 content，sourceRef=原始链接。
    R10-A 重入语义：同用户同 sourceRef 已有文档 → 更新（updated=true），旧
    hub 无 updated 字段按 false（显示仍「已入库」）。 */
export async function kbCreateDoc(input: {
  title?: string;
  sourceType: KbSourceType;
  sourceRef?: string;
  content: string;
}): Promise<{ doc: KbDocRow; updated: boolean }> {
  const v = await api("/api/v1/kb/docs", { method: "POST", body: JSON.stringify(input) });
  if (!isObj(v) || !isObj(v.doc)) throw new ProtocolError("bad kb doc response");
  return { doc: kbDocOf(v.doc), updated: fieldBool(v, "updated") === true };
}

/** GET /kb/docs → {docs:[docView…]}（按入库时间倒序）。 */
export async function kbListDocs(): Promise<KbDocRow[]> {
  const v = await api("/api/v1/kb/docs");
  const arr = isObj(v) ? fieldArray(v, "docs") : undefined;
  if (!arr) throw new ProtocolError("bad kb docs response");
  return arr.map((d): KbDocRow => {
    if (!isObj(d)) throw new ProtocolError("bad kb doc row");
    return kbDocOf(d);
  });
}

/** DELETE /kb/docs/:id → 200 {status:"ok"}（hub 级联删 chunks）。 */
export async function kbDeleteDoc(id: string): Promise<void> {
  const v = await api(`/api/v1/kb/docs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!isObj(v) || v.status !== "ok") throw new ProtocolError("bad kb doc delete response");
}

/** POST /kb/search {q, k=4} → {hits:[{docId,title,seq,text,score}]}（余弦 top-k）。 */
export async function kbSearch(q: string, k = 4): Promise<KbHit[]> {
  const v = await api("/api/v1/kb/search", { method: "POST", body: JSON.stringify({ q, k }) });
  const arr = isObj(v) ? fieldArray(v, "hits") : undefined;
  if (!arr) throw new ProtocolError("bad kb search response");
  return arr.map((h): KbHit => {
    if (!isObj(h)) throw new ProtocolError("bad kb hit row");
    const docId = fieldString(h, "docId");
    const seq = fieldNumber(h, "seq");
    const score = fieldNumber(h, "score");
    if (!docId || seq === undefined || score === undefined) throw new ProtocolError("bad kb hit fields");
    return { docId, title: fieldString(h, "title") ?? "", seq, text: fieldString(h, "text") ?? "", score };
  });
}

/* ── R11-K1 索引重建（POST /kb/rebuild，hub 并行落地中——契约：响应
     {rebuilt, approximated, dim}；approximated=存量旧档无原文按 chunks
     拼接近似重嵌的篇数）。 ── */

export interface KbRebuildResult {
  rebuilt: number;
  approximated: number;
  dim: number;
}

/** 全量重切重嵌（换 embedding 模型后用；期间检索暂不可查）。 */
export async function kbRebuild(): Promise<KbRebuildResult> {
  const v = await api("/api/v1/kb/rebuild", { method: "POST" });
  if (!isObj(v)) throw new ProtocolError("bad kb rebuild response");
  const rebuilt = fieldNumber(v, "rebuilt");
  const approximated = fieldNumber(v, "approximated");
  const dim = fieldNumber(v, "dim");
  if (rebuilt === undefined || approximated === undefined || dim === undefined) {
    throw new ProtocolError("bad kb rebuild fields");
  }
  return { rebuilt, approximated, dim };
}

/** 重建结果 hint 文案（纯函数，三态）：空库 / 全原文 / 含近似（近似篇数
    提示删除重入）。空库不出维度（dim 无意义）。 */
export function kbRebuildHint(r: KbRebuildResult): string {
  if (r.rebuilt === 0) return "重建完成 · 库为空";
  const base = `重建完成 · ${r.rebuilt} 篇 · 维度 ${r.dim}`;
  return r.approximated > 0 ? `${base} · ${r.approximated} 篇旧档为近似重建（无原文），建议删除重入` : base;
}

/** 换取 center 签发的 access token（hub /auth/login 是唯一无鉴权路由，不走 api() 以免误清 token）。 */
export async function login(email: string, password: string): Promise<string> {
  const res = await fetchOrNetworkError("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await apiErrorOf(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProtocolError("bad login response");
  }
  if (!isObj(body)) throw new ProtocolError("bad login response");
  const token = fieldString(body, "accessToken");
  if (!token) throw new ProtocolError("login response missing accessToken");
  return token;
}

/* ── SSE 流式对话 ── */

export interface ChatRequestBody {
  model: string;
  /** hub 路径必填；BYOK 直连忽略（不持久化会话） */
  session_id?: string;
  messages: ChatMessageWire[];
}

/** BYOK 直连目标：请求只发往 baseUrl，Authorization 用 BYOK key，不经 hub。 */
export interface ChatDirectTarget {
  baseUrl: string;
  apiKey: string;
}

/** POST /chat/completions（stream:true）：逐 delta 回调，尾 chunk usage 经 onDone 交出。
    direct 存在时走 BYOK 直连（{base_url}/chat/completions）：401 不清 hub token，
    请求体不带 session_id。 */
export async function chatStream(
  body: ChatRequestBody,
  onDelta: (text: string) => void,
  onDone: (usage: StreamUsage | null) => void,
  direct?: ChatDirectTarget,
): Promise<void> {
  let res: Response;
  if (direct) {
    try {
      res = await fetch(direct.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${direct.apiKey}`,
        },
        body: JSON.stringify({ model: body.model, messages: body.messages, stream: true }),
      });
    } catch (e) {
      throw new ApiError(0, "NETWORK", e instanceof Error ? e.message : "network error");
    }
    if (!res.ok) throw await apiErrorOf(res);
  } else {
    const headers = await authHeaders({ "Content-Type": "application/json" });
    res = await fetchOrNetworkError("/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (res.status === 401) {
      await clearToken();
      throw new SessionExpired();
    }
    if (!res.ok) throw await apiErrorOf(res);
  }
  if (!res.body) throw new ProtocolError("empty stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let usage: StreamUsage | null = null;

  const handleLine = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === "[DONE]") return true;
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return false;
    }
    if (!isObj(chunk)) return false;
    const delta = deltaContent(chunk);
    if (delta) onDelta(delta);
    const u = usageOf(chunk);
    if (u) usage = u;
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (handleLine(line)) {
        onDone(usage);
        return;
      }
    }
  }
  if (handleLine(buf.replace(/\r$/, ""))) {
    onDone(usage);
    return;
  }
  onDone(usage);
}

function deltaContent(chunk: Record<string, unknown>): string {
  const choices = fieldArray(chunk, "choices");
  const first = choices !== undefined ? choices[0] : undefined;
  if (!isObj(first) || !isObj(first.delta)) return "";
  return typeof first.delta.content === "string" ? first.delta.content : "";
}

function usageOf(chunk: Record<string, unknown>): StreamUsage | null {
  if (!isObj(chunk.usage)) return null;
  const prompt = fieldNumber(chunk.usage, "prompt_tokens");
  const completion = fieldNumber(chunk.usage, "completion_tokens");
  if (prompt === undefined || completion === undefined) return null;
  return { promptTokens: prompt, completionTokens: completion };
}
