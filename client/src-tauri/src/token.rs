//! hub 登录 token 本地安全存储：OS keyring（Windows Credential Manager / macOS Keychain）。
//! 红线：token 只落本机凭据库，除登录请求本身外永不发往 hub/服务端。
//!
//! 存储形状沿用 byok.rs 惯例：service=`company-platform.auth`、account=`auth_token`。
//! service 与 BYOK 分离是刻意的：BYOK 条目名是用户输入，同 service 会让
//! 名为 "auth_token" 的模型条目与登录 token 互相覆盖。

use keyring::{Entry, Error as KeyringError};

// 历史命名（R8-B 改名前身份）：keyring service 改名即丢存量登录凭据，勿动。
const SERVICE: &str = "company-platform.auth";
const ACCOUNT: &str = "auth_token";

fn entry_at(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| format!("keyring 条目创建失败: {account} ({e})"))
}

fn token_get_at(account: &str) -> Result<String, String> {
    match entry_at(account)?.get_password() {
        Ok(raw) => Ok(raw),
        Err(KeyringError::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("token 读取失败: {e}")),
    }
}

fn token_set_at(account: &str, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("token 不能为空（清除走 token_clear）".into());
    }
    entry_at(account)?
        .set_password(token)
        .map_err(|e| format!("token 写入失败: {e}"))
}

fn token_clear_at(account: &str) -> Result<(), String> {
    match entry_at(account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("token 删除失败: {e}")),
    }
}

/// 读 token；无条目返回空串（前端登录态判定沿用旧 getToken 的空串语义）。
#[tauri::command]
pub fn token_get() -> Result<String, String> {
    token_get_at(ACCOUNT)
}

/// 写 token（登录/迁移路径）。空值 Err：把「清除」写成空串条目会卡死迁移收敛。
#[tauri::command]
pub fn token_set(token: String) -> Result<(), String> {
    token_set_at(ACCOUNT, &token)
}

/// 清 token；不存在时 Ok（幂等：退出与 401 都可能重复触发）。
#[tauri::command]
pub fn token_clear() -> Result<(), String> {
    token_clear_at(ACCOUNT)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 真 keyring 往返探针：走与命令同款的 _at 路径但用独立探针 account，
    // 不碰真实 auth_token 条目；无 OS 凭据会话的机器（无头 CI）跳过不判。

    const PROBE: &str = "__probe__";

    #[test]
    fn empty_token_rejected_without_keyring_write() {
        assert!(token_set_at(PROBE, "").is_err());
        assert!(token_set_at(PROBE, "   ").is_err());
    }

    #[test]
    fn set_get_overwrite_clear_roundtrip_when_keyring_available() {
        if token_set_at(PROBE, "probe-1").is_err() {
            eprintln!("[token] keyring 不可用，跳过往返探针");
            return;
        }
        assert_eq!(token_get_at(PROBE).unwrap(), "probe-1");
        token_set_at(PROBE, "probe-2").unwrap();
        assert_eq!(token_get_at(PROBE).unwrap(), "probe-2", "覆盖写（登录刷新）");
        token_clear_at(PROBE).unwrap();
        assert_eq!(token_get_at(PROBE).unwrap(), "", "删除后回落空串");
        token_clear_at(PROBE).unwrap();
    }
}
