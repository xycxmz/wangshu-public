//! sidecar 领域类型与进程注册表：Engine 枚举、PATH 可执行解析（which）、
//! u64 id → 进程句柄表。与 harness 注册表同纪律：锁内只做 map 操作，IO 一律锁外。

use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as AsyncMutex;

/// 编码引擎。新增引擎 = 枚举加一项（probe/run 的解析与调用不需其他改动）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Dsh,
    Pi,
}

impl Engine {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "dsh" => Ok(Self::Dsh),
            "pi" => Ok(Self::Pi),
            other => Err(format!("未知引擎 '{other}'（支持: dsh / pi）")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Dsh => "dsh",
            Self::Pi => "pi",
        }
    }

    /// 全集（Dsh → Pi 固定序）。聚合消费方（env_check 等）遍历此处取清单，
    /// 不在各自模块再抄一份引擎列表。
    pub fn all() -> [Engine; 2] {
        [Self::Dsh, Self::Pi]
    }
}

/// 进程句柄。child 与 stdin 各持一把异步锁：stop 只碰 child，write 只碰 stdin，
/// 互不争锁；两把锁都不在持锁期间做长 IO。engine 由 pump 侧自行携带。
pub struct ProcHandle {
    pub pid: Option<u32>,
    pub child: AsyncMutex<Child>,
    pub stdin: AsyncMutex<Option<ChildStdin>>,
}

impl ProcHandle {
    pub fn new(pid: Option<u32>, child: Child, stdin: Option<ChildStdin>) -> Self {
        Self {
            pid,
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(stdin),
        }
    }

    /// Windows 先 taskkill /T /F 连子树一起收（引擎经 cmd shim 启动时会再拉
    /// node 等子进程，单杀 wrapper 杀不干净）；taskkill 不可用或非 Windows
    /// 退回 Child::kill。
    pub async fn kill(&self) -> Result<(), String> {
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let arg = pid.to_string();
            let killed = tokio::task::spawn_blocking(move || taskkill_tree(&arg))
                .await
                .map_err(|e| format!("taskkill 任务失败: {e}"))?;
            if killed {
                return Ok(());
            }
        }
        let mut child = self.child.lock().await;
        child.kill().await.map_err(|e| format!("kill 失败: {e}"))
    }
}

#[cfg(windows)]
fn taskkill_tree(pid: &str) -> bool {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID"])
        .arg(pid)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static PROCS: LazyLock<Mutex<HashMap<u64, Arc<ProcHandle>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_map<R>(f: impl FnOnce(&mut HashMap<u64, Arc<ProcHandle>>) -> R) -> R {
    let mut guard = PROCS.lock().expect("sidecar registry lock poisoned");
    f(&mut guard)
}

pub fn next_proc_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

pub fn insert_proc(id: u64, handle: Arc<ProcHandle>) {
    with_map(|m| {
        m.insert(id, handle);
    });
}

pub fn get_proc(id: u64) -> Option<Arc<ProcHandle>> {
    with_map(|m| m.get(&id).cloned())
}

pub fn remove_proc(id: u64) {
    with_map(|m| {
        m.remove(&id);
    });
}

/// 应用私有 node/bin（OnceLock 启动期注册一次）。engine spawn 等无 AppHandle
/// 的消费者经 resolve_executable 自动带上该前缀——私有目录里一键装的引擎
/// 对全部解析入口可见，不出现「环境区 READY、engine_start 找不到」的假绿。
static NODE_BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// lib.rs setup 注册（幂等，先到先得）。单测用独占假引擎名注册临时目录，
/// 不污染其他测试的解析。
pub fn register_node_bin(dir: PathBuf) {
    let _ = NODE_BIN.set(dir);
}

/// which（私有 node/bin 前缀 + PATH）。
pub fn resolve_executable(name: &str) -> Option<PathBuf> {
    match NODE_BIN.get() {
        Some(dir) => resolve_with_extra(name, std::slice::from_ref(dir)),
        None => resolve_with_extra(name, &[]),
    }
}

/// which + 私有目录前缀：extra_dirs 各目录先于 PATH 逐个探测（应用私有
/// node/bin 优先于系统安装），候选扩展名规则与 PATH 侧一致。Windows 上额外
/// 试 PATHEXT 扩展名——npm 全局安装的 CLI 是 .cmd shim，CreateProcess 不能
/// 直接拉起（mod.rs 会包 cmd /C）。
pub fn resolve_with_extra(name: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in extra_dirs {
        for candidate in candidates(name) {
            let full = dir.join(candidate);
            if is_executable(&full) {
                return Some(full);
            }
        }
    }
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in candidates(name) {
            let full = dir.join(candidate);
            if is_executable(&full) {
                return Some(full);
            }
        }
    }
    None
}

fn candidates(name: &str) -> Vec<String> {
    if !cfg!(windows) {
        return vec![name.to_string()];
    }
    let default_exts = [".com", ".exe", ".bat", ".cmd"];
    let exts: Vec<String> = env::var("PATHEXT")
        .map(|v| {
            v.split(';')
                .filter(|e| !e.is_empty())
                .map(|e| format!(".{}", e.trim_start_matches('.').to_ascii_lowercase()))
                .collect()
        })
        .unwrap_or_else(|_| default_exts.iter().map(|e| e.to_string()).collect());
    // PATHEXT 变体优先、裸名殿后：npm 全局目录里同名的裸名文件是 Unix sh shim
    //（CreateProcess 拉起报 os error 193），裸名排第一会把它错误顶到 .cmd 前面。
    let mut out: Vec<String> = exts.iter().map(|e| format!("{name}{e}")).collect();
    out.push(name.to_string());
    out
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    let has_exec_bit = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(windows)]
    let has_exec_bit = true;
    meta.is_file() && has_exec_bit
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PATHEXT 变体必须排在裸名前：npm 全局目录里同名的裸名文件是 Unix sh
    /// shim，CreateProcess 拉起报 os error 193（engine/pi 真 pi 集成实测回归）。
    #[cfg(windows)]
    #[test]
    fn candidates_put_pathtext_variants_before_bare_name() {
        let order = candidates("pi");
        assert_eq!(
            order.last().map(String::as_str),
            Some("pi"),
            "order: {order:?}"
        );
        assert!(
            order.iter().take(order.len() - 1).all(|c| c != "pi"),
            "裸名不得先于扩展名变体: {order:?}"
        );
    }

    /// 本机实况锚点：npm 全局 pi 应解析到 .cmd（sh shim 包装路径），而非裸名
    /// 文件。未装 pi 的机器直接跳过（双机仓不强制装 pi）。
    #[cfg(windows)]
    #[test]
    fn resolve_executable_picks_real_windows_shim_for_pi() {
        let Some(exe) = resolve_executable("pi") else {
            return;
        };
        let ext = exe
            .extension()
            .and_then(|e| e.to_str())
            .expect("Windows 可执行解析结果必须带扩展名")
            .to_ascii_lowercase();
        assert!(
            matches!(ext.as_str(), "cmd" | "bat" | "exe" | "com"),
            "unexpected: {}",
            exe.display()
        );
    }

    /// 私有目录前缀契约（v2 一键安装）：临时目录放假 .cmd 应被 resolve_with_extra
    /// 命中，且 PATH 侧不命中该假名（证明命中的确来自前缀而非系统）。
    #[cfg(windows)]
    #[test]
    fn resolve_with_extra_prefers_private_dir() {
        let dir = std::env::temp_dir().join(format!("cp-sidecar-extra-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cp-fake-npm.cmd"), "@echo off\r\n").unwrap();
        let hit = resolve_with_extra("cp-fake-npm", std::slice::from_ref(&dir))
            .expect("私有目录内的 .cmd 应命中");
        assert_eq!(hit, dir.join("cp-fake-npm.cmd"));
        assert!(
            resolve_executable("cp-fake-npm").is_none(),
            "假名不在注册前缀与 PATH 上，解析应落空"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 全局注册语义：engine spawn 走的 resolve_executable 必须看见私有目录，
    /// 否则一键装的引擎「环境区 READY、启动找不到」。独占假名零污染其他测试。
    #[cfg(windows)]
    #[test]
    fn resolve_executable_sees_registered_node_bin() {
        let dir = std::env::temp_dir().join(format!("cp-sidecar-reg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cp-reg-engine.cmd"), "@echo off\r\n").unwrap();
        register_node_bin(dir.clone());
        let hit = resolve_executable("cp-reg-engine").expect("注册目录内的假引擎应经全局前缀命中");
        assert_eq!(hit, dir.join("cp-reg-engine.cmd"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
