//! OpenAI 兼容非流式 chat/completions 客户端。P1 仅 hub 路由：
//! hub_url/token/model 由命令逐次传入，Rust 侧不持久化 token。

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::state::ChatMsg;

/// 一轮调用的 token 用量（OpenAI usage 字段）。上游不回 usage 时按 0 计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
}

/// Clone 供 spawn_subtask 派生：子任务复用同一客户端（reqwest::Client 内部是 Arc，廉价）。
#[derive(Clone)]
pub struct LlmClient {
    base_url: String,
    token: String,
    model: String,
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new(base_url: String, token: String, model: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_default();
        Self {
            base_url,
            token,
            model,
            http,
        }
    }

    /// 一轮对话。成功返回可直接回填 history 的 assistant 消息（含 tool_calls 线格式）
    /// 与本轮 usage。
    pub async fn chat(&self, messages: &[ChatMsg]) -> Result<(ChatMsg, Usage), String> {
        #[derive(Serialize)]
        struct Req<'a> {
            model: &'a str,
            messages: &'a [ChatMsg],
            tools: serde_json::Value,
        }
        #[derive(Deserialize)]
        struct Resp {
            choices: Vec<Choice>,
            #[serde(default)]
            usage: Option<Usage>,
        }
        #[derive(Deserialize)]
        struct Choice {
            message: ChatMsg,
        }

        let url = format!(
            "{}/api/v1/chat/completions",
            self.base_url.trim_end_matches('/')
        );
        let body = Req {
            model: &self.model,
            messages,
            tools: tool_definitions(),
        };
        let resp = self
            .http
            .post(&url)
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
                truncate(&text, 300)
            ));
        }
        let parsed: Resp =
            serde_json::from_str(&text).map_err(|e| format!("invalid response JSON: {e}"))?;
        let usage = parsed.usage.unwrap_or_default();
        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message)
            .map(|message| (message, usage))
            .ok_or_else(|| "response has no choices".to_string())
    }
}

/// tools 定义（OpenAI function calling 约定），与 tools.rs 的实现一一对应。
pub fn tool_definitions() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file inside the working directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the working directory." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Write text to a file inside the working directory. Held for user approval before it executes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the working directory." },
                        "content": { "type": "string", "description": "Full new file content." }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List entries of a directory inside the working directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Path relative to the working directory." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "load_skill",
                "description": "Load the full instructions of a skill by name. Available skill names are listed in the system prompt.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Skill name exactly as listed in the system prompt." }
                    },
                    "required": ["name"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "mcp_list_upstreams",
                "description": "List the MCP upstream panels reachable through the hub proxy, one line per panel with its tool allowlist. An empty allowlist means every tool is available. Call this before mcp_call to discover MCP capabilities.",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "mcp_call",
                "description": "Call a tool on an MCP upstream through the hub proxy. The hub enforces each upstream's tool allowlist; a denied or failed call returns the error text from the hub.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "upstream": { "type": "string", "description": "Upstream name exactly as listed by mcp_list_upstreams." },
                        "tool": { "type": "string", "description": "Tool name on that upstream." },
                        "arguments": { "type": "string", "description": "Tool arguments as JSON object text, e.g. \"{\\\"query\\\":\\\"...\\\"}\". Use {} when the tool takes no arguments." }
                    },
                    "required": ["upstream", "tool", "arguments"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "spawn_subtask",
                "description": "Spawn a synchronous subtask that pursues one self-contained sub-goal in the same working directory with the same tools, then return its final summary as the tool result. Writes inside the subtask still require user approval. A subtask cannot spawn further subtasks.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "goal": { "type": "string", "description": "Self-contained sub-goal for the subtask, in one or two sentences." }
                    },
                    "required": ["goal"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch an http(s) page and return its title and main text (read-only, no approval needed). Each task is limited to 10 calls; once the limit is reached, continue with the content already fetched.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "Absolute http(s) URL of the page to fetch." }
                    },
                    "required": ["url"]
                }
            }
        }
    ])
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…")
    }
}
