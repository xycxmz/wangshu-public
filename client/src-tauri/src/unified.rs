//! T1 统一任务中心聚合：
//! harness 注册表（含终态驻留）+ engine 会话元数据（dsh/pi 在跑态）+
//! schedules 表（enabled 且下次 24h 内＝「待触发」）三路 Rust 源合一，按
//! started_at 降序限 50。material 不在此列——hub 侧数据，前端从现有轮询
//! 合并进统一列表。

use serde::Serialize;

use crate::engine::dsh::DshTerminal;
use crate::engine::{EngineKind, SessionMeta};
use crate::harness::llm;
use crate::harness::state;
use crate::harness::{Task, TaskState};
use crate::tasksdb::{unix_ms, ScheduleRow, TaskDb};

/// 条目上限（设计稿：按 started_at 降序限 50）。
pub const UNIFIED_CAP: usize = 50;
/// sched 源窗口：下次触发在 24h 内的启用行才入列。
const SCHED_WINDOW_SECS: i64 = 24 * 60 * 60;
/// title 截断上限（rune，超出补省略号——同 llm::truncate 语义）。
const TITLE_MAX: usize = 80;

/// 任务类型（对前端契约：kind 判别）。派生顺序即排序决胜序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnifiedKind {
    Harness,
    Dsh,
    Pi,
    Sched,
}

/// 状态映射（对前端契约，五值）：harness aborted 归 done（用户主动收束非
/// 失败，统一状态集不设第六种——与前端 harnessRowOf 同口径）。pi 只出在跑
/// （会话注册表终态不驻留），恒为 run；sched 恒 pending（待触发）；dsh 在跑
/// run、终态走环形驻留队列（done/fail，进程内语义重启即清）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnifiedStatus {
    Run,
    Hold,
    Done,
    Fail,
    Pending,
}

/// 单条统一任务（对前端契约：snake_case 字段，started_at 为 epoch ms——
/// 与前端 UnifiedRow 逐字一致，本地事件流/素材行同为 ms，混排排序同单位）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UnifiedTask {
    pub kind: UnifiedKind,
    /// harness 为任务号（裸数字，与前端 taskEntries 键一致供合并/详情寻址）；
    /// dsh/pi 为 engine 会话号；sched 为行 id。
    pub id: String,
    pub title: String,
    pub status: UnifiedStatus,
    pub started_at: i64, // epoch ms；sched 为 next_run（秒）换算
    pub elapsed_ms: u64, // sched 恒 0（未起跑）
}

fn harness_status(s: &TaskState) -> UnifiedStatus {
    match s {
        TaskState::Running { .. } => UnifiedStatus::Run,
        TaskState::AwaitingApproval { .. } => UnifiedStatus::Hold,
        TaskState::Done { .. } | TaskState::Aborted => UnifiedStatus::Done,
        TaskState::Failed { .. } => UnifiedStatus::Fail,
    }
}

fn from_harness(t: &Task, now_ms: i64) -> UnifiedTask {
    // 终态 elapsed 钉死在 ended-started；缺 ended（终态必钉，见 state 落定）
    // 的防御分支按在跑语义回退 now-started。
    let elapsed_ms = t
        .ended_ms
        .map(|end| (end - t.started_ms).max(0) as u64)
        .unwrap_or_else(|| now_ms.saturating_sub(t.started_ms).max(0) as u64);
    UnifiedTask {
        kind: UnifiedKind::Harness,
        id: t.id.to_string(),
        title: llm::truncate(&t.goal, TITLE_MAX),
        status: harness_status(&t.state),
        started_at: t.started_ms,
        elapsed_ms,
    }
}

fn from_engine(id: u64, m: &SessionMeta, now_ms: i64) -> UnifiedTask {
    UnifiedTask {
        kind: match m.kind {
            EngineKind::Pi => UnifiedKind::Pi,
            EngineKind::Dsh => UnifiedKind::Dsh,
        },
        id: id.to_string(),
        title: llm::truncate(&m.title, TITLE_MAX),
        status: UnifiedStatus::Run,
        started_at: m.started_ms,
        elapsed_ms: now_ms.saturating_sub(m.started_ms).max(0) as u64,
    }
}

/// 终态驻留行（手动跑 dsh 收割入列的 DshTerminal）：id 与在跑行同空间，
/// 生命周期互斥（在跑由会话注册表承载，收割即摘表入列），无同 id 并存。
fn from_terminal(t: &DshTerminal) -> UnifiedTask {
    UnifiedTask {
        kind: UnifiedKind::Dsh,
        id: t.id.to_string(),
        title: llm::truncate(&t.title, TITLE_MAX),
        status: if t.ok { UnifiedStatus::Done } else { UnifiedStatus::Fail },
        started_at: t.started_ms,
        elapsed_ms: t.elapsed_ms,
    }
}

/// sched 入列窗口：启用且 next_run 在 [now, now+24h)。next_run 已过期的行
/// 正在触发或跑中（running 占位期间 next_run 不动）——其 DSH 任务已以 dsh
/// 源在列，不再以「待触发」重复出现；终态落库时 next_run 推进到未来即回归。
fn sched_in_window(s: &ScheduleRow, now_s: i64) -> bool {
    s.enabled && s.next_run >= now_s && s.next_run < now_s + SCHED_WINDOW_SECS
}

fn from_sched(s: &ScheduleRow) -> UnifiedTask {
    UnifiedTask {
        kind: UnifiedKind::Sched,
        id: s.id.clone(),
        title: llm::truncate(&s.name, TITLE_MAX),
        status: UnifiedStatus::Pending,
        started_at: s.next_run * 1000, // 表内 next_run 为 unix 秒，契约统一 ms
        elapsed_ms: 0,
    }
}

/// 聚合核心（纯函数，now 注入可测）：四源映射 + dsh 终态驻留 → started_at
/// 降序 → 截 50。同刻决胜（kind 声明序、id 字典序）保证 HashMap 采集顺序
/// 无关的稳定输出。
pub fn aggregate(
    now_ms: i64,
    harness: &[Task],
    metas: &[(u64, SessionMeta)],
    schedules: &[ScheduleRow],
    terminals: &[DshTerminal],
) -> Vec<UnifiedTask> {
    let now_s = now_ms / 1000;
    let mut all: Vec<UnifiedTask> = harness
        .iter()
        .map(|t| from_harness(t, now_ms))
        .chain(metas.iter().map(|(id, m)| from_engine(*id, m, now_ms)))
        .chain(
            schedules
                .iter()
                .filter(|s| sched_in_window(s, now_s))
                .map(from_sched),
        )
        .chain(terminals.iter().map(from_terminal))
        .collect();
    all.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.id.cmp(&b.id))
    });
    all.truncate(UNIFIED_CAP);
    all
}

/// 四源采集（命令体）：全局注册表 + dsh 终态驻留 + 本地库 → 聚合。
fn collect(db: &TaskDb, now_ms: i64) -> Vec<UnifiedTask> {
    aggregate(
        now_ms,
        &state::snapshot(),
        &crate::engine::session_metas(),
        &db.list_schedules(),
        &crate::engine::dsh::dsh_terminals(),
    )
}

/// 统一任务列（T1）：harness/dsh/pi/sched 四源。material 由前端从 hub 轮询
/// 数据合并，不经此命令。
#[tauri::command]
pub fn tasks_unified(db: tauri::State<'_, TaskDb>) -> Result<Vec<UnifiedTask>, String> {
    Ok(collect(&db, unix_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{insert_session_meta, next_session_id, remove_session};
    use crate::harness::state::{insert_task, next_task_id, update_task_state, ToolCall};
    use std::path::PathBuf;

    fn htask(id: u64, goal: &str, state: TaskState, started_ms: i64, ended_ms: Option<i64>) -> Task {
        Task {
            id,
            goal: goal.into(),
            working_dir: PathBuf::from("."),
            history: Vec::new(),
            state,
            max_steps: 1,
            depth: 0,
            tokens_in: 0,
            tokens_out: 0,
            started_ms,
            ended_ms,
        }
    }

    fn meta(kind: EngineKind, title: &str, started_ms: i64) -> SessionMeta {
        SessionMeta {
            kind,
            title: title.into(),
            started_ms,
        }
    }

    fn srow(id: &str, name: &str, enabled: bool, next_run: i64) -> ScheduleRow {
        ScheduleRow {
            id: id.into(),
            name: name.into(),
            kind: "daily".into(),
            value: "09:00".into(),
            goal: "g".into(),
            workdir: "W:/w".into(),
            webhook_url: String::new(),
            enabled,
            next_run,
            last_run: None,
            last_status: None,
            last_task_id: String::new(),
        }
    }

    /// 线格式是对前端的契约（统一列表/看板的判别依据），锁死字段名与枚举值。
    #[test]
    fn unified_task_serializes_wire_shape() {
        let t = UnifiedTask {
            kind: UnifiedKind::Harness,
            id: "7".into(),
            title: "整理目录".into(),
            status: UnifiedStatus::Hold,
            started_at: 100,
            elapsed_ms: 500,
        };
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"kind":"harness","id":"7","title":"整理目录","status":"hold","started_at":100,"elapsed_ms":500}"#
        );
        assert_eq!(
            serde_json::to_string(&UnifiedStatus::Pending).unwrap(),
            r#""pending""#
        );
    }

    /// harness 五态映射 + elapsed 语义：在跑随 now 增长、终态钉死（aborted 归
    /// done）、超长目标截 80、id 为裸任务号。
    #[test]
    fn harness_maps_states_elapsed_and_title() {
        let now = 10_000_000i64;
        let running = htask(1, "目标", TaskState::Running { step: 2 }, 9_000_000, None);
        let r = from_harness(&running, now);
        assert_eq!(
            (r.kind, r.status, r.id.as_str(), r.started_at, r.elapsed_ms),
            (UnifiedKind::Harness, UnifiedStatus::Run, "1", 9_000_000, 1_000_000)
        );
        let hold = htask(
            2,
            "g",
            TaskState::AwaitingApproval {
                step: 1,
                tool: ToolCall::ListDir { path: ".".into() },
                preview: String::new(),
            },
            0,
            None,
        );
        assert_eq!(from_harness(&hold, now).status, UnifiedStatus::Hold);
        let done = htask(3, "g", TaskState::Done { summary: "s".into() }, 2_000, Some(5_500));
        let d = from_harness(&done, now);
        assert_eq!((d.status, d.elapsed_ms), (UnifiedStatus::Done, 3_500));
        let failed = htask(4, "g", TaskState::Failed { error: "e".into() }, 0, Some(1));
        assert_eq!(from_harness(&failed, now).status, UnifiedStatus::Fail);
        let aborted = htask(5, "g", TaskState::Aborted, 0, Some(1));
        assert_eq!(
            from_harness(&aborted, now).status,
            UnifiedStatus::Done,
            "aborted 归 done（用户主动收束非失败）"
        );
        let long = "字".repeat(100);
        let t = from_harness(&htask(6, &long, TaskState::Aborted, 0, Some(1)), now);
        assert_eq!(t.title.chars().count(), 81, "80 rune + 省略号");
        assert!(t.title.ends_with('…'));
    }

    /// dsh/pi 源：kind 判别 + id 为会话号 + started_at/elapsed 均为 ms。
    #[test]
    fn engine_sources_map_kind_and_elapsed() {
        let now = 500_000i64;
        let dsh = from_engine(41, &meta(EngineKind::Dsh, "部署站点", 400_000), now);
        assert_eq!(
            (dsh.kind, dsh.status, dsh.id.as_str(), dsh.started_at, dsh.elapsed_ms),
            (UnifiedKind::Dsh, UnifiedStatus::Run, "41", 400_000, 100_000)
        );
        let pi = from_engine(42, &meta(EngineKind::Pi, "PI 会话 · demo", 499_000), now);
        assert_eq!(pi.kind, UnifiedKind::Pi);
        assert_eq!(pi.title, "PI 会话 · demo");
    }

    /// dsh 终态驻留源：ok→done / 失败→fail、elapsed 钉死收割值、与在跑行
    /// 混排按 started_at 降序（id 同空间但生命周期互斥，不重复出列）。
    #[test]
    fn terminal_source_maps_status_and_merges_desc() {
        let now = 1_000_000i64;
        let terminals = vec![
            DshTerminal {
                id: 41,
                title: "部署站点".into(),
                ok: true,
                started_ms: 400_000,
                elapsed_ms: 3_500,
            },
            DshTerminal {
                id: 42,
                title: "巡检失败".into(),
                ok: false,
                started_ms: 500_000,
                elapsed_ms: 120,
            },
        ];
        let live = vec![(90u64, meta(EngineKind::Dsh, "在跑", 900_000))];
        let got = aggregate(now, &[], &live, &[], &terminals);
        assert_eq!(
            (got[0].id.as_str(), got[0].status, got[0].elapsed_ms),
            ("90", UnifiedStatus::Run, 100_000),
            "在跑行最新排最前"
        );
        assert_eq!(
            (got[1].kind, got[1].id.as_str(), got[1].status, got[1].started_at, got[1].elapsed_ms),
            (UnifiedKind::Dsh, "42", UnifiedStatus::Fail, 500_000, 120),
            "失败终态 fail、elapsed 钉死"
        );
        assert_eq!(
            (got[2].status, got[2].title.as_str(), got[2].elapsed_ms),
            (UnifiedStatus::Done, "部署站点", 3_500),
            "成功终态 done"
        );
    }

    /// sched 源窗口：启用 + [now, now+24h) 内入列，pending 语义、started_at=next_run。
    #[test]
    fn sched_window_filters() {
        let now_s = 1_000_000i64;
        let cases = [
            ("sc-in", true, now_s, true),               // 恰在此刻
            ("sc-in2", true, now_s + 1, true),           // 近未来
            ("sc-edge", true, now_s + SCHED_WINDOW_SECS, false), // 恰 24h 整（开区间外）
            ("sc-far", true, now_s + SCHED_WINDOW_SECS + 1, false), // 超 24h
            ("sc-past", true, now_s - 1, false),         // 已过期＝触发/跑中，由 dsh 源承载
            ("sc-off", false, now_s + 60, false),        // 停用不入列
        ];
        for (id, enabled, next_run, want_in) in cases {
            let rows = [srow(id, "定时", enabled, next_run)];
            let got = aggregate(now_s * 1000, &[], &[], &rows, &[]);
            assert_eq!(got.len(), usize::from(want_in), "id={id}");
            if want_in {
                assert_eq!(
                    (got[0].kind, got[0].status, got[0].id.as_str(), got[0].started_at, got[0].elapsed_ms),
                    (UnifiedKind::Sched, UnifiedStatus::Pending, id, next_run * 1000, 0),
                    "id={id}"
                );
            }
        }
    }

    /// 四源混排 + started_at 降序 + 上限 50：截掉的是最旧的一批。
    /// sched 窗口下界是 now，入列的 sched 行必排在全部历史任务之上。
    #[test]
    fn aggregate_sorts_desc_and_caps() {
        let now = 100_000_000i64; // now_s = 100_000，sched 窗口 [100_000, 186_400)
        let mut harness = Vec::new();
        for i in 0..20u64 {
            harness.push(htask(
                i,
                &format!("goal-{i}"),
                TaskState::Running { step: 0 },
                (100_001 + i as i64) * 1_000,
                None,
            ));
        }
        let metas = vec![
            (90u64, meta(EngineKind::Dsh, "d", 150_000_000)),
            (91u64, meta(EngineKind::Pi, "p", 160_000_000)),
        ];
        let schedules = vec![
            srow("sc-1", "早", true, 100_000), // 恰在 now，最旧
            srow("sc-2", "晚", true, 186_399), // 窗口上沿内侧，排最前
        ];
        let got = aggregate(now, &harness, &metas, &schedules, &[]);
        assert_eq!(got.len(), 24);
        assert_eq!(got[0].id, "sc-2", "未来 next_run 排最前");
        assert_eq!(got[1].id, "91");
        assert_eq!(got[2].id, "90");
        assert_eq!(got[3].id, "19");
        assert_eq!(got[23].id, "sc-1", "最旧排最后");
        let starts: Vec<i64> = got.iter().map(|t| t.started_at).collect();
        let mut sorted = starts.clone();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        assert_eq!(starts, sorted, "整体必须 started_at 降序");

        let many: Vec<Task> = (0..80u64)
            .map(|i| htask(i, "g", TaskState::Running { step: 0 }, (i + 1) as i64 * 1_000, None))
            .collect();
        let capped = aggregate(now, &many, &[], &[], &[]);
        assert_eq!(capped.len(), UNIFIED_CAP);
        assert_eq!(capped[0].id, "79", "留最新的 50 条");
        assert_eq!(capped[49].id, "30", "最旧的 30 条被截");
    }

    /// 注入式采集（照仓内既有 stub 形态）：harness/引擎注册表 + 临时库 schedules
    /// 三源经 collect 合流；断言只认注入的键，容忍注册表内的并行测试残留。
    #[test]
    fn collect_merges_registry_and_db_sources() {
        let dir = std::env::temp_dir().join(format!("wangshu-unified-{}", std::process::id()));
        let db = TaskDb::init_in(&dir);
        db.save_schedule(&srow("sc-x", "每日构建", true, unix_ms() / 1000 + 600))
            .expect("临时库保存定时行应成功");
        db.save_schedule(&srow("sc-off", "停用", false, unix_ms() / 1000 + 600))
            .expect("临时库保存定时行应成功");

        let hid = next_task_id();
        insert_task(htask(
            hid,
            "注册表里的任务",
            TaskState::Running { step: 1 },
            unix_ms() - 5_000,
            None,
        ));
        update_task_state(hid, TaskState::Done { summary: "ok".into() });
        let sid = next_session_id();
        insert_session_meta(sid, meta(EngineKind::Dsh, "调度外手跑", unix_ms() - 1_000));
        // 终态驻留队列同流经 collect（手动跑收割入列的 DshTerminal）
        let tid = next_session_id();
        crate::engine::dsh::push_dsh_terminal(DshTerminal {
            id: tid,
            title: "手跑已终".into(),
            ok: true,
            started_ms: unix_ms() - 9_000,
            elapsed_ms: 9_000,
        });

        let got = collect(&db, unix_ms());
        let h = got
            .iter()
            .find(|t| t.id == hid.to_string())
            .expect("harness 注入项必须在列");
        assert_eq!((h.kind, h.status), (UnifiedKind::Harness, UnifiedStatus::Done));
        let s = got.iter().find(|t| t.id == sid.to_string()).expect("dsh 注入项必须在列");
        assert_eq!((s.kind, s.status), (UnifiedKind::Dsh, UnifiedStatus::Run));
        let t = got
            .iter()
            .find(|t| t.id == tid.to_string())
            .expect("终态驻留注入项必须在列");
        assert_eq!((t.kind, t.status, t.elapsed_ms), (UnifiedKind::Dsh, UnifiedStatus::Done, 9_000));
        let scheds: Vec<&UnifiedTask> = got.iter().filter(|t| t.kind == UnifiedKind::Sched).collect();
        assert_eq!(scheds.len(), 1, "临时库只有一条窗口内启用行");
        assert_eq!(scheds[0].id, "sc-x");
        assert_eq!(scheds[0].status, UnifiedStatus::Pending);

        remove_session(sid);
        assert!(
            !collect(&db, unix_ms()).iter().any(|t| t.id == sid.to_string()),
            "会话摘表后必须出列"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
