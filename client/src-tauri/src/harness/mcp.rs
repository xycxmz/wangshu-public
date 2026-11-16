//! hub MCP 代理的客户端面：upstream 面板发现 + JSON-RPC tools/call 代理。
//! 治理（工具白名单/审计/凭证替换）全在 hub 侧，是权威边界，本地不再加审批；
//! 一切失败以错误字符串回模型自纠，不让任务失败（与 tools.rs 同一约定）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Deserialize;

use super::llm::truncate;

/// hub MCP 面板客户端。base_url/token 与 LlmClient 同源（同一个 hub）；
/// 一次 run() 持有一个实例，JSON-RPC id 用实例内自增计数。
pub struct McpClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
    next_id: AtomicU64,
}

/// Clone 供 spawn_subtask 派生：子任务复用同一客户端面（治理仍在 hub 侧）。
/// AtomicU64 无 Clone，取当前值重建计数起点（id 只需连接内可辨，跨实例重复无害）。
impl Clone for McpClient {
    fn clone(&self) -> Self {
        Self {
            base_url: self.base_url.clone(),
            token: self.token.clone(),
            http: self.http.clone(),
            next_id: AtomicU64::new(self.next_id.load(Ordering::Relaxed)),
        }
    }
}

impl McpClient {
    pub fn new(base_url: String, token: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        Self {
            base_url,
            token,
            http,
            next_id: AtomicU64::new(1),
        }
    }

    fn url(&self, suffix: &str) -> String {
        format!(
            "{}/api/v1/mcp/{suffix}",
            self.base_url.trim_end_matches('/')
        )
    }

    /// 列出可用 MCP 面板（只读发现面）。每行 `name（工具: a, b, c）`，
    /// 无白名单的面板为 `name（工具: 全部）`；禁用面板不可调用，不列出。
    /// 空清单返回可读占位文本而非错误。
    pub async fn list_upstreams(&self) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Resp {
            upstreams: Vec<Upstream>,
        }
        #[derive(Deserialize)]
        struct Upstream {
            name: String,
            #[serde(default)]
            allowed_tools: Vec<String>,
            enabled: bool,
        }
        let resp = self
            .http
            .get(self.url("upstreams"))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("read response failed: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "hub returned {}: {}",
                status.as_u16(),
                truncate(&text, 300)
            ));
        }
        let parsed: Resp =
            serde_json::from_str(&text).map_err(|e| format!("invalid response JSON: {e}"))?;
        let lines: Vec<String> = parsed
            .upstreams
            .iter()
            .filter(|u| u.enabled)
            .map(|u| {
                if u.allowed_tools.is_empty() {
                    format!("{}（工具: 全部）", u.name)
                } else {
                    format!("{}（工具: {}）", u.name, u.allowed_tools.join(", "))
                }
            })
            .collect();
        if lines.is_empty() {
            Ok("(no MCP upstreams)".to_string())
        } else {
            Ok(lines.join("\n"))
        }
    }

    /// 经 hub 代理调用 MCP 工具。成功返回 JSON-RPC result 的序列化文本；
    /// JSON-RPC error 对象（如 hub 白名单拒绝 -32603）同样序列化返回，治理
    /// 拒绝信息对模型可见；HTTP 4xx/5xx 取 body 截 2048 字符作错误串；
    /// arguments 非 JSON 对象在本地即拒绝，不发请求。
    pub async fn call(
        &self,
        upstream: &str,
        tool: &str,
        arguments: &str,
    ) -> Result<String, String> {
        if upstream.is_empty() || upstream.contains(['/', '\\']) {
            return Err(format!("invalid upstream name '{upstream}'"));
        }
        let args: serde_json::Value = match serde_json::from_str::<serde_json::Value>(arguments) {
            Ok(v) if v.is_object() => v,
            Ok(_) => {
                return Err(format!(
                    "invalid arguments JSON: expected an object, got '{arguments}'"
                ))
            }
            Err(e) => return Err(format!("invalid arguments JSON: {e}")),
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args },
        });
        let resp = self
            .http
            .post(self.url(&format!("{upstream}/proxy")))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("read response failed: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "hub returned {}: {}",
                status.as_u16(),
                truncate(&text, 2048)
            ));
        }
        #[derive(Deserialize)]
        struct Envelope {
            #[serde(default)]
            result: Option<serde_json::Value>,
            #[serde(default)]
            error: Option<serde_json::Value>,
        }
        let parsed: Envelope =
            serde_json::from_str(&text).map_err(|e| format!("invalid response JSON: {e}"))?;
        // JSON-RPC 二选一；两者俱在时 error 优先（拒绝语义不应被 result 掩盖）。
        let value = parsed
            .error
            .or(parsed.result)
            .ok_or_else(|| "response has neither result nor error".to_string())?;
        serde_json::to_string(&value).map_err(|e| format!("re-serialize failed: {e}"))
    }
}
