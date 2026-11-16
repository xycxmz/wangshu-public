//! BYOK 模型本地安全存储：OS keyring（Windows Credential Manager / macOS Keychain）。
//! 红线：api_key 只落本机凭据库，永不发往 hub/服务端。
//!
//! 存储形状：service=`company-platform.byok`，account=模型名，
//! secret=JSON `{"base_url","api_key","model_id"}`。
//! keyring Entry 无法枚举既有条目，另维护 account=`__index__` 的名字索引
//! （secret=JSON 字符串数组），所有增删同步维护。
//!
//! 写序约定（崩溃中间态只允许"索引外孤儿凭据"，不允许"索引指向缺失条目"）：
//! save 先写 secret 再写索引；delete 先写索引再删凭据。

use std::sync::{LazyLock, Mutex};

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};

// 历史命名（R8-B 改名前身份）：keyring service 改名即丢存量 BYOK key，勿动。
const SERVICE: &str = "company-platform.byok";
const INDEX_ACCOUNT: &str = "__index__";

/// 索引读-改-写跨两次 keyring 调用，串行化并发 save/delete。
static STORE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// 单条 BYOK 配置（keyring 里的 secret 形状，含 key，永不出命令边界以外）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ByokSecret {
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
}

/// 列表视图（对前端契约）：不含 api_key。
#[derive(Debug, Clone, Serialize)]
pub struct ByokView {
    pub name: String,
    pub base_url: String,
    pub model_id: String,
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("keyring 条目创建失败: {account} ({e})"))
}

fn decode_index(raw: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(raw).map_err(|e| format!("BYOK 索引 JSON 损坏: {e}"))
}

fn encode_index(names: &[String]) -> String {
    serde_json::to_string(names).unwrap_or_else(|_| "[]".to_string())
}

fn decode_secret(raw: &str) -> Result<ByokSecret, String> {
    serde_json::from_str(raw).map_err(|e| format!("BYOK secret JSON 损坏: {e}"))
}

fn index_upsert(mut names: Vec<String>, name: &str) -> Vec<String> {
    if !names.iter().any(|n| n == name) {
        names.push(name.to_string());
    }
    names
}

fn index_remove(names: Vec<String>, name: &str) -> Vec<String> {
    names.into_iter().filter(|n| n != name).collect()
}

fn read_index() -> Result<Vec<String>, String> {
    match entry(INDEX_ACCOUNT)?.get_password() {
        Ok(raw) => decode_index(&raw),
        Err(KeyringError::NoEntry) => Ok(Vec::new()),
        Err(e) => Err(format!("BYOK 索引读取失败: {e}")),
    }
}

fn write_index(names: &[String]) -> Result<(), String> {
    entry(INDEX_ACCOUNT)?
        .set_password(&encode_index(names))
        .map_err(|e| format!("BYOK 索引写入失败: {e}"))
}

/// 列出全部 BYOK 模型（不含 key）。索引里有、凭据已缺失的条目跳过。
#[tauri::command]
pub fn byok_list() -> Result<Vec<ByokView>, String> {
    let names = read_index()?;
    let mut views = Vec::with_capacity(names.len());
    for name in names {
        let raw = match entry(&name)?.get_password() {
            Ok(raw) => raw,
            Err(KeyringError::NoEntry) => continue,
            Err(e) => return Err(format!("BYOK '{name}' 读取失败: {e}")),
        };
        let secret = decode_secret(&raw).map_err(|e| format!("BYOK '{name}': {e}"))?;
        views.push(ByokView {
            name,
            base_url: secret.base_url,
            model_id: secret.model_id,
        });
    }
    Ok(views)
}

/// 新增/覆盖一条 BYOK 配置。空名/空 base_url/空 key Err；重名覆盖。
#[tauri::command]
pub fn byok_save(
    name: String,
    base_url: String,
    api_key: String,
    model_id: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    let base_url = base_url.trim().to_string();
    let model_id = model_id.trim().to_string();
    if name.is_empty() {
        return Err("name 不能为空".into());
    }
    if name == INDEX_ACCOUNT {
        return Err(format!("'{INDEX_ACCOUNT}' 是索引保留名"));
    }
    if base_url.is_empty() {
        return Err("base_url 不能为空".into());
    }
    if api_key.trim().is_empty() {
        return Err("api_key 不能为空".into());
    }

    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let payload = serde_json::to_string(&ByokSecret {
        base_url,
        api_key,
        model_id,
    })
    .map_err(|e| format!("BYOK secret 序列化失败: {e}"))?;
    entry(&name)?
        .set_password(&payload)
        .map_err(|e| format!("BYOK '{name}' 写入失败: {e}"))?;
    write_index(&index_upsert(read_index()?, &name))
}

/// 删除一条 BYOK 配置；不存在时 Ok（幂等）。
#[tauri::command]
pub fn byok_delete(name: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    write_index(&index_remove(read_index()?, &name))?;
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("BYOK '{name}' 删除失败: {e}")),
    }
}

/// 取完整配置（含 api_key），仅供发送路径直连上游使用。
/// P0 接受任意前端 invoke 可达；需收紧时在 tauri capabilities 中
/// 限制该命令的调用来源。
#[tauri::command]
pub fn byok_get_secret(name: String) -> Result<ByokSecret, String> {
    let raw = entry(&name)?
        .get_password()
        .map_err(|e| format!("BYOK '{name}' 读取失败: {e}"))?;
    decode_secret(&raw).map_err(|e| format!("BYOK '{name}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // keyring 真实调用需要 OS 凭据会话（CI 不可得），这里只测纯函数：
    // 索引 JSON 编解码、upsert/remove 去重幂等、secret JSON 往返与坏输入。

    #[test]
    fn index_upsert_dedupes_and_remove_is_idempotent() {
        let idx = index_upsert(Vec::new(), "a");
        let idx = index_upsert(idx, "b");
        let idx = index_upsert(idx, "a");
        assert_eq!(idx, vec!["a".to_string(), "b".to_string()]);
        let idx = index_remove(idx, "a");
        assert_eq!(idx, vec!["b".to_string()]);
        assert_eq!(index_remove(idx.clone(), "missing"), idx);
    }

    #[test]
    fn index_json_roundtrip_and_garbage_rejected() {
        let idx = vec!["a".to_string(), "b".to_string()];
        assert_eq!(decode_index(&encode_index(&idx)).unwrap(), idx);
        assert_eq!(decode_index("[]").unwrap(), Vec::<String>::new());
        assert!(decode_index("not json").is_err());
    }

    #[test]
    fn secret_json_roundtrip_and_missing_fields_rejected() {
        let s = ByokSecret {
            base_url: "https://api.example.com/v1".into(),
            api_key: "sk-x".into(),
            model_id: "m-1".into(),
        };
        let raw = serde_json::to_string(&s).unwrap();
        assert_eq!(decode_secret(&raw).unwrap(), s);
        assert!(decode_secret("{}").is_err());
        assert!(decode_secret("[]").is_err());
    }
}
