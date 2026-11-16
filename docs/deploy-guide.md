# 望舒自托管部署指南

> 面向自托管用户：一台 Linux 服务器 + Docker，十分钟起一套完整的
> 望舒 hub（模型网关 + 会话 + 素材生成 + 知识库 + 管理控制台 + 桌面
> 客户端自更新分发）。

## 1 · 起栈

```bash
git clone https://github.com/xycxmz/wangshu-public.git
cd wangshu-public/server
cp .env.example .env      # 编辑：至少设置 HUB_PG_PASSWORD
docker compose up -d      # PG16 + hub 两个容器
curl http://127.0.0.1:10440/healthz   # {"status":"ok"} 即就绪
```

`.env` 关键项：

| 变量 | 说明 |
|---|---|
| HUB_PG_PASSWORD | PostgreSQL 密码（必填） |
| CENTER_URL | 账号服务地址；无外部服务时可保持示例值，注册见 §4 |
| DASHSCOPE_API_KEY | 可留空——key 也可灌进模型池（§3，推荐） |
| MATERIAL_PRICE_IMAGE / VIDEO | 素材计价（分/张、分/条），可后经控制台热改 |

## 2 · 模型池与计价

控制台 `http://<host>:10440/console`（管理员账号登录）：

- **模型池**：添加托管模型（name / provider / 上游模型 / 协议 /
  DashScope key / 入出价，价格为分/千 token）；key 存库永不出明文，
  多模型可各配各 key
- **计价**：素材价格热生效
- DashScope key 未配 env 时，素材与知识库 embedding 自动取模型池内
  首个 qwen 系模型的 key（双源机制）

## 3 · 账号

登录走 account-center 契约（Ed25519 JWT）。该账号服务暂未开源，无法随栈部署。替代路径：
将 CENTER_URL 指向自己已有或自建的兼容服务（契约同 acauth）并
注册一个 appId；或在 CENTER_URL 不可达时使用纯 BYOK 模式（客户端直连
自己的 provider，无需 hub 账号）。

## 4 · 桌面客户端与自更新

- 客户端源码在 `client/`（Tauri 2 + Rust），`npm install && npm run
  tauri build` 出安装包
- **自更新自配**：`client/src-tauri/tauri.conf.json` 的 updater
  `endpoints` 默认指向官方演示 hub——自托管请替换为
  `https://<你的域名>/api/v1/update/manifest`，并自己生成 updater
  签名密钥对（公钥填入同文件 `pubkey`，私钥在构建时经
  `TAURI_SIGNING_PRIVATE_KEY` 环境变量注入，**永不入库**）
- 更新产物放 hub 服务器的 `updates/assets/`，manifest 放
  `updates/manifest.json`（格式见仓库 wiki 或对照客户端源码
  `internal/update`）

## 5 · 常见故障

| 症状 | 处置 |
|---|---|
| healthz 不通 | `docker compose logs hub`；PG 未就绪时等 10s 重试 |
| 登录 401 INVALID_CREDENTIALS | CENTER_URL 指向错误或账号未注册到该 appId |
| 素材 503 no DashScope key | env 与模型池都无 key——控制台模型池添加带 key 的模型 |
| 知识库 503 | 同上（embedding 共用双源 key） |
| 客户端升级失败 Invalid encoding | manifest 的 signature 必须是 `.sig` 文件内容原样贴入，不要二次 base64 |

## 6 · 反向代理

hub 监听容器内 :10440，compose 已映射 127.0.0.1:10440；公网请用
Caddy/Nginx 反代并配 TLS（WebSocket/SSE 透传需开启）。
