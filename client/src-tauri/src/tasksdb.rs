//! 任务历史持久化：终态任务（harness done/failed/aborted；material succeeded/failed）
//! 落本地 sqlite，重启后任务列可见历史。只存终态，在跑任务不入库。
//!
//! open/save_finished/list_recent 是纯函数（收 &Connection，路径由调用方传），
//! 测试直接用临时文件 DB。Tauri 侧经 managed TaskDb（app_data_dir/tasks.db）；
//! 初始化失败降级为断连——持久化尽力而为，不阻塞任务本身。

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

/// 一条终态任务记录（对前端契约：snake_case 字段，harness.ts 边界窄化）。
/// id：harness "h<n>" / material 任务 uuid（对齐前端任务列 map 键）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TaskRecord {
    pub id: String,
    pub source: String,
    pub title: String,
    pub status: String,
    pub detail: String,
    pub created_at: i64,
    pub finished_at: i64,
}

/// DSH 会话历史条目（R5-B#5）：列表整体存 pref "dsh.sessions" 的 JSON。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DshSessionEntry {
    pub id: String,
    pub task: String,
    pub at: i64, // unix ms
}

pub const DSH_SESSIONS_KEY: &str = "dsh.sessions";
pub const DSH_SESSIONS_CAP: usize = 50;

/// 合并一条会话进历史（新在前、同 id 去重、截断上限）。坏旧值视同空表。
pub fn merge_dsh_session_history(prev: Option<&str>, entry: &DshSessionEntry, cap: usize) -> String {
    let mut list: Vec<DshSessionEntry> = prev
        .and_then(|p| serde_json::from_str(p).ok())
        .unwrap_or_default();
    list.retain(|e| e.id != entry.id);
    list.insert(0, entry.clone());
    list.truncate(cap.max(1));
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
}

pub fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 全库 schema（幂等批量建表）。schedules 为 R10-B B2 定时任务表：
/// kind 两态 interval（value=分钟数）/ daily（value=HH:MM 本地时区）；
/// next_run/last_run 为 unix 秒；last_status NULL(idle)/running/ok/fail——
/// running 兼作单并发占位（上次未完不再触发）。
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('interval','daily')),
    value TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    workdir TEXT NOT NULL,
    webhook_url TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run INTEGER NOT NULL,
    last_run INTEGER,
    last_status TEXT,
    last_task_id TEXT NOT NULL DEFAULT ''
);";

/// 存量库加列迁移（R11-S1 起）：SCHEMA 常量只对新建库生效——对已建库
/// CREATE TABLE IF NOT EXISTS 是 no-op，加列须探测列存在性后 ALTER。
/// 表名/列名/DDL 均为内建字面量，无拼接注入面；重复执行探测命中即跳过，
/// 跑 N 次收敛同一终态（幂等）。
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has_webhook: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('schedules') WHERE name = 'webhook_url')",
        [],
        |row| row.get(0),
    )?;
    if !has_webhook {
        conn.execute(
            "ALTER TABLE schedules ADD COLUMN webhook_url TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

/// 打开（必要时创建）DB 并建表 + 存量库加列；幂等可重复调用。
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 内存库开库建表（单测用；零落盘）。
#[cfg(test)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(SCHEMA)?;
    migrate(&conn)?;
    Ok(conn)
}

/// 读一个偏好值（B6①：PI 面板 provider/model/cwd 记忆；key 约定如 "pi.provider"）。
pub fn get_pref(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM prefs WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    })
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// 写一个偏好值（同 key 覆盖，幂等）。空串表示显式清空（读回 Some("")）。
pub fn set_pref(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO prefs (key, value) VALUES (?1, ?2)",
        [key, value],
    )?;
    Ok(())
}

/// 写入一条终态记录。同 id 重写（幂等）：重复保存收敛到同一行。
pub fn save_finished(conn: &Connection, r: &TaskRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO tasks (id, source, title, status, detail, created_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            r.id,
            r.source,
            r.title,
            r.status,
            r.detail,
            r.created_at,
            r.finished_at
        ],
    )?;
    Ok(())
}

/// 最近终态记录，finished_at 倒序。
pub fn list_recent(conn: &Connection, limit: u32) -> rusqlite::Result<Vec<TaskRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, source, title, status, detail, created_at, finished_at
         FROM tasks ORDER BY finished_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit], |row| {
        Ok(TaskRecord {
            id: row.get(0)?,
            source: row.get(1)?,
            title: row.get(2)?,
            status: row.get(3)?,
            detail: row.get(4)?,
            created_at: row.get(5)?,
            finished_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// 一条本地素材资产（B5：succeeded 素材结果下载落盘后的索引行）。
/// path 为绝对路径；缩略图/回看经 asset 协议或 reveal。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetRecord {
    pub id: i64,
    pub kind: String, // image|video
    pub prompt: String,
    pub path: String,
    pub source_url: String,
    pub created_at: i64,
}

/// 写入一条资产，回填自增 id。
pub fn asset_save(conn: &Connection, r: &mut AssetRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO assets (kind, prompt, path, source_url, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![r.kind, r.prompt, r.path, r.source_url, r.created_at],
    )?;
    r.id = conn.last_insert_rowid();
    Ok(())
}

/// 最近资产，created_at 倒序。
pub fn asset_list(conn: &Connection, limit: u32) -> rusqlite::Result<Vec<AssetRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, prompt, path, source_url, created_at
         FROM assets ORDER BY created_at DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit], |row| {
        Ok(AssetRecord {
            id: row.get(0)?,
            kind: row.get(1)?,
            prompt: row.get(2)?,
            path: row.get(3)?,
            source_url: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

/* ── 定时任务（R10-B B2）──────────────────────────────
   行为模型（schedule.rs 持纯函数决策）：
   idle(NULL) --触发--> running --完成--> ok/fail --到档--> 触发…
   调度器写态用按 id 的定点 UPDATE（行被删即 no-op，不复活），
   UI 保存用全行 upsert。 */

/// 一条定时任务（对前端契约：snake_case 字段）。last_task_id 为最近一次
/// DSH 会话 uuid（UI 跳 dsh.sessions 历史）；空串=尚未跑过。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScheduleRow {
    pub id: String,
    pub name: String,
    pub kind: String, // interval | daily
    pub value: String, // 分钟数 | HH:MM
    pub goal: String,
    pub workdir: String,
    /// 终态 webhook 推送地址（R11-S1）；空=不推送。
    pub webhook_url: String,
    pub enabled: bool,
    pub next_run: i64, // unix 秒
    pub last_run: Option<i64>,
    pub last_status: Option<String>, // NULL(idle) | running | ok | fail
    pub last_task_id: String,
}

const SCHEDULE_COLS: &str =
    "id, name, kind, value, goal, workdir, webhook_url, enabled, next_run, last_run, last_status, last_task_id";

fn schedule_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRow> {
    Ok(ScheduleRow {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        value: row.get(3)?,
        goal: row.get(4)?,
        workdir: row.get(5)?,
        webhook_url: row.get(6)?,
        enabled: row.get::<_, i64>(7)? != 0,
        next_run: row.get(8)?,
        last_run: row.get(9)?,
        last_status: row.get(10)?,
        last_task_id: row.get(11)?,
    })
}

/// 写入/覆盖一条定时任务（全字段，同 id 收敛到同一行，幂等）。
pub fn schedule_upsert(conn: &Connection, r: &ScheduleRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO schedules (id, name, kind, value, goal, workdir, webhook_url, enabled, next_run, last_run, last_status, last_task_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            r.id,
            r.name,
            r.kind,
            r.value,
            r.goal,
            r.workdir,
            r.webhook_url,
            r.enabled as i64,
            r.next_run,
            r.last_run,
            r.last_status,
            r.last_task_id
        ],
    )?;
    Ok(())
}

/// 全部定时任务，next_run 升序（最近将触发的在前）、id 决胜稳定排序。
pub fn schedule_list(conn: &Connection) -> rusqlite::Result<Vec<ScheduleRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SCHEDULE_COLS} FROM schedules ORDER BY next_run ASC, id ASC"
    ))?;
    let rows = stmt.query_map([], schedule_from_row)?;
    rows.collect()
}

/// 删除一条（不存在时幂等 Ok）。
pub fn schedule_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM schedules WHERE id = ?1", [id])?;
    Ok(())
}

/// 置 running（触发前占位，兼单并发闸）。条件更新：已占位的行回 0——调度
/// 扫描与 schedule_fire_now 并发触发时只有先到者得手，后来者让位不覆盖
/// 占位（R11-S2）。行已删同回 0（不触发、不复活）。
pub fn schedule_set_running(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE schedules SET last_status = 'running'
         WHERE id = ?1 AND (last_status IS NULL OR last_status <> 'running')",
        [id],
    )
}

/// 终态落库（ok|fail + last_run + next_run 推进 + last_task_id）。
/// 回受影响行数：0=行已删（调度器据此跳过通知）。
pub fn schedule_set_finished(
    conn: &Connection,
    id: &str,
    status: &str,
    last_run: i64,
    next_run: i64,
    last_task_id: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE schedules SET last_status = ?2, last_run = ?3, next_run = ?4, last_task_id = ?5
         WHERE id = ?1",
        rusqlite::params![id, status, last_run, next_run, last_task_id],
    )
}

/// 跳过档推进（错过窗口：只挪 next_run，不动 last_*）。回受影响行数。
pub fn schedule_set_next_run(conn: &Connection, id: &str, next_run: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE schedules SET next_run = ?2 WHERE id = ?1",
        rusqlite::params![id, next_run],
    )
}

/// 启停并重算 next_run（schedule_toggle 用）。回受影响行数。
pub fn schedule_set_enabled(
    conn: &Connection,
    id: &str,
    enabled: bool,
    next_run: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE schedules SET enabled = ?2, next_run = ?3 WHERE id = ?1",
        rusqlite::params![id, enabled as i64, next_run],
    )
}

/// Tauri 托管态：单连接 + Mutex 串行化（终态写入频率极低，无需连接池）。
/// 初始化失败保持断连（None），读写降级为空操作。
pub struct TaskDb(Mutex<Option<Connection>>);

impl TaskDb {
    pub fn connected(conn: Connection) -> Self {
        Self(Mutex::new(Some(conn)))
    }

    /// 断连形态（app_data_dir 不可得时的降级入口；IO 失败见 init_in）。
    pub fn disconnected() -> Self {
        Self(Mutex::new(None))
    }

    /// 持久化一条终态记录（尽力而为：断连/失败只 eprintln，不影响任务流）。
    pub fn save(&self, r: &TaskRecord) {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = save_finished(conn, r) {
            eprintln!("[tasksdb] 终态写库失败: {e}");
        }
    }

    pub fn list(&self, limit: u32) -> Vec<TaskRecord> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return Vec::new();
        };
        match list_recent(conn, limit) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("[tasksdb] 历史读取失败: {e}");
                Vec::new()
            }
        }
    }

    /// 已持久化的最大 harness 任务号（id "h<n>" 的 n）；断连/空库回 0。
    /// 启动时据此续接 NEXT_ID，防重启后新任务复用 "h<n>" 覆盖旧记录。
    pub fn max_harness_seq(&self) -> u64 {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return 0;
        };
        conn.query_row(
            "SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) FROM tasks WHERE source = 'harness'",
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .unwrap_or(None)
        .unwrap_or(0)
        .max(0) as u64
    }

    /// 从 app_data_dir 打开（或降级断连）。目录不存在则创建。
    pub fn init_in(dir: &Path) -> Self {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[tasksdb] 数据目录创建失败，任务历史停用: {e}");
            return Self::disconnected();
        }
        match open(&dir.join("tasks.db")) {
            Ok(conn) => Self::connected(conn),
            Err(e) => {
                eprintln!("[tasksdb] 历史库初始化失败，任务历史停用: {e}");
                Self::disconnected()
            }
        }
    }

    /// 读偏好（尽力而为：断连/失败回 None，不影响 UI）。
    pub fn get_pref(&self, key: &str) -> Option<String> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let conn = guard.as_ref()?;
        match get_pref(conn, key) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[tasksdb] 偏好读取失败: {e}");
                None
            }
        }
    }

    /// 写偏好（尽力而为：断连/失败只 eprintln）。
    pub fn set_pref(&self, key: &str, value: &str) {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = set_pref(conn, key, value) {
            eprintln!("[tasksdb] 偏好写库失败: {e}");
        }
    }

    /// 索引一条资产（尽力而为；assets.rs 落盘成功后调用）。断连/失败回 None。
    pub fn save_asset(&self, r: &mut AssetRecord) -> Option<()> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let conn = guard.as_ref()?;
        match asset_save(conn, r) {
            Ok(()) => Some(()),
            Err(e) => {
                eprintln!("[tasksdb] 资产索引写库失败: {e}");
                None
            }
        }
    }

    /// 最近资产（断连/失败回空表）。
    pub fn list_assets(&self, limit: u32) -> Vec<AssetRecord> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return Vec::new();
        };
        match asset_list(conn, limit) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("[tasksdb] 资产读取失败: {e}");
                Vec::new()
            }
        }
    }

    /// 定时任务列表（断连/失败回空表；空表=无定时任务，属正常态）。
    pub fn list_schedules(&self) -> Vec<ScheduleRow> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return Vec::new();
        };
        match schedule_list(conn) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("[tasksdb] 定时任务读取失败: {e}");
                Vec::new()
            }
        }
    }

    /// 保存定时任务（UI 全行 upsert）。管理面操作：错误上抛给命令层报 UI。
    pub fn save_schedule(&self, r: &ScheduleRow) -> Result<(), String> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return Err("本地库不可用（任务历史目录未就绪）".into());
        };
        schedule_upsert(conn, r).map_err(|e| format!("定时任务保存失败: {e}"))
    }

    /// 删除定时任务（不存在幂等 Ok）。
    pub fn delete_schedule(&self, id: &str) -> Result<(), String> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return Err("本地库不可用（任务历史目录未就绪）".into());
        };
        schedule_delete(conn, id).map_err(|e| format!("定时任务删除失败: {e}"))
    }

    /// 启停 + 重算 next_run。回受影响行数（0=不存在，命令层报 UI）。
    pub fn set_schedule_enabled(&self, id: &str, enabled: bool, next_run: i64) -> Result<usize, String> {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return Err("本地库不可用（任务历史目录未就绪）".into());
        };
        schedule_set_enabled(conn, id, enabled, next_run)
            .map_err(|e| format!("定时任务启停失败: {e}"))
    }

    /// 置 running（触发前占位，尽力而为；断连/失败回 0=不触发）。
    pub fn set_schedule_running(&self, id: &str) -> usize {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return 0;
        };
        schedule_set_running(conn, id).unwrap_or_else(|e| {
            eprintln!("[tasksdb] 定时任务置 running 失败: {e}");
            0
        })
    }

    /// 终态落库（尽力而为；断连/失败回 0=视为已删，跳过通知）。
    pub fn set_schedule_finished(
        &self,
        id: &str,
        status: &str,
        last_run: i64,
        next_run: i64,
        last_task_id: &str,
    ) -> usize {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else {
            return 0;
        };
        schedule_set_finished(conn, id, status, last_run, next_run, last_task_id).unwrap_or_else(
            |e| {
                eprintln!("[tasksdb] 定时任务终态写库失败: {e}");
                0
            },
        )
    }

    /// 跳过档推进 next_run（尽力而为）。
    pub fn set_schedule_next_run(&self, id: &str, next_run: i64) {
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(conn) = guard.as_ref() else { return };
        if let Err(e) = schedule_set_next_run(conn, id, next_run) {
            eprintln!("[tasksdb] 定时任务 next_run 推进失败: {e}");
        }
    }
}

/// 素材任务终态入库（前端轮询到终态时调用；harness 侧由 Rust 终态点直写）。
/// created/finished 取当前时刻（命令签名不含时间参数）。
#[tauri::command]
pub fn task_history_save(
    db: tauri::State<'_, TaskDb>,
    id: String,
    source: String,
    title: String,
    status: String,
    detail: String,
) {
    let now = unix_ms();
    db.save(&TaskRecord {
        id,
        source,
        title,
        status,
        detail,
        created_at: now,
        finished_at: now,
    });
}

/// 读最近终态历史（finished_at 倒序，上限 200——R6-A#3 任务中心搜索面向）。
#[tauri::command]
pub fn task_history_list(db: tauri::State<'_, TaskDb>) -> Vec<TaskRecord> {
    db.list(200)
}

/// 读一个偏好值（无记录回 null）。通用 KV：B6① PI 面板配置记忆等前端小状态。
#[tauri::command]
pub fn pref_get(db: tauri::State<'_, TaskDb>, key: String) -> Option<String> {
    db.get_pref(&key)
}

/// 写一个偏好值（value 传空串 = 显式清空为 Some("")）。
#[tauri::command]
pub fn pref_set(db: tauri::State<'_, TaskDb>, key: String, value: String) {
    db.set_pref(&key, &value);
}

#[cfg(test)]
mod tests {

    use super::*;

    fn temp_db(name: &str) -> (std::path::PathBuf, Connection) {
        let path =
            std::env::temp_dir().join(format!("cp-tasksdb-{}-{name}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let conn = open(&path).unwrap();
        (path, conn)
    }

    fn rec(id: &str, source: &str, status: &str, finished_at: i64) -> TaskRecord {
        TaskRecord {
            id: id.into(),
            source: source.into(),
            title: format!("{id} 标题"),
            status: status.into(),
            detail: format!("{id} 详情"),
            created_at: finished_at - 1000,
            finished_at,
        }
    }

    #[test]
    fn save_and_list_roundtrip_preserves_fields() {
        let (path, conn) = temp_db("roundtrip");
        let harness = rec("h1", "harness", "done", 9_000);
        let material = rec("uuid-1", "material", "failed", 8_000);
        save_finished(&conn, &harness).unwrap();
        save_finished(&conn, &material).unwrap();
        assert_eq!(list_recent(&conn, 50).unwrap(), vec![harness, material]);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn list_recent_orders_desc_and_applies_limit() {
        let (path, conn) = temp_db("order-limit");
        for finished_at in [100, 300, 200] {
            save_finished(
                &conn,
                &rec(&format!("h{finished_at}"), "harness", "done", finished_at),
            )
            .unwrap();
        }
        let ids: Vec<String> = list_recent(&conn, 2)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, vec!["h300".to_string(), "h200".to_string()]);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn saving_same_id_replaces_row() {
        let (path, conn) = temp_db("replace");
        save_finished(&conn, &rec("h2", "harness", "done", 1_000)).unwrap();
        save_finished(&conn, &rec("h2", "harness", "failed", 2_000)).unwrap();
        let rows = list_recent(&conn, 50).unwrap();
        assert_eq!(rows.len(), 1, "同 id 不得产生第二行");
        assert_eq!(rows[0].status, "failed");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn max_harness_seq_reads_persisted_ids_and_ignores_material() {
        let (path, conn) = temp_db("max-seq");
        {
            let db = TaskDb::connected(conn);
            assert_eq!(db.max_harness_seq(), 0, "空库应回 0");
        }
        let conn = open(&path).unwrap();
        for id in ["h3", "h11"] {
            save_finished(&conn, &rec(id, "harness", "done", 1_000)).unwrap();
        }
        save_finished(&conn, &rec("uuid-99", "material", "succeeded", 2_000)).unwrap();
        let db = TaskDb::connected(conn);
        assert_eq!(db.max_harness_seq(), 11);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn disconnected_db_degrades_to_noops() {
        let db = TaskDb::disconnected();
        db.save(&rec("h1", "harness", "done", 0));
        assert!(db.list(50).is_empty());
        assert_eq!(db.max_harness_seq(), 0);
        assert_eq!(db.get_pref("pi.provider"), None);
        db.set_pref("pi.provider", "x"); // 断连不 panic
    }

    #[test]
    fn pref_roundtrip_overwrites_and_clears() {
        let (path, conn) = temp_db("prefs");
        assert_eq!(get_pref(&conn, "pi.model").unwrap(), None, "空表读 None");
        set_pref(&conn, "pi.model", "m-a").unwrap();
        set_pref(&conn, "pi.model", "m-b").unwrap();
        assert_eq!(get_pref(&conn, "pi.model").unwrap().as_deref(), Some("m-b"));
        set_pref(&conn, "pi.model", "").unwrap();
        assert_eq!(get_pref(&conn, "pi.model").unwrap().as_deref(), Some(""));
        assert_eq!(
            get_pref(&conn, "pi.provider").unwrap(),
            None,
            "不同 key 互不干扰"
        );
        let db = TaskDb::connected(conn);
        assert_eq!(db.get_pref("pi.model").as_deref(), Some(""));
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn asset_save_assigns_ids_and_lists_desc() {
        let (path, conn) = temp_db("assets");
        let mut a = AssetRecord {
            id: 0,
            kind: "image".into(),
            prompt: "一只猫".into(),
            path: "F:/data/assets/1.png".into(),
            source_url: "https://oss.example/1.png".into(),
            created_at: 1_000,
        };
        asset_save(&conn, &mut a).unwrap();
        assert_eq!(a.id, 1);
        let mut b = AssetRecord {
            kind: "video".into(),
            prompt: "".into(),
            path: "F:/data/assets/2.mp4".into(),
            source_url: "".into(),
            created_at: 2_000,
            id: 0,
        };
        asset_save(&conn, &mut b).unwrap();
        let rows = asset_list(&conn, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, b.id, "created_at 倒序");
        assert_eq!(rows[1].prompt, "一只猫");
        let few = asset_list(&conn, 1).unwrap();
        assert_eq!(few.len(), 1);
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn disconnected_db_degrades_assets_to_noops() {
        let db = TaskDb::disconnected();
        let mut r = AssetRecord {
            id: 0,
            kind: "image".into(),
            prompt: "".into(),
            path: "x".into(),
            source_url: "".into(),
            created_at: 0,
        };
        assert_eq!(db.save_asset(&mut r), None);
        assert!(db.list_assets(10).is_empty());
    }
}

#[cfg(test)]
mod schedule_tests {
    use super::*;

    fn row(id: &str, next_run: i64) -> ScheduleRow {
        ScheduleRow {
            id: id.into(),
            name: format!("{id} 名"),
            kind: "interval".into(),
            value: "30".into(),
            goal: "巡检目录".into(),
            workdir: "F:/work".into(),
            webhook_url: String::new(),
            enabled: true,
            next_run,
            last_run: None,
            last_status: None,
            last_task_id: String::new(),
        }
    }

    /// 内存库 CRUD 往返：建→列→全字段保留；upsert 同 id 覆盖收敛单行。
    #[test]
    fn schedule_crud_roundtrip_on_in_memory_db() {
        let conn = open_in_memory().unwrap();
        schedule_upsert(&conn, &row("sc-1", 200)).unwrap();
        let mut daily = row("sc-2", 100);
        daily.kind = "daily".into();
        daily.value = "09:30".into();
        daily.enabled = false;
        schedule_upsert(&conn, &daily).unwrap();

        let listed = schedule_list(&conn).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "sc-2", "next_run 升序");
        let got = &listed[1];
        assert_eq!((got.id.as_str(), got.name.as_str()), ("sc-1", "sc-1 名"));
        assert_eq!((got.kind.as_str(), got.value.as_str()), ("interval", "30"));
        assert_eq!((got.goal.as_str(), got.workdir.as_str()), ("巡检目录", "F:/work"));
        assert!(got.enabled, "enabled INTEGER 1 往返");
        assert_eq!(got.next_run, 200);
        assert_eq!(got.last_run, None, "新行 last_run NULL");
        assert_eq!(got.last_status, None, "新行 last_status NULL(idle)");
        assert_eq!(got.last_task_id, "");

        let mut edited = row("sc-1", 300);
        edited.goal = "改目标".into();
        edited.enabled = false;
        schedule_upsert(&conn, &edited).unwrap();
        let after = schedule_list(&conn).unwrap();
        assert_eq!(after.len(), 2, "同 id 覆盖不得产生第二行");
        let got = after.iter().find(|r| r.id == "sc-1").unwrap();
        assert_eq!(got.goal, "改目标");
        assert!(!got.enabled, "enabled 0 往返");

        schedule_delete(&conn, "sc-1").unwrap();
        schedule_delete(&conn, "sc-1").unwrap();
        assert_eq!(schedule_list(&conn).unwrap().len(), 1, "删除幂等");
    }

    /// webhook_url 全字段往返：非空值落库读回原样，缺省行读回空串。
    #[test]
    fn schedule_roundtrip_carries_webhook_url() {
        let conn = open_in_memory().unwrap();
        let mut hooked = row("sc-1", 100);
        hooked.webhook_url = "https://hooks.example/abc".into();
        schedule_upsert(&conn, &hooked).unwrap();
        schedule_upsert(&conn, &row("sc-2", 200)).unwrap();
        let listed = schedule_list(&conn).unwrap();
        assert_eq!(listed[0].webhook_url, "https://hooks.example/abc");
        assert_eq!(listed[1].webhook_url, "", "未填的行缺省空串（=不推送）");
    }

    /// 占位条件更新（R11-S2）：已 running 的行再置 running 回 0——并发触发
    /// 后来者让位；终态/初始行照常得手 1。
    #[test]
    fn schedule_set_running_yields_to_existing_placeholder() {
        let conn = open_in_memory().unwrap();
        schedule_upsert(&conn, &row("sc-1", 1_000)).unwrap();
        assert_eq!(schedule_set_running(&conn, "sc-1").unwrap(), 1, "NULL(idle) 首次占位得手");
        assert_eq!(
            schedule_set_running(&conn, "sc-1").unwrap(),
            0,
            "running 中重入必须让位（单并发闸）"
        );
        assert_eq!(schedule_set_finished(&conn, "sc-1", "ok", 1_600, 2_000, "").unwrap(), 1);
        assert_eq!(schedule_set_running(&conn, "sc-1").unwrap(), 1, "终态后可再占位");
    }

    /// 存量库升级（R10 建库 → R11 open）：加列带缺省 ''、既有数据原样保留，
    /// open 跑两次收敛（幂等），新建库（SCHEMA 直含列）与升级库同形。
    #[test]
    fn migrating_legacy_db_adds_webhook_column_idempotently() {
        const R10_SCHEDULES: &str = "CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('interval','daily')),
            value TEXT NOT NULL,
            goal TEXT NOT NULL DEFAULT '',
            workdir TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            next_run INTEGER NOT NULL,
            last_run INTEGER,
            last_status TEXT,
            last_task_id TEXT NOT NULL DEFAULT ''
        );";
        let path = std::env::temp_dir().join(format!("cp-tasksdb-migrate-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let legacy = Connection::open(&path).unwrap();
            legacy.execute_batch(R10_SCHEDULES).unwrap();
            legacy
                .execute(
                    "INSERT INTO schedules (id, name, kind, value, workdir, next_run)
                     VALUES ('sc-old', '旧档', 'daily', '09:30', 'F:/w', 1_000)",
                    [],
                )
                .unwrap();
        }
        for _ in 0..2 {
            let conn = open(&path).unwrap();
            let rows = schedule_list(&conn).unwrap();
            assert_eq!(rows.len(), 1, "既有行不得丢失");
            assert_eq!(rows[0].id, "sc-old");
            assert_eq!(rows[0].webhook_url, "", "加列缺省空串（=不推送）");
            assert_eq!(rows[0].name, "旧档");
        }
        let _ = std::fs::remove_file(&path);
    }

    /// 调度器状态机各转移的定点 UPDATE：占位→终态→推进→启停；对已删行 no-op。
    #[test]
    fn schedule_targeted_updates_follow_state_machine() {
        let conn = open_in_memory().unwrap();
        schedule_upsert(&conn, &row("sc-1", 1_000)).unwrap();

        assert_eq!(schedule_set_running(&conn, "sc-1").unwrap(), 1);
        let r = &schedule_list(&conn).unwrap()[0];
        assert_eq!(r.last_status.as_deref(), Some("running"));
        assert_eq!(r.last_run, None, "占位不动 last_run");

        assert_eq!(
            schedule_set_finished(&conn, "sc-1", "ok", 1_660, 3_000, "session-abc").unwrap(),
            1
        );
        let r = &schedule_list(&conn).unwrap()[0];
        assert_eq!(r.last_status.as_deref(), Some("ok"));
        assert_eq!(r.last_run, Some(1_660));
        assert_eq!(r.next_run, 3_000);
        assert_eq!(r.last_task_id, "session-abc");

        assert_eq!(schedule_set_next_run(&conn, "sc-1", 9_000).unwrap(), 1);
        let r = &schedule_list(&conn).unwrap()[0];
        assert_eq!(r.next_run, 9_000, "跳过档只挪 next_run");
        assert_eq!(r.last_status.as_deref(), Some("ok"), "last_* 不动");

        assert_eq!(
            schedule_set_enabled(&conn, "sc-1", true, 500).unwrap(),
            1
        );
        let r = &schedule_list(&conn).unwrap()[0];
        assert!(r.enabled);
        assert_eq!(r.next_run, 500);

        schedule_delete(&conn, "sc-1").unwrap();
        for affected in [
            schedule_set_running(&conn, "sc-1").unwrap(),
            schedule_set_finished(&conn, "sc-1", "fail", 0, 0, "").unwrap(),
            schedule_set_next_run(&conn, "sc-1", 0).unwrap(),
            schedule_set_enabled(&conn, "sc-1", false, 0).unwrap(),
        ] {
            assert_eq!(affected, 0, "已删行的 UPDATE 必须 no-op（不复活）");
        }
    }

    /// TaskDb 断连形态下定时任务面整体降级：列表空、管理写报错、调度写回 0。
    #[test]
    fn disconnected_db_degrades_schedules() {
        let db = TaskDb::disconnected();
        assert!(db.list_schedules().is_empty());
        assert!(db.save_schedule(&row("sc-1", 0)).is_err());
        assert!(db.delete_schedule("sc-1").is_err());
        assert!(db.set_schedule_enabled("sc-1", true, 0).is_err());
        assert_eq!(db.set_schedule_running("sc-1"), 0);
        assert_eq!(db.set_schedule_finished("sc-1", "ok", 0, 0, ""), 0);
        db.set_schedule_next_run("sc-1", 0); // 不 panic
    }
}

#[cfg(test)]
mod dsh_history_tests {
    use super::{merge_dsh_session_history, DshSessionEntry};

    fn e(id: &str, at: i64) -> DshSessionEntry {
        DshSessionEntry { id: id.into(), task: format!("t-{id}"), at }
    }

    fn ids(json: &str) -> Vec<String> {
        serde_json::from_str::<Vec<DshSessionEntry>>(json)
            .unwrap()
            .into_iter()
            .map(|x| x.id)
            .collect()
    }

    /// R5-B#5：新在前、同 id 去重顶前、坏旧值容错、上限截断。
    #[test]
    fn merge_caps_and_dedups() {
        let a = merge_dsh_session_history(None, &e("s1", 1), 50);
        assert_eq!(ids(&a), ["s1"]);
        let b = merge_dsh_session_history(Some(&a), &e("s1", 2), 50);
        assert_eq!(ids(&b), ["s1"]);
        let c = merge_dsh_session_history(Some(&b), &e("s2", 3), 50);
        assert_eq!(ids(&c), ["s2", "s1"]);
        let d = merge_dsh_session_history(Some("not-json"), &e("s3", 4), 50);
        assert_eq!(ids(&d), ["s3"]);
        let mut prev = merge_dsh_session_history(None, &e("x0", 0), 2);
        for i in 1..5 {
            prev = merge_dsh_session_history(Some(&prev), &e(&format!("x{i}"), i), 2);
        }
        assert_eq!(ids(&prev), ["x4", "x3"]);
    }
}
