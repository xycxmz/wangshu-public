//! harness 领域类型与任务注册表。数据形状是对前端的契约，改动需与 UI 联动。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// 工具调用（OpenAI function call 解析后的域内表示）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolCall {
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        content: String,
    },
    ListDir {
        path: String,
    },
    /// 按名加载技能正文（免审批：只读扫描时已校验的信任目录内文件）。
    LoadSkill {
        name: String,
    },
    /// 列出 hub 侧可用 MCP 面板与工具白名单（免审批：只读发现面）。
    McpListUpstreams,
    /// 经 hub 代理调用白名单内 MCP 工具（免审批：治理在 hub 侧）。
    /// arguments 保持模型产出的 JSON 对象文本原样，执行时再解析（坏 JSON 回错误串自纠）。
    McpCall {
        upstream: String,
        tool: String,
        arguments: String,
    },
    /// 派生同步子任务（免审批：编排动作；子任务内的写操作仍走审批）。
    /// 深度限 1：子任务内再收到本调用直接回错误串，不递归。
    SpawnSubtask {
        goal: String,
    },
    /// 抓取网页为「title\n\n正文」文本（免审批：只读；预算见 tools::WEB_FETCH_CAP，
    /// 按 run() 调用计——子任务有独立预算）。
    WebFetch {
        url: String,
    },
}

impl ToolCall {
    /// 从 OpenAI function.name + function.arguments（JSON 字符串）解析。
    pub fn from_function(name: &str, arguments: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Args {
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            content: Option<String>,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            upstream: Option<String>,
            #[serde(default)]
            tool: Option<String>,
            #[serde(default)]
            arguments: Option<String>,
            #[serde(default)]
            goal: Option<String>,
            #[serde(default)]
            url: Option<String>,
        }
        let args: Args = serde_json::from_str(arguments)
            .map_err(|e| format!("invalid arguments for '{name}': {e}"))?;
        match name {
            "read_file" => Ok(Self::ReadFile {
                path: args.path.ok_or("read_file requires 'path'")?,
            }),
            "list_dir" => Ok(Self::ListDir {
                path: args.path.ok_or("list_dir requires 'path'")?,
            }),
            "write_file" => Ok(Self::WriteFile {
                path: args.path.ok_or("write_file requires 'path'")?,
                content: args.content.ok_or("write_file requires 'content'")?,
            }),
            "load_skill" => Ok(Self::LoadSkill {
                name: args.name.ok_or("load_skill requires 'name'")?,
            }),
            "mcp_list_upstreams" => Ok(Self::McpListUpstreams),
            "mcp_call" => Ok(Self::McpCall {
                upstream: args.upstream.ok_or("mcp_call requires 'upstream'")?,
                tool: args.tool.ok_or("mcp_call requires 'tool'")?,
                arguments: args.arguments.ok_or("mcp_call requires 'arguments'")?,
            }),
            "spawn_subtask" => Ok(Self::SpawnSubtask {
                goal: args.goal.ok_or("spawn_subtask requires 'goal'")?,
            }),
            "web_fetch" => Ok(Self::WebFetch {
                url: args.url.ok_or("web_fetch requires 'url'")?,
            }),
            other => Err(format!("unknown tool '{other}'")),
        }
    }
}

/// 任务状态机。序列化形如 `{"type":"awaiting_approval","step":1,"tool":…,"preview":…}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskState {
    Running {
        step: u32,
    },
    AwaitingApproval {
        step: u32,
        tool: ToolCall,
        preview: String,
    },
    Done {
        summary: String,
    },
    Failed {
        error: String,
    },
    Aborted,
}

/// OpenAI function call 的线格式（嵌在 assistant 消息里原样回传）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRaw {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

/// 直接建模 OpenAI chat 消息：system/user/assistant/tool 共用一种形状，
/// 请求序列化与响应解析复用；缺省字段不进 JSON。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallRaw>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMsg {
    pub fn system(content: &str) -> Self {
        Self {
            role: "system".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn user(content: &str) -> Self {
        Self {
            role: "user".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn tool(tool_call_id: &str, content: String) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: u64,
    pub goal: String,
    pub working_dir: PathBuf,
    pub history: Vec<ChatMsg>,
    pub state: TaskState,
    pub max_steps: u32,
    /// 派生深度：主任务 0，spawn_subtask 派生的子任务 1（上限，不再下探）。
    pub depth: u32,
    /// 累计 token 用量（每轮 LLM 响应后累加）。cost 不在客户端算：定价在 hub。
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 起飞时刻（unix ms）：统一任务列 started_at/elapsed 的源。
    pub started_ms: i64,
    /// 终态落定时刻（unix ms）；None=尚未终态。
    pub ended_ms: Option<i64>,
}

impl TaskState {
    /// 终态判定（Done/Failed/Aborted）：ended_ms 落定与历史落库共用的闸门。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            TaskState::Done { .. } | TaskState::Failed { .. } | TaskState::Aborted
        )
    }
}

impl Task {
    /// 首次转入终态时钉死结束时刻（幂等：后续终态快照不改写，elapsed 不漂移）。
    fn stamp_ended(&mut self) {
        if self.ended_ms.is_none() && self.state.is_terminal() {
            self.ended_ms = Some(crate::tasksdb::unix_ms());
        }
    }
}

/// 命令层到 loop 的控制面：abort 旗标、待审批 sender、起飞时刻。
/// loop 拥有 Task 本体，注册表只存状态快照，锁内不做 IO。
pub struct TaskControl {
    pub abort: Arc<AtomicBool>,
    pub pending: Option<oneshot::Sender<bool>>,
    pub started: Instant,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static TASKS: LazyLock<Mutex<HashMap<u64, Task>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static CONTROLS: LazyLock<Mutex<HashMap<u64, TaskControl>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_map<T, R>(lock: &Mutex<HashMap<u64, T>>, f: impl FnOnce(&mut HashMap<u64, T>) -> R) -> R {
    let mut guard = lock.lock().expect("harness registry lock poisoned");
    f(&mut guard)
}

pub fn next_task_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// 抬高任务号下限：app 启动时从持久化历史续接（重启后新任务不复用 "h<n>"
/// 覆盖旧历史记录）。只升不降，可与并发取号安全交错。
pub fn ensure_next_task_id_above(floor: u64) {
    NEXT_ID.fetch_max(floor + 1, Ordering::Relaxed);
}

pub fn insert_task(mut task: Task) {
    task.stamp_ended();
    let id = task.id;
    with_map(&TASKS, |m| {
        m.insert(id, task);
    });
}

pub fn update_task_state(id: u64, state: TaskState) {
    with_map(&TASKS, |m| {
        if let Some(t) = m.get_mut(&id) {
            t.state = state;
            t.stamp_ended();
        }
    });
}

/// loop 每次回调时同步注册表快照（状态 + 累计用量），锁内不做 IO。
pub fn update_task_progress(id: u64, task: &Task) {
    with_map(&TASKS, |m| {
        if let Some(t) = m.get_mut(&id) {
            t.state = task.state.clone();
            t.tokens_in = task.tokens_in;
            t.tokens_out = task.tokens_out;
            t.stamp_ended();
        }
    });
}

/// 注册表全量快照（终态驻留，进程级）：统一任务列的 harness 源。
pub fn snapshot() -> Vec<Task> {
    with_map(&TASKS, |m| m.values().cloned().collect())
}

pub fn task_state(id: u64) -> Option<TaskState> {
    with_map(&TASKS, |m| m.get(&id).map(|t| t.state.clone()))
}

pub fn task_usage(id: u64) -> Option<(u64, u64)> {
    with_map(&TASKS, |m| m.get(&id).map(|t| (t.tokens_in, t.tokens_out)))
}

pub fn insert_control(id: u64, abort: Arc<AtomicBool>) {
    with_map(&CONTROLS, |m| {
        m.insert(
            id,
            TaskControl {
                abort,
                pending: None,
                started: Instant::now(),
            },
        );
    });
}

pub fn remove_control(id: u64) {
    with_map(&CONTROLS, |m| {
        m.remove(&id);
    });
}

pub fn get_abort_flag(id: u64) -> Option<Arc<AtomicBool>> {
    with_map(&CONTROLS, |m| m.get(&id).map(|c| Arc::clone(&c.abort)))
}

pub fn set_pending_approval(id: u64, tx: oneshot::Sender<bool>) {
    with_map(&CONTROLS, |m| {
        if let Some(c) = m.get_mut(&id) {
            c.pending = Some(tx);
        }
    });
}

pub fn take_pending_approval(id: u64) -> Option<oneshot::Sender<bool>> {
    with_map(&CONTROLS, |m| m.get_mut(&id).and_then(|c| c.pending.take()))
}

pub fn control_started(id: u64) -> Option<Instant> {
    with_map(&CONTROLS, |m| m.get(&id).map(|c| c.started))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// load_skill 的 serde tag 是对前端的契约（harness.ts 判别联合），锁死线格式。
    #[test]
    fn load_skill_serializes_with_snake_case_tag() {
        let call = ToolCall::from_function("load_skill", r#"{"name":"demo"}"#).unwrap();
        assert_eq!(
            call,
            ToolCall::LoadSkill {
                name: "demo".into()
            }
        );
        assert_eq!(
            serde_json::to_string(&call).unwrap(),
            r#"{"type":"load_skill","name":"demo"}"#
        );
    }

    /// mcp 两变体的线格式同样是对前端的契约（harness.ts 判别联合），锁死 tag 与字段名。
    #[test]
    fn mcp_tools_serialize_with_snake_case_tag() {
        assert_eq!(
            serde_json::to_string(&ToolCall::McpListUpstreams).unwrap(),
            r#"{"type":"mcp_list_upstreams"}"#
        );
        let call = ToolCall::from_function(
            "mcp_call",
            r#"{"upstream":"demo","tool":"search","arguments":"{\"q\":1}"}"#,
        )
        .unwrap();
        assert_eq!(
            call,
            ToolCall::McpCall {
                upstream: "demo".into(),
                tool: "search".into(),
                arguments: "{\"q\":1}".into(),
            }
        );
        assert_eq!(
            serde_json::to_string(&call).unwrap(),
            r#"{"type":"mcp_call","upstream":"demo","tool":"search","arguments":"{\"q\":1}"}"#
        );
    }

    /// spawn_subtask 的线格式同样是对前端的契约（harness.ts 判别联合），锁死 tag 与字段名。
    #[test]
    fn spawn_subtask_serializes_with_snake_case_tag() {
        let call = ToolCall::from_function("spawn_subtask", r#"{"goal":"整理子目录"}"#).unwrap();
        assert_eq!(
            call,
            ToolCall::SpawnSubtask {
                goal: "整理子目录".into()
            }
        );
        assert_eq!(
            serde_json::to_string(&call).unwrap(),
            r#"{"type":"spawn_subtask","goal":"整理子目录"}"#
        );
        assert!(ToolCall::from_function("spawn_subtask", "{}").is_err());
    }

    /// from_function 认识的每个工具必须出现在 function-calling 定义里，否则模型学不到。
    #[test]
    fn advertised_tools_stay_in_sync_with_from_function() {
        let defs = serde_json::to_string(&crate::harness::llm::tool_definitions()).unwrap();
        for name in [
            "read_file",
            "write_file",
            "list_dir",
            "load_skill",
            "mcp_list_upstreams",
            "mcp_call",
            "spawn_subtask",
            "web_fetch",
        ] {
            assert!(
                defs.contains(&format!("\"name\":\"{name}\"")),
                "missing tool definition: {name}"
            );
        }
    }

    /// web_fetch 的线格式同样是对前端的契约（harness.ts 判别联合），锁死 tag 与字段名。
    #[test]
    fn web_fetch_serializes_with_snake_case_tag() {
        let call = ToolCall::from_function("web_fetch", r#"{"url":"https://example.com"}"#).unwrap();
        assert_eq!(
            call,
            ToolCall::WebFetch {
                url: "https://example.com".into()
            }
        );
        assert_eq!(
            serde_json::to_string(&call).unwrap(),
            r#"{"type":"web_fetch","url":"https://example.com"}"#
        );
        assert!(ToolCall::from_function("web_fetch", "{}").is_err());
    }

    /// 任务号续接持久化历史：抬底后取号必高于底，且只升不降。
    #[test]
    fn task_id_continues_above_persisted_floor() {
        let taken = next_task_id();
        ensure_next_task_id_above(taken + 10);
        assert!(next_task_id() > taken + 10);
    }

    fn probe_task(id: u64) -> Task {
        Task {
            id,
            goal: "探针目标".into(),
            working_dir: PathBuf::from("."),
            history: Vec::new(),
            state: TaskState::Running { step: 0 },
            max_steps: 1,
            depth: 0,
            tokens_in: 0,
            tokens_out: 0,
            started_ms: 1_000,
            ended_ms: None,
        }
    }

    /// 终态转移钉死 ended_ms 且幂等（再转移不改写，elapsed 不随时间漂移）；
    /// snapshot 全量可见（统一任务列的 harness 源含终态驻留）。
    #[test]
    fn registry_stamps_ended_once_and_snapshots() {
        let id = next_task_id();
        insert_task(probe_task(id));
        assert!(
            snapshot()
                .iter()
                .find(|t| t.id == id)
                .expect("insert 后 snapshot 必须可见")
                .ended_ms
                .is_none(),
            "非终态不得有 ended_ms"
        );
        update_task_state(id, TaskState::Failed { error: "x".into() });
        let stamped = snapshot().into_iter().find(|t| t.id == id).unwrap();
        let ended = stamped.ended_ms.expect("终态转移必须钉死 ended_ms");
        assert!(ended >= 1_000);
        update_task_state(id, TaskState::Aborted);
        let again = snapshot().into_iter().find(|t| t.id == id).unwrap();
        assert_eq!(again.ended_ms, Some(ended), "后续转移不得改写 ended_ms");
        assert_eq!(again.started_ms, 1_000, "started_ms 不随转移漂移");
    }
}
