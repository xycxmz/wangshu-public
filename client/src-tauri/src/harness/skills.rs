//! 技能（skill）系统：SKILL.md 发现 + 按需加载。
//!
//! 文件约定（本项目自定义格式，参照业界 Markdown + YAML frontmatter 公开惯例自行设计）：
//! - 信任目录下 `.skills/<目录名>/SKILL.md` 为一个技能；目录名不参与匹配，
//!   技能身份是 frontmatter 里的 `name`。
//! - 文件首行与随后的一个独立 `---` 行夹住一段 YAML frontmatter，必填两个键：
//!   `name`（全局唯一短名，模型以它调 load_skill）、`description`（一句话用途，进系统提示清单）。
//! - frontmatter 之后是 markdown 正文：完整操作指令，模型经 load_skill 按需读取后遵循，
//!   扫描阶段不预载（上下文经济）。
//! - 解析失败（无/未闭合 frontmatter、缺必填键、name 重复）的文件跳过并记录警告，
//!   绝不使任务失败。frontmatter 仅支持扁平 `key: value` 行，多余键忽略（向前兼容）。

use super::tools;
use std::fs;
use std::path::{Path, PathBuf};

/// 一个已发现的技能。正文不持有——load 时按 path 现读（目录不热变的缓存假设）。
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// SKILL.md 绝对路径（扫描时已确认存在且在信任目录内）。
    pub path: PathBuf,
}

/// 扫描结果：可用技能 + 被跳过文件的警告（进飞行日志，测试可见）。
#[derive(Debug, Default)]
pub struct ScanReport {
    pub skills: Vec<Skill>,
    pub warnings: Vec<String>,
}

/// 扫描 `{working_dir}/.skills/*/SKILL.md`。无 `.skills` 目录视为无技能（正常态）。
/// 结果按 name 排序，保证系统提示确定性；重名保留先扫到的，后者告警丢弃。
pub fn scan(working_dir: &Path) -> ScanReport {
    let mut report = ScanReport::default();
    let root = working_dir.join(".skills");
    if !root.is_dir() {
        return report;
    }
    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) => {
            report
                .warnings
                .push(format!(".skills 目录不可读，已忽略: {e}"));
            return report;
        }
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        match tools::read_capped(&skill_md, &skill_md.to_string_lossy())
            .and_then(|text| parse_skill(&text, skill_md.clone()))
        {
            Ok(skill) => report.skills.push(skill),
            Err(reason) => report
                .warnings
                .push(format!("{}: {reason}", skill_md.display())),
        }
    }
    report.skills.sort_by(|a, b| a.name.cmp(&b.name));
    let mut deduped: Vec<Skill> = Vec::new();
    for skill in report.skills.drain(..) {
        if deduped.iter().any(|kept| kept.name == skill.name) {
            report.warnings.push(format!(
                "{}: 技能名 '{}' 重复，后者丢弃",
                skill.path.display(),
                skill.name
            ));
        } else {
            deduped.push(skill);
        }
    }
    report.skills = deduped;
    report
}

/// 按名加载技能正文（免审批：只读信任目录内、扫描时已校验的文件）。
/// 未知名字返回错误串（附可用清单，助模型自纠）；文件在扫描后消失/变坏同样回错。
pub fn load(skills: &[Skill], name: &str) -> Result<String, String> {
    let Some(skill) = skills.iter().find(|s| s.name == name) else {
        let available: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        return Err(format!(
            "unknown skill '{name}'（可用技能: {}）",
            available.join(", ")
        ));
    };
    let text = tools::read_capped(&skill.path, &format!("skill '{name}'"))?;
    let (_fm, body) =
        split_frontmatter(&text).map_err(|e| format!("重读技能 '{name}' 失败: {e}"))?;
    // CRLF 归一为 LF：markdown 指令对换行风格不敏感，省 token 且断言稳定。
    Ok(body.trim().replace("\r\n", "\n"))
}

/// 解析单个 SKILL.md 文本为 Skill（只取 name/description/path）。
fn parse_skill(text: &str, path: PathBuf) -> Result<Skill, String> {
    let (fm, _body) = split_frontmatter(text)?;
    let name = frontmatter_field(fm, "name")
        .filter(|v| !v.is_empty())
        .ok_or("frontmatter 缺少必填键 name（非空短名）")?;
    let description = frontmatter_field(fm, "description")
        .filter(|v| !v.is_empty())
        .ok_or("frontmatter 缺少必填键 description（一句话）")?;
    Ok(Skill {
        name,
        description,
        path,
    })
}

/// 拆出 `(frontmatter 文本, 正文)`。首行必须是 `---`，到下一个独立 `---` 行闭合；
/// 兼容 CRLF。失败返回面向日志的原因串。
fn split_frontmatter(text: &str) -> Result<(&str, &str), String> {
    let first_end = text
        .find('\n')
        .ok_or("frontmatter 未找到（首行必须是 ---）")?;
    if text[..first_end].trim_end() != "---" {
        return Err("frontmatter 未找到（首行必须是 ---）".into());
    }
    let rest = &text[first_end + 1..];
    let mut consumed = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Ok((&rest[..consumed], &rest[consumed + line.len()..]));
        }
        consumed += line.len();
    }
    Err("frontmatter 未闭合（缺第二个 --- 行）".into())
}

/// 扁平 YAML 子集取值：首个 `key: value` 行，值去首尾空白与成对引号。行内无冒号则忽略。
fn frontmatter_field(fm: &str, key: &str) -> Option<String> {
    for line in fm.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == key {
                let v = v.trim();
                let bytes = v.as_bytes();
                let quoted = v.len() >= 2
                    && ((bytes[0] == b'"' && bytes[v.len() - 1] == b'"')
                        || (bytes[0] == b'\'' && bytes[v.len() - 1] == b'\''));
                return Some(if quoted {
                    v[1..v.len() - 1].to_string()
                } else {
                    v.to_string()
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, slug: &str, content: &str) {
        let dir = root.join(".skills").join(slug);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cp-skills-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_without_skills_dir_is_quietly_empty() {
        let root = temp_root("absent");
        let report = scan(&root);
        assert!(report.skills.is_empty());
        assert!(report.warnings.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_keeps_good_skips_bad_and_flags_duplicate_names() {
        let root = temp_root("mixed");
        write_skill(
            &root,
            "good",
            "---\nname: alpha\ndescription: \"第一个技能\"\n---\n\n正文 A。",
        );
        write_skill(&root, "bad", "---\nname: beta\n---\n缺 description。");
        write_skill(
            &root,
            "notfm",
            "name: gamma\ndescription: 没有包裹 frontmatter\n",
        );
        write_skill(
            &root,
            "dup",
            "---\nname: alpha\ndescription: 重名技能\n---\n正文 B。",
        );
        fs::create_dir_all(root.join(".skills/draft-no-file")).unwrap();
        fs::write(root.join(".skills/README.md"), "散落文件，不是技能").unwrap();

        let report = scan(&root);
        assert_eq!(report.skills.len(), 1, "skills: {:?}", report.skills);
        assert_eq!(report.skills[0].name, "alpha");

        assert_eq!(report.warnings.len(), 3, "warnings: {:?}", report.warnings);
        assert!(report
            .warnings
            .iter()
            .any(|w| w.contains("bad") && w.contains("description")));
        assert!(report
            .warnings
            .iter()
            .any(|w| w.contains("notfm") && w.contains("未找到")));
        assert!(report
            .warnings
            .iter()
            .any(|w| w.contains("重复") && w.contains("alpha")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn load_returns_body_without_frontmatter_and_errors_on_unknown() {
        let root = temp_root("load");
        write_skill(
            &root,
            "s",
            "---\r\nname: demo\r\ndescription: 演示\r\n---\r\n\r\n# 步骤\r\n\r\n1. 照做。\r\n",
        );
        let report = scan(&root);
        assert_eq!(report.skills.len(), 1);

        let body = load(&report.skills, "demo").unwrap();
        assert_eq!(body, "# 步骤\n\n1. 照做。");

        let err = load(&report.skills, "nope").unwrap_err();
        assert!(err.contains("unknown skill 'nope'"), "err: {err}");
        assert!(err.contains("demo"), "应附可用清单: {err}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn load_reports_skill_file_removed_after_scan() {
        let root = temp_root("stale");
        write_skill(
            &root,
            "s",
            "---\nname: gone\ndescription: 会被删\n---\n正文",
        );
        let report = scan(&root);
        fs::remove_file(root.join(".skills/s/SKILL.md")).unwrap();
        let err = load(&report.skills, "gone").unwrap_err();
        assert!(err.contains("skill 'gone'"), "err: {err}");
        let _ = fs::remove_dir_all(&root);
    }
}
