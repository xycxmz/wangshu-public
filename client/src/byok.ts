/* BYOK 模型桥接层：对 src-tauri/src/byok.rs 的命令做 TS 侧精确建模。
   红线：api_key 只在本机 OS keyring，发送瞬间经 byokGetSecret 取出直连上游，
   绝不发往 hub/服务端。
   @tauri-apps/api 一律动态 import（纪律同 harness.ts，非 Tauri 环境不静态引入）。 */

import { ProtocolError, fieldString, isObj } from "./api";

/** 列表行（byok_list 回包形状，snake_case 同 Rust 字段）：不含 api_key。 */
export interface ByokView {
  name: string;
  baseUrl: string;
  modelId: string;
}

/** 完整配置（byok_get_secret 回包形状）：含 api_key，仅发送路径使用。 */
export interface ByokSecret {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

function decodeView(v: unknown): ByokView {
  if (!isObj(v)) throw new ProtocolError("bad byok row");
  return {
    name: fieldString(v, "name") ?? "",
    baseUrl: fieldString(v, "base_url") ?? "",
    modelId: fieldString(v, "model_id") ?? "",
  };
}

function decodeSecret(v: unknown): ByokSecret {
  if (!isObj(v)) throw new ProtocolError("bad byok secret");
  return {
    baseUrl: fieldString(v, "base_url") ?? "",
    apiKey: fieldString(v, "api_key") ?? "",
    modelId: fieldString(v, "model_id") ?? "",
  };
}

/** invoke 回包是外部数据，先窄化再入内域。 */
export function decodeByokList(v: unknown): ByokView[] {
  if (!Array.isArray(v)) throw new ProtocolError("bad byok list");
  return v.map(decodeView);
}

export async function byokList(): Promise<ByokView[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return decodeByokList(await invoke("byok_list"));
}

export interface ByokSaveArgs {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export async function byokSave(args: ByokSaveArgs): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("byok_save", {
    name: args.name,
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    modelId: args.modelId,
  });
}

export async function byokDelete(name: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("byok_delete", { name });
}

export async function byokGetSecret(name: string): Promise<ByokSecret> {
  const { invoke } = await import("@tauri-apps/api/core");
  return decodeSecret(await invoke("byok_get_secret", { name }));
}
