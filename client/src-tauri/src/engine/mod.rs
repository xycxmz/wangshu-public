//! R3 引擎适配层：外部编码引擎的会话与归一事件——PI `--mode rpc` 长驻会话、
//! DSH `headless --json` 一次性任务两种形态。方言隔离在 pi.rs/dsh.rs
//! （spawn/命令构造/事件映射），本模块持有对前端的数据形状与会话注册表
//! （id 空间共用）；未来 AcpAdapter 以平级子模块加入，前端契约不变。
//! MVP 契约：`engine://update` {id, event: EngineEvent}；命令 engine_start/
//! prompt/steer/follow_up/abort/confirm/stop。注册表纪律同 harness/sidecar：
//! 锁内只做 map 操作，IO 一律锁外。

pub mod dsh;
pub mod pi;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::sidecar::state::ProcHandle;

pub const EVENT_UPDATE: &str = "engine://update";

/// 引擎优雅退出的等待上限，超时退回 taskkill 子树强杀（ProcHandle::kill）。
const STOP_GRACE: Duration = Duration::from_secs(5);

/// 归一事件（设计文档 §二 + Error 补充）：前端只认这一种形状。
/// 序列化形如 `{"type":"textDelta","text":"…"}`——tag=type + camelCase，
/// 与 harness TaskState 同风格，是对前端的契约（engine.ts 判别联合）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EngineEvent {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    /// args_json：toolcall_start 阶段参数未到位为空串，tool_execution_start 起为
    /// 完整参数对象文本（同一调用会先后收到两个 ToolStart，UI 按名就近合并）。
    ToolStart {
        name: String,
        args_json: String,
    },
    ToolEnd {
        name: String,
        is_error: bool,
    },
    /// 引擎上报的累计值直接透传（input/output）。
    Usage {
        tokens_in: u64,
        tokens_out: u64,
    },
    /// extension_ui_request（confirm/input）→ 前端审批卡；响应经 engine_confirm 回写。
    ConfirmRequest {
        id: String,
        title: String,
        message: String,
    },
    /// 本轮静止（agent_settled：无重试/压缩/排队自动续跑）。
    Settled,
    Exit {
        code: Option<i32>,
    },
    /// 命令被引擎拒绝（如流式中 prompt 未带 streamingBehavior）：message 为引擎
    /// 原文，原样回事件流。
    Error {
        message: String,
    },
    /// 飞行日志行（DSH turn/step 结构事件的日志呈现；step≠tool 不硬映射
    /// ToolStart，成功流采样后 P3 再定）。
    LogLine {
        text: String,
    },
    /// 当前 pi 会话 uuid（启动即发的 get_state 成功响应携带）：裸起新会话时
    /// uuid 由 pi 实铸，前端以此更新「自动续上次」目标与历史列表。
    SessionStarted {
        session_id: String,
    },
    /// DSH 会话 uuid（session/final 记录捕获，首见即发一次）：统一详情的
    /// 「续跑」数据源。独立变体而非复用 SessionStarted——PI 面板对后者
    /// 不过滤会话号直接采纳，混发会把 dsh uuid 错记成 pi 续会目标。
    DshSession {
        session_id: String,
    },
}

/// 引擎会话：子进程句柄复用 sidecar ProcHandle（child/stdin 双锁 + Windows
/// taskkill 子树），加自增命令号与待响应确认表（extension_ui_request id →
/// method，供 engine_confirm 校验来源与日志）。
pub struct Session {
    pub proc: Arc<ProcHandle>,
    next_cmd: AtomicU64,
    pub pending_confirms: Arc<Mutex<HashMap<String, String>>>,
}

impl Session {
    pub fn new(proc: Arc<ProcHandle>) -> Self {
        Self {
            proc,
            next_cmd: AtomicU64::new(0),
            pending_confirms: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// pi 命令 id：c1/c2/…（协议要求字符串，自增保证唯一以供响应关联）。
    pub fn next_command_id(&self) -> String {
        format!("c{}", self.next_cmd.fetch_add(1, Ordering::Relaxed) + 1)
    }

    pub fn register_confirm(&self, req_id: String, method: String) {
        let mut guard = self
            .pending_confirms
            .lock()
            .expect("engine confirm lock poisoned");
        guard.insert(req_id, method);
    }

    /// 取走待响应请求（一次性：重复响应/伪造 id 直接落空）。
    pub fn take_confirm(&self, req_id: &str) -> Option<String> {
        let mut guard = self
            .pending_confirms
            .lock()
            .expect("engine confirm lock poisoned");
        guard.remove(req_id)
    }

    /// 写一行 stdin（行 + \n + flush）；pi 侧 shutdown 也靠关闭 stdin 触发。
    pub async fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.proc.stdin.lock().await;
        let writer = guard.as_mut().ok_or("引擎 stdin 已关闭")?;
        writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("stdin 写入失败: {e}"))?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|e| format!("stdin 写入失败: {e}"))?;
        writer
            .flush()
            .await
            .map_err(|e| format!("stdin 刷新失败: {e}"))
    }

    /// 构造并发送一条引擎命令（id 自增关联，错误经响应流回 Error 事件）。
    pub async fn send(&self, cmd: pi::Command) -> Result<(), String> {
        let line = pi::command_line(&self.next_command_id(), &cmd);
        self.write_line(&line).await
    }

    /// 停止会话：关闭 stdin 请求 pi 有序退出，超时退回 taskkill 子树。
    /// 会话摘表与 Exit 事件由 pump 在进程收割后发出。
    pub async fn stop(&self) -> Result<(), String> {
        {
            let mut guard = self.proc.stdin.lock().await;
            *guard = None;
        }
        let waited = tokio::time::timeout(STOP_GRACE, async {
            let mut child = self.proc.child.lock().await;
            child.wait().await
        })
        .await;
        match waited {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(format!("等待引擎退出失败: {e}")),
            Err(_) => self.proc.kill().await,
        }
    }
}

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
static SESSIONS: LazyLock<Mutex<HashMap<u64, Arc<Session>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 会话引擎侧别（T1 统一任务列的 kind 源）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    Pi,
    Dsh,
}

/// 会话元数据（T1 统一任务列的 dsh/pi 源）：title/started 不在 Session 本体
/// （进程句柄无业务语义），随会话注册表同生命周期——insert_session 处写入，
/// remove_session 一并摘除（pump 收割即出列，终态不驻留）。
#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub kind: EngineKind,
    pub title: String,
    pub started_ms: i64, // unix ms
}

static SESSION_META: LazyLock<Mutex<HashMap<u64, SessionMeta>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_map<R>(f: impl FnOnce(&mut HashMap<u64, Arc<Session>>) -> R) -> R {
    let mut guard = SESSIONS.lock().expect("engine registry lock poisoned");
    f(&mut guard)
}

fn with_meta_map<R>(f: impl FnOnce(&mut HashMap<u64, SessionMeta>) -> R) -> R {
    let mut guard = SESSION_META.lock().expect("engine meta lock poisoned");
    f(&mut guard)
}

pub fn next_session_id() -> u64 {
    NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn insert_session(id: u64, session: Arc<Session>) {
    with_map(|m| {
        m.insert(id, session);
    });
}

pub fn insert_session_meta(id: u64, meta: SessionMeta) {
    with_meta_map(|m| {
        m.insert(id, meta);
    });
}

/// 元数据快照（tasks_unified 聚合用）：只含在跑会话（随 remove_session 摘除）。
pub fn session_metas() -> Vec<(u64, SessionMeta)> {
    with_meta_map(|m| m.iter().map(|(id, meta)| (*id, meta.clone())).collect())
}

/// 单会话元数据（pump 收割处读 started_ms；摘表前调用必有值）。
pub fn session_meta_of(id: u64) -> Option<SessionMeta> {
    with_meta_map(|m| m.get(&id).cloned())
}

pub fn get_session(id: u64) -> Option<Arc<Session>> {
    with_map(|m| m.get(&id).cloned())
}

pub fn remove_session(id: u64) {
    with_map(|m| {
        m.remove(&id);
    });
    with_meta_map(|m| {
        m.remove(&id);
    });
}

fn emit_update(app: &tauri::AppHandle, id: u64, event: &EngineEvent) {
    let _ = app.emit(
        EVENT_UPDATE,
        serde_json::json!({ "id": id, "event": event }),
    );
}

/// 启动 pi 引擎会话（--mode rpc + --session-dir 固定 app 数据目录；可选
/// provider/model/session_id——session_id 命中既有会话文件才续接，未命中裸起
/// 新会话，pi 实铸 uuid 经 SessionStarted 事件回传，R5-B#5 恢复链），
/// 立即返回会话 id；stdout 逐行映射为归一事件经 `engine://update` 推送。
#[tauri::command]
pub async fn engine_start(
    provider: Option<String>,
    model: Option<String>,
    cwd: String,
    session_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let cwd = PathBuf::from(&cwd)
        .canonicalize()
        .map_err(|e| format!("cwd 不可访问: {cwd} ({e})"))?;
    // pi 会话目录：app 数据目录下 pi-sessions（建目录失败不阻断——pi 自会报错）
    let session_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("pi-sessions"))
        .map_err(|e| format!("app 数据目录不可用: {e}"))?;
    let _ = std::fs::create_dir_all(&session_dir);
    let (session, stdout, stderr) = pi::spawn(
        &cwd,
        provider.as_deref(),
        model.as_deref(),
        &session_dir,
        session_id.as_deref(),
    )?;
    let session = Arc::new(session);
    let id = next_session_id();
    insert_session(id, Arc::clone(&session));
    let workdir = cwd
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.to_string_lossy().into_owned());
    insert_session_meta(
        id,
        SessionMeta {
            kind: EngineKind::Pi,
            title: format!("PI 会话 · {workdir}"),
            started_ms: crate::tasksdb::unix_ms(),
        },
    );
    tauri::async_runtime::spawn(pi::pump(id, session, stdout, stderr, app));
    Ok(id)
}

/// 发起新任务/续问。agent 流式中 pi 会拒绝未带 streamingBehavior 的 prompt
/// （我们 UI 场景用 steer 命令独立表达），错误经 Error 事件回流。
#[tauri::command]
pub async fn engine_prompt(id: u64, text: String) -> Result<(), String> {
    let session = get_session(id).ok_or("引擎会话不存在或已结束")?;
    session.send(pi::Command::Prompt { text }).await
}

/// 流式中插话（本轮工具执行完、下次调模型前投递）。
#[tauri::command]
pub async fn engine_steer(id: u64, text: String) -> Result<(), String> {
    let session = get_session(id).ok_or("引擎会话不存在或已结束")?;
    session.send(pi::Command::Steer { text }).await
}

/// 排队到本轮结束后投递的追问。
#[tauri::command]
pub async fn engine_follow_up(id: u64, text: String) -> Result<(), String> {
    let session = get_session(id).ok_or("引擎会话不存在或已结束")?;
    session.send(pi::Command::FollowUp { text }).await
}

/// 中止当前操作（abort 等会话静止后才回响应）。
#[tauri::command]
pub async fn engine_abort(id: u64) -> Result<(), String> {
    let session = get_session(id).ok_or("引擎会话不存在或已结束")?;
    session.send(pi::Command::Abort).await
}

/// 回应 ConfirmRequest：confirmed=false → cancelled；true+value → value（input
/// 型）；true 无 value → confirmed（confirm 型）。req_id 必须在待响应表中。
#[tauri::command]
pub async fn engine_confirm(
    id: u64,
    req_id: String,
    confirmed: bool,
    value: Option<String>,
) -> Result<(), String> {
    let session = get_session(id).ok_or("引擎会话不存在或已结束")?;
    let method = session
        .take_confirm(&req_id)
        .ok_or("该确认请求不存在或已响应")?;
    if (method == "confirm" && value.is_some())
        || (method == "input" && confirmed && value.is_none())
    {
        eprintln!("[engine] 回复形状与请求方法不匹配: method={method} req={req_id}");
    }
    let line = pi::confirm_response_line(&req_id, confirmed, value.as_deref());
    session.write_line(&line).await
}

/// 停止会话（先礼后兵：关 stdin → 限时等待 → taskkill 子树）。
#[tauri::command]
pub async fn engine_stop(id: u64) -> Result<(), String> {
    let session = get_session(id).ok_or("引擎会话不存在或已结束")?;
    session.stop().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EngineEvent 的线格式是对前端的契约（engine.ts 判别联合），逐变体锁死
    /// tag 与字段名的 camelCase 形状。
    #[test]
    fn engine_events_serialize_with_camel_case_tag() {
        let cases: Vec<(EngineEvent, String)> = vec![
            (
                EngineEvent::TextDelta { text: "hi".into() },
                r#"{"type":"textDelta","text":"hi"}"#.into(),
            ),
            (
                EngineEvent::ThinkingDelta { text: "想".into() },
                r#"{"type":"thinkingDelta","text":"想"}"#.into(),
            ),
            (
                EngineEvent::ToolStart {
                    name: "bash".into(),
                    args_json: r#"{"command":"ls"}"#.into(),
                },
                r#"{"type":"toolStart","name":"bash","argsJson":"{\"command\":\"ls\"}"}"#.into(),
            ),
            (
                EngineEvent::ToolStart {
                    name: "read".into(),
                    args_json: String::new(),
                },
                r#"{"type":"toolStart","name":"read","argsJson":""}"#.into(),
            ),
            (
                EngineEvent::ToolEnd {
                    name: "bash".into(),
                    is_error: true,
                },
                r#"{"type":"toolEnd","name":"bash","isError":true}"#.into(),
            ),
            (
                EngineEvent::Usage {
                    tokens_in: 11,
                    tokens_out: 22,
                },
                r#"{"type":"usage","tokensIn":11,"tokensOut":22}"#.into(),
            ),
            (
                EngineEvent::ConfirmRequest {
                    id: "uuid-2".into(),
                    title: "Clear session?".into(),
                    message: "All messages will be lost.".into(),
                },
                r#"{"type":"confirmRequest","id":"uuid-2","title":"Clear session?","message":"All messages will be lost."}"#.into(),
            ),
            (EngineEvent::Settled, r#"{"type":"settled"}"#.into()),
            (
                EngineEvent::Exit { code: Some(0) },
                r#"{"type":"exit","code":0}"#.into(),
            ),
            (
                EngineEvent::Exit { code: None },
                r#"{"type":"exit","code":null}"#.into(),
            ),
            (
                EngineEvent::Error {
                    message: "boom".into(),
                },
                r#"{"type":"error","message":"boom"}"#.into(),
            ),
            (
                EngineEvent::LogLine {
                    text: "TURN 1 · STEP 1 开始".into(),
                },
                r#"{"type":"logLine","text":"TURN 1 · STEP 1 开始"}"#.into(),
            ),
            (
                EngineEvent::SessionStarted {
                    session_id: "01a1d916-b7f5-70a8-b141-735b17f12759".into(),
                },
                r#"{"type":"sessionStarted","sessionId":"01a1d916-b7f5-70a8-b141-735b17f12759"}"#.into(),
            ),
            (
                EngineEvent::DshSession {
                    session_id: "session-a1a8fe9b-73f0-4b39-8753-0de06f3f92a4".into(),
                },
                r#"{"type":"dshSession","sessionId":"session-a1a8fe9b-73f0-4b39-8753-0de06f3f92a4"}"#.into(),
            ),
        ];
        for (event, want) in cases {
            assert_eq!(serde_json::to_string(&event).unwrap(), want);
        }
    }

    #[cfg(windows)]
    #[test]
    fn session_command_ids_increment() {
        let session = Session::new(Arc::new(ProcHandle::new(None, fake_child(), None)));
        assert_eq!(session.next_command_id(), "c1");
        assert_eq!(session.next_command_id(), "c2");
        assert_eq!(session.next_command_id(), "c3");
    }

    /// 命令号是每会话独立命名空间：两个会话各自从 c1 起（响应按 (会话,id) 关联）。
    #[cfg(windows)]
    #[test]
    fn command_ids_are_per_session_namespace() {
        let a = Session::new(Arc::new(ProcHandle::new(None, fake_child(), None)));
        let b = Session::new(Arc::new(ProcHandle::new(None, fake_child(), None)));
        assert_eq!(a.next_command_id(), "c1");
        assert_eq!(b.next_command_id(), "c1");
        assert_eq!(a.next_command_id(), "c2");
    }

    #[cfg(windows)]
    #[test]
    fn pending_confirm_register_and_take_is_one_shot() {
        let session = Session::new(Arc::new(ProcHandle::new(None, fake_child(), None)));
        session.register_confirm("uuid-1".into(), "confirm".into());
        assert_eq!(session.take_confirm("uuid-1").as_deref(), Some("confirm"));
        assert!(session.take_confirm("uuid-1").is_none(), "重复响应必须落空");
        assert!(session.take_confirm("never-registered").is_none());
    }

    #[tokio::test]
    async fn commands_on_unknown_session_error() {
        assert!(engine_prompt(99_999_999, "hi".into()).await.is_err());
        assert!(engine_steer(99_999_999, "hi".into()).await.is_err());
        assert!(engine_follow_up(99_999_999, "hi".into()).await.is_err());
        assert!(engine_abort(99_999_999).await.is_err());
        assert!(engine_stop(99_999_999).await.is_err());
        assert!(engine_confirm(99_999_999, "r".into(), true, None)
            .await
            .is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn session_write_line_without_pipe_errors() {
        let session = Session::new(Arc::new(ProcHandle::new(None, fake_child(), None)));
        assert!(session.write_line("{}").await.is_err());
    }

    #[test]
    fn session_ids_increment_from_registry() {
        let a = next_session_id();
        let b = next_session_id();
        assert!(b > a, "会话号必须单调递增");
    }

    /// 注册表往返：insert/get/remove 与未命中行为（pump 退出摘表依赖 remove）。
    #[cfg(windows)]
    #[test]
    fn registry_roundtrip_insert_get_remove() {
        assert!(get_session(98_999_999).is_none(), "未注册 id 必须查空");
        let id = next_session_id();
        let session = Arc::new(Session::new(Arc::new(ProcHandle::new(
            None,
            fake_child(),
            None,
        ))));
        insert_session(id, Arc::clone(&session));
        assert!(get_session(id).is_some(), "注册后必须可查");
        remove_session(id);
        assert!(get_session(id).is_none(), "摘表后必须查空");
        remove_session(id);
    }

    /// 元数据注册表随会话生命周期：insert 后快照可见，remove_session 一并
    /// 摘除（pump 收割即出统一任务列，终态不驻留）。
    #[test]
    fn session_meta_follows_session_lifecycle() {
        let id = next_session_id();
        assert!(
            !session_metas().iter().any(|(i, _)| *i == id),
            "未注册 id 不得出现在元数据快照"
        );
        insert_session_meta(
            id,
            SessionMeta {
                kind: EngineKind::Dsh,
                title: "部署站点".into(),
                started_ms: 1_234,
            },
        );
        let got = session_metas()
            .into_iter()
            .find(|(i, _)| *i == id)
            .expect("insert 后快照必须可见");
        assert_eq!(got.1.kind, EngineKind::Dsh);
        assert_eq!(got.1.title, "部署站点");
        assert_eq!(got.1.started_ms, 1_234);
        remove_session(id);
        assert!(
            !session_metas().iter().any(|(i, _)| *i == id),
            "remove_session 必须一并摘除元数据"
        );
        remove_session(id);
    }

    /// stop 对已自行退出的进程：stdin 本就为空、wait 立即返回，整个调用 Ok。
    #[cfg(windows)]
    #[tokio::test]
    async fn stop_on_already_exited_process_succeeds() {
        let session = Session::new(Arc::new(ProcHandle::new(None, fake_child(), None)));
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.stop().await.expect("已退出进程的 stop 应 Ok");
    }

    /// stop 对不理会 stdin 关闭的长命进程：宽限超时后必须走 taskkill 子树
    /// 强杀路径并成功返回（ping 持续约 12s，远超 5s 宽限）。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stop_falls_back_to_tree_kill_when_grace_expires() {
        let mut command = tokio::process::Command::new("ping");
        command
            .args(["-n", "12", "-w", "1000", "127.0.0.1"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("ping 应可启动");
        let pid = child.id().expect("spawn 成功必有 pid");
        let session = Session::new(Arc::new(ProcHandle::new(Some(pid), child, None)));
        session.stop().await.expect("宽限超时应走强杀路径并成功");
        assert!(!process_alive(pid), "进程树必须被收掉: pid={pid}");
    }

    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        use std::os::windows::process::CommandExt as _;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .creation_flags(0x0800_0000)
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }

    /// 构造一个即刻退出的占位进程，只为满足 ProcHandle 的 Child 类型。
    #[cfg(windows)]
    fn fake_child() -> tokio::process::Child {
        let mut command = tokio::process::Command::new("cmd");
        command
            .arg("/C")
            .arg("exit 0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null());
        command.spawn().expect("占位进程应可启动")
    }
}
