# 望舒 wangshu

自托管的 AI 工作台：对话、agent 任务、个人创作一体。模型接入双模对等——可自带 API key 直连自己的模型，也可接入 hub 托管模型池。当前为 toC 单用户设计。

## 核心能力

- **对话域**：双模模型接入。自带 key 存本地系统 keyring，直连 provider 不经 hub；或走 hub 托管模型池。流式对话、会话管理、@技能 注入、@agent 发起任务
- **任务域**：内置 Rust agent harness（状态机、工具、审批门、信任目录、SKILL.md 技能、子代理）。工具写操作出 diff 预览，人工批准或拒绝；任务遥测与飞行日志
- **编码引擎**：DSH 与 PI 双 sidecar 可切换，各配独立面板。PI 会话跨重启自动续，DSH 历史可回填续跑
- **素材生成**：hub 内置模块，图与视频异步任务流，产物可收进本地资产页
- **知识库**：文档入库、向量检索、@资料 即席注入
- **hub 控制台**：/console 管理面，模型池、计价、MCP、用量、素材监控，admin 角色门
- **环境检测与一键安装**：设置页检测 Node 与 PI/DSH 就绪状态，缺失时代装到应用私有目录，不写 PATH 与注册表
- **自更新**：应用内检查更新与升级，minisign 签名验签
- **主题**：浅色与深色双主题，跟随系统并可手动覆盖

客户端为 Tauri 2 + Rust（Windows 优先），无 hub 时以纯本地 BYOK 模式运行。hub 为 Go 单二进制 + PostgreSQL，`server/docker-compose.yml` 一键编排，登录走 Ed25519 JWT 验签的账号服务。CI 覆盖 server Go、client Rust、client web 三矩阵。

## 自托管快速开始

### 方式一：纯本地 BYOK（零服务）

构建并运行客户端，在设置中填入 provider base URL 与 API key。key 存本地系统 keyring，请求直连 provider，不经任何中间服务。

### 方式二：完整 hub（Docker Compose）

```bash
git clone <本仓库地址> && cd wangshu-public/server
cp .env.example .env        # 至少设置 HUB_PG_PASSWORD
docker compose up -d --build
# hub 监听 127.0.0.1:10440；对外服务请自加反向代理与 TLS
```

客户端「设置」中把 hub 地址指向 `http://<host>:10440`。

**登录与账号服务**：hub 的登录代理与令牌验签面向一个独立的账号服务（`CENTER_URL`，契约见 `server/internal/auth/acauth/`）。该服务是本项目生态的另一组件，暂未开源。自托管者可以：

- 将 `CENTER_URL` 指向自己已有或自建的兼容账号服务；或
- 本地开发/试用：用 `server/cmd/devtoken` 在本地铸造密钥对与访问令牌，把输出的 JWKS 写入 `CENTER_JWKS_JSON`，请求携带 `Authorization: Bearer <token>`。

### 出厂默认值（自托管必读）

- 客户端默认 hub 地址（`client/src/api.ts` 的 `DEFAULT_HUB_URL`）与自更新 manifest 端点（`client/src-tauri/tauri.conf.json`）指向作者实例 `platform.secai.fun`；hub 的 `CENTER_URL` 默认同样指向作者实例。自托管请全部改为自己的地址。
- 自更新为 minisign 签名验签：二次分发需自持密钥对，并替换 `tauri.conf.json` 中 updater 的 `pubkey` 与端点。

## 从源码构建

- 客户端（需 Node 24 + Rust 工具链）：`cd client && npm ci && npm run tauri dev`（开发）/ `npm run tauri build`（打包）
- hub（需 Go 1.25）：`cd server && go build ./cmd/hub`
- CI：`.github/workflows/ci.yml`（go vet/test、cargo test/clippy、npm build 三矩阵）

## 布局

```
server/   hub（Go 单二进制）：acauth 鉴权 / 模型池 / OpenAI 兼容网关 /
          会话与用量 / 素材生成 / 知识库 / MCP 治理 / 控制台 / 自更新分发
client/   Tauri 2 + Rust：对话域（双模接入）/ 内置 harness（工具/审批/
          信任目录）/ 任务域 / DSH+PI sidecar / 资产 / 设置
docs/     自托管部署指南
```

## 文档

- [docs/deploy-guide.md](docs/deploy-guide.md) — 自托管部署指南（起栈 / 模型池 / 账号 / 自更新 / 故障处置）
- [CHANGELOG.md](CHANGELOG.md) — 版本更新日志

## 许可

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
