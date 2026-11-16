//! 工具执行与信任目录边界。所有路径先并入 working_dir，再解析校验：
//! 向上找最深的已存在祖先并 canonicalize，拼回余下分量后必须仍落在
//! canonicalize(working_dir) 之内，否则判为路径逃逸。
//! 一切失败以错误字符串返回给模型（不 panic、不让任务失败），模型可见并可纠正。

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::fetch::{self, PageContent};

/// 单文件读入上限，防超大文件撑爆上下文。
const READ_CAP_BYTES: usize = 100_000;

/// web_fetch 单任务调用上限（防打转：超限回错误串，模型改用已抓内容继续）。
pub const WEB_FETCH_CAP: u32 = 10;
/// web_fetch 返回文本截断（字符）：网页是参考输入不是归档，防上下文撑爆。
const WEB_FETCH_MAX_CHARS: usize = 8_000;

/// web_fetch 工具体（R10-B B1）：调 fetch.rs 的抓取与剥离，返回「title\n\n正文」。
/// 预算按尝试计（失败不退补——换 URL 重试也是网络成本）；超限不发网直接回错误。
pub async fn web_fetch(url: &str, used: &mut u32) -> Result<String, String> {
    if *used >= WEB_FETCH_CAP {
        return Err(format!(
            "web_fetch 调用已达单任务上限 {WEB_FETCH_CAP} 次，请改用已抓取的内容继续"
        ));
    }
    *used += 1;
    let page = fetch::fetch_page(url.to_string()).await?;
    Ok(format_page(page))
}

/// 抓取结果 → 工具文本：title 非空拼「title\n\n正文」，整体截 8K 字并标注。
pub fn format_page(page: PageContent) -> String {
    let whole = if page.title.is_empty() {
        page.text
    } else {
        format!("{}\n\n{}", page.title, page.text)
    };
    if whole.chars().count() > WEB_FETCH_MAX_CHARS {
        let cut: String = whole.chars().take(WEB_FETCH_MAX_CHARS).collect();
        cut + "\n… [web_fetch 截断]"
    } else {
        whole
    }
}

pub fn resolve(working_dir: &Path, user_path: &str) -> Result<PathBuf, String> {
    let base = working_dir
        .canonicalize()
        .map_err(|e| format!("working directory inaccessible: {e}"))?;
    let mut probe = working_dir.join(user_path);
    let mut tail: Vec<OsString> = Vec::new();
    while !probe.exists() {
        match (probe.parent(), probe.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                probe = parent.to_path_buf();
            }
            _ => return Err(format!("cannot resolve path '{user_path}'")),
        }
    }
    let mut candidate = probe
        .canonicalize()
        .map_err(|e| format!("cannot resolve '{user_path}': {e}"))?;
    for part in tail.iter().rev() {
        candidate.push(part);
    }
    if !candidate.starts_with(&base) {
        return Err(format!("path '{user_path}' escapes the working directory"));
    }
    Ok(candidate)
}

pub fn read_file(working_dir: &Path, user_path: &str) -> Result<String, String> {
    let path = resolve(working_dir, user_path)?;
    read_capped(&path, user_path)
}

/// 读文件并施加 READ_CAP 截断（read_file 与技能正文加载共用）。label 用于错误信息。
pub fn read_capped(path: &Path, label: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read '{label}' failed: {e}"))?;
    if bytes.len() > READ_CAP_BYTES {
        let mut head = String::from_utf8_lossy(&bytes[..READ_CAP_BYTES]).into_owned();
        head.push_str(&format!("\n… [truncated, file is {} bytes]", bytes.len()));
        Ok(head)
    } else {
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

pub fn list_dir(working_dir: &Path, user_path: &str) -> Result<String, String> {
    let path = resolve(working_dir, user_path)?;
    let entries = fs::read_dir(&path).map_err(|e| format!("list '{user_path}' failed: {e}"))?;
    let mut lines: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            "/"
        } else {
            ""
        };
        lines.push(format!("{name}{suffix}"));
    }
    lines.sort();
    if lines.is_empty() {
        Ok("(empty directory)".to_string())
    } else {
        Ok(lines.join("\n"))
    }
}

/// 写前备份：目标存在则先复制为 同名+".bak"（覆盖旧备份），再写入新内容。
pub fn write_file_backup(
    working_dir: &Path,
    user_path: &str,
    content: &str,
) -> Result<String, String> {
    let path = resolve(working_dir, user_path)?;
    if path.is_dir() {
        return Err(format!("'{user_path}' is a directory"));
    }
    let mut backup_note = "no previous version";
    if path.exists() {
        let mut bak = path.as_os_str().to_os_string();
        bak.push(".bak");
        fs::copy(&path, Path::new(&bak))
            .map_err(|e| format!("backup '{user_path}' failed: {e}"))?;
        backup_note = "backup .bak written";
    }
    fs::write(&path, content).map_err(|e| format!("write '{user_path}' failed: {e}"))?;
    Ok(format!(
        "wrote {} bytes to '{user_path}' ({backup_note})",
        content.len()
    ))
}

/// 写操作审批预览：旧内容→新内容的 diff 式文本；旧文件不存在标注 NEW。
/// 纯展示，不失败；路径已出界时直接展示校验错误。
pub fn write_preview(working_dir: &Path, user_path: &str, new_content: &str) -> String {
    let old = match resolve(working_dir, user_path) {
        Ok(p) if p.is_file() => fs::read(&p)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned()),
        Ok(_) => None,
        Err(e) => return format!("[路径校验失败] {e}\n（批准后写入也会被拒绝）"),
    };
    match old {
        None => {
            let mut out = format!("[NEW] {user_path}\n");
            for line in new_content.lines() {
                out.push_str(&format!("+ {line}\n"));
            }
            out.trim_end().to_string()
        }
        Some(old) => line_diff(user_path, &old, new_content),
    }
}

/// 朴素行级 diff（公共前后缀裁剪），只取变更区前后各 2 行上下文。
fn line_diff(rel: &str, old: &str, new: &str) -> String {
    let o: Vec<&str> = old.lines().collect();
    let n: Vec<&str> = new.lines().collect();
    let mut prefix = 0;
    while prefix < o.len() && prefix < n.len() && o[prefix] == n[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < o.len() - prefix
        && suffix < n.len() - prefix
        && o[o.len() - 1 - suffix] == n[n.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let removed = &o[prefix..o.len() - suffix];
    let added = &n[prefix..n.len() - suffix];

    let mut out = format!("--- {rel} (旧)\n+++ {rel} (新)\n");
    let ctx_start = prefix.saturating_sub(2);
    for line in &o[ctx_start..prefix] {
        out.push_str(&format!("  {line}\n"));
    }
    for line in removed {
        out.push_str(&format!("- {line}\n"));
    }
    for line in added {
        out.push_str(&format!("+ {line}\n"));
    }
    let ctx_end = (o.len() - suffix + 2).min(o.len());
    for line in &o[o.len() - suffix..ctx_end] {
        out.push_str(&format!("  {line}\n"));
    }
    if removed.is_empty() && added.is_empty() {
        out.push_str("  (内容无变化)\n");
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::{format_page, web_fetch, PageContent, WEB_FETCH_CAP};

    fn page(title: &str, text: &str) -> PageContent {
        PageContent { title: title.into(), text: text.into() }
    }

    /// 返回形态：title 非空拼「title\n\n正文」；title 空只回正文。
    #[test]
    fn format_page_joins_title_and_text() {
        assert_eq!(format_page(page("标题", "正文")), "标题\n\n正文");
        assert_eq!(format_page(page("", "正文")), "正文");
    }

    /// 超长截断：恰 8K 字不加标注；多一字截到 8K 并带截断标注。
    #[test]
    fn format_page_truncates_beyond_cap_with_marker() {
        let exact: String = "a".repeat(8_000);
        assert_eq!(format_page(page("", &exact)).chars().count(), 8_000);
        let over = exact.clone() + "b";
        let cut = format_page(page("", &over));
        assert!(cut.starts_with(&exact), "前 8K 字原样保留");
        assert!(cut.ends_with("\n… [web_fetch 截断]"), "截断标注收尾: 尾部={}", &cut[cut.len() - 30..]);
        assert!(cut.chars().count() <= 8_000 + "\n… [web_fetch 截断]".chars().count() + 2);
    }

    /// 超限不发网：预算满直接回错误串（含上限数与「改用已抓内容」指引），计数不增。
    #[tokio::test]
    async fn web_fetch_over_cap_errors_without_network() {
        let mut used = WEB_FETCH_CAP;
        let err = web_fetch("https://example.com", &mut used).await.unwrap_err();
        assert!(err.contains("上限"), "err: {err}");
        assert!(err.contains("已抓取"), "应指引模型改用已有内容: {err}");
        assert_eq!(used, WEB_FETCH_CAP, "超限路径不得再计数");
    }

    /// 预算按尝试计：scheme 拒绝（发网前失败）也烧一次预算——防换 URL 重试打转。
    #[tokio::test]
    async fn web_fetch_counts_failed_attempts() {
        let mut used = 0;
        let err = web_fetch("file:///C:/Windows/win.ini", &mut used).await.unwrap_err();
        assert!(err.contains("http"), "应在发网前被拒: {err}");
        assert_eq!(used, 1, "失败尝试同样计数");
    }
}
