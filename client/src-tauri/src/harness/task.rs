//! agent 主循环：tool-call loop + 写操作人工审批门。
//! run() 不依赖 Tauri 运行时，审批与状态变化经钩子注入，单测直接驱动。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::oneshot;

use super::llm::{truncate, LlmClient};
use super::mcp::McpClient;
use super::skills::{self, Skill};
use super::state::{ChatMsg, Task, TaskState, ToolCall};
use super::tools;

/// 审批钩子：进入 HOLD 时为本次写操作取一个审批接收端（生产环境把 sender 挂进注册表）。
pub type ApprovalHook = Box<dyn FnMut(u64) -> oneshot::Receiver<bool> + Send>;
/// 状态钩子：每次状态变化/工具动作回调，携带任务快照（state 与累计 tokens；
/// 生产环境更新注册表并向前端 emit）。
pub type StateHook = Box<dyn FnMut(&Task, &str) + Send>;

const SYSTEM_PROMPT: &str = "你是 望舒 工作台的内置 agent，在用户指定的信任目录内完成目标。\
可用工具：read_file / list_dir 读取文件与目录；write_file 写文件（需用户批准后才执行，被拒绝时换思路或如实汇报）；\
web_fetch 抓取网页（http/https URL，返回标题与正文文本，只读免审批，单任务限 10 次，超限后改用已抓内容继续）。\
所有路径必须是信任目录内的相对路径；绝对路径或跳出目录的路径会被拒绝，此时调整路径重试。\
另有 MCP 能力：先调 mcp_list_upstreams 发现可用面板与工具白名单，再按需用 mcp_call 调用（arguments 传 JSON 对象文本）。\
完成后停止调用工具，直接用一段中文总结做了什么、结果如何。";

/// 子任务能力说明，仅 depth=0 注入（子任务不再被告知该能力）。
const SUBTASK_PROMPT: &str = "可用 spawn_subtask 把一个自包含的子目标交给子任务执行：\
子任务在同一信任目录用同一工具集工作（写操作同样需用户批准），其最终总结作为工具结果返回；\
子任务不能再派生子任务。";

/// 派生子任务的步数上限：比主任务紧，防失控递归消耗。
const SUBTASK_MAX_STEPS: u32 = 10;

/// 系统提示 = 基础指令 +（有技能时）技能清单 +（depth=0 时）子任务能力。
/// 清单只列 name — description，正文由模型经 load_skill 按需加载（上下文经济）。
fn system_prompt(skills: &[Skill], depth: u32) -> String {
    let mut prompt = if skills.is_empty() {
        SYSTEM_PROMPT.to_string()
    } else {
        let list: Vec<String> = skills
            .iter()
            .map(|s| format!("- {} — {}", s.name, s.description))
            .collect();
        format!(
            "{SYSTEM_PROMPT}\n可用技能（load_skill 按名加载完整指令）：\n{}",
            list.join("\n")
        )
    };
    if depth == 0 {
        prompt.push('\n');
        prompt.push_str(SUBTASK_PROMPT);
    }
    prompt
}

fn tplus(started: Instant) -> String {
    let s = started.elapsed().as_secs();
    format!("T+{:02}:{:02}", s / 60, s % 60)
}

/// agent 循环。返回终态任务（history 完整）。
/// abort 检查点：每轮开始、模型返回后、每个工具执行前、审批唤醒后；命中即静默返回
/// （Aborted 的注册表落库与事件由命令层负责，避免重复 emit）。
pub async fn run(
    mut task: Task,
    llm: LlmClient,
    mcp: McpClient,
    approval: ApprovalHook,
    on_state: StateHook,
    abort: Arc<AtomicBool>,
) -> Task {
    // 钩子装进 Arc<Mutex> 供 spawn_subtask 递归共享：子任务以捕获 Arc 克隆的
    // 'static 转发闭包复用同一审批通道与日志钩子。不能泛型化钩子参数——递归调用
    // 传入捕获前一层泛型的新闭包会让 monomorphization 无限膨胀（编译期死循环）；
    // Box<dyn> 又装不下借用本地变量的闭包（隐含 'static）。锁只在同步钩子调用内
    // 短持有，从不跨 await，无死锁面。
    let approval_shared = Arc::new(Mutex::new(approval));
    let on_state_shared = Arc::new(Mutex::new(on_state));
    let approval = |task_id: u64| (approval_shared.lock().expect("approval hook lock"))(task_id);
    let on_state = |t: &Task, log: &str| (on_state_shared.lock().expect("state hook lock"))(t, log);

    let started = Instant::now();
    // 任务启动时扫描一次 .skills，结果供整轮 loop 复用（目录不热变的缓存假设）；
    // 跳过的坏文件记 WARN 进飞行日志，不影响任务。
    let skill_report = skills::scan(&task.working_dir);
    task.history.push(ChatMsg::system(&system_prompt(
        &skill_report.skills,
        task.depth,
    )));
    task.history.push(ChatMsg::user(&task.goal));
    task.state = TaskState::Running { step: 0 };
    on_state(
        &task,
        &format!(
            "{} SYS task #{} 启动 · 目标: {}",
            tplus(started),
            task.id,
            truncate(&task.goal, 60)
        ),
    );
    for warning in &skill_report.warnings {
        on_state(
            &task,
            &format!("{} WARN skill 跳过 · {}", tplus(started), warning),
        );
    }

    let mut step: u32 = 0;
    // web_fetch 预算：按本次 run() 计（子任务递归各有独立预算，见 tools::web_fetch）。
    let mut web_fetch_used: u32 = 0;
    loop {
        if abort.load(Ordering::SeqCst) {
            task.state = TaskState::Aborted;
            return task;
        }
        if step >= task.max_steps {
            task.state = TaskState::Failed {
                error: format!("max_steps({}) exceeded", task.max_steps),
            };
            on_state(
                &task,
                &format!(
                    "{} ERR 步数超限 · max_steps={}",
                    tplus(started),
                    task.max_steps
                ),
            );
            return task;
        }
        step += 1;
        task.state = TaskState::Running { step };
        on_state(
            &task,
            &format!("{} RUN step {} · 调用模型", tplus(started), step),
        );

        let (message, usage) = match llm.chat(&task.history).await {
            Ok(res) => res,
            Err(e) => {
                task.state = TaskState::Failed { error: e.clone() };
                on_state(
                    &task,
                    &format!(
                        "{} ERR 模型调用失败 · {}",
                        tplus(started),
                        truncate(&e, 120)
                    ),
                );
                return task;
            }
        };
        if abort.load(Ordering::SeqCst) {
            task.state = TaskState::Aborted;
            return task;
        }
        task.tokens_in += usage.prompt_tokens;
        task.tokens_out += usage.completion_tokens;
        task.history.push(message.clone());

        let calls = message.tool_calls.clone().unwrap_or_default();
        if calls.is_empty() {
            let summary = message.content.clone().unwrap_or_default();
            task.state = TaskState::Done {
                summary: summary.clone(),
            };
            on_state(
                &task,
                &format!("{} SYS 完成 · {}", tplus(started), truncate(&summary, 80)),
            );
            return task;
        }
        for call in &calls {
            if abort.load(Ordering::SeqCst) {
                task.state = TaskState::Aborted;
                return task;
            }
            let parsed =
                match ToolCall::from_function(&call.function.name, &call.function.arguments) {
                    Ok(p) => p,
                    Err(e) => {
                        task.history
                            .push(ChatMsg::tool(&call.id, format!("error: {e}")));
                        on_state(
                            &task,
                            &format!("{} ERR 非法工具调用 · {}", tplus(started), truncate(&e, 80)),
                        );
                        continue;
                    }
                };
            match parsed {
                ToolCall::ReadFile { path } => {
                    let res = tools::read_file(&task.working_dir, &path);
                    let log = match &res {
                        Ok(content) => {
                            format!(
                                "{} TOOL read {} · {} 字符",
                                tplus(started),
                                path,
                                content.chars().count()
                            )
                        }
                        Err(e) => format!(
                            "{} TOOL read {} · 失败 {}",
                            tplus(started),
                            path,
                            truncate(e, 60)
                        ),
                    };
                    let content = res.unwrap_or_else(|e| format!("error: {e}"));
                    task.history.push(ChatMsg::tool(&call.id, content));
                    on_state(&task, &log);
                }
                ToolCall::ListDir { path } => {
                    let res = tools::list_dir(&task.working_dir, &path);
                    let log = match &res {
                        Ok(listing) => {
                            format!(
                                "{} TOOL list {} · {} 项",
                                tplus(started),
                                path,
                                listing.lines().count()
                            )
                        }
                        Err(e) => format!(
                            "{} TOOL list {} · 失败 {}",
                            tplus(started),
                            path,
                            truncate(e, 60)
                        ),
                    };
                    let content = res.unwrap_or_else(|e| format!("error: {e}"));
                    task.history.push(ChatMsg::tool(&call.id, content));
                    on_state(&task, &log);
                }
                ToolCall::LoadSkill { name } => {
                    // 免审批：只读扫描时已校验、且在信任目录内的 SKILL.md。
                    let res = skills::load(&skill_report.skills, &name);
                    let log = match &res {
                        Ok(body) => format!(
                            "{} TOOL skill {} · {} 字符",
                            tplus(started),
                            name,
                            body.chars().count()
                        ),
                        Err(e) => format!(
                            "{} TOOL skill {} · 失败 {}",
                            tplus(started),
                            name,
                            truncate(e, 60)
                        ),
                    };
                    let content = res.unwrap_or_else(|e| format!("error: {e}"));
                    task.history.push(ChatMsg::tool(&call.id, content));
                    on_state(&task, &log);
                }
                ToolCall::McpListUpstreams => {
                    // 免审批：只读发现面；面板治理（禁用/白名单）由 hub 侧裁决。
                    let res = mcp.list_upstreams().await;
                    let log = match &res {
                        Ok(listing) => format!(
                            "{} TOOL mcp_list · {} 项",
                            tplus(started),
                            listing.lines().count()
                        ),
                        Err(e) => format!(
                            "{} TOOL mcp_list · 失败 {}",
                            tplus(started),
                            truncate(e, 60)
                        ),
                    };
                    let content = res.unwrap_or_else(|e| format!("error: {e}"));
                    task.history.push(ChatMsg::tool(&call.id, content));
                    on_state(&task, &log);
                }
                ToolCall::McpCall {
                    upstream,
                    tool,
                    arguments,
                } => {
                    // 免审批：工具白名单治理在 hub 侧，越权调用被 hub 回 JSON-RPC error。
                    let res = mcp.call(&upstream, &tool, &arguments).await;
                    let log = match &res {
                        Ok(out) => format!(
                            "{} TOOL mcp_call {}/{} · {} 字符",
                            tplus(started),
                            upstream,
                            tool,
                            out.chars().count()
                        ),
                        Err(e) => format!(
                            "{} TOOL mcp_call {}/{} · 失败 {}",
                            tplus(started),
                            upstream,
                            tool,
                            truncate(e, 60)
                        ),
                    };
                    let content = res.unwrap_or_else(|e| format!("error: {e}"));
                    task.history.push(ChatMsg::tool(&call.id, content));
                    on_state(&task, &log);
                }
                ToolCall::WebFetch { url } => {
                    // 免审批：只读抓网；预算防打转（超限回错误串自纠，不发网）。
                    let res = tools::web_fetch(&url, &mut web_fetch_used).await;
                    let log = match &res {
                        Ok(text) => format!(
                            "{} TOOL web_fetch {} · {} 字符",
                            tplus(started),
                            truncate(&url, 60),
                            text.chars().count()
                        ),
                        Err(e) => format!(
                            "{} TOOL web_fetch {} · 失败 {}",
                            tplus(started),
                            truncate(&url, 60),
                            truncate(e, 60)
                        ),
                    };
                    let content = res.unwrap_or_else(|e| format!("error: {e}"));
                    task.history.push(ChatMsg::tool(&call.id, content));
                    on_state(&task, &log);
                }
                ToolCall::WriteFile { path, content } => {
                    let preview = tools::write_preview(&task.working_dir, &path, &content);
                    task.state = TaskState::AwaitingApproval {
                        step,
                        tool: ToolCall::WriteFile {
                            path: path.clone(),
                            content: content.clone(),
                        },
                        preview,
                    };
                    on_state(
                        &task,
                        &format!("{} TOOL write {} · 进入 HOLD 待审批", tplus(started), path),
                    );

                    let rx = (approval)(task.id);
                    let approved = rx.await.unwrap_or(false);
                    if abort.load(Ordering::SeqCst) {
                        task.state = TaskState::Aborted;
                        return task;
                    }
                    if approved {
                        let res = tools::write_file_backup(&task.working_dir, &path, &content);
                        let log = match &res {
                            Ok(_) => {
                                format!("{} TOOL write {} · 已批准并执行", tplus(started), path)
                            }
                            Err(e) => format!(
                                "{} TOOL write {} · 执行失败 {}",
                                tplus(started),
                                path,
                                truncate(e, 60)
                            ),
                        };
                        let note = res.unwrap_or_else(|e| format!("error: {e}"));
                        task.history.push(ChatMsg::tool(&call.id, note));
                        task.state = TaskState::Running { step };
                        on_state(&task, &log);
                    } else {
                        task.history.push(ChatMsg::tool(
                            &call.id,
                            "user denied this write".to_string(),
                        ));
                        task.state = TaskState::Running { step };
                        on_state(
                            &task,
                            &format!("{} TOOL write {} · 用户拒绝", tplus(started), path),
                        );
                    }
                }
                ToolCall::SpawnSubtask { goal } => {
                    // 免审批：spawn 是编排动作；子任务内部的写操作仍走同一审批通道。
                    // 深度限 1：子任务再派生直接回错误串，模型自纠，不 spawn。
                    if task.depth >= 1 {
                        task.history.push(ChatMsg::tool(
                            &call.id,
                            "error: 子任务不能再派生子任务，请用现有工具直接完成目标".to_string(),
                        ));
                        on_state(
                            &task,
                            &format!("{} TOOL spawn_subtask · 深度限制拒绝", tplus(started)),
                        );
                    } else {
                        on_state(
                            &task,
                            &format!("{} SUB 开始 · {}", tplus(started), truncate(&goal, 30)),
                        );
                        let sub = Task {
                            // 复用主任务 id：审批钩子与事件都路由到主任务名下
                            // （生产钩子本就按捕获的主 id 注册 pending）。
                            id: task.id,
                            goal: goal.clone(),
                            working_dir: task.working_dir.clone(),
                            history: Vec::new(),
                            state: TaskState::Running { step: 0 },
                            max_steps: SUBTASK_MAX_STEPS,
                            depth: task.depth + 1,
                            tokens_in: 0,
                            tokens_out: 0,
                            // 子任务时刻不单独记：统一任务列按主任务起止呈现。
                            started_ms: task.started_ms,
                            ended_ms: None,
                        };
                        // 子任务活动不进主日志（噪声控制）；仅 HOLD 审批态透传——
                        // 审批卡需展示子任务 write 的 preview，主任务此刻阻塞在
                        // 本工具执行中，单活审批假设仍成立。
                        let sub_approval_shared = Arc::clone(&approval_shared);
                        let sub_on_state_shared = Arc::clone(&on_state_shared);
                        // Box::pin 断开 async fn 递归的无限 future 尺寸；深度限 1，
                        // 每层派生只多一次堆分配。
                        let sub = Box::pin(run(
                            sub,
                            llm.clone(),
                            mcp.clone(),
                            Box::new(move |task_id: u64| {
                                (sub_approval_shared.lock().expect("approval hook lock"))(task_id)
                            }),
                            Box::new(move |t: &Task, log: &str| {
                                if matches!(t.state, TaskState::AwaitingApproval { .. }) {
                                    (sub_on_state_shared.lock().expect("state hook lock"))(t, log)
                                }
                            }),
                            Arc::clone(&abort),
                        ))
                        .await;
                        task.tokens_in += sub.tokens_in;
                        task.tokens_out += sub.tokens_out;
                        let (note, log) = match &sub.state {
                            TaskState::Done { summary } => (
                                summary.clone(),
                                format!("{} SUB 完成 · {}", tplus(started), truncate(summary, 40)),
                            ),
                            TaskState::Failed { error } => (
                                format!("error: subtask failed: {error}"),
                                format!("{} SUB 失败 · {}", tplus(started), truncate(error, 40)),
                            ),
                            TaskState::Aborted => (
                                "error: subtask aborted".to_string(),
                                format!("{} SUB 失败 · 用户中止", tplus(started)),
                            ),
                            // run() 的所有返回路径都是终态；此处不可达。
                            TaskState::Running { .. } | TaskState::AwaitingApproval { .. } => {
                                unreachable!("run 必返回终态")
                            }
                        };
                        task.history.push(ChatMsg::tool(&call.id, note));
                        on_state(&task, &log);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::thread;

    /// 手写 mini HTTP server：逐连接返回脚本化响应，读满 Content-Length 后回 200 并关闭连接。
    fn spawn_llm_server(responses: Vec<String>) -> String {
        spawn_llm_server_capture(responses).0
    }

    /// 同上，但把每个收到的完整请求（含请求行头）留存，供断言发往 LLM 的 messages。
    fn spawn_llm_server_capture(
        responses: Vec<String>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let sink = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let records = std::sync::Arc::clone(&sink);
        thread::spawn(move || {
            for body in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                records.lock().unwrap().push(read_request(&mut stream));
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), sink)
    }

    /// path 分流路由：method+path 首次匹配即消费（同 path 可排多条，按序取用）。
    struct HubRoute {
        method: &'static str,
        path: &'static str,
        body: String,
        consumed: bool,
    }

    /// mini HTTP server 的 path 分流形态：同一端口同时伺服 chat/completions 与
    /// MCP upstreams/proxy，逐连接按 (method, path) 匹配首个未消费路由回 200，
    /// 未匹配回 404。线程持续 accept（测试结束随进程回收），全部请求留存供断言。
    fn spawn_hub_server(
        routes: Vec<HubRoute>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let sink = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let records = std::sync::Arc::clone(&sink);
        let mut routes = routes;
        thread::spawn(move || loop {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
            let req = read_request(&mut stream);
            records.lock().unwrap().push(req.clone());
            let (method, path) = request_line(&req);
            let hit = routes
                .iter()
                .position(|r| !r.consumed && r.method == method && r.path == path);
            let resp = match hit {
                Some(i) => {
                    routes[i].consumed = true;
                    let body = &routes[i].body;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                }
                None => "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"error\":\"no route\"}".to_string(),
            };
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        });
        (format!("http://{addr}"), sink)
    }

    /// 读完一个 HTTP 请求（请求行+头+Content-Length 的 body）为原始文本；
    /// 断连/超时返回已读部分。
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let complete =
                find_body_start(&buf).is_some_and(|h| buf.len() >= h + content_length(&buf));
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

    /// 请求行 `POST /x?q=1 HTTP/1.1` → ("POST", "/x")；畸形行回空串。
    fn request_line(req: &str) -> (&str, &str) {
        let mut parts = req.lines().next().unwrap_or("").split(' ');
        let method = parts.next().unwrap_or("");
        let path = parts.next().unwrap_or("").split('?').next().unwrap_or("");
        (method, path)
    }

    /// 捕获的原始 HTTP 请求 → JSON body。
    fn request_json(req: &str) -> serde_json::Value {
        let body = req.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
        serde_json::from_str(body).unwrap()
    }

    fn find_body_start(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
    }

    fn content_length(buf: &[u8]) -> usize {
        let head = String::from_utf8_lossy(buf);
        for line in head.split("\r\n") {
            if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                return v.trim().parse().unwrap_or(0);
            }
        }
        0
    }

    fn text_response(content: &str) -> String {
        serde_json::json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string()
    }

    fn tool_response(id: &str, name: &str, args: serde_json::Value) -> String {
        serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{ "id": id, "type": "function", "function": { "name": name, "arguments": args.to_string() } }]
                }
            }]
        })
        .to_string()
    }

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cp-harness-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在 `{dir}/.skills/{slug}/SKILL.md` 写一个技能文件。
    fn make_skill(dir: &Path, slug: &str, content: &str) {
        let sdir = dir.join(".skills").join(slug);
        fs::create_dir_all(&sdir).unwrap();
        fs::write(sdir.join("SKILL.md"), content).unwrap();
    }

    fn new_task(id: u64, dir: &Path, max_steps: u32) -> Task {
        Task {
            id,
            goal: "整理工作目录".into(),
            working_dir: dir.to_path_buf(),
            history: Vec::new(),
            state: TaskState::Running { step: 0 },
            max_steps,
            depth: 0,
            tokens_in: 0,
            tokens_out: 0,
            started_ms: 0,
            ended_ms: None,
        }
    }

    fn test_llm(base: String) -> LlmClient {
        LlmClient::new(base, "test-token".into(), "test-model".into())
    }

    /// 不触发 MCP 调用的用例兜底：地址指向不可达端口，误调用会快速失败回错误串。
    fn unused_mcp() -> McpClient {
        McpClient::new("http://127.0.0.1:9".into(), "test-token".into())
    }

    /// 不应触达审批的用例兜底：sender 立即丢弃 → loop 视为拒绝，测试不挂死。
    fn deny_approval() -> ApprovalHook {
        Box::new(|_| {
            let (tx, rx) = oneshot::channel();
            drop(tx);
            rx
        })
    }

    type EventRecord = (String, String, u64, u64);

    fn record_events() -> (
        StateHook,
        std::sync::Arc<std::sync::Mutex<Vec<EventRecord>>>,
    ) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&seen);
        (
            Box::new(move |task: &Task, log: &str| {
                sink.lock().unwrap().push((
                    serde_json::to_string(&task.state).unwrap(),
                    log.to_string(),
                    task.tokens_in,
                    task.tokens_out,
                ));
            }),
            seen,
        )
    }

    fn abort_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    fn tool_messages(task: &Task) -> Vec<&ChatMsg> {
        task.history.iter().filter(|m| m.role == "tool").collect()
    }

    #[tokio::test]
    async fn plain_reply_completes_in_one_round() {
        let dir = test_dir("plain");
        let base = spawn_llm_server(vec![text_response("已确认目标，无需改动。")]);
        let task = run(
            new_task(1, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        match &task.state {
            TaskState::Done { summary } => assert_eq!(summary, "已确认目标，无需改动。"),
            other => panic!("expected Done, got {other:?}"),
        }
        assert_eq!(task.history.len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_file_feeds_tool_message_into_history() {
        let dir = test_dir("read");
        fs::write(dir.join("a.txt"), "ROADMAP-CONTENT-42").unwrap();
        let base = spawn_llm_server(vec![
            tool_response(
                "call-1",
                "read_file",
                serde_json::json!({ "path": "a.txt" }),
            ),
            text_response("已读取 roadmap。"),
        ]);
        let task = run(
            new_task(2, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(tools[0].content.as_deref(), Some("ROADMAP-CONTENT-42"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn write_approval_granted_writes_and_backs_up() {
        let dir = test_dir("write-approve");
        fs::write(dir.join("old.txt"), "OLD").unwrap();
        let base = spawn_llm_server(vec![
            tool_response(
                "call-1",
                "write_file",
                serde_json::json!({ "path": "old.txt", "content": "NEW" }),
            ),
            text_response("写入完成。"),
        ]);
        let approval: ApprovalHook = Box::new(|_| {
            let (tx, rx) = oneshot::channel();
            tx.send(true).unwrap();
            rx
        });
        let task = run(
            new_task(3, &dir, 20),
            test_llm(base),
            unused_mcp(),
            approval,
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        assert_eq!(fs::read_to_string(dir.join("old.txt")).unwrap(), "NEW");
        assert_eq!(fs::read_to_string(dir.join("old.txt.bak")).unwrap(), "OLD");
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert!(tools[0].content.as_deref().unwrap().contains("wrote"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn write_denied_reports_denial_and_skips_file() {
        let dir = test_dir("write-deny");
        let base = spawn_llm_server(vec![
            tool_response(
                "call-1",
                "write_file",
                serde_json::json!({ "path": "fresh.txt", "content": "SHOULD-NOT-EXIST" }),
            ),
            text_response("用户拒绝，改为汇报。"),
        ]);
        let approval: ApprovalHook = Box::new(|_| {
            let (tx, rx) = oneshot::channel();
            tx.send(false).unwrap();
            rx
        });
        let task = run(
            new_task(4, &dir, 20),
            test_llm(base),
            unused_mcp(),
            approval,
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        assert!(!dir.join("fresh.txt").exists());
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].content.as_deref(), Some("user denied this write"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn escaping_paths_return_tool_errors() {
        let dir = test_dir("escape");
        fs::write(dir.join("a.txt"), "X").unwrap();
        let base = spawn_llm_server(vec![
            tool_response(
                "c1",
                "read_file",
                serde_json::json!({ "path": "../../etc/passwd" }),
            ),
            tool_response(
                "c2",
                "read_file",
                serde_json::json!({ "path": "C:\\Windows\\win.ini" }),
            ),
            tool_response("c3", "list_dir", serde_json::json!({ "path": ".." })),
            text_response("了解边界了。"),
        ]);
        let task = run(
            new_task(5, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 3);
        for msg in &tools {
            let content = msg.content.as_deref().unwrap();
            assert!(
                content.contains("escapes"),
                "expected escape error, got: {content}"
            );
            assert!(
                content.starts_with("error:"),
                "expected tool error format, got: {content}"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn max_steps_exhaustion_fails_the_task() {
        let dir = test_dir("max-steps");
        fs::write(dir.join("a.txt"), "X").unwrap();
        let scripted: Vec<String> = (0..8)
            .map(|_| {
                tool_response(
                    "call-x",
                    "read_file",
                    serde_json::json!({ "path": "a.txt" }),
                )
            })
            .collect();
        let base = spawn_llm_server(scripted);
        let task = run(
            new_task(6, &dir, 2),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        match &task.state {
            TaskState::Failed { error } => {
                assert!(error.contains("max_steps"), "unexpected error: {error}")
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        assert_eq!(task.history.len(), 6);
        let _ = fs::remove_dir_all(&dir);
    }

    fn read_response_with_usage(usage: serde_json::Value) -> String {
        let arguments = serde_json::json!({ "path": "a.txt" }).to_string();
        serde_json::json!({
            "usage": usage,
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{ "id": "call-1", "type": "function",
                        "function": { "name": "read_file", "arguments": arguments } }]
                }
            }]
        })
        .to_string()
    }

    #[tokio::test]
    async fn usage_accumulates_across_rounds_into_events_and_task() {
        let dir = test_dir("usage");
        fs::write(dir.join("a.txt"), "X").unwrap();
        let done = serde_json::json!({
            "usage": { "prompt_tokens": 50, "completion_tokens": 10 },
            "choices": [{ "message": { "role": "assistant", "content": "完成。" } }]
        })
        .to_string();
        let base = spawn_llm_server(vec![
            read_response_with_usage(serde_json::json!({
                "prompt_tokens": 100,
                "completion_tokens": 20
            })),
            read_response_with_usage(serde_json::Value::Null),
            done,
        ]);
        let (events, seen) = record_events();
        let task = run(
            new_task(8, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            events,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        assert_eq!((task.tokens_in, task.tokens_out), (150, 30));
        let records = seen.lock().unwrap().clone();
        assert_eq!(records[0].2, 0, "startup event carries zero usage");
        let tool_reads: Vec<&EventRecord> = records
            .iter()
            .filter(|(_, log, _, _)| log.contains("TOOL read"))
            .collect();
        assert_eq!(tool_reads.len(), 2);
        assert_eq!((tool_reads[0].2, tool_reads[0].3), (100, 20));
        assert_eq!(
            (tool_reads[1].2, tool_reads[1].3),
            (100, 20),
            "null usage must not reset counters"
        );
        let done_rec = records
            .iter()
            .find(|(state, _, _, _)| state.contains("\"done\""))
            .expect("done event recorded");
        assert_eq!((done_rec.2, done_rec.3), (150, 30));
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn abort_during_hold_wakes_and_aborts() {
        let dir = test_dir("abort");
        let base = spawn_llm_server(vec![tool_response(
            "call-1",
            "write_file",
            serde_json::json!({ "path": "a.txt", "content": "X" }),
        )]);
        let abort = abort_flag();
        let flag = Arc::clone(&abort);
        let approval: ApprovalHook = Box::new(move |_| {
            flag.store(true, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel();
            let _ = tx.send(false);
            rx
        });
        let (events, seen) = record_events();
        let task = run(
            new_task(7, &dir, 20),
            test_llm(base),
            unused_mcp(),
            approval,
            events,
            abort,
        )
        .await;
        assert!(matches!(task.state, TaskState::Aborted));
        assert!(!dir.join("a.txt").exists());
        assert_eq!(task.history.len(), 3);
        let states: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(s, _, _, _)| s.clone())
            .collect();
        assert!(
            states.iter().any(|s| s.contains("awaiting_approval")),
            "states: {states:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn skill_list_injected_into_prompt_and_bad_skill_warns() {
        let dir = test_dir("skills-inject");
        make_skill(
            &dir,
            "good",
            "---\nname: good-skill\ndescription: 演示用技能\n---\n\n这是技能正文。",
        );
        make_skill(&dir, "bad", "---\nname: bad-skill\n---\n缺 description。");
        let (base, requests) = spawn_llm_server_capture(vec![
            tool_response(
                "call-1",
                "load_skill",
                serde_json::json!({ "name": "good-skill" }),
            ),
            text_response("技能已加载。"),
        ]);
        let (events, seen) = record_events();
        let task = run(
            new_task(9, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            events,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));

        let requests = requests.lock().unwrap().clone();
        let system = request_json(&requests[0])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            system.contains("可用技能（load_skill 按名加载完整指令）"),
            "system: {system}"
        );
        assert!(system.contains("- good-skill — 演示用技能"));
        assert!(!system.contains("bad-skill"), "坏技能不得进清单: {system}");

        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].content.as_deref(), Some("这是技能正文。"));

        let logs: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(_, log, _, _)| log.clone())
            .collect();
        assert!(
            logs.iter().any(|l| l.contains("WARN") && l.contains("bad")),
            "logs: {logs:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn load_skill_unknown_name_returns_error_string_for_self_correction() {
        let dir = test_dir("skills-unknown");
        make_skill(
            &dir,
            "s",
            "---\nname: good-skill\ndescription: 演示\n---\n正文",
        );
        let base = spawn_llm_server(vec![
            tool_response("c1", "load_skill", serde_json::json!({ "name": "nope" })),
            text_response("没有该技能，如实汇报。"),
        ]);
        let task = run(
            new_task(10, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let content = tools[0].content.as_deref().unwrap();
        assert!(content.starts_with("error:"), "content: {content}");
        assert!(
            content.contains("unknown skill 'nope'"),
            "content: {content}"
        );
        assert!(content.contains("good-skill"), "应附可用清单: {content}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn no_skills_leaves_system_prompt_without_list() {
        let dir = test_dir("skills-none");
        let (base, requests) = spawn_llm_server_capture(vec![text_response("完成。")]);
        let task = run(
            new_task(11, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let requests = requests.lock().unwrap().clone();
        let system = request_json(&requests[0])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            system.contains("望舒"),
            "基础提示应保留: {system}"
        );
        assert!(!system.contains("可用技能"), "无技能不得注入清单: {system}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// mcp 面板发现进系统提示（只说明能力存在，不预拉面板清单）。
    #[tokio::test]
    async fn system_prompt_mentions_mcp_capability_without_prewarming() {
        let dir = test_dir("mcp-prompt");
        let (base, requests) = spawn_llm_server_capture(vec![text_response("完成。")]);
        let task = run(
            new_task(12, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let requests = requests.lock().unwrap().clone();
        let system = request_json(&requests[0])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            system.contains("mcp_list_upstreams"),
            "应说明 MCP 发现入口: {system}"
        );
        assert!(!system.contains("（工具:"), "不得预拉面板清单: {system}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mcp_list_upstreams_formats_panels_into_tool_message() {
        let dir = test_dir("mcp-list");
        let upstreams = serde_json::json!({
            "upstreams": [
                { "name": "demo", "base_url": "http://x", "has_token": true, "enabled": true, "allowed_tools": ["search", "fetch"] },
                { "name": "wiki", "base_url": "http://y", "has_token": false, "enabled": true, "allowed_tools": [] },
                { "name": "off", "base_url": "http://z", "has_token": false, "enabled": false, "allowed_tools": [] }
            ]
        })
        .to_string();
        let (base, requests) = spawn_hub_server(vec![
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: tool_response("c1", "mcp_list_upstreams", serde_json::json!({})),
                consumed: false,
            },
            HubRoute {
                method: "GET",
                path: "/api/v1/mcp/upstreams",
                body: upstreams,
                consumed: false,
            },
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: text_response("面板已知。"),
                consumed: false,
            },
        ]);
        let task = run(
            new_task(13, &dir, 20),
            test_llm(base.clone()),
            McpClient::new(base, "test-token".into()),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let content = tools[0].content.as_deref().unwrap();
        assert!(
            content.contains("demo（工具: search, fetch）"),
            "content: {content}"
        );
        assert!(content.contains("wiki（工具: 全部）"), "content: {content}");
        assert!(!content.contains("off"), "禁用面板不应出现: {content}");

        let requests = requests.lock().unwrap().clone();
        let get = requests
            .iter()
            .find(|r| r.starts_with("GET /api/v1/mcp/upstreams"))
            .expect("upstreams GET recorded");
        assert!(
            get.to_ascii_lowercase()
                .contains("authorization: bearer test-token"),
            "get: {get}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mcp_call_posts_jsonrpc_and_returns_result_text() {
        let dir = test_dir("mcp-call");
        let result = serde_json::json!({
            "jsonrpc": "2.0", "id": 1,
            "result": { "content": [{ "type": "text", "text": "hit-42" }] }
        })
        .to_string();
        let (base, requests) = spawn_hub_server(vec![
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: tool_response(
                    "c1",
                    "mcp_call",
                    serde_json::json!({ "upstream": "demo", "tool": "search", "arguments": "{\"q\":\"hello\"}" }),
                ),
                consumed: false,
            },
            HubRoute {
                method: "POST",
                path: "/api/v1/mcp/demo/proxy",
                body: result,
                consumed: false,
            },
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: text_response("调用完成。"),
                consumed: false,
            },
        ]);
        let task = run(
            new_task(14, &dir, 20),
            test_llm(base.clone()),
            McpClient::new(base, "test-token".into()),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let got: serde_json::Value =
            serde_json::from_str(tools[0].content.as_deref().unwrap()).unwrap();
        assert_eq!(
            got,
            serde_json::json!({ "content": [{ "type": "text", "text": "hit-42" }] })
        );

        let requests = requests.lock().unwrap().clone();
        let proxy = requests
            .iter()
            .find(|r| r.starts_with("POST /api/v1/mcp/demo/proxy"))
            .expect("proxy request recorded");
        assert!(
            proxy
                .to_ascii_lowercase()
                .contains("authorization: bearer test-token"),
            "proxy: {proxy}"
        );
        let body = request_json(proxy);
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["method"], "tools/call");
        assert_eq!(body["id"], 1, "首个 JSON-RPC id 应为 1");
        assert_eq!(body["params"]["name"], "search");
        assert_eq!(body["params"]["arguments"]["q"], "hello");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mcp_call_denial_error_object_reaches_history() {
        let dir = test_dir("mcp-deny");
        let denied = serde_json::json!({
            "jsonrpc": "2.0", "id": 1,
            "error": { "code": -32603, "message": "tool not allowed: secret_tool" }
        })
        .to_string();
        let (base, _requests) = spawn_hub_server(vec![
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: tool_response(
                    "c1",
                    "mcp_call",
                    serde_json::json!({ "upstream": "demo", "tool": "secret_tool", "arguments": "{}" }),
                ),
                consumed: false,
            },
            HubRoute {
                method: "POST",
                path: "/api/v1/mcp/demo/proxy",
                body: denied,
                consumed: false,
            },
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: text_response("被治理拒绝，如实汇报。"),
                consumed: false,
            },
        ]);
        let task = run(
            new_task(15, &dir, 20),
            test_llm(base.clone()),
            McpClient::new(base, "test-token".into()),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let got: serde_json::Value =
            serde_json::from_str(tools[0].content.as_deref().unwrap()).unwrap();
        assert_eq!(got["code"], -32603);
        assert_eq!(got["message"], "tool not allowed: secret_tool");
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn mcp_call_bad_arguments_json_returns_error_string_without_request() {
        let dir = test_dir("mcp-badargs");
        let (base, requests) = spawn_hub_server(vec![
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: tool_response(
                    "c1",
                    "mcp_call",
                    serde_json::json!({ "upstream": "demo", "tool": "search", "arguments": "not json" }),
                ),
                consumed: false,
            },
            HubRoute {
                method: "POST",
                path: "/api/v1/chat/completions",
                body: text_response("参数写错，重试。"),
                consumed: false,
            },
        ]);
        let task = run(
            new_task(16, &dir, 20),
            test_llm(base.clone()),
            McpClient::new(base, "test-token".into()),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let content = tools[0].content.as_deref().unwrap();
        assert!(content.starts_with("error:"), "content: {content}");
        assert!(
            content.contains("invalid arguments JSON"),
            "content: {content}"
        );
        let requests = requests.lock().unwrap().clone();
        assert!(
            !requests.iter().any(|r| r.contains("/proxy")),
            "坏 JSON 不得发出 proxy 请求: {requests:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 终态写库管线（R2.2-3）：mock 一轮 done 任务 → history_record 出记录 → 落 DB 可列出。
    #[tokio::test]
    async fn finished_task_persists_history_record() {
        let dir = test_dir("history");
        let base = spawn_llm_server(vec![text_response("已整理完毕。")]);
        let task = run(
            new_task(21, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        let record = crate::harness::history_record(&task, 1_000).expect("终态必有记录");
        assert_eq!(record.id, "h21");
        assert_eq!(record.source, "harness");
        assert_eq!(record.status, "done");
        assert_eq!(record.detail, "已整理完毕。");
        assert_eq!(record.title, "整理工作目录");
        assert!(record.finished_at >= record.created_at);

        let mut long = task.clone();
        long.goal = "长".repeat(50);
        let long_record = crate::harness::history_record(&long, 1_000).unwrap();
        assert_eq!(
            long_record.title.chars().count(),
            41,
            "标题截 40 字 + 省略号"
        );

        let db_path = std::env::temp_dir().join(format!("cp-tasksdb-{}.db", std::process::id()));
        let _ = fs::remove_file(&db_path);
        let conn = crate::tasksdb::open(&db_path).unwrap();
        crate::tasksdb::save_finished(&conn, &record).unwrap();
        let rows = crate::tasksdb::list_recent(&conn, 50).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "h21");
        assert_eq!(rows[0].status, "done");
        assert_eq!(rows[0].detail, "已整理完毕。");
        drop(conn);
        let _ = fs::remove_file(&db_path);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 非终态不出记录（防御分支：run 返回必为终态，直接构造 Running 验证）。
    #[test]
    fn running_task_yields_no_history_record() {
        let task = new_task(22, Path::new("."), 20);
        assert!(crate::harness::history_record(&task, 0).is_none());
    }

    fn logs_of(seen: &std::sync::Arc<std::sync::Mutex<Vec<EventRecord>>>) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .map(|(_, l, _, _)| l.clone())
            .collect()
    }

    /// web_fetch 工具在环内：坏 scheme 在发网前被拒，错误串回进 history 供自纠
    /// （复用 fetch.rs 的拒绝形态，全程无网络）。系统提示的工具清单含 web_fetch。
    #[tokio::test]
    async fn web_fetch_bad_scheme_returns_tool_error_and_prompt_lists_it() {
        let dir = test_dir("web-fetch");
        let (base, requests) = spawn_llm_server_capture(vec![
            tool_response(
                "c1",
                "web_fetch",
                serde_json::json!({ "url": "file:///C:/Windows/win.ini" }),
            ),
            text_response("链接不行，如实汇报。"),
        ]);
        let task = run(
            new_task(35, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            record_events().0,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let content = tools[0].content.as_deref().unwrap();
        assert!(content.starts_with("error:"), "content: {content}");
        assert!(content.contains("http/https"), "应在发网前被拒: {content}");

        let requests = requests.lock().unwrap().clone();
        let system = request_json(&requests[0])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(system.contains("web_fetch"), "工具清单应含 web_fetch: {system}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 子任务全链：主 spawn → 子纯文本收尾 → 子 summary 成为主任务的工具结果，
    /// 主终态 Done；飞行日志有 SUB 开始/完成两行，子任务内部活动不透传。
    #[tokio::test]
    async fn subtask_summary_becomes_tool_result_and_completes_main() {
        let dir = test_dir("sub-ok");
        let (base, requests) = spawn_llm_server_capture(vec![
            tool_response(
                "c1",
                "spawn_subtask",
                serde_json::json!({ "goal": "清点目录文件" }),
            ),
            text_response("子任务已清点 3 个文件。"),
            text_response("主任务汇总完成。"),
        ]);
        let (events, seen) = record_events();
        let task = run(
            new_task(31, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            events,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(tools[0].content.as_deref(), Some("子任务已清点 3 个文件。"));

        let logs = logs_of(&seen);
        assert!(
            logs.iter()
                .any(|l| l.contains("SUB 开始") && l.contains("清点目录文件")),
            "logs: {logs:?}"
        );
        assert!(
            logs.iter()
                .any(|l| l.contains("SUB 完成") && l.contains("子任务已清点")),
            "logs: {logs:?}"
        );
        assert_eq!(
            logs.iter().filter(|l| l.contains("SYS task #")).count(),
            1,
            "子任务启动日志不得透传: {logs:?}"
        );
        assert_eq!(
            logs.iter().filter(|l| l.contains("RUN step")).count(),
            2,
            "子任务步进日志不得透传: {logs:?}"
        );

        let requests = requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 3, "主 2 次 + 子 1 次，不得多调");
        let sub_system = request_json(&requests[1])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            sub_system.contains("望舒"),
            "子任务应有基础系统提示: {sub_system}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 子任务失败：子的唯一一次模型调用拿到坏响应 → 子 Failed → 主任务工具结果
    /// 是 error: subtask 串（可读可自纠），主任务自身仍可 Done。
    #[tokio::test]
    async fn subtask_failure_surfaces_error_string_to_main() {
        let dir = test_dir("sub-fail");
        let base = spawn_llm_server(vec![
            tool_response(
                "c1",
                "spawn_subtask",
                serde_json::json!({ "goal": "子目标" }),
            ),
            "not-json".to_string(),
            text_response("主任务读到子任务失败，接手完成。"),
        ]);
        let (events, seen) = record_events();
        let task = run(
            new_task(32, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            events,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        let content = tools[0].content.as_deref().unwrap();
        assert!(
            content.starts_with("error: subtask failed:"),
            "content: {content}"
        );
        assert!(
            content.contains("invalid response JSON"),
            "应携带子任务失败原因: {content}"
        );
        let logs = logs_of(&seen);
        assert!(
            logs.iter().any(|l| l.contains("SUB 失败")),
            "logs: {logs:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// 深度限制：子任务内再调 spawn_subtask → 收到错误串、不递归（无孙任务的
    /// LLM 请求）；子任务的系统提示不注入子任务能力说明。
    #[tokio::test]
    async fn subtask_cannot_spawn_grandsubtask() {
        let dir = test_dir("sub-depth");
        let (base, requests) = spawn_llm_server_capture(vec![
            tool_response(
                "c1",
                "spawn_subtask",
                serde_json::json!({ "goal": "第一层子目标" }),
            ),
            tool_response(
                "s1",
                "spawn_subtask",
                serde_json::json!({ "goal": "第二层子目标" }),
            ),
            text_response("子任务收到不能派生的提示，直接完成。"),
            text_response("主任务完成。"),
        ]);
        let (events, _seen) = record_events();
        let task = run(
            new_task(33, &dir, 20),
            test_llm(base),
            unused_mcp(),
            deny_approval(),
            events,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].content.as_deref(),
            Some("子任务收到不能派生的提示，直接完成。")
        );

        let requests = requests.lock().unwrap().clone();
        assert_eq!(
            requests.len(),
            4,
            "主 2 次 + 子 2 次，孙任务不得产生任何请求: {requests:?}"
        );
        let main_system = request_json(&requests[0])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            main_system.contains("spawn_subtask"),
            "主任务提示应说明子任务能力: {main_system}"
        );
        let sub_system = request_json(&requests[1])["messages"][0]["content"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            !sub_system.contains("spawn_subtask"),
            "子任务提示不得说明子任务能力: {sub_system}"
        );
        let sub_second = request_json(&requests[2]);
        let refused = sub_second["messages"].as_array().unwrap().iter().any(|m| {
            m["role"] == "tool"
                && m["content"]
                    .as_str()
                    .unwrap_or("")
                    .contains("子任务不能再派生子任务")
        });
        assert!(refused, "错误串必须回进子任务 history 供自纠: {sub_second}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 子任务审批穿透：子任务 write → HOLD 事件（带子的 preview）出现在主任务
    /// 事件流、审批钩子以主任务 id 被调用 → 批准 → 子写盘并备份 → 主 Done。
    #[tokio::test]
    async fn subtask_write_holds_on_main_approval_channel() {
        let dir = test_dir("sub-hold");
        fs::write(dir.join("sub.txt"), "OLD").unwrap();
        let base = spawn_llm_server(vec![
            tool_response(
                "c1",
                "spawn_subtask",
                serde_json::json!({ "goal": "改写 sub.txt" }),
            ),
            tool_response(
                "s1",
                "write_file",
                serde_json::json!({ "path": "sub.txt", "content": "FROM-SUB" }),
            ),
            text_response("子任务写入完成。"),
            text_response("主任务完成。"),
        ]);
        let held = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
        let held_sink = std::sync::Arc::clone(&held);
        let approval: ApprovalHook = Box::new(move |task_id: u64| {
            held_sink.lock().unwrap().push(task_id);
            let (tx, rx) = oneshot::channel();
            tx.send(true).unwrap();
            rx
        });
        let (events, seen) = record_events();
        let task = run(
            new_task(34, &dir, 20),
            test_llm(base),
            unused_mcp(),
            approval,
            events,
            abort_flag(),
        )
        .await;
        assert!(matches!(task.state, TaskState::Done { .. }));

        let records = seen.lock().unwrap().clone();
        let hold = records
            .iter()
            .find(|(s, _, _, _)| s.contains("awaiting_approval"))
            .expect("HOLD 事件应出现在主任务事件流");
        assert!(
            hold.0.contains("sub.txt"),
            "HOLD 状态应携带子任务 write 的 tool/preview: {}",
            hold.0
        );
        assert!(
            hold.1.contains("sub.txt") && hold.1.contains("HOLD"),
            "HOLD 日志应指明子任务写目标: {}",
            hold.1
        );
        let logs = logs_of(&seen);
        assert_eq!(
            logs.iter().filter(|l| l.contains("SYS task #")).count(),
            1,
            "子任务启动日志不得透传: {logs:?}"
        );
        assert_eq!(
            held.lock().unwrap().clone(),
            vec![34],
            "审批钩子应以主任务 id 被调用"
        );
        assert_eq!(fs::read_to_string(dir.join("sub.txt")).unwrap(), "FROM-SUB");
        assert_eq!(fs::read_to_string(dir.join("sub.txt.bak")).unwrap(), "OLD");
        let tools = tool_messages(&task);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].content.as_deref(), Some("子任务写入完成。"));
        let _ = fs::remove_dir_all(&dir);
    }
}
