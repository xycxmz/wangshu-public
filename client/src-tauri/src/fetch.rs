//! R9-D D1「@资料」：网页抓取命令 fetch_page——用户给的 URL 取回来剥成
//! {title, text}，供本轮资料注入（不落库、单轮即弃，hub 零改动）。
//!
//! 边界把关都在命令侧（scheme/Content-Type/超时/重定向/大小），HTML→文本
//! 剥离是无 DOM 依赖的纯函数 html_to_text，可离线单测。

use std::time::Duration;

use serde::Serialize;

/// 抓取总超时（设计 20s）：资料是用户正等着用的输入，不是后台任务，
/// 慢源快速失败（对齐口径：资产下载是 120s，那是后台落盘）。
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// 重定向上限（设计 ≤3）：reqwest 默认 10 次，过宽。
const FETCH_MAX_REDIRECTS: usize = 3;
/// 响应体上限（设计 256K）：流式读到即停，截断不报错——资料是给 LLM 看
/// 的参考，不是要完整归档的文件。
const FETCH_MAX_BYTES: usize = 256 * 1024;

/// fetch_page 的返回契约（前端 invoke 按此字段名取值，勿改）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageContent {
    pub title: String,
    pub text: String,
}

/// 抓取网页并剥成 {title, text}。仅 http/https；Content-Type 须 text/*
/// （html/plain 都收，二进制/图片明确拒绝）。失败原样回传错误串，前端就地提示。
#[tauri::command]
pub async fn fetch_page(url: String) -> Result<PageContent, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!(
            "仅支持 http/https 链接，不支持 {}",
            parsed.scheme()
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(FETCH_MAX_REDIRECTS))
        // 不少站点对 reqwest 默认 UA 直接 403，浏览器式 UA 换真实页面可得性
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))?;
    let mut resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("抓取失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("抓取失败: {e}"))?;
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mime = ctype
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !mime.starts_with("text/") {
        return Err(format!(
            "不支持的 Content-Type「{ctype}」：仅支持 text/*（如 text/html）"
        ));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while bytes.len() < FETCH_MAX_BYTES {
        let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("读取响应体失败: {e}"))?
        else {
            break;
        };
        let room = FETCH_MAX_BYTES - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }
    let html = String::from_utf8_lossy(&bytes);
    let (title, text) = html_to_text(&html);
    Ok(PageContent { title, text })
}

/// HTML→纯文本剥离（无 DOM 依赖手写）：先提 <title>，再剥 script/style
/// 整块与其余标签，五种常见实体解码，空白折叠但保留换行结构。
pub fn html_to_text(html: &str) -> (String /*title*/, String /*text*/) {
    let markup = mask_entity_angle(html);
    let title = extract_title(&markup);
    let text = fold_whitespace(&decode_entities(&strip_tags(&strip_elements(&markup))));
    (title, text)
}

/// 实体尖括号先占位成控制字符（\u{1}/\u{2} 在正常 HTML 文本不出现）：
/// 后续所有标记扫描只认真实标签，文本里的 &lt;…&gt;（代码片段常态）
/// 不会被当成标签起点跨段吃正文。
fn mask_entity_angle(s: &str) -> String {
    s.replace("&lt;", "\u{1}").replace("&gt;", "\u{2}")
}

/// 大小写不敏感子串定位：HTML 标签名大小写任意；to_ascii_lowercase 保
/// 字节长度（非 ASCII 字节不动），返回的索引对原串直接可用。
fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(&needle.to_ascii_lowercase())
}

/// 整块剥除的元素（含内容与闭合标签）：script/style 内容不是正文；
/// title 已单独提取，正文侧再剥避免标题串重复混入。
const STRIP_ELEMENTS: &[&str] = &["script", "style", "title"];

/// 剥 STRIP_ELEMENTS 整块（open 标签带任意属性也命中）。未闭合的块剥到
/// 文末——截断页/坏页不给正文留脚本尾巴。
fn strip_elements(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let mut best: Option<(usize, &str)> = None;
        for name in STRIP_ELEMENTS {
            if let Some(i) = find_ci(rest, &format!("<{name}")) {
                if best.is_none_or(|(b, _)| i < b) {
                    best = Some((i, name));
                }
            }
        }
        let Some((start, name)) = best else { break };
        out.push_str(&rest[..start]);
        let block = &rest[start..];
        let end = find_ci(block, &format!("</{name}"))
            .and_then(|i| block[i..].find('>').map(|g| i + g + 1))
            .unwrap_or(block.len());
        rest = &block[end..];
    }
    out.push_str(rest);
    out
}

/// 提取首个 <title>：内容实体解码 + 空白折成单空格；无 title 得空串。
fn extract_title(markup: &str) -> String {
    let lower = markup.to_ascii_lowercase();
    let Some(open) = lower.find("<title") else {
        return String::new();
    };
    let Some(tag_end) = lower[open..].find('>') else {
        return String::new();
    };
    let body_start = open + tag_end + 1;
    let body_end = lower[body_start..]
        .find("</title")
        .map_or(markup.len(), |i| body_start + i);
    decode_entities(&markup[body_start..body_end])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 块级标签集合：剥除时折为换行，保住段落/行结构（行内标签直接消失）。
/// 够用集，不求穷尽——漏网的块标签只是少个换行，不损文本内容。
const BLOCK_TAGS: &[&str] = &[
    "p", "div", "br", "section", "article", "header", "footer", "nav", "aside", "main",
    "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote", "pre", "hr", "table",
    "thead", "tbody", "tr", "dl", "dt", "dd", "form", "fieldset", "figure", "figcaption",
];

/// 剥全部标签：`<` 到 `>` 整段丢弃，块级标签换行。未闭合的 `<`（截断页
/// 尾）丢弃到文末。注释 `<!--…-->` 无 `>` 嵌套时被当作一个标签剥掉。
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let Some(len) = rest[start..].find('>').map(|g| g + 1) else {
            break;
        };
        let name: String = rest[start + 1..start + len - 1]
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase();
        if BLOCK_TAGS.contains(&name.as_str()) {
            out.push('\n');
        }
        rest = &rest[start + len..];
    }
    out.push_str(rest);
    out
}

/// 五种常见 HTML 实体解码（&lt;/&gt; 经 mask_entity_angle 占位后在此
/// 还原）。&amp; 最后替换：&amp;lt; 应得字面 "&lt;"，不被二次解码。
fn decode_entities(s: &str) -> String {
    s.replace('\u{1}', "<")
        .replace('\u{2}', ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// 单行空白折叠：任意空白串折成单空格，首尾去净。
fn fold_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 多行空白折叠但保留换行结构：逐行折空白，内容行间原有空行保留一行
/// （段落边界），无空行的相邻行保留单换行；首尾与连续空行修齐。
fn fold_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blanks = 0usize;
    for line in s.lines() {
        let folded = fold_line(line);
        if folded.is_empty() {
            blanks += 1;
        } else {
            if !out.is_empty() {
                out.push_str(if blanks >= 1 { "\n\n" } else { "\n" });
            }
            out.push_str(&folded);
            blanks = 0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{fetch_page, html_to_text};

    #[test]
    fn strips_script_style_and_title_elements() {
        let (title, text) = html_to_text(
            "<HTML><HEAD><TITLE>页面标题</TITLE>\
             <STYLE>body { color: red }</STYLE>\
             <SCRIPT>var s = '<p>not text</p>';</SCRIPT></HEAD>\
             <BODY><P>正文一段</P><script src=\"a.js\"></script></BODY></HTML>",
        );
        assert_eq!(title, "页面标题", "title 大小写不敏感提取");
        assert!(!text.contains("color"), "style 内容不得混入正文");
        assert!(!text.contains("not text"), "script 内容不得混入正文");
        assert!(!text.contains("a.js"), "带属性的 script 标签整块剥除");
        assert!(
            !text.contains("页面标题"),
            "title 已单独提取，正文侧剥除不重复"
        );
        assert_eq!(text, "正文一段");
    }

    #[test]
    fn decodes_five_common_entities_without_double_decode() {
        let (_, text) = html_to_text("<p>a &lt; b &gt; c &quot;d&quot; &#39;e&#39; &amp;lt;</p>");
        assert_eq!(text, "a < b > c \"d\" 'e' &lt;");
    }

    #[test]
    fn keeps_line_structure_from_block_tags() {
        let (_, text) = html_to_text("<h1>标题</h1><p>one</p><p>two<br>three</p>");
        assert_eq!(text, "标题\n\none\n\ntwo\nthree");
        let (_, squeezed) = html_to_text("<p>a   b \t c</p>");
        assert_eq!(squeezed, "a b c", "行内空白折成单空格");
    }

    #[test]
    fn missing_title_yields_empty_title() {
        let (title, text) = html_to_text("<p>只有正文</p>");
        assert_eq!(title, "");
        assert_eq!(text, "只有正文");
    }

    #[tokio::test]
    async fn fetch_page_rejects_non_http_schemes() {
        for bad in [
            "file:///C:/Windows/win.ini",
            "ftp://example.com/a",
            "javascript:alert(1)",
            "not a url",
        ] {
            let err = fetch_page(bad.to_string()).await.unwrap_err();
            assert!(
                err.contains("http") || err.contains("URL"),
                "「{bad}」应在发网前被拒: {err}"
            );
        }
    }

    /// 真网络集成（对照 engine/pi.rs real_pi 风格）。
    /// 本地实跑：cargo test -p wangshu fetch -- --ignored。
    #[ignore = "需真外网；CI 无网会挂，本地用 --ignored 实跑"]
    #[tokio::test]
    async fn real_fetch_example_com_roundtrip() {
        let page = fetch_page("https://example.com".to_string())
            .await
            .expect("example.com 应可抓取");
        assert_eq!(page.title, "Example Domain");
        // 文案两版都含的稳定短语（旧版 illustrative examples / 新版
        // documentation examples），不钉死单版整句
        assert!(
            page.text.contains("This domain"),
            "正文应含页面主句，实得: {}",
            page.text
        );
    }
}
