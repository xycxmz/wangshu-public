//! R10-B B2 定时任务：schedules 表之上的调度决策与执行。决策是纯函数
//! （next_after / should_fire / missed_window / tick_action，可离线单测），
//! 执行是 setup 起的 30s 扫描线程：到期项置 running 占位（单并发闸）→ 触发
//! DSH 同款管线（engine::dsh::start_task 复用 dsh_run 的校验与 spawn）→
//! 终态回 ok/fail + next_run 推进 + 托盘通知 + webhook 推送（R11-S1）。
//! 管理面命令五个在此（R11-S2 加 schedule_fire_now 立即触发）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use chrono::{Local, TimeZone};
use serde::Deserialize;
use tauri::Manager;

use crate::engine::dsh::{self, DshOutcome};
use crate::tasksdb::{unix_ms, ScheduleRow, TaskDb};

/// 扫描周期：next_run 精度即此值（30s 内的到点差异无感）。
const SCAN_INTERVAL: Duration = Duration::from_secs(30);
/// webhook 单次 POST 超时（R11-S1）；非 2xx/传输失败重试 1 次后放弃。
const WEBHOOK_TIMEOUT: Duration = Duration::from_secs(10);
const WEBHOOK_ATTEMPTS: usize = 2;
/// summary 上限（rune）：终答取前 500 字，无终答回退末 3 行日志拼接，同上限。
const SUMMARY_MAX_CHARS: usize = 500;
/// 错过补跑窗口：next_run 迟到 ≤30min 补跑一次，更久跳过等下一档
/// （桌面休眠场景——睡醒后不把睡着期间的档全部补跑一遍）。
const CATCHUP_WINDOW_SECS: i64 = 30 * 60;
/// next_after 对存量坏行算不出下一档时的兜底重试间隔（正常路径不可达：
/// 保存前已校验；手改库防坏行打转扫描）。
const FALLBACK_RETRY_SECS: i64 = 3600;

fn unix_now() -> i64 {
    unix_ms() / 1000
}

/* ── 调度决策（纯函数） ──────────────────────────────── */

/// 下一档触发时间（unix 秒）。interval：value=分钟数，now+N*60；
/// daily：value=HH:MM 本地时区，当天未到取当天、已到（含恰在当刻）取次日。
/// 非法 kind/value 回 Err（schedule_save 据此在保存前拒绝坏输入）。
pub fn next_after(kind: &str, value: &str, now: i64) -> Result<i64, String> {
    match kind {
        "interval" => {
            let minutes: i64 = value
                .trim()
                .parse()
                .map_err(|_| format!("interval 的 value 须为分钟数，得到「{value}」"))?;
            if minutes < 1 {
                return Err(format!("interval 分钟数须 ≥ 1，得到 {minutes}"));
            }
            if minutes > i64::MAX / 60 {
                return Err(format!("interval 分钟数过大: {minutes}"));
            }
            Ok(now + minutes * 60)
        }
        "daily" => {
            let (h, m) = parse_hhmm(value)?;
            let now_local = Local
                .timestamp_opt(now, 0)
                .single()
                .ok_or("now 本地时间不可解析")?;
            let today = now_local
                .date_naive()
                .and_hms_opt(h, m, 0)
                .ok_or("daily 时间组合非法")?;
            if let Some(t) = local_to_unix(today).filter(|t| *t > now) {
                return Ok(t);
            }
            let tomorrow = today
                .checked_add_days(chrono::Days::new(1))
                .ok_or("日期推进越界")?;
            local_to_unix(tomorrow)
                .ok_or_else(|| "daily 时间在本地时区不可解析（夏令时空档）".to_string())
        }
        other => Err(format!("kind 须为 interval 或 daily，得到「{other}」")),
    }
}

fn parse_hhmm(value: &str) -> Result<(u32, u32), String> {
    let bad = || format!("daily 的 value 须为 HH:MM，得到「{value}」");
    let (h, m) = value.trim().split_once(':').ok_or_else(bad)?;
    let h: u32 = h.parse().map_err(|_| bad())?;
    let m: u32 = m.parse().map_err(|_| bad())?;
    if h > 23 || m > 59 {
        return Err(format!("daily 时间越界（HH 0-23 / MM 0-59），得到「{value}」"));
    }
    Ok((h, m))
}

/// 本地 naive → unix 秒；歧义时刻取较早侧，不存在（夏令时空档）回 None。
fn local_to_unix(naive: chrono::NaiveDateTime) -> Option<i64> {
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.timestamp())
}

/// 到点判定：启用 && now ≥ next_run && 不在 running 占位（上次未完不再触发）。
pub fn should_fire(s: &ScheduleRow, now: i64) -> bool {
    s.enabled && s.last_status.as_deref() != Some("running") && now >= s.next_run
}

/// 错过窗口：now 落后 next_run 超过补跑窗口（strictly >，恰 30min 仍补跑）。
pub fn missed_window(s: &ScheduleRow, now: i64) -> bool {
    now.saturating_sub(s.next_run) > CATCHUP_WINDOW_SECS
}

/// 一次扫描对单行的裁决。
#[derive(Debug, PartialEq)]
pub enum TickAction {
    /// 未到点/停用/占位中：不动。
    Wait,
    /// 错过窗口：跳过该档，推进 next_run 到给值（不触发、不动 last_*）。
    SkipTo(i64),
    /// 到点且在补跑窗口内：触发。
    Fire,
}

/// 单行裁决：should_fire 先闸，missed_window 分流补跑/跳过。跳过档的下一档
/// 按 now 重算；存量坏行（value 手改坏）算不出时兜底 1h 后重试并 log。
pub fn tick_action(s: &ScheduleRow, now: i64) -> TickAction {
    if !should_fire(s, now) {
        return TickAction::Wait;
    }
    if !missed_window(s, now) {
        return TickAction::Fire;
    }
    let next = match next_after(&s.kind, &s.value, now) {
        Ok(next) => next,
        Err(e) => {
            eprintln!("[schedule] 「{}」下一档计算失败（{}），{}s 后重试", s.name, e, FALLBACK_RETRY_SECS);
            now + FALLBACK_RETRY_SECS
        }
    };
    TickAction::SkipTo(next)
}

/* ── 扫描线程 ────────────────────────────────────────── */

/// 调度线程生命周期：setup 起，随进程活——app 退出时 tauri async runtime
/// drop，本任务随之取消；无自持资源要清理（触发出去的 DSH pump 是独立
/// spawn 任务，子进程 kill_on_drop 兜底，同 dsh_run 手跑路径）。
/// interval 首拍即刻到，启动恢复后马上扫一轮（应用启动恢复扫描）。
pub fn spawn_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        recover_stale_running(&app);
        let mut ticker = tokio::time::interval(SCAN_INTERVAL);
        loop {
            ticker.tick().await;
            scan_once(&app);
        }
    });
}

/// 启动恢复：running 占位只在本进程存活期间合法（pump 随进程死），跨重启即
/// 死占位——复位为 fail，next_run 保持原值，让首扫按错过规则决定补跑/跳过。
/// 不发通知（陈旧中断，定时列表的「上次状态」已可见）。
fn recover_stale_running(app: &tauri::AppHandle) {
    let db = app.state::<TaskDb>();
    let now = unix_now();
    for row in db.list_schedules() {
        if row.last_status.as_deref() == Some("running")
            && db.set_schedule_finished(&row.id, "fail", now, row.next_run, "") > 0
        {
            eprintln!("[schedule] 恢复：「{}」上次运行因应用退出中断，置 fail", row.name);
        }
    }
}

fn scan_once(app: &tauri::AppHandle) {
    let db = app.state::<TaskDb>();
    let now = unix_now();
    for row in db.list_schedules() {
        match tick_action(&row, now) {
            TickAction::Wait => {}
            TickAction::SkipTo(next) => {
                eprintln!(
                    "[schedule] 「{}」错过窗口超过 {} 分钟，跳过档等下一轮",
                    row.name,
                    CATCHUP_WINDOW_SECS / 60
                );
                db.set_schedule_next_run(&row.id, next);
            }
            TickAction::Fire => fire(app, &row),
        }
    }
}

/// 触发一条：先置 running（占位条件更新——已 running/行已删即让位放弃），
/// 再走 dsh_run 同款管线（cwd 校验、key 走 dsh_run 沉淀的进程内记忆）。
/// 起跑即败（cwd 不可访问/dsh 未装）直接落终态；正常路径由 pump 终局回调
/// 收尾（终态时间戳取完成时刻）。扫描到点与 fire_now 共用此口。
fn fire(app: &tauri::AppHandle, row: &ScheduleRow) {
    let db = app.state::<TaskDb>();
    if db.set_schedule_running(&row.id) == 0 {
        return;
    }
    eprintln!("[schedule] 「{}」触发 DSH（workdir {}）", row.name, row.workdir);
    let cb_app = app.clone();
    let fired = row.clone();
    let started = dsh::start_task(
        &row.workdir,
        &row.goal,
        &dsh::remembered_key(),
        None,
        app.clone(),
        Some(Box::new(move |outcome| {
            finish(&cb_app, &fired, outcome);
        })),
    );
    if let Err(e) = started {
        eprintln!("[schedule] 「{}」触发失败: {e}", row.name);
        finish(
            app,
            row,
            DshOutcome {
                ok: false,
                error: Some(e),
                text: String::new(),
                log_tail: Vec::new(),
                session_id: None,
                exit: None,
            },
        );
    }
}

/// 终态统一收口：落库（行已删则跳过不通知不推送）+ webhook 推送 + 托盘通知。
/// next_run 从完成时刻重算（interval 保持完成后再数 N 分钟的节奏；daily 取
/// 下一 occurrence）。推送为异步尽力而为，不阻塞通知与终态。
fn finish(app: &tauri::AppHandle, row: &ScheduleRow, outcome: DshOutcome) {
    let now = unix_now();
    let next = next_after(&row.kind, &row.value, now).unwrap_or(now + FALLBACK_RETRY_SECS);
    let status = if outcome.ok { "ok" } else { "fail" };
    let db = app.state::<TaskDb>();
    if db.set_schedule_finished(
        &row.id,
        status,
        now,
        next,
        outcome.session_id.as_deref().unwrap_or(""),
    ) == 0
    {
        return;
    }
    spawn_webhook(row, status, now, summary(&outcome));
    notify_result(app, &row.name, &outcome);
}

/* ── 终态摘要与 webhook（R11-S1）────────────────────── */

/// 终态摘要（webhook payload 与托盘通知同源）：终答非空取前 500 rune；
/// 无终答取末 3 行飞行日志拼接；再无（起跑即败）退错误原文；全空回空串。
fn summary(outcome: &DshOutcome) -> String {
    if !outcome.text.is_empty() {
        return outcome.text.chars().take(SUMMARY_MAX_CHARS).collect();
    }
    if !outcome.log_tail.is_empty() {
        return outcome.log_tail
            .join("\n")
            .chars()
            .take(SUMMARY_MAX_CHARS)
            .collect();
    }
    outcome
        .error
        .as_deref()
        .map(|e| e.chars().take(SUMMARY_MAX_CHARS).collect())
        .unwrap_or_default()
}

/// webhook 推送体（S1 契约：snake_case JSON 四字段）。
#[derive(Debug, serde::Serialize)]
struct WebhookPayload {
    name: String,
    status: String,
    finished_at: i64, // unix 秒
    summary: String,
}

/// 终态 webhook：地址非空才推。异步发射到 tauri runtime，失败只日志
/// （推送不影响任务终态——终态已先行落库）。
fn spawn_webhook(row: &ScheduleRow, status: &str, finished_at: i64, summary: String) {
    if row.webhook_url.is_empty() {
        return;
    }
    let url = row.webhook_url.clone();
    let payload = WebhookPayload {
        name: row.name.clone(),
        status: status.to_string(),
        finished_at,
        summary,
    };
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(WEBHOOK_TIMEOUT).build() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[schedule] webhook client 构建失败: {e}");
                return;
            }
        };
        if !deliver_webhook(&client, &url, &payload).await {
            eprintln!("[schedule] webhook 推送终败（已重试）: {url}");
        }
    });
}

/// 单次 POST：2xx 视为送达；非 2xx/传输错误（超时、断连）回 Err 原因。
async fn post_webhook_once(
    client: &reqwest::Client,
    url: &str,
    payload: &WebhookPayload,
) -> Result<(), String> {
    let resp = client
        .post(url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("非 2xx 响应: {}", resp.status()))
    }
}

/// 送达循环：非 2xx/超时/断连重试 1 次，仍败放弃（调用方只日志）。回
/// 是否送达（单测断言用）。
async fn deliver_webhook(
    client: &reqwest::Client,
    url: &str,
    payload: &WebhookPayload,
) -> bool {
    for attempt in 1..=WEBHOOK_ATTEMPTS {
        match post_webhook_once(client, url, payload).await {
            Ok(()) => return true,
            Err(e) => {
                eprintln!("[schedule] webhook 第 {attempt}/{WEBHOOK_ATTEMPTS} 次推送失败: {e}")
            }
        }
    }
    false
}

/// 通知正文（R11-S3）：成功带 summary 首行截 60 rune；失败保留错误原文
/// （大声失败——日志行对排障无用，错误才是要大声说的）。
fn notify_body(outcome: &DshOutcome) -> String {
    if outcome.ok {
        let text = summary(outcome);
        let first = text
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("任务完成");
        crate::harness::llm::truncate(first, 60)
    } else {
        match &outcome.error {
            Some(e) => crate::harness::llm::truncate(e, 120),
            None => format!("进程异常退出（exit {:?}），末行日志: {}",
                outcome.exit,
                outcome.log_tail.last().map(String::as_str).unwrap_or("")),
        }
    }
}

/// 终态托盘通知（notification 插件，与前端 notifyTaskDone 同源）：主窗口
/// 可见时不打扰（对齐其 document.hidden 语义）。文案「定时 · <名> · 成功/失败」。
fn notify_result(app: &tauri::AppHandle, name: &str, outcome: &DshOutcome) {
    if crate::desktop::main_window_visible(app) {
        return;
    }
    let title = format!("定时 · {name} · {}", if outcome.ok { "成功" } else { "失败" });
    let body = notify_body(outcome);
    use tauri_plugin_notification::NotificationExt as _;
    if let Err(e) = app.notification().builder().title(&title).body(&body).show() {
        eprintln!("[schedule] 通知发送失败: {e}");
    }
}

/* ── 管理命令 ────────────────────────────────────────── */

/// schedule_save 的输入（对前端契约：snake_case；id 空/缺=新建，有=改）。
/// webhook_url 缺省容错（旧前端未带该字段=空=不推送）。
#[derive(Debug, Clone, Deserialize)]
pub struct ScheduleInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: String,
    pub value: String,
    pub goal: String,
    pub workdir: String,
    #[serde(default)]
    pub webhook_url: String,
    pub enabled: bool,
}

static ID_SEQ: AtomicU64 = AtomicU64::new(1);

fn new_schedule_id() -> String {
    format!("sc-{:x}-{}", unix_ms(), ID_SEQ.fetch_add(1, Ordering::Relaxed))
}

/// webhook 地址规范化（schedule_save 的边界校验）：trim 后空=不推送；
/// 非空须为 http(s) 绝对 URL（reqwest 只走 http(s)，坏值在保存前拒绝）。
fn normalize_webhook_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().to_string();
    if url.is_empty() {
        return Ok(url);
    }
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("webhook 地址无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(url),
        other => Err(format!("webhook 地址须为 http(s) URL，得到 {other}://")),
    }
}

/// 定时任务列表（next_run 升序）。
#[tauri::command]
pub fn schedule_list(db: tauri::State<'_, TaskDb>) -> Vec<ScheduleRow> {
    db.list_schedules()
}

/// 新建/编辑一条：id 空=建、有=改（保留 last_* 历史，只改定义并重算 next_run）。
/// kind/value 合法性经 next_after 校验，webhook_url 经 normalize_webhook_url
/// 校验，坏输入在落库前拒绝。回保存后的行。
#[tauri::command]
pub fn schedule_save(
    db: tauri::State<'_, TaskDb>,
    s: ScheduleInput,
) -> Result<ScheduleRow, String> {
    let name = s.name.trim().to_string();
    if name.is_empty() {
        return Err("name 不能为空".into());
    }
    let goal = s.goal.trim().to_string();
    if goal.is_empty() {
        return Err("goal 不能为空".into());
    }
    let workdir = s.workdir.trim().to_string();
    if workdir.is_empty() {
        return Err("workdir 不能为空".into());
    }
    let webhook_url = normalize_webhook_url(&s.webhook_url)?;
    let value = s.value.trim().to_string();
    let next = next_after(&s.kind, &value, unix_now())?;
    let row = match s.id.as_deref().map(str::trim).filter(|i| !i.is_empty()) {
        Some(id) => {
            let existing = db
                .list_schedules()
                .into_iter()
                .find(|r| r.id == id)
                .ok_or_else(|| "定时任务不存在（可能已被删除），请刷新后重试".to_string())?;
            ScheduleRow {
                id: existing.id,
                name,
                kind: s.kind,
                value,
                goal,
                workdir,
                webhook_url,
                enabled: s.enabled,
                next_run: next,
                last_run: existing.last_run,
                last_status: existing.last_status,
                last_task_id: existing.last_task_id,
            }
        }
        None => ScheduleRow {
            id: new_schedule_id(),
            name,
            kind: s.kind,
            value,
            goal,
            workdir,
            webhook_url,
            enabled: s.enabled,
            next_run: next,
            last_run: None,
            last_status: None,
            last_task_id: String::new(),
        },
    };
    db.save_schedule(&row)?;
    Ok(row)
}

/// 立即触发的行裁决（R11-S2）：行存在且不在 running 占位 → 可触发；占位中
/// 拒绝（上一轮未完）；不存在报错。停用行放行——enabled 闸的是自动触发，
/// 不拦显式操作。
fn fire_now_row(rows: Vec<ScheduleRow>, id: &str) -> Result<ScheduleRow, String> {
    let row = rows
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "定时任务不存在（可能已被删除）".to_string())?;
    if row.last_status.as_deref() == Some("running") {
        return Err(format!("「{}」上一轮仍在运行中，待完成后再试", row.name));
    }
    Ok(row)
}

/// 立即跑一轮（R11-S2）：忽略 next_run 直接触发；running 占位仍生效（快照
/// 拒绝 + 占位条件更新双闸，与扫描线程并发时只跑一份）；完成路径与常规
/// 触发一致（webhook/通知/next_run 从完成时刻重算）。
#[tauri::command]
pub fn schedule_fire_now(
    app: tauri::AppHandle,
    db: tauri::State<'_, TaskDb>,
    id: String,
) -> Result<(), String> {
    let row = fire_now_row(db.list_schedules(), &id)?;
    fire(&app, &row);
    Ok(())
}

/// 启停一条并重算 next_run（重新启用从当下取下一档，不追旧账）。
#[tauri::command]
pub fn schedule_toggle(db: tauri::State<'_, TaskDb>, id: String, enabled: bool) -> Result<(), String> {
    let row = db
        .list_schedules()
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "定时任务不存在（可能已被删除）".to_string())?;
    let next = next_after(&row.kind, &row.value, unix_now())?;
    match db.set_schedule_enabled(&id, enabled, next)? {
        0 => Err("定时任务不存在（可能已被删除）".to_string()),
        _ => Ok(()),
    }
}

/// 删除一条（不存在幂等 Ok；在跑任务的终态回调对已删行 no-op）。
#[tauri::command]
pub fn schedule_delete(db: tauri::State<'_, TaskDb>, id: String) -> Result<(), String> {
    db.delete_schedule(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(enabled: bool, next_run: i64, last_status: Option<&str>) -> ScheduleRow {
        ScheduleRow {
            id: "sc-t".into(),
            name: "测试档".into(),
            kind: "interval".into(),
            value: "30".into(),
            goal: "巡检".into(),
            workdir: "F:/work".into(),
            webhook_url: String::new(),
            enabled,
            next_run,
            last_run: None,
            last_status: last_status.map(str::to_string),
            last_task_id: String::new(),
        }
    }

    fn outcome(ok: bool, text: &str, log_tail: Vec<&str>, error: Option<&str>) -> DshOutcome {
        DshOutcome {
            ok,
            error: error.map(str::to_string),
            text: text.into(),
            log_tail: log_tail.into_iter().map(str::to_string).collect(),
            session_id: None,
            exit: None,
        }
    }

    fn local_unix(y: i32, m: u32, d: u32, h: u32, min: u32) -> i64 {
        use chrono::TimeZone as _;
        Local
            .with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("fixture 时刻须无歧义")
            .timestamp()
    }

    /// 本地时刻六元组（断言 daily 命中当天/次日时区无关）。
    fn ymdhm(unix: i64) -> (i32, u32, u32, u32, u32) {
        use chrono::{Datelike as _, Timelike as _, TimeZone as _};
        let dt = Local.timestamp_opt(unix, 0).single().expect("可解析");
        (dt.year(), dt.month(), dt.day(), dt.hour(), dt.minute())
    }

    #[test]
    fn next_after_interval_adds_minutes_and_validates() {
        assert_eq!(next_after("interval", "30", 1_000).unwrap(), 2_800);
        assert_eq!(next_after("interval", " 5 ", 0).unwrap(), 300, "value 容忍首尾空白");
        for bad in ["0", "-5", "abc", "", "99999999999999999999"] {
            assert!(next_after("interval", bad, 0).is_err(), "「{bad}」应被拒");
        }
        assert!(next_after("weekly", "1", 0).is_err(), "未知 kind 应被拒");
    }

    /// daily 三态：当天未到取当天、已到（含恰在当刻）取次日、跨月照推。
    #[test]
    fn next_after_daily_picks_today_then_tomorrow_across_days() {
        let before = next_after("daily", "09:30", local_unix(2026, 11, 15, 8, 0)).unwrap();
        assert_eq!(ymdhm(before), (2026, 11, 15, 9, 30), "未到点取当天");

        let after = next_after("daily", "09:30", local_unix(2026, 11, 15, 10, 0)).unwrap();
        assert_eq!(ymdhm(after), (2026, 11, 16, 9, 30), "过点次日同刻");

        let exact = next_after("daily", "09:30", local_unix(2026, 11, 15, 9, 30)).unwrap();
        assert_eq!(ymdhm(exact), (2026, 11, 16, 9, 30), "恰在当刻=已到点，取次日");

        let month_end = next_after("daily", "00:05", local_unix(2026, 11, 30, 23, 0)).unwrap();
        assert_eq!(ymdhm(month_end), (2026, 12, 1, 0, 5), "跨月推进");
    }

    #[test]
    fn next_after_daily_validates_hhmm() {
        for bad in ["24:00", "12:60", "9", "ab:cd", "12:30:45", ""] {
            assert!(
                next_after("daily", bad, local_unix(2026, 11, 15, 8, 0)).is_err(),
                "「{bad}」应被拒"
            );
        }
        assert_eq!(
            ymdhm(next_after("daily", "9:5", local_unix(2026, 11, 15, 8, 0)).unwrap()),
            (2026, 11, 15, 9, 5),
            "个位数时/分容忍（9:5 = 09:05）"
        );
    }

    /// should_fire：停用/未到/running 占位三闸，ok/fail 终态到点照触发。
    #[test]
    fn should_fire_gates_on_enabled_due_and_running() {
        let now = 10_000;
        assert!(!should_fire(&row(false, 10_000, None), now), "停用不触发");
        assert!(!should_fire(&row(true, 10_001, None), now), "未到点不触发");
        assert!(!should_fire(&row(true, 9_999, Some("running")), now), "running 占位不重复触发");
        assert!(should_fire(&row(true, 10_000, None), now), "恰到点触发（含等号）");
        assert!(should_fire(&row(true, 9_000, Some("ok")), now), "上轮 ok 到点再触发");
        assert!(should_fire(&row(true, 9_000, Some("fail")), now), "上轮 fail 到点再触发");
    }

    /// missed_window：≤30min 补跑、>30min 跳过（恰 30min 仍补跑）、未到点恒否。
    #[test]
    fn missed_window_allows_catchup_within_thirty_minutes() {
        let s = row(true, 10_000, None);
        assert!(!missed_window(&s, 10_000 + 29 * 60), "29min 迟到仍在补跑窗");
        assert!(!missed_window(&s, 10_000 + 30 * 60), "恰 30min 仍补跑（strictly >）");
        assert!(missed_window(&s, 10_000 + 30 * 60 + 1), "过 30min 跳过档");
        assert!(!missed_window(&s, 9_000), "未到点（负差饱和为 0）恒不跳过");
    }

    /// tick_action 汇流：Wait/SkipTo/Fire 三态与纯函数闸一致；跳过档落在未来。
    #[test]
    fn tick_action_dispatches_wait_skip_fire() {
        let now = 100_000;
        assert!(matches!(tick_action(&row(false, now, None), now), TickAction::Wait));
        assert!(matches!(tick_action(&row(true, now + 1, None), now), TickAction::Wait));
        assert!(matches!(tick_action(&row(true, now, Some("running")), now), TickAction::Wait));
        assert!(matches!(tick_action(&row(true, now, None), now), TickAction::Fire), "到点即触发");
        let late = row(true, now - 31 * 60, Some("ok"));
        match tick_action(&late, now) {
            TickAction::SkipTo(next) => {
                assert!(next > now, "跳过档必须推进到未来: {next} <= {now}");
                assert_eq!(next, next_after("interval", "30", now).unwrap());
            }
            other => panic!("迟到超窗应 SkipTo, got {other:?}"),
        }
    }

    /// 端到端决策→落库（内存库）：到点 Fire 的行置 running 后不再 Fire；
    /// 跳过档推进 next_run 后转 Wait；终态写库后按新档再 Fire。
    #[test]
    fn tick_actions_drive_rows_through_in_memory_db() {
        let conn = crate::tasksdb::open_in_memory().unwrap();
        let mut s = row(true, 1_000, None);
        s.id = "sc-flow".into();
        crate::tasksdb::schedule_upsert(&conn, &s).unwrap();

        assert!(matches!(tick_action(&s, 1_000), TickAction::Fire));
        assert_eq!(crate::tasksdb::schedule_set_running(&conn, &s.id).unwrap(), 1);
        let after = crate::tasksdb::schedule_list(&conn).unwrap().remove(0);
        assert!(matches!(tick_action(&after, 1_000), TickAction::Wait), "running 占位拦住重复触发");

        let mut late = s.clone();
        late.next_run = 1_000;
        match tick_action(&late, 1_000 + 31 * 60) {
            TickAction::SkipTo(next) => {
                assert_eq!(
                    crate::tasksdb::schedule_set_next_run(&conn, &late.id, next).unwrap(),
                    1
                );
            }
            other => panic!("应 SkipTo, got {other:?}"),
        }
        let skipped = crate::tasksdb::schedule_list(&conn).unwrap().remove(0);
        assert!(matches!(tick_action(&skipped, 1_000 + 31 * 60), TickAction::Wait), "推进后未到点不再动");
        assert_eq!(
            skipped.last_status.as_deref(),
            Some("running"),
            "跳过档只挪 next_run，不动 last_*"
        );
    }

    /// 立即触发裁决（R11-S2）：idle/停用/终态行放行，running 占位拒绝，
    /// 不存在报错。
    #[test]
    fn fire_now_row_gates_on_running_placeholder() {
        let mut r = row(true, 10_000, None);
        r.id = "sc-now".into();
        assert!(
            fire_now_row(vec![r.clone()], "sc-now").is_ok(),
            "idle 行可立即触发（next_run 未到也放行）"
        );
        r.enabled = false;
        assert!(
            fire_now_row(vec![r.clone()], "sc-now").is_ok(),
            "停用行放行——enabled 闸自动触发，不拦显式操作"
        );
        r.last_status = Some("running".into());
        let err = fire_now_row(vec![r], "sc-now").unwrap_err();
        assert!(err.contains("仍在运行"), "running 占位必须拒绝: {err}");
        assert!(
            fire_now_row(vec![], "sc-gone").is_err(),
            "行不存在拒绝（可能已被删除）"
        );
    }

    /// summary 三级回退（R11-S1）：终答前 500 rune；无终答末 3 行日志拼接；
    /// 再无取错误原文；全空回空串。
    #[test]
    fn summary_prefers_text_then_log_tail_then_error() {
        let long = "汉".repeat(600);
        let s = summary(&outcome(true, &long, vec!["日志行"], None));
        assert_eq!(s.chars().count(), 500, "终答截前 500 rune");
        assert!(s.chars().all(|c| c == '汉'), "取的是前缀");

        let s = summary(&outcome(true, "", vec!["l1", "l2", "l3"], None));
        assert_eq!(s, "l1\nl2\nl3", "无终答取末 3 行日志换行拼接");

        let s = summary(&outcome(false, "", Vec::new(), Some("dsh 未安装")));
        assert_eq!(s, "dsh 未安装", "无终答无日志（起跑即败）退错误原文");

        assert_eq!(summary(&outcome(false, "", Vec::new(), None)), "", "全空回空串");
    }

    /// 通知正文（R11-S3）：成功带 summary 首行截 60；失败保留错误原文。
    #[test]
    fn notify_body_caps_summary_first_line_and_keeps_error_loud() {
        let body = notify_body(&outcome(true, &"好".repeat(200), Vec::new(), None));
        assert!(body.chars().count() <= 61, "60 rune + 省略号: {body}");
        assert!(body.ends_with('…'), "超长首行须截断标记");

        let body = notify_body(&outcome(true, "首行\n第二行", Vec::new(), None));
        assert_eq!(body, "首行", "多行 summary 取首个非空行");

        let body = notify_body(&outcome(true, "", vec!["l1"], None));
        assert_eq!(body, "l1", "无终答时 summary 首行=首条日志");

        let body = notify_body(&outcome(true, "", Vec::new(), None));
        assert_eq!(body, "任务完成", "全空兜底文案");

        let body = notify_body(&outcome(false, "", vec!["TURN 1 开始"], Some("boom 失败原因")));
        assert!(body.contains("boom 失败原因"), "失败正文必须带错误原文: {body}");
    }

    /// schedule_save 输入契约：旧前端不带 webhook_url 字段可反序列化
    /// （serde default 空=不推送），带字段时透传。
    #[test]
    fn schedule_input_tolerates_missing_webhook_url() {
        let legacy = serde_json::json!({
            "name": "巡检", "kind": "interval", "value": "30",
            "goal": "看一眼", "workdir": "F:/w", "enabled": true
        });
        let input: ScheduleInput = serde_json::from_value(legacy).unwrap();
        assert_eq!(input.webhook_url, "", "缺字段容错为空（不推送）");

        let with_hook = serde_json::json!({
            "name": "巡检", "kind": "interval", "value": "30",
            "goal": "看一眼", "workdir": "F:/w", "enabled": true,
            "webhook_url": "https://hooks.example/abc"
        });
        let input: ScheduleInput = serde_json::from_value(with_hook).unwrap();
        assert_eq!(input.webhook_url, "https://hooks.example/abc");
    }

    /// webhook 地址边界校验：空/http(s) 通过（trim 归一），其余拒绝。
    #[test]
    fn normalize_webhook_url_validates_scheme() {
        assert_eq!(normalize_webhook_url("").unwrap(), "");
        assert_eq!(normalize_webhook_url("  ").unwrap(), "", "纯空白=空=不推送");
        assert_eq!(
            normalize_webhook_url(" https://hooks.example/abc ").unwrap(),
            "https://hooks.example/abc",
            "trim 后透传"
        );
        assert_eq!(normalize_webhook_url("http://127.0.0.1:9/x").unwrap(), "http://127.0.0.1:9/x");
        assert!(normalize_webhook_url("ftp://x.example").is_err(), "非 http(s) 拒绝");
        assert!(normalize_webhook_url("hooks.example/abc").is_err(), "非绝对 URL 拒绝");
    }

    /* ── webhook 推送（mini HTTP server，同 harness/task.rs 手写形态）── */

    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// 手写 mini HTTP server：逐连接按脚本状态码应答（Content-Length: 0 +
    /// Connection: close，迫使重试开新连接），留存完整请求供断言。
    fn spawn_webhook_server(statuses: Vec<u16>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let records = Arc::clone(&sink);
        thread::spawn(move || {
            for code in statuses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let req = read_request(&mut stream);
                records.lock().unwrap().push(req);
                let reason = match code {
                    200 => "OK",
                    500 => "Internal Server Error",
                    _ => "Status",
                };
                let resp = format!(
                    "HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), sink)
    }

    /// 读完一个 HTTP 请求（请求行+头+Content-Length 的 body）为原始文本。
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let headers_end = buf
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|p| p + 4);
            let complete = headers_end.is_some_and(|h| {
                let head = String::from_utf8_lossy(&buf[..h]);
                let len: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse().ok())
                    })
                    .unwrap_or(0);
                buf.len() >= h + len
            });
            if complete {
                break;
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn webhook_client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(WEBHOOK_TIMEOUT)
            .build()
            .unwrap()
    }

    fn sample_payload() -> WebhookPayload {
        WebhookPayload {
            name: "巡检".into(),
            status: "ok".into(),
            finished_at: 1_763_000_000,
            summary: "一切正常".into(),
        }
    }

    /// POST 形态（R11-S1 契约）：application/json 的 {name,status,finished_at,
    /// summary} 恰四字段；非 2xx 重试 1 次后送达。
    #[tokio::test]
    async fn webhook_posts_json_payload_and_retries_once_on_non_2xx() {
        let (url, sink) = spawn_webhook_server(vec![500, 200]);
        assert!(
            deliver_webhook(&webhook_client(), &url, &sample_payload()).await,
            "500 后重试 200 应送达"
        );

        let reqs = sink.lock().unwrap().clone();
        assert_eq!(reqs.len(), 2, "非 2xx 恰重试 1 次");
        assert!(reqs[0].starts_with("POST / HTTP/1.1"), "POST 打到所给地址");
        assert!(
            reqs[0]
                .to_ascii_lowercase()
                .contains("content-type: application/json"),
            "JSON 请求头: {}",
                reqs[0].lines().find(|l| l.starts_with("Content-Type")).unwrap_or("")
        );
        for req in &reqs {
            let body = req.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
            let json: serde_json::Value = serde_json::from_str(body)
                .unwrap_or_else(|e| panic!("body 须为合法 JSON（{e}）: {body}"));
            assert_eq!(json["name"], "巡检");
            assert_eq!(json["status"], "ok");
            assert_eq!(json["finished_at"], 1_763_000_000, "finished_at 为 unix 秒");
            assert_eq!(json["summary"], "一切正常");
            assert_eq!(json.as_object().unwrap().len(), 4, "payload 恰四字段");
        }
    }

    /// 重试后仍非 2xx：放弃并回报未送达（不影响任务终态——调用方只日志）。
    #[tokio::test]
    async fn webhook_gives_up_after_one_retry() {
        let (url, sink) = spawn_webhook_server(vec![500, 500]);
        assert!(!deliver_webhook(&webhook_client(), &url, &sample_payload()).await);
        assert_eq!(sink.lock().unwrap().len(), 2, "两次尝试后放弃，不再第三发");
    }

    /// 传输失败（断连/拒连）与非 2xx 同等重试，终败干净放弃不 panic。
    #[tokio::test]
    async fn webhook_treats_connection_failure_as_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener); // 端口无服务：连接即拒，两次尝试都传输失败
        let url = format!("http://{addr}");
        assert!(!deliver_webhook(&webhook_client(), &url, &sample_payload()).await);
    }
}
