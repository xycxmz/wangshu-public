mod assets;
mod byok;
mod desktop;
mod engine;
mod fetch;
mod harness;
mod schedule;
mod sidecar;
mod tasksdb;
mod token;
mod unified;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

/// R8-B 改名前的 identifier（存量安装的 AppData 目录以此为名落盘）。
const LEGACY_IDENTIFIER: &str = "fun.secai.company-platform";

/// R8-B 改名迁移（幂等合并语义，对启动时序零前提）：同一基目录下旧
/// identifier 目录存在即逐子项并入新名目录——同名条目跳过（新目录已
/// 有的保留，典型如启动序先建的 EBWebView），锁住条目（实证：升级场景
/// 旧进程 WebView2 子进程持文件句柄）滞留下次启动再收敛，全部搬空后
/// 删除旧目录空壳。两个基目录各跑一次：app_data_dir（Windows Roaming：
/// tasks.db / assets）与 app_local_data_dir（Windows Local：EBWebView /
/// node；macOS 两路径相同，第二次自然幂等）。
/// 为什么不做整目录 rename 起手：真机实证（TRACE 轮）新目录在 setup
/// 执行前已被启动序某环节创建，「新目录不存在才迁」的前提永不成立；
/// 合并语义无时序依赖，每次启动收敛一步，终态唯一。
fn migrate_legacy_identifier_dir(new_dir: &std::path::Path) {
    let Some(base) = new_dir.parent() else { return };
    let old_dir = base.join(LEGACY_IDENTIFIER);
    if !old_dir.is_dir() {
        return;
    }
    if std::fs::create_dir_all(new_dir).is_err() {
        return;
    }
    let mut moved = 0usize;
    let mut stuck: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&old_dir) {
        for entry in entries.flatten() {
            let target = new_dir.join(entry.file_name());
            if target.exists() {
                // 同名：新目录已有等价物（典型如启动序先建的 EBWebView），
                // 旧条目作废删除——否则永远滞留，空壳删不掉（WebView 本地
                // 数据随之丢弃是设计 §3.1 已接受的损失）
                if entry.path().is_dir() {
                    let _ = std::fs::remove_dir_all(entry.path());
                } else {
                    let _ = std::fs::remove_file(entry.path());
                }
                continue;
            }
            match std::fs::rename(entry.path(), &target) {
                Ok(()) => moved += 1,
                Err(_) => stuck.push(entry.file_name().to_string_lossy().into_owned()),
            }
        }
    }
    if moved > 0 || !stuck.is_empty() {
        eprintln!(
            "[appdata] 旧目录并入 {} 项；滞留（下次启动收敛）: {:?}",
            moved, stuck
        );
    }
    // 空壳清理：全部搬空才删，有滞留保留旧目录等下轮
    if stuck.is_empty() && std::fs::remove_dir(&old_dir).is_err() {
        // 删不掉（仍被锁）不影响正确性，下次启动再试
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        desktop::dispatch_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        // 开机自启：macOS 走 LaunchAgent；启动参数无（不支持 --hidden 静默启动）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            // R8-B 改名迁移须先于一切初始化：tasksdb / node 前缀 / WebView 数据都落在 identifier 目录下
            for dir in [app.path().app_data_dir(), app.path().app_local_data_dir()]
                .into_iter()
                .flatten()
            {
                migrate_legacy_identifier_dir(&dir);
            }
            let db = match app.path().app_data_dir() {
                Ok(dir) => {
                    // 私有 node/bin 注册进全局解析前缀（一键装的 Node/引擎对 engine spawn 可见）
                    sidecar::state::register_node_bin(dir.join("node").join("bin"));
                    tasksdb::TaskDb::init_in(&dir)
                }
                Err(e) => {
                    eprintln!("[tasksdb] app_data_dir 不可得，任务历史停用: {e}");
                    tasksdb::TaskDb::disconnected()
                }
            };
            // harness 任务号续接历史最大号，防重启后新任务复用 "h<n>" 覆盖旧记录
            harness::state::ensure_next_task_id_above(db.max_harness_seq());
            app.manage(db);
            desktop::setup(app)?;
            // R10-B B2 定时任务：调度线程随 app 起落（首扫做启动恢复）
            schedule::spawn_scheduler(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 最小化到托盘（写库即时无挂起清理；真退出走托盘菜单「退出」）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // 小窗失焦即藏：随手问形态下焦点走了就没有停留价值（隐藏路径的
            // hide 再触发一次失焦事件，对已隐藏窗口幂等无害）
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == desktop::QUICKASK_WINDOW {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            byok::byok_list,
            byok::byok_save,
            byok::byok_delete,
            byok::byok_get_secret,
            token::token_get,
            token::token_set,
            token::token_clear,
            engine::engine_start,
            engine::engine_prompt,
            engine::engine_steer,
            engine::engine_follow_up,
            engine::engine_abort,
            engine::engine_confirm,
            engine::engine_stop,
            engine::dsh::dsh_run,
            engine::dsh::dsh_last_session,
            engine::dsh::dsh_session_list,
            sidecar::env_check,
            sidecar::env_install,
            sidecar::env_install_node,
            harness::harness_run,
            harness::harness_approve,
            harness::harness_abort,
            harness::harness_status,
            harness::skills_list,
            harness::harness_recent_events,
            tasksdb::task_history_save,
            tasksdb::task_history_list,
            tasksdb::pref_get,
            tasksdb::pref_set,
            assets::asset_save_from_url,
            assets::asset_list,
            assets::asset_reveal,
            fetch::fetch_page,
            schedule::schedule_list,
            schedule::schedule_save,
            schedule::schedule_toggle,
            schedule::schedule_delete,
            schedule::schedule_fire_now,
            unified::tasks_unified,
            desktop::tray_set_state,
            desktop::focus_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::migrate_legacy_identifier_dir;
    use std::fs;
    use std::path::PathBuf;

    /// 三态桩目录：base 下按用例摆 fun.secai.company-platform / fun.secai.wangshu。
    fn scratch(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("wangshu-migrate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn migrates_when_only_legacy_dir_exists() {
        let base = scratch("legacy-only");
        let legacy = base.join("fun.secai.company-platform");
        let new_dir = base.join("fun.secai.wangshu");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("tasks.db"), "x").unwrap();
        migrate_legacy_identifier_dir(&new_dir);
        assert!(new_dir.join("tasks.db").exists(), "旧目录内容应整目录随迁");
        assert!(!legacy.exists(), "旧目录应不复存在");
        let _ = fs::remove_dir_all(&base);
    }

    /// 合并语义：新目录已存在（启动序先建，如 EBWebView）时旧目录无同名
    /// 条目仍并入；新目录已有条目不动。
    #[test]
    fn merges_into_existing_new_dir() {
        let base = scratch("both-exist");
        let legacy = base.join("fun.secai.company-platform");
        let new_dir = base.join("fun.secai.wangshu");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&new_dir).unwrap();
        fs::write(legacy.join("stale"), "x").unwrap();
        fs::write(new_dir.join("fresh"), "fresh").unwrap();
        fs::write(legacy.join("fresh"), "old").unwrap(); // 同名：新目录已有，跳过
        migrate_legacy_identifier_dir(&new_dir);
        assert!(new_dir.join("stale").exists(), "无同名条目应并入新目录");
        assert!(
            fs::read_to_string(new_dir.join("fresh")).unwrap() == "fresh",
            "同名条目新目录内容优先"
        );
        assert!(!legacy.exists(), "搬空后旧目录空壳应删除");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn no_op_when_no_dir_exists() {
        let base = scratch("fresh-install");
        let new_dir = base.join("fun.secai.wangshu");
        migrate_legacy_identifier_dir(&new_dir);
        assert!(!new_dir.exists(), "首装无旧目录，不得创建新目录");
        let _ = fs::remove_dir_all(&base);
    }

    /// 锁条目滞留（真机实证：升级场景旧进程 WebView2 子进程持文件句柄）：
    /// 未锁条目照搬、锁条目滞留下次启动收敛、旧目录因滞留保留。
    #[cfg(windows)]
    #[test]
    fn locked_entry_stays_until_next_run() {
        let base = scratch("locked-entry");
        let legacy = base.join("fun.secai.company-platform");
        let new_dir = base.join("fun.secai.wangshu");
        fs::create_dir_all(legacy.join("EBWebView")).unwrap();
        fs::create_dir_all(legacy.join("node").join("bin")).unwrap();
        fs::write(legacy.join("node").join("bin").join("npm.cmd"), "x").unwrap();
        fs::write(legacy.join("EBWebView").join("data.bin"), "x").unwrap();
        let lock = fs::File::open(legacy.join("EBWebView").join("data.bin")).unwrap();
        migrate_legacy_identifier_dir(&new_dir);
        assert!(
            new_dir.join("node/bin/npm.cmd").exists(),
            "未锁的 node 应搬至新目录"
        );
        assert!(
            legacy.join("EBWebView").exists(),
            "被锁条目滞留旧目录待下次收敛"
        );
        assert!(!legacy.join("node").exists(), "搬走的条目不在旧目录残留");
        drop(lock);
        // 锁释放后下次启动收敛：滞留条目并入，空壳删除
        migrate_legacy_identifier_dir(&new_dir);
        assert!(new_dir.join("EBWebView/data.bin").exists(), "锁释放后滞留条目收敛");
        assert!(!legacy.exists(), "全部搬空后旧目录空壳删除");
        let _ = fs::remove_dir_all(&base);
    }
}
