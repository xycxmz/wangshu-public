/* 本地素材资产桥接层（B5，roadmap-r4）：对 src-tauri assets 命令做 TS 侧
   精确建模。纯函数（decode/标题）无 DOM、无运行时 import，node 断言脚本可
   直接复用；命令封装经动态 import（同 engine.ts 惯例——非 Tauri 环境静态
   引入会破坏浏览器降级路径）。 */

import { ProtocolError, fieldNumber, fieldString } from "./api";

export interface AssetRecord {
  id: number;
  kind: string; // image|video
  prompt: string;
  path: string;
  sourceUrl: string;
  createdAt: number; // unix ms
}

function decodeAsset(v: unknown): AssetRecord {
  if (typeof v !== "object" || v === null) throw new ProtocolError("bad asset record");
  const o = v as Record<string, unknown>;
  const id = fieldNumber(o, "id");
  const kind = fieldString(o, "kind");
  const path = fieldString(o, "path");
  const createdAt = fieldNumber(o, "created_at");
  if (id === undefined || kind === undefined || path === undefined || createdAt === undefined) {
    throw new ProtocolError("asset record missing fields");
  }
  return {
    id,
    kind,
    prompt: fieldString(o, "prompt") ?? "",
    path,
    sourceUrl: fieldString(o, "source_url") ?? "",
    createdAt,
  };
}

/** wire 形态对齐 asset_list 命令返回：裸数组（非包裹对象）+ snake_case 字段，
    同 harness.ts task_history_list 惯例（AssetRecord 无 serde rename_all）。 */
export function decodeAssetList(v: unknown): AssetRecord[] {
  if (!Array.isArray(v)) throw new ProtocolError("bad asset list shape");
  return v.map(decodeAsset);
}

/** 资产缩略/回看 URL：asset 协议（tauri.conf assetProtocol scope 已限 assets/**）。
    浏览器降级环境无 Tauri runtime，转换抛错原样上抛——资产页有环境门。 */
export async function assetSrc(path: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

/** 资产卡标题：同 materialTitle 纪律——空白折叠取前 20 字，超长省略号。 */
export function assetTitle(prompt: string): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length <= 20 ? t : t.slice(0, 20) + "…";
}

export async function assetSaveFromUrl(url: string, kind: string, prompt: string): Promise<AssetRecord> {
  const { invoke } = await import("@tauri-apps/api/core");
  return decodeAsset(await invoke<unknown>("asset_save_from_url", { url, kind, prompt }));
}

export async function assetList(): Promise<AssetRecord[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return decodeAssetList(await invoke<unknown>("asset_list"));
}

export async function assetReveal(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("asset_reveal", { path });
}
