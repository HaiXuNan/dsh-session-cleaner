# dsh-session-cleaner

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）侧栏会话菜单加一个「删除会话」项，用来**永久删除已归档的会话**。

## 为什么需要它

DSH 0.2.1-rc.3 只提供「归档」，没有删除：工作区 RPC 里只有 `archiveSession` / `unarchiveSession`，会话日志会一直堆在 `~/.dsh/sessions/` 下。归档只是把 ID 记进 `workspace.json` 的 `archivedSessionIds`，数据本身不会消失。

这个插件补上删除能力：归档会话的 ⋯ 菜单里多一项「删除会话」，确认后删除会话日志、投影缓存和注册表里的全部引用。

## 行为

- **只对已归档会话出现**。正在运行的会话不会显示这一项，宿主端也会二次拒绝。
- 删除范围：
  - `~/.dsh/sessions/<workspace>/session-<id>/`（会话日志）
  - `~/.dsh/storages/session_projcache/sessions/session-<id>.json`（投影缓存）
  - 注册表引用：工作区归属、归档集、置顶集（全部通过官方 `workspaceRegistry` API 写入，不直接改 `workspace.json`）
- 删除不可恢复。
- 删除成功后只调用 `sessions.refresh()` 刷新侧栏列表，不重载页面。
- 启动时自愈：如果某个归档 ID 的日志文件已经不存在（例如上次删除中途退出），插件会自动把它从归档集里清掉。

## 安装

插件以「组合包（bundle）」形式发布：包内自带 `cordis.patch.yml`，`dsh plugin add` 选中它时会自动挂载，不需要手改 profile 配置。

### 方式一：官方安装命令（推荐）

需要本机有 DSH CLI（`npm i -g @deepseek-ai/dsh`，或使用桌面端自带的 `dsh`）：

```bash
dsh plugin --profile desktop add github:HaiXuNan/dsh-session-cleaner
```

没有 CLI 也可以用 Web 的「插件」页：侧栏 → 插件 → 安装，spec 填 `github:HaiXuNan/dsh-session-cleaner`。

装完重启 DSH（未启用 HMR 时，新组合包在重启后生效）。

### 方式二：手动安装（不依赖 CLI）

1. 克隆到 profile 的 `node_modules`（Windows 下把 `~` 换成 `%USERPROFILE%`）：

   ```bash
   mkdir -p ~/.dsh/profiles/desktop/node_modules
   git clone https://github.com/HaiXuNan/dsh-session-cleaner.git \
     ~/.dsh/profiles/desktop/node_modules/dsh-session-cleaner
   ```

2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: session-cleaner
         name: dsh-session-cleaner
   ```

3. 完全退出并重新启动 DSH。

> 两种方式**不要同时使用**：组合包方式已经会插入 `id: session-cleaner` 这一行，手写一遍会因重复 id 导致加载失败。从手动切到组合包方式时，先删掉 profile `cordis.patch.yml` 里的那段 `insert`。

侧栏筛选切到「全部对话（显示已归档）」或「仅显示已归档」，点归档会话右侧的 ⋯，就能看到红色的「删除会话」。

### 升级

- 组合包方式：插件页里更新，或 `dsh plugin --profile desktop remove dsh-session-cleaner` 后重新 `add`。
- 手动方式：进入插件目录 `git pull`，然后重启 DSH。

## 接口

宿主端注册了一个本地路由（仅本机、同一来源）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/session-cleaner/archived` | 返回当前归档集 |
| `POST` | `/session-cleaner/delete` | `{ "sessionId": "session-<uuid>" }`，删除该已归档会话 |

错误码：`invalid-session-id`、`not-archived`、`session-live`、`log-missing`、`registry-unavailable`。

## 开发

```bash
# 宿主端离线测试（会在临时目录里建一个假的 DSH_HOME）
node test-host-v2.mjs
```

`test-host.mjs` 是初版用例，`test-host-v2.mjs` 覆盖现行逻辑（先删文件再写注册表、410 保护、启动自愈）。

## 兼容性

- 目标版本：DSH `0.2.1-rc.3`（桌面端 profile `desktop`）
- 依赖的宿主服务：`webServer`、`workspaceRegistry`
- 依赖的客户端服务：`slots`、`workspaces`、`sessions`、`locale`
- 图标与 `danger` 样式对齐 DSH 自带的「删除工作区」菜单项

上游如果以后原生支持删除会话，这个插件就可以直接卸掉。

## License

MIT
