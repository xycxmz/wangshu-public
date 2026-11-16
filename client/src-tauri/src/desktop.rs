/* 桌面常规件（R2.3-3）：托盘 + 全局快捷键 + 主窗口显隐；
R9-B2 增全局快捷小窗（quickask）。窗口显隐决策收敛在本模块
（托盘菜单 / 托盘左键 / 快捷键共用同一路径）；
lib.rs 只做装配（插件注册、关窗转托盘）与降级日志。 */

use std::str::FromStr;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalPosition, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// 主窗口 label（tauri.conf.json app.windows[0].label）。
const MAIN_WINDOW: &str = "main";

/// 全局显隐主窗口快捷键。唯一权威在 Rust 侧；src/desktop.ts 的 TOGGLE_SHORTCUT
/// 是展示副本，改这里须同步改前端。
pub const TOGGLE_SHORTCUT: &str = "Alt+Shift+P";

/// 快捷小窗 label（tauri.conf.json app.windows[1].label；其 url hash `#quick`
/// 是前端切小窗模式的契约，与 label 同为前端识别锚点）。
pub const QUICKASK_WINDOW: &str = "quickask";

/// 全局呼出快捷小窗热键（K=问；避开主窗已占的 Alt+Shift+P）。展示同步约定
/// 同 TOGGLE_SHORTCUT。
pub const QUICKASK_SHORTCUT: &str = "Alt+Shift+K";

/// 小窗尺寸与贴角内缩量（逻辑像素；尺寸须与 tauri.conf.json quickask 窗口
/// 声明的 width/height 一致——几何计算用，声明改动时两处同改）。
const QUICKASK_SIZE: (f64, f64) = (480.0, 320.0);
const QUICKASK_MARGIN: f64 = 16.0;

/// 显示主窗口：从隐藏/最小化唤回并聚焦。
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 显隐切换：可见且未最小化 → 隐藏；否则唤回。
/// Windows 上最小化时 is_visible 仍为 true，须加 is_minimized 判断。
pub fn toggle_main_window(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let visible = win.is_visible().unwrap_or(true);
        let minimized = win.is_minimized().unwrap_or(false);
        if visible && !minimized {
            let _ = win.hide();
        } else {
            show_main_window(app);
        }
    }
}

/// 全局快捷键分发（lib.rs 插件 handler 过滤 Pressed 后转发到此）。
/// 显式逐键匹配、未知组合忽略——未来加第三键时误改此处不会静默误伤主窗热键。
pub fn dispatch_shortcut(app: &AppHandle, pressed: &Shortcut) {
    if Shortcut::from_str(TOGGLE_SHORTCUT).is_ok_and(|k| pressed == &k) {
        toggle_main_window(app);
    } else if Shortcut::from_str(QUICKASK_SHORTCUT).is_ok_and(|k| pressed == &k) {
        toggle_quickask(app);
    }
}

/// 小窗显隐切换：可见 → 隐藏；隐藏 → 贴角唤出并聚焦（失焦自动隐藏由
/// lib.rs 窗口事件负责，本函数只管热键路径）。
pub fn toggle_quickask(app: &AppHandle) {
    let Some(win) = app.get_webview_window(QUICKASK_WINDOW) else {
        return;
    };
    if win.is_visible().unwrap_or(true) {
        let _ = win.hide();
    } else {
        place_quickask(app, &win);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 主屏工作区右上角内缩 16px 的小窗左上角坐标（逻辑像素）。
/// 纯函数抽出只为可单测；入参用逻辑像素与窗口 480x320 声明同单位。
fn quickask_position(screen_w: f64, _screen_h: f64) -> (f64, f64) {
    (
        screen_w - QUICKASK_SIZE.0 - QUICKASK_MARGIN,
        QUICKASK_MARGIN,
    )
}

/// 每次 show 前重算贴角位置（屏幕分辨率/主屏工作区变化后不残留在旧坐标）。
/// Monitor 的 workArea 是物理像素，须除 scale 因子换算成逻辑坐标再算几何。
fn place_quickask(app: &AppHandle, win: &WebviewWindow) {
    let monitor = match app.primary_monitor() {
        Ok(mon) => mon,
        Err(e) => {
            eprintln!("[desktop] 主屏不可得，小窗贴角跳过（按上次位置显示）: {e}");
            return;
        }
    };
    let Some(mon) = monitor else {
        eprintln!("[desktop] 主屏不可得，小窗贴角跳过（按上次位置显示）");
        return;
    };
    let scale = mon.scale_factor();
    let wa = mon.work_area();
    let (dx, dy) = quickask_position(wa.size.width as f64 / scale, wa.size.height as f64 / scale);
    let x = wa.position.x as f64 / scale + dx;
    let y = wa.position.y as f64 / scale + dy;
    let _ = win.set_position(LogicalPosition::new(x, y));
}

/// 小窗「转入主窗」按钮调用（无参命令）：唤回主窗，与托盘/热键同一路径。
#[tauri::command]
pub fn focus_main_window(app: AppHandle) {
    show_main_window(&app);
}

/// R8-B 改名清理：旧 productName「company-platform」注册的开机自启键指向旧
/// exe，属失效残留。键名依据（插件源码）：tauri-plugin-autostart 2.7.0 未见
/// Builder::app_name 时取 package_info().name，即 tauri.conf.json 的
/// productName；auto-launch 0.6.0 windows.rs 以该名为
/// HKCU\Software\Microsoft\Windows\CurrentVersion\Run 的值名。disable() 按值
/// 名删除（路径参数无关），键不存在时静默成功，幂等；StartupApproved\Run 的
/// 伴生值插件自身 disable 也不清，孤儿值无 Run 项配对不生效，保持同语义。
#[cfg(windows)]
fn remove_legacy_autostart() {
    let legacy = auto_launch::AutoLaunch::new(
        "company-platform",
        "",
        auto_launch::WindowsEnableMode::CurrentUser,
        &[] as &[&str],
    );
    if let Err(e) = legacy.disable() {
        eprintln!("[desktop] 旧自启键清理失败（不阻断启动）: {e}");
    }
}

/// 托盘 + 全局快捷键装配（lib.rs setup 末尾调用）。
/// 托盘构建失败直接让启动失败：关窗转托盘是既定行为，无托盘时窗口 hide 后无法唤回。
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    #[cfg(windows)]
    remove_legacy_autostart();
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = app
        .default_window_icon()
        .expect("bundle.icon 已配，tauri-build 必嵌入默认图标")
        .clone();
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("望舒")
        .menu(&menu)
        // 右键弹菜单；左键单击唤回主窗口（Windows 习惯）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    // 快捷键逐个注册、逐个降级（仅日志）：一个被占用不影响另一个，也不阻断
    // 启动；显示/隐藏仍可走托盘
    for shortcut in [TOGGLE_SHORTCUT, QUICKASK_SHORTCUT] {
        if let Err(e) = app.global_shortcut().register(shortcut) {
            eprintln!("[desktop] 全局快捷键 {shortcut} 注册失败（可能被占用）: {e}");
        }
    }
    Ok(())
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

/// 主窗口当前是否可见（schedule 终态通知的「盯屏不打扰」判定，R10-B B2）：
/// 对齐前端 notifyTaskDone 的 document.hidden 语义——不可见才发系统通知。
/// 可见性不可得时回 false（宁可多通知不吞结果）。
pub fn main_window_visible(app: &AppHandle) -> bool {
    main_window(app).is_some_and(|w| w.is_visible().unwrap_or(false))
}

/* ── 托盘状态变体（R6-A#5）──────────────────────────
   窗口外的盲区信号：update=橙方（有新版本待装）、warn=红方（hub 持续不可达）。
   不引图标资产，纯像素绘制（Flight Console 语言：面板底 + 居中信号方块）。 */

fn rounded_inside(x: u32, y: u32, s: u32, r: u32) -> bool {
    let cx = x.max(r).min(s - 1 - r);
    let cy = y.max(r).min(s - 1 - r);
    let dx = x as i32 - cx as i32;
    let dy = y as i32 - cy as i32;
    dx * dx + dy * dy <= (r * r) as i32
}

/// 32x32 圆角面板底 + 居中 12x12 信号方块。
fn tray_state_icon(color: [u8; 3]) -> tauri::image::Image<'static> {
    const S: u32 = 32;
    const R: u32 = 7;
    let base = [14u8, 21, 32];
    let mut rgba = Vec::<u8>::with_capacity((S * S * 4) as usize);
    for y in 0..S {
        for x in 0..S {
            if rounded_inside(x, y, S, R) {
                let signal = (10..22).contains(&x) && (10..22).contains(&y);
                let c = if signal { color } else { base };
                rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    tauri::image::Image::new_owned(rgba, S, S)
}

/// 前端驱动托盘状态：normal（恢复默认图标）/ update / warn。
#[tauri::command]
pub fn tray_set_state(app: AppHandle, state: String) {
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    match state.as_str() {
        "update" => {
            let _ = tray.set_icon(Some(tray_state_icon([255, 138, 61])));
            let _ = tray.set_tooltip(Some("望舒 · 有新版本待安装"));
        }
        "warn" => {
            let _ = tray.set_icon(Some(tray_state_icon([255, 93, 93])));
            let _ = tray.set_tooltip(Some("望舒 · hub 持续不可达"));
        }
        _ => {
            if let Some(icon) = app.default_window_icon() {
                let _ = tray.set_icon(Some(icon.clone()));
            }
            let _ = tray.set_tooltip(Some("望舒"));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    /// 常量须为合法快捷键：拼错会让启动期注册静默降级，快捷键无声失效。
    #[test]
    fn toggle_shortcut_parses() {
        tauri_plugin_global_shortcut::Shortcut::from_str(super::TOGGLE_SHORTCUT)
            .expect("TOGGLE_SHORTCUT 应为合法快捷键");
    }

    /// 同上，小窗热键。
    #[test]
    fn quickask_shortcut_parses() {
        tauri_plugin_global_shortcut::Shortcut::from_str(super::QUICKASK_SHORTCUT)
            .expect("QUICKASK_SHORTCUT 应为合法快捷键");
    }

    /// 两热键必须互异：同键时后注册者失败，一套 toggle 静默错乱成另一套。
    #[test]
    fn shortcuts_are_distinct() {
        let main =
            tauri_plugin_global_shortcut::Shortcut::from_str(super::TOGGLE_SHORTCUT).unwrap();
        let quick =
            tauri_plugin_global_shortcut::Shortcut::from_str(super::QUICKASK_SHORTCUT).unwrap();
        assert_ne!(main, quick);
    }

    /// 小窗几何契约：工作区右上内缩 16px（1920-480-16=1424）。
    #[test]
    fn quickask_position_full_hd() {
        assert_eq!(super::quickask_position(1920.0, 1080.0), (1424.0, 16.0));
    }

    /// 低分屏同契约：1366-480-16=870，仍完整在屏内。
    #[test]
    fn quickask_position_laptop() {
        assert_eq!(super::quickask_position(1366.0, 768.0), (870.0, 16.0));
    }

    /// 状态图标几何契约：32x32、角透明、中心为信号色、方外为面板底。
    #[test]
    fn tray_state_icon_geometry() {
        let img = super::tray_state_icon([255, 138, 61]);
        assert_eq!((img.width(), img.height()), (32, 32));
        let rgba = img.rgba();
        assert_eq!(rgba.len(), 32 * 32 * 4);
        let px = |x: usize, y: usize| -> [u8; 4] {
            let i = (y * 32 + x) * 4;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        assert_eq!(px(0, 0)[3], 0, "圆角外透明");
        assert_eq!(px(16, 16), [255, 138, 61, 255], "中心为信号色");
        assert_eq!(px(3, 16), [14, 21, 32, 255], "方外为面板底");
    }
}
