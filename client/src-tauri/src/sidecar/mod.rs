//! P2 编码引擎 sidecar：DSH/PI 外部编码 agent 的子进程生命周期 + 输出流转发。
//! MVP 契约：`sidecar://output` {id, engine, stream: "out"|"err", line}、
//! `sidecar://exit` {id, engine, code}。不做引擎协议适配。
//! spawn 前三项校验（engine / 可执行 / cwd）全部先行，进程表与 harness
//! CONTROLS 同型管理：短临界区，IO 一律锁外。
//! 环境区 v2：npm 引擎一键安装 + Node 私有目录代装，进度走 `env://line`。

pub mod state;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};

use state::{Engine, ProcHandle};

pub const EVENT_OUTPUT: &str = "sidecar://output";
pub const EVENT_EXIT: &str = "sidecar://exit";
pub const EVENT_ENV_LINE: &str = "env://line";

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Node 发行版三常量（供应链校验钉死；升级 Node 改这三处）。包名与 URL 不接受
// 任何用户输入，是 v2 安全边界。
const NODE_VER: &str = "v24.21.0";
const NODE_ZIP_URL: &str = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip";
const NODE_ZIP_SHA256: &str = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541";

/// 安装输出尾部行数上限：InstallOutcome.output 只留末尾若干行防超长。
const TAIL_LINES: usize = 20;
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const NODE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const NODE_EXTRACT_TIMEOUT: Duration = Duration::from_secs(120);

/// env://line 载荷。键名 target/line 是前端契约（设计文档 v2），勿改。
#[derive(Serialize, Clone)]
struct LineEvt {
    target: String,
    line: String,
}

/// 一键安装结果：output 为安装日志尾部（TAIL_LINES 截断）。
#[derive(Debug, Clone, Serialize)]
pub struct InstallOutcome {
    pub ok: bool,
    pub output: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub available: bool,
    pub path: Option<String>,
    pub version_hint: Option<String>,
}

/// env_check 聚合条目。JSON 键钉死 snake_case（engine / probe.available /
/// probe.path / probe.version_hint），是前端契约，勿改成 camelCase。
#[derive(Debug, Clone, Serialize)]
pub struct EngineEnv {
    pub engine: String,
    pub probe: ProbeResult,
}

/// 探测单个可执行（引擎名或 npm）：私有目录前缀 + PATH 上找同名可执行并跑
/// `--version` 取首行作版本提示。可执行缺失 → available=false（不报错，设置页
/// 按缺失渲染安装指引）。
async fn probe_one(name: &str, extra_dirs: &[PathBuf]) -> ProbeResult {
    let Some(exe) = state::resolve_with_extra(name, extra_dirs) else {
        return ProbeResult {
            available: false,
            path: None,
            version_hint: None,
        };
    };
    let mut command = build_command(&exe, &["--version".to_string()]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    // 版本信息有 CLI 落 stderr 的习惯，stdout 拿不到时退回 stderr 首个非空行
    let version_hint = match command.output().await {
        Ok(out) => first_nonempty_line(&out.stdout).or_else(|| first_nonempty_line(&out.stderr)),
        Err(_) => None,
    };
    ProbeResult {
        available: true,
        path: Some(exe.display().to_string()),
        version_hint,
    }
}

/// 应用私有 node bin 目录（app_data/node/bin）：目录可能尚不存在，仅作解析
/// 前缀；app_data 不可得时退化为 PATH-only（环境检测不因此整体失败）。
fn node_bin_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|d| vec![d.join("node").join("bin")])
        .unwrap_or_default()
}

/// 环境检测聚合（引擎 + npm），与 env_check 命令体分离以可无 AppHandle 单测。
async fn env_report(extra_dirs: &[PathBuf]) -> Vec<EngineEnv> {
    let mut report = Vec::new();
    for engine in Engine::all() {
        report.push(EngineEnv {
            engine: engine.as_str().to_string(),
            probe: probe_one(engine.as_str(), extra_dirs).await,
        });
    }
    // npm 不进 Engine 枚举（它不是编码引擎）：单条追加，供前端渲染 Node 状态
    report.push(EngineEnv {
        engine: "npm".to_string(),
        probe: probe_one("npm", extra_dirs).await,
    });
    report
}

/// 环境检测：设置页「环境」区一次拉取。npm 条目见 env_report。
#[tauri::command]
pub async fn env_check(app: tauri::AppHandle) -> Result<Vec<EngineEnv>, String> {
    Ok(env_report(&node_bin_dirs(&app)).await)
}

/// spawn 前校验：engine → cwd → 可执行。cwd 先于可执行检查，使缺 cwd 的
/// 报错不依赖引擎是否安装。extra_dirs 为应用私有 node bin 解析前缀。
fn prepare(
    engine: &str,
    cwd: &str,
    extra_dirs: &[PathBuf],
) -> Result<(Engine, PathBuf, PathBuf), String> {
    let engine = Engine::parse(engine)?;
    let cwd = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|e| format!("cwd 不可访问: {cwd} ({e})"))?;
    let exe = state::resolve_with_extra(engine.as_str(), extra_dirs).ok_or_else(|| {
        format!(
            "引擎 '{}' 未安装（设置 → 环境可查看或一键安装）",
            engine.as_str()
        )
    })?;
    Ok((engine, exe, cwd))
}

/// 启动引擎子进程，立即返回进程 id。stdout/stderr 逐行转事件，退出时发
/// `sidecar://exit` 并摘表。
// Retired from the JS surface (2026-11-09): both engines now go through
// the engine module; kept for internal helpers reused by engine/.
#[allow(dead_code)]
#[tauri::command]
pub async fn sidecar_run(
    engine: String,
    cwd: String,
    args: Vec<String>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let (engine, exe, cwd) = prepare(&engine, &cwd, &node_bin_dirs(&app))?;
    let mut command = build_command(&exe, &args);
    command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {e}", engine.as_str()))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let id = state::next_proc_id();
    let handle = Arc::new(ProcHandle::new(pid, child, stdin));
    state::insert_proc(id, Arc::clone(&handle));

    tauri::async_runtime::spawn(pump(id, engine, handle, stdout, stderr, app));
    Ok(id)
}

/// 停止进程（Windows 连子树一起收，见 ProcHandle::kill）。
// Retired from the JS surface (2026-11-09): both engines now go through
// the engine module; kept for internal helpers reused by engine/.
#[allow(dead_code)]
#[tauri::command]
pub async fn sidecar_stop(id: u64) -> Result<(), String> {
    let handle = state::get_proc(id).ok_or("进程不存在或已结束")?;
    handle.kill().await
}

/// 向运行中的进程写一行 stdin（行 + \n，供交互式 CLI）。
// Retired from the JS surface (2026-11-09): both engines now go through
// the engine module; kept for internal helpers reused by engine/.
#[allow(dead_code)]
#[tauri::command]
pub async fn sidecar_write(id: u64, line: String) -> Result<(), String> {
    let handle = state::get_proc(id).ok_or("进程不存在或已结束")?;
    let mut stdin = handle.stdin.lock().await;
    let writer = stdin.as_mut().ok_or("进程 stdin 已关闭")?;
    let line = line.trim_end_matches(['\r', '\n']);
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("stdin 写入失败: {e}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|e| format!("stdin 写入失败: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("stdin 刷新失败: {e}"))
}

// ---- 环境区 v2：一键安装（引擎 npm 包 + Node 私有目录代装）----

/// 全局安装互斥：Node 代装会重建 npm 所在目录，与引擎 npm install 并发互相
/// 踩；同一时刻只放行一个安装动作。
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// CAS 进入安装互斥；Drop 复位（Err/panic 路径同样释放），不靠手动收尾。
struct InstallGuard;

impl InstallGuard {
    fn enter() -> Result<Self, String> {
        INSTALLING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "已有安装进行中".to_string())
            .map(|_| Self)
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::Release);
    }
}

/// 引擎 → npm 安装包名注册表。包名硬编码不收用户输入（v2 安全边界），
/// 新引擎在此与 Engine 枚举同步加一行。
fn install_pkg(engine: &Engine) -> &'static str {
    match engine {
        Engine::Pi => "@mariozechner/pi-coding-agent",
        Engine::Dsh => "@deepseek-ai/dsh",
    }
}

/// 安装前置：引擎名 → (Engine, 包名)。未知引擎在此拒绝；独立于命令壳是
/// 单测锚点（AppHandle 在单测里不可构造）。
fn install_target(engine: &str) -> Result<(Engine, &'static str), String> {
    let engine = Engine::parse(engine)?;
    let pkg = install_pkg(&engine);
    Ok((engine, pkg))
}

/// 一键安装引擎：npm install -g <注册表包名>。stdout/stderr 逐行进
/// env://line（前端飞行日志），尾部行随 InstallOutcome 返回。npm 缺失即
/// 引导先装 Node（exit 非零不算 Err：装完的事，尾部日志给前端就地展示）。
#[tauri::command]
pub async fn env_install(engine: String, app: tauri::AppHandle) -> Result<InstallOutcome, String> {
    let (engine, pkg) = install_target(&engine)?;
    let _guard = InstallGuard::enter()?;
    let extra = node_bin_dirs(&app);
    let Some(npm) = state::resolve_with_extra("npm", &extra) else {
        return Err("npm 不可用（先在环境区安装 Node）".to_string());
    };
    let args = ["install", "-g", pkg].map(str::to_string).to_vec();
    let command = build_command(&npm, &args);
    let (code, output) = run_collect(&app, engine.as_str(), command, NPM_INSTALL_TIMEOUT).await?;
    Ok(InstallOutcome {
        ok: code == Some(0),
        output,
    })
}

/// 一键安装 Node 到应用私有目录（零系统侵入：不写 PATH/注册表，卸载即删
/// 目录）：下载官方 zip（流式进度）→ sha256 校验（不匹配删下载件即 Err）→
/// powershell 解压展平为 node/bin → 复验 npm 可解析。bin 下已有 npm 即幂等 ok。
#[tauri::command]
pub async fn env_install_node(app: tauri::AppHandle) -> Result<InstallOutcome, String> {
    let _guard = InstallGuard::enter()?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir 不可得: {e}"))?;
    let node_dir = data_dir.join("node");
    let bin_dir = node_dir.join("bin");
    let mut tail: Vec<String> = Vec::new();

    if state::resolve_with_extra("npm", std::slice::from_ref(&bin_dir)).is_some() {
        return Ok(InstallOutcome {
            ok: true,
            output: "已存在".to_string(),
        });
    }

    let tmp_zip = data_dir.join("node.zip.tmp");
    download_node_zip(&app, &tmp_zip, &mut tail).await?;

    // 供应链校验：哈希不符绝不解压，下载件就地删除
    let hash_script = format!(
        "(Get-FileHash -Algorithm SHA256 {}).Hash",
        ps_quote(&tmp_zip.to_string_lossy())
    );
    let hash_ok = powershell(&hash_script, Duration::from_secs(60))
        .await
        .map(|out| normalize_hash(&out) == NODE_ZIP_SHA256);
    match hash_ok {
        Ok(true) => {}
        Ok(false) => {
            let _ = std::fs::remove_file(&tmp_zip);
            return Err("校验失败（sha256 不匹配），已删除下载文件".to_string());
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp_zip);
            return Err(format!("校验失败: {e}"));
        }
    }
    emit_line(&app, "node", "校验通过");
    push_tail(&mut tail, "校验通过");

    // 先删旧 node 目录再解压：升级语义（半截/旧版目录不与新解压内容混合）
    if node_dir.exists() {
        let _ = std::fs::remove_dir_all(&node_dir);
    }
    let top_dir = node_dir.join(format!("node-{NODE_VER}-win-x64"));
    let expand_script = format!(
        "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
        ps_quote(&tmp_zip.to_string_lossy()),
        ps_quote(&node_dir.to_string_lossy())
    );
    let rename_script = format!(
        "Rename-Item -LiteralPath {} -NewName bin",
        ps_quote(&top_dir.to_string_lossy())
    );
    let extracted = async {
        powershell(&expand_script, NODE_EXTRACT_TIMEOUT).await?;
        powershell(&rename_script, NODE_EXTRACT_TIMEOUT).await?;
        state::resolve_with_extra("npm", std::slice::from_ref(&bin_dir))
            .ok_or_else(|| "解压后 npm 仍不可解析".to_string())?;
        Ok::<(), String>(())
    }
    .await;
    // zip 成败都清（成功后无用，失败下次重下）；解压失败的半截 node 目录留给
    // 幂等入口的「先删再解」自愈
    let _ = std::fs::remove_file(&tmp_zip);
    extracted?;
    emit_line(&app, "node", "安装完成");
    push_tail(&mut tail, "安装完成");
    Ok(InstallOutcome {
        ok: true,
        output: tail.join("\n"),
    })
}

/// 流式下载 Node zip 到 tmp：每满 1MB 发一行进度（节流防刷屏），完成后一次
/// 落盘（约 30MB，与 assets.rs 的内存缓冲上限同量级）。
async fn download_node_zip(
    app: &tauri::AppHandle,
    dest: &Path,
    tail: &mut Vec<String>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(NODE_DOWNLOAD_TIMEOUT)
        .build()
        .unwrap_or_default();
    let resp = client
        .get(NODE_ZIP_URL)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?;
    let total_mb = resp.content_length().map(|l| l / 1024 / 1024);
    let mut resp = resp;
    let mut bytes = Vec::new();
    let mut reported_mb = 0usize;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载失败: {e}"))? {
        bytes.extend_from_slice(&chunk);
        let got_mb = bytes.len() / 1024 / 1024;
        if got_mb > reported_mb {
            reported_mb = got_mb;
            let line = match total_mb {
                Some(total) => format!("下载 {got_mb}/{total} MB"),
                None => format!("下载 {got_mb} MB"),
            };
            emit_line(app, "node", &line);
            push_tail(tail, &line);
        }
    }
    std::fs::write(dest, &bytes).map_err(|e| format!("写文件失败: {e}"))?;
    let line = format!("下载完成（{} MB）", bytes.len() / 1024 / 1024);
    emit_line(app, "node", &line);
    push_tail(tail, &line);
    Ok(())
}

/// 流式跑安装子进程：stdout/stderr 逐行 emit env://line + 留尾部行，限时
/// （超时经 kill_on_drop 杀进程）。返回退出码与尾部日志。
async fn run_collect(
    app: &tauri::AppHandle,
    target: &str,
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Result<(Option<i32>, String), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|e| format!("启动失败: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let tail = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        readers.push(tauri::async_runtime::spawn(forward_lines(
            pipe,
            app.clone(),
            target.to_string(),
            Arc::clone(&tail),
        )));
    }
    if let Some(pipe) = stderr {
        readers.push(tauri::async_runtime::spawn(forward_lines(
            pipe,
            app.clone(),
            target.to_string(),
            Arc::clone(&tail),
        )));
    }
    let waited = tokio::time::timeout(timeout, async {
        for reader in readers {
            let _ = reader.await;
        }
        child.wait().await.ok().and_then(|status| status.code())
    })
    .await;
    waited
        .map_err(|_| format!("安装超时（{} 秒）", timeout.as_secs()))
        .map(|code| (code, tail_output(&tail)))
}

/// stdout/stderr 共用的转发任务体：一行 = 一个 env://line 事件 + 一条尾部留痕。
async fn forward_lines<R: AsyncRead + Unpin>(
    pipe: R,
    app: tauri::AppHandle,
    target: String,
    tail: Arc<Mutex<Vec<String>>>,
) {
    read_lines(pipe, |line| {
        emit_line(&app, &target, line);
        let mut tail = tail.lock().expect("install tail lock poisoned");
        push_tail(&mut tail, line);
    })
    .await;
}

/// 跑 powershell 单命令并收 stdout（hash/解压用；单行结果无流式价值，不进
/// 事件流）。ErrorPreference=Stop 使 cmdlet 失败必成非零退出码——不静默假绿。
async fn powershell(script: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let exe = state::resolve_executable("powershell").ok_or("powershell 不可用")?;
    let args = [
        "-NoProfile".to_string(),
        "-Command".to_string(),
        format!("$ErrorActionPreference='Stop'; {script}"),
    ];
    let mut command = build_command(&exe, &args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let out = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| format!("powershell 超时（{} 秒）", timeout.as_secs()))?
        .map_err(|e| format!("powershell 启动失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "powershell 失败: {}",
            first_nonempty_line(&out.stderr).unwrap_or_else(|| "未知错误".to_string())
        ));
    }
    Ok(out.stdout)
}

/// PowerShell 单引号字面量：内嵌单引号翻倍转义，路径带空格也安全。
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// powershell 哈希输出 → 可比对形态：首非空行 + 统一小写（Get-FileHash 出
/// 大写十六进制；BOM 由 first_nonempty_line 剥除）。
fn normalize_hash(bytes: &[u8]) -> String {
    first_nonempty_line(bytes)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn push_tail(tail: &mut Vec<String>, line: &str) {
    tail.push(line.to_string());
    if tail.len() > TAIL_LINES {
        tail.drain(..tail.len() - TAIL_LINES);
    }
}

fn tail_output(tail: &Mutex<Vec<String>>) -> String {
    tail.lock().expect("install tail lock poisoned").join("\n")
}

fn emit_line(app: &tauri::AppHandle, target: &str, line: &str) {
    let _ = app.emit(
        EVENT_ENV_LINE,
        LineEvt {
            target: target.to_string(),
            line: line.to_string(),
        },
    );
}

/// 输出泵：stdout/stderr 各一个读取任务；双 EOF 后 wait 收割退出码，先摘表
/// 再发 exit（摘表后 stop/write 对该 id 即刻报"不存在"，与实际一致）。
async fn pump(
    id: u64,
    engine: Engine,
    handle: Arc<ProcHandle>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    app: tauri::AppHandle,
) {
    let mut readers = Vec::new();
    if let Some(pipe) = stdout {
        let app = app.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            read_lines(pipe, |line| emit_output(&app, id, engine, "out", line)).await;
        }));
    }
    if let Some(pipe) = stderr {
        let app = app.clone();
        readers.push(tauri::async_runtime::spawn(async move {
            read_lines(pipe, |line| emit_output(&app, id, engine, "err", line)).await;
        }));
    }
    for reader in readers {
        let _ = reader.await;
    }
    let code = {
        let mut child = handle.child.lock().await;
        child.wait().await.ok().and_then(|status| status.code())
    };
    state::remove_proc(id);
    let _ = app.emit(
        EVENT_EXIT,
        serde_json::json!({ "id": id, "engine": engine.as_str(), "code": code }),
    );
}

/// 逐行读取直到 EOF：按 \n 切行、剥行尾 CR、非 UTF-8 内容 lossy 转码，
/// EOF 前无换行的最后一段也作为一行交出。读错即止（管道随进程关闭）。
/// 不依赖 Tauri 运行时，逐行行为可直接单测。
/// 字节级 \n 切分（tokio read_until），U+2028/2029 不会被当作行界——engine 的
/// JSONL 协议读取复用此处正是为此（Node readline 会切 U+2028，不能用）。
pub(crate) async fn read_lines<R: AsyncRead + Unpin>(pipe: R, mut on_line: impl FnMut(&str)) {
    let mut reader = BufReader::new(pipe);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                on_line(text.trim_end_matches(['\r', '\n']));
            }
            Err(_) => break,
        }
    }
}

fn emit_output(app: &tauri::AppHandle, id: u64, engine: Engine, stream: &str, line: &str) {
    let payload = serde_json::json!({
        "id": id,
        "engine": engine.as_str(),
        "stream": stream,
        "line": line,
    });
    let _ = app.emit(EVENT_OUTPUT, payload);
}

/// 由解析出的可执行路径构命令。Windows 上 .cmd/.bat（npm shim）不能被
/// CreateProcess 直接拉起，经 cmd.exe /C 包装。
pub(crate) fn build_command(exe: &Path, args: &[String]) -> tokio::process::Command {
    let mut command = if cfg!(windows) && is_batch(exe) {
        let mut wrapped = tokio::process::Command::new("cmd.exe");
        wrapped.arg("/C").arg(exe);
        wrapped
    } else {
        tokio::process::Command::new(exe)
    };
    command.args(args);
    command
}

fn is_batch(exe: &Path) -> bool {
    exe.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "cmd" | "bat"))
}

fn first_nonempty_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    // 剥 BOM：npm/powershell 管道 stdout 常带，U+FEFF 不属 trim 空白须显式剥，
    // 否则版本提示与哈希比对都会首字符带渣
    let text = text.trim_start_matches('\u{feff}');
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_parse_accepts_only_known_engines() {
        assert_eq!(Engine::parse("dsh"), Ok(Engine::Dsh));
        assert_eq!(Engine::parse("pi"), Ok(Engine::Pi));
        // 报错须列出支持清单，缺了引擎名的错无从自查
        let err = Engine::parse("codex").unwrap_err();
        assert!(err.contains("dsh") && err.contains("pi"), "unexpected: {err}");
    }

    /// 只做结构性断言（前端契约），不断言 which 结果（机器相关）。v2 起含
    /// npm 条目（Node 状态卡）。
    #[tokio::test]
    async fn env_report_lists_engines_and_npm_in_frontend_shape() {
        let report = env_report(&[]).await;
        let mut names: Vec<&str> = report.iter().map(|e| e.engine.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["dsh", "npm", "pi"], "report: {report:?}");
        for entry in &report {
            let json = serde_json::to_value(entry).unwrap();
            assert!(json["engine"].is_string(), "json: {json}");
            let probe = &json["probe"];
            assert!(probe["available"].is_boolean(), "json: {json}");
            assert!(
                probe["path"].is_string() || probe["path"].is_null(),
                "json: {json}"
            );
            assert!(
                probe["version_hint"].is_string() || probe["version_hint"].is_null(),
                "json: {json}"
            );
        }
    }

    /// env_install 的前置门（单测锚点：AppHandle 不可构造，命令体不可直测）：
    /// 未知引擎拒绝，两引擎各映射到钉死的包名。
    #[test]
    fn install_target_rejects_unknown_and_maps_registry_pkgs() {
        let err = install_target("codex").unwrap_err();
        assert!(err.contains("codex"), "unexpected: {err}");
        assert_eq!(
            install_target("pi").unwrap().1,
            "@mariozechner/pi-coding-agent"
        );
        assert_eq!(install_target("dsh").unwrap().1, "@deepseek-ai/dsh");
    }

    /// 互斥语义：占用中二次进入 Err，释放后可再进。
    #[test]
    fn install_guard_cas_rejects_reentry_and_resets_on_drop() {
        let held = InstallGuard::enter().expect("空闲态进入应成功");
        assert!(InstallGuard::enter().is_err(), "占用中应拒绝");
        drop(held);
        let reentered = InstallGuard::enter().expect("释放后应可再进");
        drop(reentered);
    }

    #[test]
    fn push_tail_keeps_only_last_lines() {
        let mut tail = Vec::new();
        for i in 0..(TAIL_LINES + 5) {
            push_tail(&mut tail, &format!("line-{i}"));
        }
        assert_eq!(tail.len(), TAIL_LINES);
        assert_eq!(tail.first().map(String::as_str), Some("line-5"));
        assert_eq!(tail.last().map(String::as_str), Some("line-24"));
    }

    /// Get-FileHash 出大写 + powershell 管道可能带 BOM/空白：必须归一成与
    /// 常量可直接 == 比对小写串，否则校验误判。
    #[test]
    fn normalize_hash_strips_bom_and_lowercases() {
        let bytes = "\u{feff}158F7685B44D\r\n".as_bytes();
        assert_eq!(normalize_hash(bytes), "158f7685b44d");
        assert_eq!(normalize_hash(b"\n\n  ABCDEF  \n"), "abcdef");
        assert_eq!(normalize_hash(b""), "");
    }

    #[test]
    fn ps_quote_escapes_embedded_quotes() {
        assert_eq!(ps_quote(r"C:\it's\node"), r"'C:\it''s\node'");
        assert_eq!(ps_quote("plain"), "'plain'");
    }

    #[test]
    fn resolve_executable_returns_none_for_missing_binary() {
        assert!(state::resolve_executable("cp-sidecar-definitely-missing-xyz").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn resolve_executable_finds_system_binary() {
        let exe = state::resolve_executable("cmd").expect("cmd.exe 应在 PATH 上");
        assert!(exe.is_file());
    }

    #[test]
    fn prepare_rejects_missing_cwd() {
        let missing =
            std::env::temp_dir().join(format!("cp-sidecar-absent-{}", std::process::id()));
        let err = prepare("dsh", &missing.to_string_lossy(), &[]).unwrap_err();
        assert!(err.contains("cwd"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn stop_and_write_on_unknown_id_error() {
        assert!(sidecar_stop(99_999_999).await.is_err());
        assert!(sidecar_write(99_999_999, "hi".into()).await.is_err());
    }

    #[tokio::test]
    async fn read_lines_splits_trims_crlf_and_keeps_tail() {
        let (mut tx, rx) = tokio::io::duplex(256);
        tx.write_all(b"alpha\r\n\nbeta\ngamma").await.unwrap();
        drop(tx);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&seen);
        read_lines(rx, move |line| sink.lock().unwrap().push(line.to_string())).await;
        assert_eq!(*seen.lock().unwrap(), vec!["alpha", "", "beta", "gamma"]);
    }

    #[tokio::test]
    async fn read_lines_decodes_invalid_utf8_lossily() {
        let (mut tx, rx) = tokio::io::duplex(256);
        tx.write_all(b"\xff\xfe markers\n").await.unwrap();
        drop(tx);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&seen);
        read_lines(rx, move |line| sink.lock().unwrap().push(line.to_string())).await;
        assert_eq!(*seen.lock().unwrap(), vec!["\u{FFFD}\u{FFFD} markers"]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn build_command_runs_resolved_exe_and_streams_stdout() {
        let exe = state::resolve_executable("cmd").unwrap();
        let mut command = build_command(&exe, &["/C".into(), "echo sidecar-ok".into()]);
        command.stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&seen);
        read_lines(stdout, move |line| {
            sink.lock().unwrap().push(line.to_string())
        })
        .await;
        let _ = child.wait().await;
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("sidecar-ok")),
            "output: {:?}",
            seen.lock().unwrap()
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn build_command_wraps_batch_shims_via_cmd() {
        let dir = std::env::temp_dir().join(format!("cp-sidecar-shim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("fake-engine.cmd");
        std::fs::write(&shim, "@echo sidecar-shim-ok\r\n").unwrap();
        let mut command = build_command(&shim, &[]);
        command.stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&seen);
        read_lines(stdout, move |line| {
            sink.lock().unwrap().push(line.to_string())
        })
        .await;
        let _ = child.wait().await;
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("sidecar-shim-ok")),
            "output: {:?}",
            seen.lock().unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
