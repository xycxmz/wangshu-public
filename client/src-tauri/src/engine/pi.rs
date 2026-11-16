//! PI 方言适配（pi `--mode rpc` 私有协议；版本升级前跑契约测试）。
//! 传输严格 JSONL：按字节 \n 切分、剥行尾 CR——U+2028/2029 在 JSON 字符串内
//! 合法，禁用通用 line reader（sidecar::read_lines 是字节级实现，直接复用）。
//! 协议事实来自 pi 自带 docs/rpc*.md + json.md，本机实跑核对过；会话方言按
//! 实装 0.73.1（2026-11-14）：无 --session-id flag，续会 = --session <path|id>
//! 且仅命中既有文件才传，新会话 uuid 经启动即发的 get_state 响应回传。

use std::path::Path;
use std::sync::Arc;

use tokio::process::{ChildStderr, ChildStdout};

use super::{emit_update, EngineEvent, Session};
use crate::sidecar::{self, state::ProcHandle};

/// 输出泵：stdout 逐行映射归一事件并 emit（经 usage_updated 去重）；stderr 只
/// 排空防管道积压（协议约定 stdout 才是数据面）。stdout EOF 后收割退出码、
/// 摘表、发 Exit。
pub async fn pump(
    id: u64,
    session: Arc<Session>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    app: tauri::AppHandle,
) {
    // 会话 uuid 回传：启动即问一次状态，其成功响应经 map_line 出 SessionStarted
    // （前端「自动续上次」需要 pi 裸起新会话时实铸的 uuid）。发送失败说明引擎
    // 已在退出边缘，Exit 事件随后来临。
    if let Err(e) = session.send(Command::GetState).await {
        eprintln!("[engine:pi] 初始 get_state 发送失败: {e}");
    }
    let drain = tauri::async_runtime::spawn(async move {
        sidecar::read_lines(stderr, |line| eprintln!("[engine:pi:stderr] {line}")).await;
    });
    let mut last_usage: Option<(u64, u64)> = None;
    let emitter = Arc::new(app);
    let register = Arc::clone(&session);
    sidecar::read_lines(stdout, |line| {
        let mapped = map_line(line);
        if let Some((req_id, method)) = mapped.pending_confirm {
            register.register_confirm(req_id, method);
        }
        for event in mapped.events {
            if usage_updated(&mut last_usage, &event) {
                emit_update(&emitter, id, &event);
            }
        }
    })
    .await;
    // stderr 排空任务限时等待：进程死后管道必关，超时说明有泄漏，放弃等待。
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), drain).await;
    let code = {
        let mut child = session.proc.child.lock().await;
        child.wait().await.ok().and_then(|status| status.code())
    };
    super::remove_session(id);
    emit_update(&emitter, id, &EngineEvent::Exit { code });
}

/// Usage 去重闸（pump 用）：message_update 每条都携带累计 usage，重复值不重发
/// （前端最后值生效，语义不变、事件量降一个数量级）；值变化或非 Usage 事件放行。
fn usage_updated(last_usage: &mut Option<(u64, u64)>, event: &EngineEvent) -> bool {
    if let EngineEvent::Usage {
        tokens_in,
        tokens_out,
    } = event
    {
        if *last_usage == Some((*tokens_in, *tokens_out)) {
            return false;
        }
        *last_usage = Some((*tokens_in, *tokens_out));
    }
    true
}

/// 解析出的 pi 可执行 + rpc 参数 → 子进程三管道。复用 sidecar 的 which/包装
/// （npm .cmd shim 经 cmd /C 拉起）与 CREATE_NO_WINDOW/kill_on_drop。
pub fn spawn(
    cwd: &Path,
    provider: Option<&str>,
    model: Option<&str>,
    session_dir: &Path,
    session_id: Option<&str>,
) -> Result<(Session, ChildStdout, ChildStderr), String> {
    let exe = sidecar::state::resolve_executable("pi")
        .ok_or("pi 未安装在 PATH 上（设置 → 环境可查看安装指引）")?;
    let mut command =
        sidecar::build_command(&exe, &spawn_args(provider, model, session_dir, session_id)?);
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(sidecar::CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|e| format!("启动 pi 失败: {e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let handle = Arc::new(ProcHandle::new(pid, child, stdin));
    Ok((
        Session::new(handle),
        stdout.expect("piped stdout"),
        stderr.expect("piped stderr"),
    ))
}

/// pi CLI 约束：--provider 必须与 --model 同传（--model 可单独用，支持
/// "provider/id" 形式）。续会（pi 0.73.1 实测 2026-11-14）：无 --session-id
/// flag，--session <path|id> 按部分 uuid 自匹配且不 create-or-reuse——只在
/// session_dir 下命中既有 <ts>_<uuid>.jsonl 时传；未命中裸起（旧会话文件
/// 缺失=新起，硬传会 "No session found" 崩出）。
pub fn spawn_args(
    provider: Option<&str>,
    model: Option<&str>,
    session_dir: &Path,
    session_id: Option<&str>,
) -> Result<Vec<String>, String> {
    if provider.is_some() && model.is_none() {
        return Err("--provider 需与 --model 同传（pi CLI 约束）".to_string());
    }
    let mut args = vec![
        "--mode".into(),
        "rpc".into(),
        "--session-dir".into(),
        session_dir.to_string_lossy().into_owned(),
    ];
    if let Some(id) = session_id.filter(|id| !id.is_empty()) {
        if session_file_matches(session_dir, id) {
            args.push("--session".into());
            args.push(id.into());
        }
    }
    if let Some(p) = provider {
        args.push("--provider".into());
        args.push(p.into());
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.into());
    }
    Ok(args)
}

/// session_dir 下是否有文件名包含该 id 的 .jsonl（pi 会话文件名
/// `<ts>_<uuid>.jsonl`，uuid 段即 --session 的匹配面）。目录不可读视同未命中。
fn session_file_matches(session_dir: &Path, id: &str) -> bool {
    std::fs::read_dir(session_dir)
        .map(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.ends_with(".jsonl") && name.contains(id)
            })
        })
        .unwrap_or(false)
}

/// stdin 命令（可带 id 供响应关联；pi 异步处理，必须按 id 而非顺序对账）。
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// 新任务/续问。刻意不带 streamingBehavior：流式中 pi 会拒绝并回错误事件，
    /// 插话走 Steer。
    Prompt { text: String },
    /// 流式中插话（本轮工具执行完、下次调模型前投递）。
    Steer { text: String },
    /// 本轮结束后投递的追问。
    FollowUp { text: String },
    /// 中止当前操作。
    Abort,
    /// 查询会话状态。pump 启动即发一条：成功响应携带 sessionId，是 SessionStarted
    /// （会话 uuid 回传）的数据源；真 pi 集成测试也用它做命令往返验证。
    GetState,
}

/// 一条命令序列化为一行 JSONL（不含换行符，由 write_line 补）。
pub fn command_line(id: &str, cmd: &Command) -> String {
    let mut record = match cmd {
        Command::Prompt { text } => serde_json::json!({"type": "prompt", "message": text}),
        Command::Steer { text } => serde_json::json!({"type": "steer", "message": text}),
        Command::FollowUp { text } => serde_json::json!({"type": "follow_up", "message": text}),
        Command::Abort => serde_json::json!({"type": "abort"}),
        Command::GetState => serde_json::json!({"type": "get_state"}),
    };
    record["id"] = serde_json::json!(id);
    serde_json::to_string(&record).expect("Value 序列化不会失败")
}

/// extension_ui_response 三形态：cancelled（任何对话框可撤销）/ value（input
/// 型）/ confirmed（confirm 型）。
pub fn confirm_response_line(req_id: &str, confirmed: bool, value: Option<&str>) -> String {
    let record = if !confirmed {
        serde_json::json!({"type": "extension_ui_response", "id": req_id, "cancelled": true})
    } else if let Some(text) = value {
        serde_json::json!({"type": "extension_ui_response", "id": req_id, "value": text})
    } else {
        serde_json::json!({"type": "extension_ui_response", "id": req_id, "confirmed": true})
    };
    serde_json::to_string(&record).expect("Value 序列化不会失败")
}

/// 一行 stdout 记录的映射结果：归一事件（可多条，message_update 同时携带
/// delta 与 usage）+ 需登记的待响应确认（id, method）。
#[derive(Debug, Default, PartialEq)]
pub struct MappedLine {
    pub events: Vec<EngineEvent>,
    pub pending_confirm: Option<(String, String)>,
}

fn one(event: EngineEvent) -> MappedLine {
    MappedLine {
        events: vec![event],
        pending_confirm: None,
    }
}

/// 线格式 → 归一事件。未知/不关心的记录静默跳过（协议前向兼容），坏 JSON
/// 不 panic。字段缺失一律取默认值而非报错：事件流是尽力而为的数据面。
pub fn map_line(line: &str) -> MappedLine {
    let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
        return MappedLine::default();
    };
    match record["type"].as_str() {
        Some("agent_settled") => one(EngineEvent::Settled),
        Some("message_update") => map_message_update(&record),
        Some("tool_execution_start") => one(EngineEvent::ToolStart {
            name: str_field(&record["toolName"]),
            args_json: record
                .get("args")
                .map(|a| a.to_string())
                .unwrap_or_default(),
        }),
        Some("tool_execution_end") => one(EngineEvent::ToolEnd {
            name: str_field(&record["toolName"]),
            is_error: record["isError"].as_bool().unwrap_or(false),
        }),
        Some("extension_ui_request") => map_ui_request(&record),
        Some("response") => match record["success"].as_bool() {
            Some(false) => one(EngineEvent::Error {
                message: str_field(&record["error"]),
            }),
            _ => {
                // get_state 成功响应携带 data.sessionId（pi 0.73.1 实测）：pump
                // 启动即发一条，借此回传 pi 实铸的会话 uuid。其余成功响应静默。
                let session_id = str_field(&record["data"]["sessionId"]);
                if record["command"] == "get_state" && !session_id.is_empty() {
                    one(EngineEvent::SessionStarted { session_id })
                } else {
                    MappedLine::default()
                }
            }
        },
        _ => MappedLine::default(),
    }
}

fn map_message_update(record: &serde_json::Value) -> MappedLine {
    let mut events = Vec::new();
    if let Some(event) = record.get("assistantMessageEvent") {
        match event["type"].as_str() {
            Some("text_delta") => events.push(EngineEvent::TextDelta {
                text: str_field(&event["delta"]),
            }),
            Some("thinking_delta") => events.push(EngineEvent::ThinkingDelta {
                text: str_field(&event["delta"]),
            }),
            Some("toolcall_start") => events.push(EngineEvent::ToolStart {
                name: str_field(&event["toolName"]),
                args_json: String::new(),
            }),
            Some("toolcall_end") => events.push(EngineEvent::ToolEnd {
                name: str_field(&event["toolCall"]["name"]),
                is_error: false,
            }),
            _ => {}
        }
    }
    if let Some(usage) = record.get("usage") {
        events.push(EngineEvent::Usage {
            tokens_in: usage["input"].as_u64().unwrap_or(0),
            tokens_out: usage["output"].as_u64().unwrap_or(0),
        });
    }
    MappedLine {
        events,
        pending_confirm: None,
    }
}

/// extension_ui_request：confirm/input 是阻塞式对话框（映射审批卡并登记待
/// 响应表），其余方法 fire-and-forget，记 stderr 后忽略。
fn map_ui_request(record: &serde_json::Value) -> MappedLine {
    let method = str_field(&record["method"]);
    if method != "confirm" && method != "input" {
        eprintln!("[engine:pi] 忽略 extension_ui_request method={method}");
        return MappedLine::default();
    }
    let req_id = str_field(&record["id"]);
    MappedLine {
        events: vec![EngineEvent::ConfirmRequest {
            id: req_id.clone(),
            title: str_field(&record["title"]),
            message: record["message"]
                .as_str()
                .or_else(|| record["placeholder"].as_str())
                .unwrap_or("")
                .to_string(),
        }],
        pending_confirm: Some((req_id, method)),
    }
}

fn str_field(value: &serde_json::Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncWriteExt as _;

    fn events_of(line: &str) -> Vec<EngineEvent> {
        map_line(line).events
    }

    #[test]
    fn text_delta_maps_to_text_delta_event() {
        let line = r#"{"type":"message_update","usage":{"input":100,"output":1},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}"#;
        assert_eq!(
            events_of(line),
            vec![
                EngineEvent::TextDelta {
                    text: "Hello ".into()
                },
                EngineEvent::Usage {
                    tokens_in: 100,
                    tokens_out: 1
                },
            ]
        );
    }

    #[test]
    fn thinking_delta_maps_to_thinking_delta_event() {
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":1,"delta":"考虑中"}}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::ThinkingDelta {
                text: "考虑中".into()
            }]
        );
    }

    /// toolcall_start 阶段参数尚未流完：args_json 为空串，UI 先出名字。
    #[test]
    fn toolcall_start_maps_to_tool_start_with_empty_args() {
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":2,"id":"call_abc","toolName":"bash"}}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::ToolStart {
                name: "bash".into(),
                args_json: String::new(),
            }]
        );
    }

    /// toolcall_end 携带完整 ToolCall（调用层完成，尚未执行，is_error 恒 false）。
    #[test]
    fn toolcall_end_maps_to_tool_end_from_complete_call() {
        let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":2,"toolCall":{"type":"toolCall","id":"call_abc","name":"read","arguments":{"path":"a.txt"}}}}"#;
        assert_eq!(
            events_of(line)[0],
            EngineEvent::ToolEnd {
                name: "read".into(),
                is_error: false,
            }
        );
    }

    /// tool_execution_start 的 args 是完整对象：紧凑序列化为 args_json。
    #[test]
    fn tool_execution_start_maps_to_tool_start_with_serialized_args() {
        let line = r#"{"type":"tool_execution_start","toolCallId":"call_abc","toolName":"bash","args":{"command":"ls -la"}}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::ToolStart {
                name: "bash".into(),
                args_json: r#"{"command":"ls -la"}"#.into(),
            }]
        );
    }

    #[test]
    fn tool_execution_end_maps_to_tool_end_with_is_error() {
        let ok = r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[]},"isError":false,"durationMs":12}"#;
        let bad = r#"{"type":"tool_execution_end","toolCallId":"c2","toolName":"edit","result":{"content":[]},"isError":true}"#;
        assert_eq!(
            events_of(ok),
            vec![EngineEvent::ToolEnd {
                name: "bash".into(),
                is_error: false,
            }]
        );
        assert_eq!(
            events_of(bad),
            vec![EngineEvent::ToolEnd {
                name: "edit".into(),
                is_error: true,
            }]
        );
    }

    /// usage 是 message_update 顶层字段、累计值直接透传；缺字段按 0 容错。
    #[test]
    fn usage_passthrough_and_tolerates_missing_fields() {
        let zero_input = r#"{"type":"message_update","usage":{"output":7},"assistantMessageEvent":{"type":"text_delta","delta":"x"}}"#;
        assert_eq!(
            events_of(zero_input)[1],
            EngineEvent::Usage {
                tokens_in: 0,
                tokens_out: 7
            }
        );
        let null_usage = r#"{"type":"message_update","usage":null,"assistantMessageEvent":{"type":"text_delta","delta":"x"}}"#;
        assert_eq!(
            events_of(null_usage)[1],
            EngineEvent::Usage {
                tokens_in: 0,
                tokens_out: 0
            },
            "usage 为 null 不产生事件外的噪音字段"
        );
    }

    #[test]
    fn agent_settled_maps_to_settled() {
        assert_eq!(
            events_of(r#"{"type":"agent_settled","aborted":false}"#),
            vec![EngineEvent::Settled]
        );
    }

    /// aborted 路径同样归一到 Settled：本轮已静止，aborted 细节 UI 可后续再要。
    #[test]
    fn aborted_settled_still_maps_to_settled() {
        assert_eq!(
            events_of(r#"{"type":"agent_settled","aborted":true}"#),
            vec![EngineEvent::Settled]
        );
    }

    /// usage 字段单独出现的 message_update（无 assistantMessageEvent）也透传。
    #[test]
    fn message_update_with_usage_only_yields_usage_event() {
        let line = r#"{"type":"message_update","usage":{"input":42,"output":9}}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::Usage {
                tokens_in: 42,
                tokens_out: 9
            }]
        );
    }

    /// 未映射的 delta 形态（toolcall_delta/text_end/thinking_end/start）静默跳过：
    /// 前端按 delta 自拼、以 *_end 的权威内容为准是后续增强，不进当前契约。
    #[test]
    fn unmapped_assistant_event_types_produce_no_delta_events() {
        for inner in [
            r#"{"type":"toolcall_delta","contentIndex":2,"delta":"{\"a\":1}"}"#,
            r#"{"type":"text_end","contentIndex":0,"content":"全文"}"#,
            r#"{"type":"thinking_end","contentIndex":1,"content":"全思考"}"#,
            r#"{"type":"text_start","contentIndex":0}"#,
        ] {
            let line = format!(r#"{{"type":"message_update","assistantMessageEvent":{inner}}}"#);
            assert!(events_of(&line).is_empty(), "未映射形态不得出事件: {inner}");
        }
    }

    /// 字段缺失的容错面：名字/错误标志/参数缺省不 panic、取安全默认。
    #[test]
    fn mapping_tolerates_missing_optional_fields() {
        let exec_start_no_args =
            r#"{"type":"tool_execution_start","toolCallId":"c1","toolName":"read"}"#;
        assert_eq!(
            events_of(exec_start_no_args),
            vec![EngineEvent::ToolStart {
                name: "read".into(),
                args_json: String::new(),
            }]
        );
        let exec_end_no_flag =
            r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"read"}"#;
        assert_eq!(
            events_of(exec_end_no_flag),
            vec![EngineEvent::ToolEnd {
                name: "read".into(),
                is_error: false,
            }]
        );
        let call_end_no_toolcall =
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end"}}"#;
        assert_eq!(
            events_of(call_end_no_toolcall),
            vec![EngineEvent::ToolEnd {
                name: String::new(),
                is_error: false,
            }]
        );
        let confirm_no_text = r#"{"type":"extension_ui_request","id":"u1","method":"confirm"}"#;
        let mapped = map_line(confirm_no_text);
        assert_eq!(
            mapped.events,
            vec![EngineEvent::ConfirmRequest {
                id: "u1".into(),
                title: String::new(),
                message: String::new(),
            }]
        );
        assert_eq!(
            mapped.pending_confirm,
            Some(("u1".into(), "confirm".into()))
        );
    }

    /// 失败响应缺 error 字段：Error 事件仍发出（空串正文），不吞错。
    #[test]
    fn failed_response_without_error_field_still_emits_error() {
        let line = r#"{"type":"response","command":"abort","success":false}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::Error {
                message: String::new()
            }]
        );
    }

    /// success 字段缺失的响应按无事件处理（不臆断成败）。
    #[test]
    fn response_without_success_field_produces_no_event() {
        let line = r#"{"id":"c1","type":"response","command":"prompt"}"#;
        assert_eq!(map_line(line), MappedLine::default());
    }

    /// 记录携带未知附加字段（协议前向演进）不影响映射。
    #[test]
    fn unknown_extra_fields_do_not_break_mapping() {
        let line = r#"{"type":"agent_settled","aborted":false,"futureField":{"x":1}}"#;
        assert_eq!(events_of(line), vec![EngineEvent::Settled]);
    }

    /// confirm 对话框：title/message 全量映射，且登记 (id, method) 待响应。
    #[test]
    fn confirm_request_maps_and_registers_pending() {
        let line = r#"{"type":"extension_ui_request","id":"uuid-2","method":"confirm","title":"Clear session?","message":"All messages will be lost.","timeout":5000}"#;
        let mapped = map_line(line);
        assert_eq!(
            mapped.events,
            vec![EngineEvent::ConfirmRequest {
                id: "uuid-2".into(),
                title: "Clear session?".into(),
                message: "All messages will be lost.".into(),
            }]
        );
        assert_eq!(
            mapped.pending_confirm,
            Some(("uuid-2".to_string(), "confirm".to_string()))
        );
    }

    /// input 对话框没有 message 字段：placeholder 兜底为审批卡正文。
    #[test]
    fn input_request_falls_back_to_placeholder() {
        let line = r#"{"type":"extension_ui_request","id":"uuid-3","method":"input","title":"Enter a value","placeholder":"type something..."}"#;
        let mapped = map_line(line);
        assert_eq!(
            mapped.events,
            vec![EngineEvent::ConfirmRequest {
                id: "uuid-3".into(),
                title: "Enter a value".into(),
                message: "type something...".into(),
            }]
        );
        assert_eq!(
            mapped.pending_confirm,
            Some(("uuid-3".to_string(), "input".to_string()))
        );
    }

    /// input 同时带 message 与 placeholder 时 message 优先（confirm 语义正文）。
    #[test]
    fn input_request_prefers_message_over_placeholder() {
        let line = r#"{"type":"extension_ui_request","id":"u2","method":"input","title":"t","message":"正文","placeholder":"占位"}"#;
        assert_eq!(
            map_line(line).events,
            vec![EngineEvent::ConfirmRequest {
                id: "u2".into(),
                title: "t".into(),
                message: "正文".into(),
            }]
        );
    }

    /// method 缺失/空串的 extension_ui_request：按未知方法忽略，不登记待响应。
    #[test]
    fn ui_request_without_method_is_ignored() {
        assert_eq!(
            map_line(r#"{"type":"extension_ui_request","id":"u3"}"#),
            MappedLine::default()
        );
        assert_eq!(
            map_line(r#"{"type":"extension_ui_request","id":"u3","method":""}"#),
            MappedLine::default()
        );
    }

    /// fire-and-forget 方法（notify/select/editor/setStatus…）不出事件也不登记。
    #[test]
    fn non_dialog_ui_requests_are_ignored() {
        for line in [
            r#"{"type":"extension_ui_request","id":"u","method":"notify","message":"done","notifyType":"warning"}"#,
            r#"{"type":"extension_ui_request","id":"u","method":"select","title":"Pick","options":["a","b"]}"#,
            r#"{"type":"extension_ui_request","id":"u","method":"editor","title":"Edit","prefill":"x"}"#,
            r#"{"type":"extension_ui_request","id":"u","method":"setStatus","statusKey":"k","statusText":"t"}"#,
            r#"{"type":"extension_ui_request","id":"u","method":"setWidget","widgetKey":"k","widgetLines":["a"]}"#,
        ] {
            assert_eq!(map_line(line), MappedLine::default(), "line: {line}");
        }
    }

    /// 失败响应原样回流 Error 事件（含 parse 型：我们发的坏 JSON 也会得到）。
    #[test]
    fn failed_response_maps_to_error_event_with_verbatim_message() {
        let line = r#"{"id":"c1","type":"response","command":"prompt","success":false,"error":"Cannot prompt while streaming without streamingBehavior"}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::Error {
                message: "Cannot prompt while streaming without streamingBehavior".into()
            }]
        );
        let parse = r#"{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token"}"#;
        assert_eq!(
            events_of(parse),
            vec![EngineEvent::Error {
                message: "Failed to parse command: Unexpected token".into()
            }]
        );
    }

    /// 成功响应被内部消费（id 对账留待需要时），不向前端转发。
    #[test]
    fn successful_response_produces_no_event() {
        let line = r#"{"id":"c1","type":"response","command":"get_state","success":true,"data":{"isStreaming":false}}"#;
        assert_eq!(map_line(line), MappedLine::default());
    }

    /// get_state 成功响应携带 data.sessionId（pi 0.73.1 实测）：映射为
    /// SessionStarted 回传——pump 启动即发一条，前端「自动续上次」靠它拿
    /// pi 裸起新会话时实铸的 uuid。
    #[test]
    fn get_state_success_response_maps_to_session_started() {
        let line = r#"{"id":"c1","type":"response","command":"get_state","success":true,"data":{"sessionId":"01a1d916-b7f5-70a8-b141-735b17f12759","sessionFile":"C:\\s\\2026-01-01T00-00-00-000Z_01a1d916-b7f5-70a8-b141-735b17f12759.jsonl"}}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::SessionStarted {
                session_id: "01a1d916-b7f5-70a8-b141-735b17f12759".into()
            }]
        );
    }

    /// 非 get_state 的成功响应仍静默；get_state 缺 sessionId 不臆造事件。
    #[test]
    fn other_success_responses_and_missing_session_id_stay_silent() {
        assert_eq!(
            map_line(
                r#"{"id":"c1","type":"response","command":"prompt","success":true,"data":{"sessionId":"x"}}"#
            ),
            MappedLine::default()
        );
        assert_eq!(
            map_line(r#"{"id":"c1","type":"response","command":"get_state","success":true,"data":{}}"#),
            MappedLine::default()
        );
    }

    /// 坏 JSON 行与未知事件类型静默跳过（前向兼容，不 panic 不事件）。
    #[test]
    fn malformed_and_unknown_records_are_skipped() {
        assert_eq!(map_line("not json at all"), MappedLine::default());
        assert_eq!(
            map_line(r#"{"type":"future_event","payload":1}"#),
            MappedLine::default()
        );
        assert_eq!(map_line(r#"{"type":42}"#), MappedLine::default());
        assert_eq!(map_line(""), MappedLine::default());
    }

    /// 线格式断言按解析后的 Value 比对：键序不是契约（serde_json 默认按键名排序
    /// 序列化），字段集合与值才是。
    #[test]
    fn command_lines_carry_incremented_style_ids_and_wire_format() {
        let cases = [
            (
                command_line(
                    "c1",
                    &Command::Prompt {
                        text: "Review this repo".into(),
                    },
                ),
                json!({"type":"prompt","message":"Review this repo","id":"c1"}),
            ),
            (
                command_line(
                    "c2",
                    &Command::Steer {
                        text: "换个方向".into(),
                    },
                ),
                json!({"type":"steer","message":"换个方向","id":"c2"}),
            ),
            (
                command_line(
                    "c3",
                    &Command::FollowUp {
                        text: "完成后总结".into(),
                    },
                ),
                json!({"type":"follow_up","message":"完成后总结","id":"c3"}),
            ),
            (
                command_line("c4", &Command::Abort),
                json!({"type":"abort","id":"c4"}),
            ),
            (
                command_line("c5", &Command::GetState),
                json!({"type":"get_state","id":"c5"}),
            ),
        ];
        for (line, want) in cases {
            let got: serde_json::Value = serde_json::from_str(&line)
                .unwrap_or_else(|e| panic!("命令行必须是合法 JSON ({e}): {line}"));
            assert_eq!(got, want, "line: {line}");
        }
    }

    /// 刻意不带 streamingBehavior（UI 场景 steer 独立表达）：线格式里不得出现。
    #[test]
    fn prompt_line_never_contains_streaming_behavior() {
        let line = command_line("c1", &Command::Prompt { text: "hi".into() });
        assert!(!line.contains("streamingBehavior"));
    }

    #[test]
    fn confirm_response_wire_shapes() {
        let cases = [
            (
                confirm_response_line("uuid-2", true, None),
                json!({"type":"extension_ui_response","id":"uuid-2","confirmed":true}),
            ),
            (
                confirm_response_line("uuid-3", true, Some("my text")),
                json!({"type":"extension_ui_response","id":"uuid-3","value":"my text"}),
            ),
            (
                confirm_response_line("uuid-9", false, None),
                json!({"type":"extension_ui_response","id":"uuid-9","cancelled":true}),
            ),
        ];
        for (line, want) in cases {
            let got: serde_json::Value = serde_json::from_str(&line)
                .unwrap_or_else(|e| panic!("回复行必须是合法 JSON ({e}): {line}"));
            assert_eq!(got, want, "line: {line}");
        }
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&confirm_response_line(
                "uuid-9",
                false,
                Some("ignored")
            ))
            .unwrap(),
            json!({"type":"extension_ui_response","id":"uuid-9","cancelled":true}),
            "撤销时带 value 也必须是 cancelled 形态"
        );
    }

    fn dir() -> std::path::PathBuf {
        std::path::PathBuf::from("/data/pi-sessions")
    }

    #[test]
    fn spawn_args_validate_provider_requires_model() {
        assert_eq!(
            spawn_args(None, None, &dir(), None).unwrap(),
            vec!["--mode", "rpc", "--session-dir", "/data/pi-sessions"]
        );
        // session_id 空串视同未传（新会话）
        assert_eq!(
            spawn_args(None, None, &dir(), Some("")).unwrap(),
            vec!["--mode", "rpc", "--session-dir", "/data/pi-sessions"]
        );
        // session_id 在默认目录无既有文件可命中：忽略并裸起（防 --session 硬崩）
        assert_eq!(
            spawn_args(None, Some("anthropic/claude*"), &dir(), Some("u-1")).unwrap(),
            vec![
                "--mode",
                "rpc",
                "--session-dir",
                "/data/pi-sessions",
                "--model",
                "anthropic/claude*"
            ]
        );
        assert_eq!(
            spawn_args(Some("anthropic"), Some("claude-sonnet-4"), &dir(), None).unwrap(),
            vec![
                "--mode",
                "rpc",
                "--session-dir",
                "/data/pi-sessions",
                "--provider",
                "anthropic",
                "--model",
                "claude-sonnet-4"
            ]
        );
        assert!(spawn_args(Some("anthropic"), None, &dir(), None).is_err());
    }

    /// 临时 session 目录：造给定文件名的空文件（filename 形态即契约输入）。
    fn sess_dir(tag: &str, files: &[&str]) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cp-pi-sess-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in files {
            std::fs::write(dir.join(name), "").unwrap();
        }
        dir
    }

    /// 会话方言三态（pi 0.73.1 实测 2026-11-14）：无 --session-id flag；--session
    /// 只在 session-dir 下命中既有 <ts>_<uuid>.jsonl 时传（文件名包含 id 即命中，
    /// pi 按 partial uuid 自匹配）；未命中/空 id/目录不可读一律裸起新会话。
    #[test]
    fn spawn_args_session_flag_only_when_existing_jsonl_matches() {
        let uuid = "01a1d916-b7f5-70a8-b141-735b17f12759";
        let dir = sess_dir("hit", &[&format!("2026-01-01T00-00-00-000Z_{uuid}.jsonl")]);
        let bare = vec![
            "--mode".to_string(),
            "rpc".to_string(),
            "--session-dir".to_string(),
            dir.to_string_lossy().into_owned(),
        ];
        let with_session = |id: &str| {
            bare.iter()
                .cloned()
                .chain(["--session".to_string(), id.to_string()])
                .collect::<Vec<_>>()
        };
        assert_eq!(
            spawn_args(None, None, &dir, Some(uuid)).unwrap(),
            with_session(uuid),
            "完整 uuid 命中传 --session"
        );
        assert_eq!(
            spawn_args(None, None, &dir, Some("01a1d916")).unwrap(),
            with_session("01a1d916"),
            "部分 uuid 同样命中（包含匹配）"
        );
        assert_eq!(
            spawn_args(None, None, &dir, Some("ffffffff-ffff-ffff-ffff-ffffffffffff"))
                .unwrap(),
            bare,
            "未命中必须裸起，不得硬传 --session"
        );
        assert_eq!(
            spawn_args(None, None, &dir, Some("")).unwrap(),
            bare.clone(),
            "空 id 视同未传"
        );
        let _ = std::fs::remove_dir_all(&dir);

        // 只有非 .jsonl 文件名包含 id：不算命中
        let txt = sess_dir("txt", &[&format!("note-{uuid}.txt")]);
        assert_eq!(
            spawn_args(None, None, &txt, Some(uuid)).unwrap(),
            vec![
                "--mode",
                "rpc",
                "--session-dir",
                txt.to_string_lossy().as_ref(),
            ],
            "非 .jsonl 不得命中"
        );
        let _ = std::fs::remove_dir_all(&txt);

        // 目录不存在（read_dir 失败）视同未命中：裸起不报错
        let missing = std::env::temp_dir().join(format!("cp-pi-sess-{}-absent", std::process::id()));
        assert_eq!(
            spawn_args(None, None, &missing, Some(uuid)).unwrap().len(),
            4,
            "目录不可读同样裸起"
        );
    }

    /// provider/model 原样透传：不做引号包裹或转义（值本身是 CLI 参数）。
    #[test]
    fn spawn_args_pass_values_through_verbatim() {
        let args = spawn_args(Some("openai-compatible"), Some("my model*"), &dir(), None).unwrap();
        assert_eq!(args[5], "openai-compatible");
        assert_eq!(args[7], "my model*");
    }

    /// prompt 文本不修剪：前后空白是用户输入的一部分，引擎自己定夺语义。
    #[test]
    fn command_line_preserves_message_whitespace_verbatim() {
        let line = command_line(
            "c1",
            &Command::Prompt {
                text: "  保留空白 \t".into(),
            },
        );
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["message"], json!("  保留空白 \t"));
    }

    /// U+2028/2029 在 JSON 字符串内合法且不得被切行：复用的 read_lines 是字节级
    /// \n 切分（Node readline 会在此处切错）。
    #[tokio::test]
    async fn reader_does_not_split_on_unicode_line_separators() {
        let delta = "行内\u{2028}段内\u{2029}尾";
        let payload =
            json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta": delta}}).to_string();
        assert!(
            payload.contains('\u{2028}') && payload.contains('\u{2029}'),
            "serde_json 会按字面输出 U+2028/2029"
        );
        let (mut tx, rx) = tokio::io::duplex(4096);
        tx.write_all(payload.as_bytes()).await.unwrap();
        tx.write_all(b"\n").await.unwrap();
        drop(tx);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        crate::sidecar::read_lines(rx, move |line| {
            sink.lock().unwrap().push(line.to_string());
        })
        .await;
        let lines = seen.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "U+2028/2029 不得当作行界: {lines:?}");
        let parsed: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(parsed["assistantMessageEvent"]["delta"], json!(delta));
        assert_eq!(
            events_of(&lines[0]),
            vec![EngineEvent::TextDelta {
                text: delta.to_string()
            }],
            "含 U+2028/2029 的行必须完整走通映射"
        );
    }

    /// CRLF 入流时行尾 CR 必须剥掉，否则 JSON 解析失败。
    #[tokio::test]
    async fn reader_strips_trailing_carriage_return() {
        let (mut tx, rx) = tokio::io::duplex(256);
        tx.write_all(b"{\"type\":\"agent_settled\"}\r\n")
            .await
            .unwrap();
        drop(tx);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        crate::sidecar::read_lines(rx, move |line| {
            sink.lock().unwrap().push(line.to_string());
        })
        .await;
        let lines = seen.lock().unwrap().clone();
        assert_eq!(lines, vec![r#"{"type":"agent_settled"}"#.to_string()]);
        assert_eq!(events_of(&lines[0]), vec![EngineEvent::Settled]);
    }

    /// JSONL 完整性：message 内含裸换行/引号/反斜杠时，序列化必须整体转义成
    /// 单行（write_line 只补一个 \n，行内再出现裸 \n 即协议破框）。
    #[test]
    fn command_line_escapes_embedded_newlines_into_single_line() {
        for text in ["第一行\n第二行", "引号\"与反斜杠\\", "制表\t和回车\r"] {
            let line = command_line("c1", &Command::Prompt { text: text.into() });
            assert!(!line.contains('\n') && !line.contains('\r'), "line: {line}");
            let parsed: serde_json::Value =
                serde_json::from_str(&line).expect("必须是合法单行 JSON");
            assert_eq!(parsed["message"], json!(text));
        }
        let reply = confirm_response_line("u1", true, Some("a\nb"));
        assert!(!reply.contains('\n'), "reply: {reply}");
        let parsed: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(parsed["value"], json!("a\nb"));
    }

    /// 行跨多次 write 到达（管道分片）：reader 按字节缓冲拼到 \n 才交行。
    #[tokio::test]
    async fn reader_reassembles_lines_split_across_writes() {
        let (mut tx, rx) = tokio::io::duplex(64);
        tx.write_all(b"{\"type\":\"agent_s").await.unwrap();
        tx.write_all(b"ettled\"").await.unwrap();
        tx.write_all(b"}\n").await.unwrap();
        drop(tx);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        crate::sidecar::read_lines(rx, move |line| {
            sink.lock().unwrap().push(line.to_string());
        })
        .await;
        let lines = seen.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "分片必须拼回一行: {lines:?}");
        assert_eq!(events_of(&lines[0]), vec![EngineEvent::Settled]);
    }

    /// 一次 write 含多行：逐行交出，不粘连不丢行。
    #[tokio::test]
    async fn reader_splits_multiple_lines_in_one_write() {
        let (mut tx, rx) = tokio::io::duplex(256);
        tx.write_all(b"{\"type\":\"agent_settled\"}\n{\"type\":\"agent_settled\"}\n")
            .await
            .unwrap();
        drop(tx);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        crate::sidecar::read_lines(rx, move |line| {
            sink.lock().unwrap().push(line.to_string());
        })
        .await;
        let lines = seen.lock().unwrap().clone();
        assert_eq!(lines.len(), 2, "lines: {lines:?}");
        assert!(lines
            .iter()
            .all(|l| events_of(l) == vec![EngineEvent::Settled]));
    }

    /// Usage 去重闸：重复累计值拦截、变化值放行、非 Usage 事件恒放行。
    #[test]
    fn usage_dedup_gate_filters_repeats_and_passes_changes() {
        let mut last = None;
        let u = |i: u64, o: u64| EngineEvent::Usage {
            tokens_in: i,
            tokens_out: o,
        };
        assert!(usage_updated(&mut last, &u(0, 0)), "首个值必须放行");
        assert!(!usage_updated(&mut last, &u(0, 0)), "重复值必须拦截");
        assert!(usage_updated(&mut last, &u(0, 1)), "output 变化放行");
        assert!(!usage_updated(&mut last, &u(0, 1)));
        assert!(usage_updated(&mut last, &u(5, 1)), "input 变化放行");
        assert!(usage_updated(&mut last, &u(0, 0)), "回落的值也算变化放行");
        assert!(
            usage_updated(&mut last, &EngineEvent::Settled),
            "非 Usage 恒放行"
        );
        assert_eq!(last, Some((0, 0)));
    }

    /// 真 pi 集成（本机装 pi ≥1.5，npm i -g @earendil-works/pi-coding-agent）。
    /// 本地实跑：cargo test -p wangshu engine -- --ignored。
    /// 覆盖：.cmd shim spawn、命令往返（id 关联的 response 型行）、JSONL 切分、
    /// 坏 JSON 的 parse 响应、关 stdin 的优雅退出。LLM 层不测（无 provider 配置）。
    #[ignore = "需本机全局安装 pi≥1.5；CI 无 pi 会挂，本地用 --ignored 实跑"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_pi_rpc_get_state_roundtrip_and_graceful_exit() {
        let cwd = std::env::temp_dir().join(format!("cp-engine-pi-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let (session, stdout, _stderr) = spawn(&cwd, None, None, &cwd, None).expect("pi 应已全局安装");

        let state_id = session.next_command_id();
        session
            .write_line(&command_line(&state_id, &Command::GetState))
            .await
            .unwrap();
        session.write_line("definitely not json").await.unwrap();
        // 关 stdin 请求有序退出：pi 处理完在途命令后退出，stdout 随之 EOF。
        {
            let mut guard = session.proc.stdin.lock().await;
            *guard = None;
        }

        let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        tokio::time::timeout(std::time::Duration::from_secs(90), async move {
            crate::sidecar::read_lines(stdout, move |line| {
                sink.lock().unwrap().push(line.to_string());
            })
            .await;
        })
        .await
        .expect("pi 应在 stdin 关闭后退出并 EOF");

        let records: Vec<serde_json::Value> = lines
            .lock()
            .unwrap()
            .iter()
            .map(|l| serde_json::from_str(l).expect("stdout 每行必须是合法 JSON"))
            .collect();
        let state_response = records
            .iter()
            .find(|r| r["type"] == "response" && r["id"] == json!(state_id))
            .expect("get_state 响应必须带请求 id 回来");
        assert_eq!(state_response["command"], "get_state");
        assert_eq!(
            state_response["success"], true,
            "响应原文见 {state_response}"
        );
        assert!(
            state_response["data"]["sessionId"].is_string(),
            "get_state data 应含 sessionId"
        );
        // 真机形态核对：get_state 响应行必须映射出 SessionStarted（uuid 回传链）
        let state_line = {
            let captured = lines.lock().unwrap();
            captured
                .iter()
                .find(|l| l.contains(&format!("\"id\":\"{state_id}\"")))
                .cloned()
                .expect("原始响应行应在采集里")
        };
        assert_eq!(
            events_of(&state_line),
            vec![EngineEvent::SessionStarted {
                session_id: state_response["data"]["sessionId"]
                    .as_str()
                    .unwrap()
                    .to_string()
            }],
            "真 pi 的 get_state 响应必须走通 SessionStarted 映射"
        );
        let parse_error = records
            .iter()
            .find(|r| r["command"] == "parse" && r["success"] == false)
            .expect("坏 JSON 应得到 parse 失败响应");
        assert!(parse_error["error"]
            .as_str()
            .unwrap()
            .contains("Failed to parse"));

        let code = {
            let mut child = session.proc.child.lock().await;
            child.wait().await.unwrap().code()
        };
        assert_eq!(code, Some(0), "关 stdin 后 pi 应有序退出（exit 0）");
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
