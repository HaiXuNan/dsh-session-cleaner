# dsh-session-cleaner

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）侧栏会话菜单加一个「删除会话」项，用来**永久删除已归档的会话**。

## 为什么需要它

DSH 0.2.1-rc.3 只提供「归档」，没有删除：工作区 RPC 里只有 `archiveSession` / `unarchiveSession`，会话日志会一直堆在 `~/.dsh/sessions/` 下。归档只是把 ID 记进 `workspace.json` 的 `archivedSessionIds`，数据本身不会消失。

这个插件补上删除能力：归档会话的 ⋯ 菜单里多一项「删除会话」，确认后删除会话日志、投影缓存和注册表里的全部引用。

## 行为

- **只对已归档会话出现**。宿主端会再次校验归档状态；只有「还有进行中的工作」（回合、子智能体、后台任务、定时提醒）时才拒绝删除。归档后会话仍驻留在内存里是正常的，不影响删除。
- 删除范围：
  - `~/.dsh/sessions/<workspace>/session-<id>/`（会话日志）
  - `~/.dsh/storages/session_projcache/sessions/session-<id>.json`（投影缓存）
  - 注册表引用：工作区归属、归档集、置顶集（全部通过官方 `workspaceRegistry` API 写入，不直接改 `workspace.json`）
- 删除不可恢复。
- 删除成功后只调用 `sessions.refresh()` 刷新侧栏列表，不重载页面。
- 启动时自愈：如果某个归档 ID 的日志文件已经不存在（例如上次删除中途退出），插件会自动把它从归档集里清掉。

## 平台支持

宿主端是纯 Node 代码（只用 `node:fs/promises`、`node:path`、`node:os`），客户端是标准浏览器模块，同一份构建在三个平台上行为一致：

| 平台 | DSH 形态 | profile | 数据目录 | 验证 |
| --- | --- | --- | --- | --- |
| Windows 10/11 | 桌面端 / CLI | `desktop` | `%USERPROFILE%\.dsh` | 本机实测 Node 24.9 |
| macOS | 桌面端 / CLI | `desktop` | `~/.dsh` | CI 矩阵 `macos-latest` |
| Linux（含 WSL2） | CLI + `dsh web` | `web`（或自建 profile） | `~/.dsh` | Ubuntu 24.04 实测 Node 24.9 |

为了做到这一点，有三处细节是刻意写成平台无关的：

- **工作区 slug 不靠猜。** Windows 的 slug 形如 `--C-Users-me-Desktop--`，macOS/Linux 形如 `--home-me-project--`。插件从不拼接 slug，而是扫 `<home>/sessions/*/session-<uuid>/` 找到日志目录，slug 长什么样都不影响。
- **会话 ID 先规范成小写再碰文件系统。** Linux 区分大小写，Windows 与 macOS（默认 APFS）不区分；宿主端统一转小写，避免同一个请求在不同平台解析到不同目录。
- **删除带重试。** `rm` 在 Windows 上会自动重试 `EBUSY`/`EPERM`/`ENOTEMPTY`（`maxRetries: 5`），macOS/Linux 直接忽略这两个选项，一套代码通吃；若仍然失败，返回可操作的错误码，而不是裸 500。

三平台共用一个 CI 矩阵（`.github/workflows/ci.yml`，Windows/macOS/Linux × Node 22/24），每次提交都会跑一遍离线用例。

## 安装

插件以「组合包（bundle）」形式发布：包内自带 `cordis.patch.yml`，`dsh plugin add` 选中它时会自动挂载，不需要手改 profile 配置。

### 方式一：官方安装命令（推荐）

需要本机有 DSH CLI（`npm i -g @deepseek-ai/dsh`，或使用桌面端自带的 `dsh`）。**profile 名按平台/形态选**：桌面端（Windows、macOS）是 `desktop`，Linux 上用 `dsh web` 时是 `web`：

```bash
# macOS（桌面端）
dsh plugin --profile desktop add github:HaiXuNan/dsh-session-cleaner

# Linux（dsh web）
dsh plugin --profile web add github:HaiXuNan/dsh-session-cleaner
```

```powershell
# Windows
dsh plugin --profile desktop add github:HaiXuNan/dsh-session-cleaner
```

没有 CLI 也可以用 Web 的「插件」页：侧栏 → 插件 → 安装，spec 填 `github:HaiXuNan/dsh-session-cleaner`。

`dsh plugin add` 走 git 协议拉取，所以需要本机有 `git`；macOS 若提示找不到 git，先执行 `xcode-select --install`。

装完重启 DSH（未启用 HMR 时，新组合包在重启后生效）。

### 方式二：手动安装（不依赖 CLI）

1. 克隆到 profile 的 `node_modules`：

   macOS / Linux：

   ```bash
   PROFILE=desktop          # Linux 上用 dsh web 时改成 web
   mkdir -p ~/.dsh/profiles/$PROFILE/node_modules
   git clone https://github.com/HaiXuNan/dsh-session-cleaner.git \
     ~/.dsh/profiles/$PROFILE/node_modules/dsh-session-cleaner
   ```

   Windows（PowerShell）：

   ```powershell
   $target = "$env:USERPROFILE\.dsh\profiles\desktop"
   New-Item -ItemType Directory -Force -Path "$target\node_modules" | Out-Null
   git clone https://github.com/HaiXuNan/dsh-session-cleaner.git "$target\node_modules\dsh-session-cleaner"
   ```

2. 在该 profile 的 `cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: session-cleaner
         name: dsh-session-cleaner
   ```

3. 完全退出并重新启动 DSH。

> 两种方式**不要同时使用**：组合包方式已经会插入 `id: session-cleaner` 这一行，手写一遍会因重复 id 导致加载失败。从手动切到组合包方式时，先删掉 profile `cordis.patch.yml` 里的那段 `insert`。

侧栏筛选切到「全部对话（显示已归档）」或「仅显示已归档」，点归档会话右侧的 ⋯，就能看到红色的「删除会话」。

### 升级

- 组合包方式：插件页里更新，或 `dsh plugin --profile <你的 profile> remove dsh-session-cleaner` 后重新 `add`。
- 手动方式：进入插件目录 `git pull`，然后重启 DSH。

## 接口

宿主端注册了一个本地路由（仅本机、同一来源）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/session-cleaner/archived` | 返回当前归档集 |
| `POST` | `/session-cleaner/delete` | `{ "sessionId": "session-<uuid>" }`，删除该已归档会话 |

错误码：

| 码 | 状态 | 含义 |
| --- | --- | --- |
| `invalid-session-id` | 400 | 不是 `session-<uuid>` 形态（含路径穿越） |
| `not-archived` | 409 | 会话未归档，先归档再删 |
| `session-active` | 409 | 还有进行中的回合 / 子智能体 / 后台任务 / 定时提醒 |
| `log-missing` | 410 | 归档集里有这个 ID，但磁盘上已无日志 |
| `permission-denied` | 409 | 没有权限删文件（Linux/macOS 上多为 `~/.dsh` 归 root） |
| `file-locked` | 409 | 文件被占用或受系统保护（Windows 上多为 DSH 仍持有句柄；macOS 上可能是隐私目录） |
| `remove-failed` | 500 | 其它文件系统错误，消息里带具体原因 |
| `registry-unavailable` | 503 | 工作区注册表服务未就绪 |

## 开发

```bash
# 两套宿主端离线用例（会各自建一个临时目录当 DSH_HOME，跑完即删）
npm test        # = node test-host-v2.mjs && node test-host.mjs
```

`test-host.mjs` 是精简冒烟用例，`test-host-v2.mjs` 覆盖完整契约（先删文件再写注册表、410 保护、启动自愈、大写 ID 归一化）。两套都在 Windows、macOS、Linux 上跑，CI 矩阵见 `.github/workflows/ci.yml`。

## 兼容性

- 代码层面无平台分支：不用 `process.platform`、不硬编码分隔符或盘符、不依赖原生模块，因此 Windows / macOS / Linux 共用同一份构建
- 目标版本：DSH `0.2.1-rc.3`（桌面端 profile `desktop`，Linux `dsh web` 为 `web`）
- npm 上的 dist-tags 目前是 `latest = 0.2.1-rc.2`、`next = 0.2.1-rc.4`，与插件声明的 rc.3 不一致；在别的机器上装之前请显式指定 `@deepseek-ai/dsh@0.2.1-rc.3`，或先用 `GET /session-cleaner/archived` 自检宿主服务面
- 依赖的宿主服务：`webServer`、`workspaceRegistry`
- 依赖的客户端服务：`slots`、`workspaces`、`sessions`、`locale`
- 图标与 `danger` 样式对齐 DSH 自带的「删除工作区」菜单项

上游如果以后原生支持删除会话，这个插件就可以直接卸掉。

## License

MIT
