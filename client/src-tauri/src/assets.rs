//! 本地素材资产（B5，roadmap-r4）：succeeded 素材结果下载落盘
//! `app_data_dir/assets/`，索引进 tasks.db `assets` 表；rail 03 资产页浏览。
//! 客户端本地优先（toC 单用户，无 hub 侧资产库——红线「无 hub 本地模式」一致）。
//!
//! asset_save_from_url 是异步命令（reqwest 下载）；reveal 按平台唤文件管理器
//! 定位文件。下载失败原样回传错误串，前端就地提示。

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Manager;

use crate::tasksdb::{unix_ms, AssetRecord, TaskDb};

const ASSET_LIMIT: u32 = 200;
/// 下载总超时：对齐 harness llm.rs/mcp.rs 的 120s（资产为图片/视频，放宽于纯文本）。
const ASSET_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// 单资产大小上限：content-length 预检 + 流式限读双闸（后者兜住谎报/缺失头）。
const ASSET_MAX_BYTES: usize = 50 * 1024 * 1024;

/// 从 URL 提取扩展名（取 path 段末段后缀，仅接受字母数字 1-5 位）；
/// 提不出按 kind 回退（image→png，video→mp4）。
fn ext_from_url(url: &str, kind: &str) -> String {
    let fallback = if kind == "video" { "mp4" } else { "png" };
    let path = url.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    match last.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            ext.to_ascii_lowercase()
        }
        _ => fallback.to_string(),
    }
}

/// 资产文件名：时间戳 + 自增序号（同一毫秒内靠序号错开，单用户无并发碰撞需求）。
fn next_file_name(kind: &str, url: &str) -> String {
    let n = ASSET_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{}.{}", unix_ms(), n, ext_from_url(url, kind))
}

static ASSET_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 不可得: {e}"))?
        .join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("资产目录创建失败: {e}"))?;
    Ok(dir)
}

/// content-length 上限预检：header 缺失（None）不拦，由流式限读兜底。
fn content_length_within_cap(len: Option<u64>) -> bool {
    len.is_none_or(|l| l as usize <= ASSET_MAX_BYTES)
}

/// 带超时的下载客户端（reqwest::get 的默认客户端无总超时，会被慢源拖死）。
fn asset_http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(ASSET_DOWNLOAD_TIMEOUT)
        .build()
        .unwrap_or_default()
}

/// 落盘原子化：先写 `<name>.tmp` 再 rename，崩溃/中断不留半截正名文件。
fn write_asset_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let stem = path.file_name().and_then(|n| n.to_str()).unwrap_or("asset");
    let tmp = path.with_file_name(format!("{stem}.tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写文件失败: {e}"))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(format!("落盘重命名失败: {e}"))
        }
    }
}

/// 归属校验：canonicalize 两侧后比较（Windows 侧统一带 `\\?\` 前缀才可比；
/// 不存在的路径 canonicalize 失败即拒绝）。防 reveal 越出资产根定位任意文件。
fn path_within(path: &Path, root: &Path) -> bool {
    match (std::fs::canonicalize(path), std::fs::canonicalize(root)) {
        (Ok(p), Ok(r)) => p.starts_with(r),
        _ => false,
    }
}

/// 下载素材结果到本地资产夹并索引。同名（同毫秒同序号）概率为零，
/// 重试由前端发起新命令完成；失败不留半截文件、不留无索引孤儿。
#[tauri::command]
pub async fn asset_save_from_url(
    app: tauri::AppHandle,
    db: tauri::State<'_, TaskDb>,
    url: String,
    kind: String,
    prompt: String,
) -> Result<AssetRecord, String> {
    if kind != "image" && kind != "video" {
        return Err(format!("未知素材类型: {kind}"));
    }
    let dir = assets_dir(&app)?;
    let name = next_file_name(&kind, &url);
    let path = dir.join(&name);
    let mut resp = asset_http()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?;
    if !content_length_within_cap(resp.content_length()) {
        return Err(format!(
            "资产超过大小上限（{}MB）",
            ASSET_MAX_BYTES / 1024 / 1024
        ));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取响应体失败: {e}"))?
    {
        if bytes.len() + chunk.len() > ASSET_MAX_BYTES {
            return Err(format!(
                "资产超过大小上限（{}MB）",
                ASSET_MAX_BYTES / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    write_asset_atomic(&path, &bytes)?;

    let mut rec = AssetRecord {
        id: 0,
        kind,
        prompt,
        path: path.to_string_lossy().into_owned(),
        source_url: url,
        created_at: unix_ms(),
    };
    match db.save_asset(&mut rec) {
        Some(()) => Ok(rec),
        None => {
            let _ = std::fs::remove_file(&path);
            Err("资产索引写入失败（本地库不可用）".to_string())
        }
    }
}

/// 最近资产（created_at 倒序，上限 200）。
#[tauri::command]
pub fn asset_list(db: tauri::State<'_, TaskDb>) -> Vec<AssetRecord> {
    db.list_assets(ASSET_LIMIT)
}

/// 在系统文件管理器中定位资产文件（Windows 资源管理器选中，macOS Finder
/// reveal，Linux 打开所在目录）。path 必须落在本地资产根内——前端传的是
/// asset_list 下发的绝对路径，越根（被篡改/伪造）一律拒绝。
#[tauri::command]
pub fn asset_reveal(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let root = assets_dir(&app)?;
    let p = Path::new(&path);
    if !path_within(p, &root) {
        return Err("路径不在本地资产目录内".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let dir = p
            .parent()
            .map(|d| d.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        content_length_within_cap, ext_from_url, path_within, write_asset_atomic, ASSET_MAX_BYTES,
    };

    #[test]
    fn ext_from_url_prefers_real_ext_and_falls_back_by_kind() {
        assert_eq!(
            ext_from_url("https://oss.example/a/b/out.png?Expires=1", "image"),
            "png"
        );
        assert_eq!(
            ext_from_url("https://oss.example/out.MP4#t=0", "video"),
            "mp4"
        );
        assert_eq!(ext_from_url("https://oss.example/noext", "video"), "mp4");
        assert_eq!(ext_from_url("https://oss.example/noext", "image"), "png");
        assert_eq!(
            ext_from_url("https://oss.example/.hidden", "image"),
            "png",
            "无主名段不采信"
        );
        assert_eq!(
            ext_from_url("https://oss.example/a.tooolongext", "image"),
            "png"
        );
        assert_eq!(ext_from_url("", "video"), "mp4");
    }

    #[test]
    fn content_length_cap_boundary() {
        assert!(content_length_within_cap(None), "缺失 header 交给流式限读");
        assert!(
            content_length_within_cap(Some(ASSET_MAX_BYTES as u64)),
            "恰好上限放行"
        );
        assert!(
            !content_length_within_cap(Some(ASSET_MAX_BYTES as u64 + 1)),
            "超上限预检拒绝"
        );
    }

    #[test]
    fn write_atomic_leaves_final_file_and_no_tmp() {
        let dir = std::env::temp_dir().join(format!("cp-asset-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("1752-0.png");
        write_asset_atomic(&path, b"pngbytes").unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"pngbytes",
            "正名文件内容完整"
        );
        assert!(!dir.join("1752-0.png.tmp").exists(), "不留 .tmp 残件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_within_accepts_assets_root_only() {
        let base = std::env::temp_dir().join(format!("cp-asset-reveal-{}", std::process::id()));
        let root = base.join("assets");
        std::fs::create_dir_all(&root).unwrap();
        let inside = root.join("1752-0.png");
        std::fs::write(&inside, b"x").unwrap();
        let outside = base.join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();

        assert!(path_within(&inside, &root), "资产根内文件放行");
        assert!(!path_within(&outside, &root), "资产根外文件拒绝");
        assert!(!path_within(&base, &root), "以根祖先冒充也拒绝");
        assert!(
            !path_within(&root.join("missing.png"), &root),
            "不存在的路径 canonicalize 失败即拒绝"
        );

        // 逐级 ../ 逃逸：拼接后仍解析回根外
        let escape = root.join("..").join("secret.txt");
        assert!(!path_within(&escape, &root), "../ 逃逸路径拒绝");

        let _ = std::fs::remove_dir_all(&base);
    }
}
