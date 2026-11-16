//! P1 内置 agent harness：tool-call loop + 写审批门 + 信任目录白名单。
//! task::run 是纯循环（可直接单测），本模块把它接到 Tauri 命令与事件。

pub mod llm;
pub mod mcp;
pub mod skills;
pub mod state;
pub mod task;
pub mod tools;

pub use state::{Task, TaskState};

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{LazyLock, Mutex};
use std::sync::Arc;
use std::time::Instant;

use tauri::{Emitter, Manager};

use crate::tasksdb::{unix_ms, TaskDb, TaskRecord};

pub const EVENT_TASK_UPDATE: &str = "harness://task-update";
const DEFAULT_MAX_STEPS: u32 = 20;

/// 最近 task_update 载荷环形缓存（R5-A-① 重载窗口）。WebView 重载期间
/// emit 无监听者、事件即丢；缓存进程内最近 RECENT_EVENTS_CAP 条，前端
/// 订阅后经 harness_recent_events 重放。不探测监听者（tauri emit 不暴露
/// 监听计数）：恒入队有上限，重放由前端一次性消费并跳过通知。
static RECENT_UPDATES: LazyLock<Mutex<VecDeque<serde_json::Value>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
const RECENT_EVENTS_CAP: usize = 200;

fn flight_log(started: Instant, tag: &str) -> String {
    let s = started.elapsed().as_secs();
    format!("T+{:02}:{:02} {tag}", s / 60, s % 60)
}

fn push_recent(payload: &serde_json::Value) {
    let mut q = RECENT_UPDATES.lock().expect("harness replay queue lock poisoned");
    if q.len() >= RECENT_EVENTS_CAP {
        q.pop_front();
    }
    q.push_back(payload.clone());
}

/// 最近 task_update 载荷（旧→新，至多 200 条），供重载后的前端重放。
/// 进程级：应用退出即清空。
#[tauri::command]
pub fn harness_recent_events() -> Vec<serde_json::Value> {
    RECENT_UPDATES
        .lock()
        .expect("harness replay queue lock poisoned")
        .iter()
        .cloned()
        .collect()
}

fn emit_update(
    app: &tauri::AppHandle,
    id: u64,
    state: &TaskState,
    log: &str,
    tokens_in: u64,
    tokens_out: u64,
) {
    let payload = serde_json::json!({
        "id": id,
        "state": state,
        "log": log,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
    });
    push_recent(&payload);
    let _ = app.emit(EVENT_TASK_UPDATE, payload);
}

/// 启动一个 harness 任务，立即返回 task id；循环在后台异步推进，
/// 进度经 `harness://task-update` 事件与 harness_status 查询。
#[tauri::command]
pub fn harness_run(
    goal: String,
    working_dir: String,
    model: String,
    hub_url: String,
    token: String,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let wd = PathBuf::from(&working_dir);
    wd.canonicalize()
        .map_err(|e| format!("working_dir 不可访问: {working_dir} ({e})"))?;

    let id = state::next_task_id();
    let started_ms = unix_ms();
    let task = Task {
        id,
        goal,
        working_dir: wd,
        history: Vec::new(),
        state: TaskState::Running { step: 0 },
        max_steps: DEFAULT_MAX_STEPS,
        depth: 0,
        tokens_in: 0,
        tokens_out: 0,
        started_ms,
        ended_ms: None,
    };
    state::insert_task(task.clone());

    let abort = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state::insert_control(id, Arc::clone(&abort));

    let llm = llm::LlmClient::new(hub_url.clone(), token.clone(), model);
    let mcp = mcp::McpClient::new(hub_url, token);

    let state_id = id;
    let state_app = app.clone();
    let on_state = move |task: &Task, log: &str| {
        state::update_task_progress(state_id, task);
        emit_update(
            &state_app,
            state_id,
            &task.state,
            log,
            task.tokens_in,
            task.tokens_out,
        );
    };

    let hold_id = id;
    let approval = move |_task_id: u64| {
        let (tx, rx) = tokio::sync::oneshot::channel();
        state::set_pending_approval(hold_id, tx);
        rx
    };

    let finish_id = id;
    let finish_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let final_task = task::run(
            task,
            llm,
            mcp,
            Box::new(approval),
            Box::new(on_state),
            abort,
        )
        .await;
        if let Some(record) = history_record(&final_task, started_ms) {
            finish_app.state::<TaskDb>().save(&record);
        }
        state::insert_task(final_task);
        state::remove_control(finish_id);
    });
    Ok(id)
}

/// 终态任务 → 历史记录；非终态（防御，run 返回必为终态）回 None。
/// 挂点：task::run 返回后由 spawn 写库——run 是全部终态（含 abort 路径）的
/// 单一汇合点，harness_abort 命令只翻旗标与补发事件，loop 最终仍经此处返回。
fn history_record(task: &Task, started_ms: i64) -> Option<TaskRecord> {
    let (status, detail) = match &task.state {
        TaskState::Done { summary } => ("done", summary.clone()),
        TaskState::Failed { error } => ("failed", error.clone()),
        TaskState::Aborted => ("aborted", String::new()),
        TaskState::Running { .. } | TaskState::AwaitingApproval { .. } => return None,
    };
    Some(TaskRecord {
        id: format!("h{}", task.id),
        source: "harness".into(),
        title: llm::truncate(&task.goal, 40),
        status: status.into(),
        detail,
        created_at: started_ms,
        finished_at: unix_ms(),
    })
}

/// 审批当前 HOLD 中的写操作。没有待审批任务时报错。
#[tauri::command]
pub fn harness_approve(task_id: u64, approved: bool) -> Result<(), String> {
    let tx = state::take_pending_approval(task_id).ok_or("该任务当前没有待审批的写操作")?;
    tx.send(approved).map_err(|_| "审批通道已关闭".to_string())
}

/// 中止任务：置 abort 旗标；若在 HOLD 中则经 oneshot 唤醒，loop 丢弃裁决后退出。
#[tauri::command]
pub fn harness_abort(task_id: u64, app: tauri::AppHandle) -> Result<(), String> {
    let abort = state::get_abort_flag(task_id).ok_or("任务不存在或已结束")?;
    abort.store(true, Ordering::SeqCst);
    if let Some(tx) = state::take_pending_approval(task_id) {
        let _ = tx.send(false);
    }
    state::update_task_state(task_id, TaskState::Aborted);
    let log = state::control_started(task_id)
        .map(|started| flight_log(started, "SYS 用户中止"))
        .unwrap_or_else(|| "SYS 用户中止".to_string());
    let (tokens_in, tokens_out) = state::task_usage(task_id).unwrap_or((0, 0));
    emit_update(
        &app,
        task_id,
        &TaskState::Aborted,
        &log,
        tokens_in,
        tokens_out,
    );
    Ok(())
}

/// 查询任务状态（含终态后的最终快照）。
#[tauri::command]
pub fn harness_status(task_id: u64) -> Option<TaskState> {
    state::task_state(task_id)
}

/// 技能名补全（R6-B U5 @技能）：扫 working_dir/.skills/*/SKILL.md，
/// 返回 {name, description}。无 .skills 目录=空表（正常态）。
#[tauri::command]
pub fn skills_list(working_dir: String) -> Vec<SkillView> {
    let report = skills::scan(std::path::Path::new(&working_dir));
    report
        .skills
        .into_iter()
        .map(|s| SkillView {
            name: s.name,
            description: s.description,
        })
        .collect()
}

/// skills_list 的 wire 视图（serde 默认小驼峰：name / description）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillView {
    pub name: String,
    pub description: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 环形缓存只留最近 RECENT_EVENTS_CAP 条且旧→新有序；单测串行触全局
    /// 队列，避免与并行测试互扰。快照语义：取出后再入队不影响已取内容。
    #[test]
    fn recent_events_ring_keeps_last_cap_in_order() {
        for n in 0..(RECENT_EVENTS_CAP as u64 + 5) {
            push_recent(&serde_json::json!({"id": n, "log": format!("step-{n}")}));
        }
        let got = harness_recent_events();
        assert_eq!(got.len(), RECENT_EVENTS_CAP);
        assert_eq!(got[0]["id"], serde_json::json!(5), "oldest entries must evict");
        assert_eq!(got[0]["log"], "step-5");
        assert_eq!(
            got[RECENT_EVENTS_CAP - 1]["id"],
            serde_json::json!(RECENT_EVENTS_CAP as u64 + 4)
        );
        push_recent(&serde_json::json!({"id": 999}));
        assert_eq!(got.len(), RECENT_EVENTS_CAP, "snapshot must not mutate");
    }
}
