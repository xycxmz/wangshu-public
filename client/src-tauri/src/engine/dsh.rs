//! DSH 方言适配（dsh headless --json
//! 2026-11-09 实测采样）。形态与 PI 相反：spawn-per-task 一次性进程，任务经
//! argv 传入、答完即退，无 stdin 命令面——续问=同 --session-id 再 spawn，
//! 会话 id 空间与 PI 共用注册表（engine_stop 可停，pump 收割后摘表）。
//! 事件映射：session/final 记 sessionId；turn/step 结构事件作 LogLine 飞行
//! 日志行；turn_end/final 的 reason.kind=error 与顶层 type=error → Error；
//! final 恒收口 Settled；未知 type 忽略+log（rc 版 schema 漂移防线）。

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use tokio::process::{ChildStderr, ChildStdout};

use super::{emit_update, EngineEvent, Session};
use crate::sidecar::{self, state::ProcHandle};
use tauri::Manager;

/// 最近一次 DSH sessionId（session/final 事件记录，供续跑预填）。
static LAST_SESSION_ID: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 最近一次非空 DEEPSEEK_API_KEY 的进程内记忆（R10-B B2）。语义对齐前端
/// keyMemory：只在本次应用进程内存里、不落盘（明文不落盘红线）；dsh_run
/// 每次用户手跑即刷新，调度器无人值守触发时取此值。空=本进程尚未有 key，
/// spawn 显式清 DEEPSEEK_API_KEY，dsh 走自身凭据服务/MISSING_CREDENTIAL 流。
static KEY_MEMORY: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));

fn remember_key(key: &str) {
    if key.is_empty() {
        return;
    }
    *KEY_MEMORY.lock().expect("dsh key memory lock poisoned") = key.to_string();
}

/// 调度器触发用的记忆 key（无则空串）。
pub fn remembered_key() -> String {
    KEY_MEMORY
        .lock()
        .expect("dsh key memory lock poisoned")
        .clone()
}

fn record_session_id(session_id: String) {
    let mut guard = LAST_SESSION_ID.lock().expect("dsh session lock poisoned");
    *guard = Some(session_id);
}

/// 最近一次 DSH 任务的 sessionId（无则 None）。
#[tauri::command]
pub fn dsh_last_session() -> Option<String> {
    LAST_SESSION_ID
        .lock()
        .expect("dsh session lock poisoned")
        .clone()
}

/// 一次 DSH headless 任务的终局（R10-B B2：调度器回调用，命令路径不消费）。
/// ok=全程无 Error 事件且退出码 0；error 为最后一个 Error 事件原文；
/// text 为终答全文（final/text 整段快照的最新值）；log_tail 为末尾若干
/// 飞行日志行（R11-S1：无终答时 summary 的回退源）；session_id 为 dsh 侧
/// 会话 uuid（首行 session 事件捕获）。
pub struct DshOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub text: String,
    pub log_tail: Vec<String>,
    pub session_id: Option<String>,
    pub exit: Option<i32>,
}

/// 飞行日志尾部保留条数（summary 回退只取末 3 行，防长任务全量累积）。
pub const LOG_TAIL_LEN: usize = 3;

/// 日志尾部累积（pump 逐事件调用）：只保留末 LOG_TAIL_LEN 行。
pub fn push_log_tail(tail: &mut Vec<String>, line: String) {
    tail.push(line);
    if tail.len() > LOG_TAIL_LEN {
        tail.remove(0);
    }
}

/* ── DSH 终态驻留（统一任务列下批）：手动跑的终态摘要环形队列 ── */

/// dsh 终态摘要（统一任务列的终态行）。进程内语义：重启即清、不落盘——
/// 手动跑无 tasksdb 归宿，环形队列是它唯一驻留；sched 触发的终态已由
/// schedules 表 last_* 承载，不入列防双计。
#[derive(Debug, Clone, PartialEq)]
pub struct DshTerminal {
    /// engine 会话号（统一任务列 id 空间，与在跑行同源可续点）。
    pub id: u64,
    pub title: String,
    /// 全程无 Error 且退出码 0（DshOutcome.ok 同口径）。
    pub ok: bool,
    pub started_ms: i64,
    /// 收割时刻钉死的全程耗时。
    pub elapsed_ms: u64,
}

/// 驻留条数上限（最近 20 条）。
pub const DSH_TERMINALS_CAP: usize = 20;

static DSH_TERMINALS: LazyLock<Mutex<VecDeque<DshTerminal>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// 入列裁剪（纯核心，本地 deque 可测）：新者进尾，超 cap 逐出最旧。
fn push_capped(deque: &mut VecDeque<DshTerminal>, entry: DshTerminal, cap: usize) {
    deque.push_back(entry);
    while deque.len() > cap {
        deque.pop_front();
    }
}

/// 收割入列（pump 终点调用）：新者进尾，超上限逐出最旧。
pub fn push_dsh_terminal(entry: DshTerminal) {
    let mut guard = DSH_TERMINALS.lock().expect("dsh terminals lock poisoned");
    push_capped(&mut guard, entry, DSH_TERMINALS_CAP);
}

/// 驻留快照（tasks_unified 聚合源）：旧→新。
pub fn dsh_terminals() -> Vec<DshTerminal> {
    DSH_TERMINALS
        .lock()
        .expect("dsh terminals lock poisoned")
        .iter()
        .cloned()
        .collect()
}

/// 启动一次 DSH headless 任务（dsh_run 的可复用内部入口，调度器同款管线）：
/// cwd 校验、spawn、会话注册、起 pump，立即返回会话 id。on_finish 为终局
/// 回调（pump 收尾处调用一次；None=命令路径无回调）。
pub fn start_task(
    cwd: &str,
    task: &str,
    deepseek_api_key: &str,
    session_id: Option<&str>,
    app: tauri::AppHandle,
    on_finish: Option<Box<dyn FnOnce(DshOutcome) + Send>>,
) -> Result<u64, String> {
    let task_label = dsh_task_label(task);
    let cwd = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|e| format!("cwd 不可访问: {cwd} ({e})"))?;
    let (session, stdout, stderr) = spawn(&cwd, task, deepseek_api_key, session_id)?;
    let session = Arc::new(session);
    let id = super::next_session_id();
    let started_ms = crate::tasksdb::unix_ms();
    super::insert_session(id, Arc::clone(&session));
    super::insert_session_meta(
        id,
        super::SessionMeta {
            kind: super::EngineKind::Dsh,
            title: task_label.clone(),
            started_ms,
        },
    );
    tauri::async_runtime::spawn(pump(id, session, stdout, stderr, app, task_label, on_finish));
    Ok(id)
}

/// 启动一次 DSH headless 任务，立即返回会话 id。stdout 逐行映射为归一事件
/// 经 `engine://update` 推送；stderr 只排空（人类可读诊断，不进事件）。
/// 无 abort/steer/confirm（一次性进程，停止复用 engine_stop）。
#[tauri::command]
pub async fn dsh_run(
    cwd: String,
    task: String,
    deepseek_api_key: String,
    session_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    remember_key(&deepseek_api_key);
    start_task(
        &cwd,
        &task,
        &deepseek_api_key,
        session_id.as_deref().filter(|id| !id.is_empty()),
        app,
        None,
    )
}

/// 历史列表用的任务标签：首行、压空白、截 48 字。
fn dsh_task_label(task: &str) -> String {
    let first = task.lines().next().unwrap_or("").replace(['\t', '\r'], " ");
    let first = first.trim();
    if first.chars().count() <= 48 {
        first.to_string()
    } else {
        let cut: String = first.chars().take(48).collect();
        cut + "…"
    }
}

/// DSH 会话历史（R5-B#5）：最近会话列表，新在前。
#[tauri::command]
pub fn dsh_session_list(
    db: tauri::State<'_, crate::tasksdb::TaskDb>,
) -> Vec<crate::tasksdb::DshSessionEntry> {
    db.get_pref(crate::tasksdb::DSH_SESSIONS_KEY)
        .and_then(|p| serde_json::from_str(&p).ok())
        .unwrap_or_default()
}

/// 输出泵：stdout 逐行映射归一事件并 emit（session/final 的 sessionId 首见
/// 即发 DshSession 事件并顺手记录）；stderr 持续排空（不只防积压——实测
/// stderr 管道持而不读会卡死 dsh 的退出，node 阻塞在写、stdout 永不 EOF）。
/// stdout EOF 后收割退出码、摘表、发 Exit（错误流实测 exit 1，成功流按实际码
/// 透传）；手动跑（无 on_finish 回调）的终态摘要入环形队列驻留，最后回调
/// 终局（on_finish 有则调度器消费：ok/错误原文/终答/session uuid/退出码）。
pub async fn pump(
    id: u64,
    session: Arc<Session>,
    stdout: ChildStdout,
    stderr: ChildStderr,
    app: tauri::AppHandle,
    task_label: String,
    on_finish: Option<Box<dyn FnOnce(DshOutcome) + Send>>,
) {
    let drain = tauri::async_runtime::spawn(async move {
        sidecar::read_lines(stderr, |line| eprintln!("[engine:dsh:stderr] {line}")).await;
    });
    let emitter = Arc::new(app);
    // 终局聚合（stdout 侧累计，EOF 后交 on_finish）
    let mut last_error: Option<String> = None;
    let mut final_text = String::new();
    let mut log_tail: Vec<String> = Vec::new();
    let mut dsh_session: Option<String> = None;
    sidecar::read_lines(stdout, |line| {
        let mapped = map_line(line);
        if let Some(session_id) = mapped.session_id {
            // 首见才发：session 与 final 各携带一次，统一详情只消费第一条
            let first_seen = dsh_session.is_none();
            dsh_session.get_or_insert(session_id.clone());
            if first_seen {
                emit_update(
                    &emitter,
                    id,
                    &EngineEvent::DshSession {
                        session_id: session_id.clone(),
                    },
                );
            }
            record_session_id(session_id.clone());
            // R5-B#5：历史列表持久化（尽力而为，失败只日志不碍流）
            if let Some(db) = emitter.try_state::<crate::tasksdb::TaskDb>() {
                let entry = crate::tasksdb::DshSessionEntry {
                    id: session_id,
                    task: task_label.clone(),
                    at: crate::tasksdb::unix_ms(),
                };
                let prev = db.get_pref(crate::tasksdb::DSH_SESSIONS_KEY);
                let merged = crate::tasksdb::merge_dsh_session_history(
                    prev.as_deref(),
                    &entry,
                    crate::tasksdb::DSH_SESSIONS_CAP,
                );
                db.set_pref(crate::tasksdb::DSH_SESSIONS_KEY, &merged);
            }
        }
        for event in mapped.events {
            match &event {
                EngineEvent::Error { message } => last_error = Some(message.clone()),
                EngineEvent::TextDelta { text } => final_text = text.clone(),
                EngineEvent::LogLine { text } => push_log_tail(&mut log_tail, text.clone()),
                _ => {}
            }
            emit_update(&emitter, id, &event);
        }
    })
    .await;
    // stderr 排空任务限时等待：进程死后管道必关，超时说明有泄漏，放弃等待。
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), drain).await;
    let code = {
        let mut child = session.proc.child.lock().await;
        child.wait().await.ok().and_then(|status| status.code())
    };
    let ok = last_error.is_none() && code == Some(0);
    let started_ms = super::session_meta_of(id)
        .map(|m| m.started_ms)
        .unwrap_or_default();
    super::remove_session(id);
    emit_update(&emitter, id, &EngineEvent::Exit { code });
    // 终态驻留：手动跑（无调度回调）才入列；sched 触发的终态由 schedules 表
    // last_* 承载，不入列防双计。
    if on_finish.is_none() {
        push_dsh_terminal(DshTerminal {
            id,
            title: task_label.clone(),
            ok,
            started_ms,
            elapsed_ms: crate::tasksdb::unix_ms().saturating_sub(started_ms).max(0) as u64,
        });
    }
    if let Some(cb) = on_finish {
        cb(DshOutcome {
            ok,
            error: last_error,
            text: final_text,
            log_tail,
            session_id: dsh_session,
            exit: code,
        });
    }
}

/// 解析出的 dsh 可执行 + headless 参数 → 子进程管道。凭据经 env 注入并完全
/// 接管：key 非空才设 DEEPSEEK_API_KEY，否则显式清除（隔离宿主环境变量，无
/// key 走 MISSING_CREDENTIAL 流）。stdin 弃用（任务在 argv，`-` 读 stdin 的
/// 形态不用）。复用 sidecar 的 which/包装（npm .cmd shim 经 cmd /C 拉起）。
pub fn spawn(
    cwd: &Path,
    task: &str,
    deepseek_api_key: &str,
    session_id: Option<&str>,
) -> Result<(Session, ChildStdout, ChildStderr), String> {
    let exe = sidecar::state::resolve_executable("dsh")
        .ok_or_else(|| "dsh 未安装在 PATH 上（设置 → 环境可查看安装指引）".to_string())?;
    let mut command = sidecar::build_command(&exe, &spawn_args(task, session_id));
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    command.env_remove("DEEPSEEK_API_KEY");
    if !deepseek_api_key.is_empty() {
        command.env("DEEPSEEK_API_KEY", deepseek_api_key);
    }
    #[cfg(windows)]
    command.creation_flags(sidecar::CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|e| format!("启动 dsh 失败: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let handle = Arc::new(ProcHandle::new(pid, child, None));
    Ok((
        Session::new(handle),
        stdout.expect("piped stdout"),
        stderr.expect("piped stderr"),
    ))
}

/// headless 参数拼装：选项在前、任务 positional 殿后（flags-after-positional
/// 未实证不赌）。task 原样透传（argv 引用由 Command 负责）；session_id 空
/// 串视同未传（None 与 "" 同为开新会话）。
pub fn spawn_args(task: &str, session_id: Option<&str>) -> Vec<String> {
    let mut args = vec!["headless".into(), "--json".into()];
    if let Some(id) = session_id.filter(|id| !id.is_empty()) {
        args.push("--session-id".into());
        args.push(id.into());
    }
    args.push(task.into());
    args
}

/// 一行 stdout 记录的映射结果：归一事件（可多条，final 携带 TextDelta/Error+
/// Settled）+ 捕获的 sessionId（session/final 事件携带，供续跑）。
#[derive(Debug, Default, PartialEq)]
pub struct MappedLine {
    pub events: Vec<EngineEvent>,
    pub session_id: Option<String>,
}

fn one(event: EngineEvent) -> MappedLine {
    MappedLine {
        events: vec![event],
        session_id: None,
    }
}

/// 线格式 → 归一事件。坏 JSON/未知 type 忽略+log 不 panic（前向兼容）；
/// 字段缺失一律取安全默认（事件流是尽力而为的数据面）。
pub fn map_line(line: &str) -> MappedLine {
    let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
        eprintln!("[engine:dsh] 忽略坏 JSON 行: {line}");
        return MappedLine::default();
    };
    match record["type"].as_str() {
        Some("session") => MappedLine {
            events: Vec::new(),
            session_id: non_empty(str_field(&record["sessionId"])),
        },
        Some("status") => map_status(&record),
        Some("final") => map_final(&record),
        // 成功流载荷事件（真 key 采样 2026-11-09）：headless 无流式 delta，
        // text/thinking 各自是整段快照，长回复实测仅一个 text 事件。
        Some("text") => one(EngineEvent::TextDelta {
            text: str_field(&record["text"]),
        }),
        Some("thinking") => one(EngineEvent::ThinkingDelta {
            text: str_field(&record["text"]),
        }),
        // 顶层 error：不可恢复的 CLI 错误（如 --session-id 不存在），实测单行
        // 即退，无 session/final 包裹。
        Some("error") => one(EngineEvent::Error {
            message: str_field(&record["message"]),
        }),
        Some(other) => {
            eprintln!("[engine:dsh] 忽略未知事件 type={other}");
            MappedLine::default()
        }
        None => {
            eprintln!("[engine:dsh] 忽略无 type 行: {line}");
            MappedLine::default()
        }
    }
}

/// status 事件：turn/step 结构作 LogLine 日志行；turn_end 仅错误形态出 Error
/// （成功流的 turn_end reason 未采样，先忽略+log，P3 采样后补映射）。
fn map_status(record: &serde_json::Value) -> MappedLine {
    let turn = record["turn"].as_u64().unwrap_or(0);
    let step = record["step"].as_u64().unwrap_or(0);
    match record["phase"].as_str() {
        Some("turn_start") => one(EngineEvent::LogLine {
            text: format!("TURN {turn} 开始"),
        }),
        Some("step_start") => one(EngineEvent::LogLine {
            text: format!("TURN {turn} · STEP {step} 开始"),
        }),
        Some("step_end") => {
            // 成功流 step_end 携带本轮累计 usage（真 key 采样）；错误流无此字段。
            let usage = record["usage"].clone();
            let mut events = vec![EngineEvent::LogLine {
                text: format!("TURN {turn} · STEP {step} 结束"),
            }];
            if !usage.is_null() {
                events.push(EngineEvent::Usage {
                    tokens_in: usage["inputTokens"].as_u64().unwrap_or(0),
                    tokens_out: usage["outputTokens"].as_u64().unwrap_or(0),
                });
            }
            MappedLine {
                events,
                session_id: None,
            }
        }
        Some("turn_end") => {
            if error_kind(&record["reason"]) {
                one(EngineEvent::Error {
                    message: error_message(&record["reason"]),
                })
            } else {
                eprintln!(
                    "[engine:dsh] 忽略非错误 turn_end reason: {}",
                    record["reason"]
                );
                MappedLine::default()
            }
        }
        Some(other) => {
            eprintln!("[engine:dsh] 忽略未知 status phase={other}");
            MappedLine::default()
        }
        None => MappedLine::default(),
    }
}

/// final 收口：text 非空先 TextDelta 整段、reason.kind=error 先 Error，
/// 然后恒 Settled（终答/终错都意味着本轮静止；Exit 由 pump 按实际退出码发）。
fn map_final(record: &serde_json::Value) -> MappedLine {
    let mut events = Vec::new();
    let text = str_field(&record["text"]);
    if !text.is_empty() {
        events.push(EngineEvent::TextDelta { text });
    }
    if error_kind(&record["reason"]) {
        events.push(EngineEvent::Error {
            message: error_message(&record["reason"]),
        });
    }
    events.push(EngineEvent::Settled);
    MappedLine {
        events,
        session_id: non_empty(str_field(&record["sessionId"])),
    }
}

fn error_kind(reason: &serde_json::Value) -> bool {
    reason["kind"].as_str() == Some("error")
}

/// 错误正文取 error.message 原文，缺失退 error.code（仍无则空串，事件照发
/// 不吞错）。
fn error_message(reason: &serde_json::Value) -> String {
    let error = &reason["error"];
    let message = str_field(&error["message"]);
    if !message.is_empty() {
        return message;
    }
    str_field(&error["code"])
}

fn non_empty(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn str_field(value: &serde_json::Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events_of(line: &str) -> Vec<EngineEvent> {
        map_line(line).events
    }

    /// 采样文档全量重放（无 key 错误流，2026-11-09 实测原文逐行替换 uuid）：
    /// 每行断言映射结果，锁死契约快照。
    #[test]
    fn sampled_missing_credential_stream_maps_line_by_line() {
        let session = r#"{"type":"session","sessionId":"session-a1a8fe9b-73f0-4b39-8753-0de06f3f92a4","cwd":"F:\\code-glm"}"#;
        let mapped = map_line(session);
        assert_eq!(mapped.events, Vec::new(), "session 不出事件");
        assert_eq!(
            mapped.session_id.as_deref(),
            Some("session-a1a8fe9b-73f0-4b39-8753-0de06f3f92a4")
        );

        assert_eq!(
            events_of(r#"{"type":"status","phase":"turn_start","turn":1}"#),
            vec![EngineEvent::LogLine {
                text: "TURN 1 开始".into()
            }]
        );
        assert_eq!(
            events_of(r#"{"type":"status","phase":"step_start","turn":1,"step":1}"#),
            vec![EngineEvent::LogLine {
                text: "TURN 1 · STEP 1 开始".into()
            }]
        );
        assert_eq!(
            events_of(r#"{"type":"status","phase":"step_end","turn":1,"step":1}"#),
            vec![EngineEvent::LogLine {
                text: "TURN 1 · STEP 1 结束".into()
            }]
        );

        let message = "llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment";
        let turn_end = format!(
            r#"{{"type":"status","phase":"turn_end","turn":1,"reason":{{"kind":"error","error":{{"message":{message_json},"code":"MISSING_CREDENTIAL"}}}}}}"#,
            message_json = serde_json::json!(message)
        );
        assert_eq!(
            events_of(&turn_end),
            vec![EngineEvent::Error {
                message: message.into()
            }],
            "turn_end 错误 message 原文回传"
        );

        let final_line = format!(
            r#"{{"type":"final","sessionId":"session-a1a8fe9b-73f0-4b39-8753-0de06f3f92a4","reason":{{"kind":"error","error":{{"message":{message_json},"code":"MISSING_CREDENTIAL"}}}},"text":""}}"#,
            message_json = serde_json::json!(message)
        );
        let mapped = map_line(&final_line);
        assert_eq!(
            mapped.events,
            vec![
                EngineEvent::Error {
                    message: message.into()
                },
                EngineEvent::Settled,
            ],
            "final 错误形态：Error 先行再 Settled，空 text 不出 TextDelta"
        );
        assert_eq!(
            mapped.session_id.as_deref(),
            Some("session-a1a8fe9b-73f0-4b39-8753-0de06f3f92a4"),
            "final 也携带同一 sessionId"
        );
    }

    /// 成功形态 final（未采样，按 schema 推演）：text 整段 TextDelta + Settled。
    #[test]
    fn final_with_text_maps_to_text_delta_then_settled() {
        let line =
            r#"{"type":"final","sessionId":"session-x","reason":{"kind":"done"},"text":"pong"}"#;
        assert_eq!(
            events_of(line),
            vec![
                EngineEvent::TextDelta {
                    text: "pong".into()
                },
                EngineEvent::Settled,
            ]
        );
    }

    /// final 双形态并存：text 非空先 TextDelta、错误先 Error，顺序锁死。
    #[test]
    fn final_with_both_text_and_error_emits_in_order() {
        let line = r#"{"type":"final","sessionId":"session-x","reason":{"kind":"error","error":{"message":"半途而废"}},"text":"部分产出"}"#;
        assert_eq!(
            events_of(line),
            vec![
                EngineEvent::TextDelta {
                    text: "部分产出".into()
                },
                EngineEvent::Error {
                    message: "半途而废".into()
                },
                EngineEvent::Settled,
            ]
        );
    }

    /// 顶层 error（实测：--session-id 指向不存在的会话）：单行 Error 即退。
    #[test]
    fn top_level_error_maps_to_error_event() {
        let line = r#"{"type":"error","message":"session \"session-mytest-1234\" does not exist; omit --session-id to start a new Session"}"#;
        assert_eq!(
            events_of(line),
            vec![EngineEvent::Error {
                message: "session \"session-mytest-1234\" does not exist; omit --session-id to start a new Session".into()
            }]
        );
    }

    /// turn_end 错误缺 message 时退 code（仍无则空串），Error 照发不吞错。
    #[test]
    fn turn_end_error_falls_back_to_code_then_empty() {
        let code_only = r#"{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"error","error":{"code":"AUTH"}}}"#;
        assert_eq!(
            events_of(code_only),
            vec![EngineEvent::Error {
                message: "AUTH".into()
            }]
        );
        let bare = r#"{"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"error"}}"#;
        assert_eq!(
            events_of(bare),
            vec![EngineEvent::Error {
                message: String::new()
            }]
        );
    }

    /// 成功流的 turn_end（reason 非 error，未采样）：忽略不出事件。
    #[test]
    fn non_error_turn_end_is_ignored() {
        for line in [
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"done"}}"#,
            r#"{"type":"status","phase":"turn_end","turn":1}"#,
        ] {
            assert_eq!(map_line(line), MappedLine::default(), "line: {line}");
        }
    }

    /// status 缺 turn/step 字段容错为 0，不 panic。
    #[test]
    fn status_tolerates_missing_turn_and_step() {
        assert_eq!(
            events_of(r#"{"type":"status","phase":"turn_start"}"#),
            vec![EngineEvent::LogLine {
                text: "TURN 0 开始".into()
            }]
        );
        assert_eq!(
            events_of(r#"{"type":"status","phase":"step_end","turn":3}"#),
            vec![EngineEvent::LogLine {
                text: "TURN 3 · STEP 0 结束".into()
            }]
        );
    }

    /// session 事件缺 sessionId：不捕获、不出事件。
    #[test]
    fn session_without_session_id_captures_nothing() {
        assert_eq!(
            map_line(r#"{"type":"session","cwd":"F:\\x"}"#),
            MappedLine::default()
        );
    }

    /// 未知 type、未知 status phase、坏 JSON、无 type 静默忽略（漂移防线）。
    #[test]
    fn unknown_types_phases_and_bad_json_are_skipped() {
        assert_eq!(
            map_line(r#"{"type":"message","delta":"未采样的成功流中间事件"}"#),
            MappedLine::default()
        );
        assert_eq!(
            map_line(r#"{"type":"status","phase":"compaction_start","turn":1}"#),
            MappedLine::default()
        );
        assert_eq!(map_line("not json at all"), MappedLine::default());
        assert_eq!(map_line(r#"{"type":42}"#), MappedLine::default());
        assert_eq!(map_line(""), MappedLine::default());
    }

    /// 记录携带未知附加字段（schema 前向演进）不影响映射。
    #[test]
    fn unknown_extra_fields_do_not_break_mapping() {
        assert_eq!(
            events_of(r#"{"type":"status","phase":"turn_start","turn":1,"futureField":true}"#),
            vec![EngineEvent::LogLine {
                text: "TURN 1 开始".into()
            }]
        );
    }

    /// 参数拼装：无 session_id 只有三元组；非空加 --session-id 对（选项在
    /// positional 前）；空串视同未传。
    #[test]
    fn spawn_args_assemble_session_id_pair_before_task() {
        assert_eq!(
            spawn_args("do the thing", None),
            vec!["headless", "--json", "do the thing"]
        );
        assert_eq!(
            spawn_args("do the thing", Some("session-abc")),
            vec![
                "headless",
                "--json",
                "--session-id",
                "session-abc",
                "do the thing"
            ]
        );
        assert_eq!(
            spawn_args("do the thing", Some("")),
            vec!["headless", "--json", "do the thing"],
            "空 sessionId 视同开新会话"
        );
    }

    /// task 原样透传：前后空白/引号/换行不修剪不转义（argv 单元引用由
    /// Command 负责）。
    #[test]
    fn spawn_args_pass_task_through_verbatim() {
        assert_eq!(
            spawn_args("  keep  spaces \"quoted\"\n", None)[2],
            "  keep  spaces \"quoted\"\n"
        );
    }

    /// last_session 全局记录：记录后可读，新值覆盖旧值。
    #[test]
    fn dsh_last_session_returns_latest_recorded() {
        record_session_id("session-first".into());
        assert_eq!(dsh_last_session().as_deref(), Some("session-first"));
        record_session_id("session-second".into());
        assert_eq!(dsh_last_session().as_deref(), Some("session-second"));
    }

    /// key 进程内记忆（调度器触发用）：非空覆盖、空串不冲掉旧值。
    #[test]
    fn key_memory_keeps_latest_non_empty() {
        remember_key("key-a");
        assert_eq!(remembered_key(), "key-a");
        remember_key("key-b");
        assert_eq!(remembered_key(), "key-b");
        remember_key("");
        assert_eq!(remembered_key(), "key-b", "空 key（前端清空输入框直跑）不得清记忆");
    }

    /// 日志尾部累积（R11-S1 summary 回退源）：只留末 3 行，顺序不倒。
    #[test]
    fn log_tail_keeps_only_last_three_lines() {
        let mut tail = Vec::new();
        for i in 1..=5 {
            push_log_tail(&mut tail, format!("l{i}"));
        }
        assert_eq!(tail, vec!["l3".to_string(), "l4".into(), "l5".into()]);
    }

    /// 终态环形队列裁剪（本地 deque 纯测）：恰留最近 20 条，最旧逐出，旧→新保序。
    #[test]
    fn terminal_ring_evicts_oldest_beyond_cap() {
        let mut dq = VecDeque::new();
        for i in 0..(DSH_TERMINALS_CAP as u64 + 3) {
            push_capped(
                &mut dq,
                DshTerminal {
                    id: 100 + i,
                    title: format!("t{i}"),
                    ok: i % 2 == 0,
                    started_ms: i as i64,
                    elapsed_ms: i * 10,
                },
                DSH_TERMINALS_CAP,
            );
        }
        assert_eq!(dq.len(), DSH_TERMINALS_CAP, "恰留上限条数");
        assert_eq!(dq.front().map(|t| t.id), Some(103), "最旧 3 条被逐出");
        assert_eq!(
            dq.back().map(|t| t.id),
            Some(100 + DSH_TERMINALS_CAP as u64 + 2),
            "最新在尾"
        );
        let elapsed: Vec<u64> = dq.iter().map(|t| t.elapsed_ms).collect();
        let want: Vec<u64> = (3..=DSH_TERMINALS_CAP as u64 + 2).map(|i| i * 10).collect();
        assert_eq!(elapsed, want, "快照旧→新保序");
    }

    /// 全局队列往返：push 后快照可见（注入键断言，容忍并行测试残留）。
    #[test]
    fn global_terminal_ring_roundtrip() {
        let id = crate::engine::next_session_id();
        push_dsh_terminal(DshTerminal {
            id,
            title: "手跑终态".into(),
            ok: false,
            started_ms: 12,
            elapsed_ms: 34,
        });
        let got = dsh_terminals();
        assert!(
            got.len() <= DSH_TERMINALS_CAP,
            "全局队列任何时刻不超上限: {}",
            got.len()
        );
        let t = got.iter().find(|t| t.id == id).expect("push 后快照必须可见");
        assert_eq!(
            (t.ok, t.started_ms, t.elapsed_ms, t.title.as_str()),
            (false, 12, 34, "手跑终态")
        );
    }

    /// 真 dsh 集成（本机 dsh 0.2.2-rc.1 + node ≥24.9，无 key）。本地实跑：
    /// cargo test -p wangshu dsh -- --ignored。
    /// 覆盖：.cmd shim spawn、MISSING_CREDENTIAL 全链事件序（session→
    /// turn/step 日志行→turn_end Error→final Error+Settled）、错误流 exit 1。
    /// 成功流（真 DEEPSEEK_API_KEY）不测。
    /// stderr 必须像 pump 一样排空：持管道不读会卡死 dsh 退出（实测 node 在
    /// 写 stderr 时阻塞、stdout 永不 EOF——drop/排空两形态均正常退出）。
    #[ignore = "需本机全局安装 dsh 0.2.2-rc 且 node≥24.9；CI 无 dsh 会挂，本地用 --ignored 实跑"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_dsh_headless_missing_credential_full_chain() {
        let cwd = std::env::temp_dir().join(format!("cp-engine-dsh-{}", std::process::id()));
        std::fs::create_dir_all(&cwd).unwrap();
        let (session, stdout, stderr) =
            spawn(&cwd, "reply with the single word: pong", "", None).expect("dsh 应已全局安装");

        let drain = tokio::spawn(async move {
            crate::sidecar::read_lines(stderr, |line| eprintln!("[engine:dsh:stderr] {line}"))
                .await;
        });
        let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&lines);
        tokio::time::timeout(std::time::Duration::from_secs(90), async move {
            crate::sidecar::read_lines(stdout, move |line| {
                sink.lock().unwrap().push(line.to_string());
            })
            .await;
        })
        .await
        .expect("dsh headless 应答完即退并 EOF");
        let _ = drain.await;

        let mapped: Vec<MappedLine> = lines.lock().unwrap().iter().map(|l| map_line(l)).collect();
        let session_id = mapped[0]
            .session_id
            .as_deref()
            .expect("首行 session 事件必须带 sessionId")
            .to_string();
        assert!(
            session_id.starts_with("session-"),
            "sessionId 形如 session-<uuid>: {session_id}"
        );
        assert_eq!(
            mapped.last().and_then(|m| m.session_id.as_deref()),
            Some(session_id.as_str()),
            "末行 final 事件应携带同一 sessionId"
        );

        let events: Vec<EngineEvent> = mapped.iter().flat_map(|m| m.events.clone()).collect();
        assert_eq!(
            events.len(),
            6,
            "全链事件序不得多不得少（漂移即改契约）: {events:?}"
        );
        assert_eq!(
            events[0],
            EngineEvent::LogLine {
                text: "TURN 1 开始".into()
            }
        );
        assert_eq!(
            events[1],
            EngineEvent::LogLine {
                text: "TURN 1 · STEP 1 开始".into()
            }
        );
        assert_eq!(
            events[2],
            EngineEvent::LogLine {
                text: "TURN 1 · STEP 1 结束".into()
            }
        );
        for idx in [3, 4] {
            match &events[idx] {
                EngineEvent::Error { message } => assert!(
                    message.contains("DEEPSEEK_API_KEY"),
                    "turn_end/final 双 Error 应为缺 key 原文: {message}"
                ),
                other => panic!("第 {idx} 个事件应为 Error: {other:?}"),
            }
        }
        assert_eq!(events[5], EngineEvent::Settled);

        let code = {
            let mut child = session.proc.child.lock().await;
            child.wait().await.unwrap().code()
        };
        assert_eq!(code, Some(1), "无 key 错误流实测 exit 1");
        let _ = std::fs::remove_dir_all(&cwd);
    }
}

#[cfg(test)]
mod success_flow_tests {
    use super::*;

    // 成功流采样（真 key，2026-11-09）：长回复实测 text 仅一个整段事件。
    #[test]
    fn text_event_maps_to_whole_text_delta() {
        let m = map_line(r#"{"type":"text","text":"pong"}"#);
        assert!(matches!(
            m.events.as_slice(),
            [EngineEvent::TextDelta { text }] if text == "pong"
        ));
    }

    #[test]
    fn thinking_event_maps_to_thinking_delta() {
        let m = map_line(r#"{"type":"thinking","text":"let me count"}"#);
        assert!(matches!(
            m.events.as_slice(),
            [EngineEvent::ThinkingDelta { text }] if text == "let me count"
        ));
    }

    #[test]
    fn step_end_with_usage_emits_logline_then_usage() {
        let m = map_line(
            r#"{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6440,"outputTokens":3,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":6443}}"#,
        );
        assert_eq!(m.events.len(), 2);
        assert!(
            matches!(&m.events[0], EngineEvent::LogLine { text } if text.contains("STEP 1 结束"))
        );
        assert!(matches!(
            &m.events[1],
            EngineEvent::Usage {
                tokens_in: 6440,
                tokens_out: 3
            }
        ));
    }

    #[test]
    fn step_end_without_usage_stays_logline_only() {
        let m = map_line(r#"{"type":"status","phase":"step_end","turn":1,"step":1}"#);
        assert_eq!(m.events.len(), 1);
    }
}
