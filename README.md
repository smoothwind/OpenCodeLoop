# OpenCodeLoop

OpenCode 无人值守守护管理台 — 让 `opencode run` 像守护进程一样持续迭代你的项目，直到任务完成。

OpenCodeLoop 是 [OpenCode](https://opencode.ai) 的桌面伴生工具（Electron + Vue 3）：为每个项目配置一条提示词，守护进程循环拉起 `opencode run`，退出即按间隔重启，直到输出中出现完成标记（默认 `DONE`）才停。前身是单任务脚本 `keep-alive.ps1`，现已进程化为多任务管理台。

## 功能特性

### 多任务守护

- **任务卡片 / 列表**：同时守护多个项目，逐任务启停、立即重启、查看轮数 / 退出码 / 本轮时长 / 实际模型
- **会话策略**：最近会话（`-c` 续写）/ 指定会话（`-s`）/ 每轮新会话
- **会话闸门**：每轮发送前通过 opencode 本地 API 检测目标会话是否正在运行（TUI / 桌面端）或仍有排队消息；忙碌时等待空闲再发送（默认最多 30 分钟，可配置），避免 `opencode run` 以 steer 方式插入正在执行的回合
- **停止即中断**：停止守护 / 立即重启时调用 opencode 的 interrupt 接口结束服务器端 agent loop，而不是只杀掉本地 CLI 进程
- **模型链**：主力模型 + 可选模型列表，主力连续失败后按序顺延，恢复后自动回到主力
- **迭代模式**：每轮完成后自动开始下一轮（可设总轮数上限），适合「持续改进直到满意」的场景
- **完成标记**：输出中出现关键字（默认 `DONE`）即判定完成；等子进程自然退出，保证 git commit 等收尾动作执行完

### 会话闸门与并发安全

`opencode run --session <id>` 在 v2 中以 **steer** 方式投递消息：目标会话如果正在 TUI / 桌面端执行，守护提示词会插入正在运行的回合，造成互相干扰。守护在每轮发送前会先做一次「会话闸门」检查：

1. 解析本轮目标会话：`-s` 指定会话；`-c` 取项目下最近更新的会话
2. 通过 opencode 本地 API（`~/.local/state/opencode/service.json` 凭据）检查：
   - `GET /api/session/active`：会话是否正在执行（权威状态；`outcome` / `time.idle` 在运行期间仍是上一次的旧值，不能单独用于判断）
   - `GET /api/session/{id}/inbox`：是否仍有排队消息（有排队也视为忙）
3. 忙碌时进入 `waiting` 状态，用 `POST /api/experimental/session/{id}/wait` 长轮询等待空闲；接口不可用时退化为轮询 `/active`
4. 空闲后读取上次执行结果（成功 / 失败 / 中断）并写入日志，然后才 spawn `opencode run`
5. 等待超过任务的「会话等待上限」（默认 30 分钟，0 = 不限）后，记录告警并按配置继续发送

其他保护：

- **单会话租约**：进程内同一会话同时只允许一个守护发送，避免多个任务共用同一会话时并发投递
- **停止即中断**：停止 / 立即重启时调用 `POST /api/session/{id}/interrupt` 结束服务器端执行；只 kill CLI 不会终止服务器端 agent loop
- **降级**：`service.json` 或 API 不可用时记录一次警告并退回旧行为（直接发送），避免守护被卡死
- 等待原因、排队条数、5 分钟心跳与超时都会写入应用内日志；界面显示「等待空闲 X 分 Y 秒」

> 若 TUI 使用 `--standalone` 或连接了另一个独立 opencode 服务，闸门无法看到该服务上的会话状态；默认 TUI 与守护共用同一个托管服务，不受影响。

### 错误分级处理

守护会对每轮累计的错误文本做分类，按类别执行不同恢复策略（详见 `src/main/errpolicy.js`）：

| 分类 | 典型错误 | 处理策略 |
|---|---|---|
| 额度不足 | 套餐/配额用尽、欠费、GLM 1308/1310/1113 | 从错误信息解析**恢复时间**（ISO / HH:MM / `5pm` / UTC / 相对时长均支持），到点自动拉起，不消耗重启次数；配置了可选模型则**立即切换备选** |
| 鉴权失败 | 401/403、密钥无效、套餐过期 1309/1311 | 有备选模型则切换；无备选直接停止并给出明确原因 |
| 触发限流 | 429、并发超限、GLM 1302 | 带时间窗则等待，否则退避 ≥ 60 秒 |
| 服务端过载 | 5xx、GLM 1305 | 常规间隔重启 |
| 网络异常 | 连接重置 / 超时 / DNS 失败 | 常规间隔重启 |
| 端口冲突 | opencode 托管服务端口被僵死进程占用 | 自动结束僵死进程后立即重试（最多 3 次） |

恢复等待上限 24 小时（防错误文案解析偏差导致无限等待）；会话闸门等待上限默认 30 分钟，可按任务调整（0 = 不限）。停止的任务不再计时，日志面板按任务/项目过滤消息。

### 会话与项目治理

- **会话管理**：优先走 opencode 本地 API（`~/.local/state/opencode/service.json` 凭据），CLI 兜底；查看全局历史会话、按项目过滤、删除会话
- **权限配置**：读写项目 `opencode.json[c]` 的 `permission` 块（edit / webfetch / bash 模式），保守 JSONC 解析，失败绝不写盘
- **attach 服务**：健康检查与一键重启（Web 审批界面）
- **模型候选**：聚合全局 opencode 配置的 provider 段与 `opencode models` 查询结果

### 桌面集成

- 系统托盘（状态汇总、逐任务启停、全部启动/停止）、关闭到托盘、开机自启
- 提示词预设与变量：`{{project}}` `{{date}}` `{{time}}`
- 日志：全量输出落盘 + 应用内语义化日志（AI 文本 / 工具调用 / 错误，环形缓冲）
- 便携模式：安装目录可写时配置存 `exe 同级 data/`，否则回退系统 userData
- 孤儿守护清理：异常退出后下次启动回收残留的 opencode 进程

## 快速开始

### 安装使用（推荐）

从 `dist/OpenCodeLoop-Setup-0.1.0.exe` 安装（NSIS，可选安装目录，创建桌面快捷方式）。

前置要求：本机已安装 `opencode` CLI（PATH 可见，或在设置中指定完整路径）。

1. 新建任务 → 选择项目目录，名称自动取目录名
2. 按需调整提示词 / 会话策略 / 模型链（默认提示词即「读 `.progress.md` 续做直到 DONE」实战版）
3. 启动守护，最小化到托盘即可

### 开发运行

```powershell
npm install       # 安装依赖
npm run dev       # 开发模式（electron-vite dev）
npm run test      # vitest 单元测试（106 例）
npm run dist      # 打包 Windows 安装包
```

> UxKit 组件库通过 `@ux/*` 别名解析：优先取本地 `../UX-FRW/packages`（源码直连），否则回退 `vendor/uxkit`（可用 `npm run sync-ux` 从上游同步生成）。

## 任务配置速查

| 字段 | 说明 |
|---|---|
| 项目目录 | 守护的工作目录，也是默认日志位置 `<项目>\keep-alive.log` |
| 会话策略 | `last` 每轮 `-c` 续最近会话；`id` 固定 `-s`；`new` 每轮新会话 |
| 主力/可选模型 | `provider/model` 格式；不配置则用会话默认模型 |
| 重启间隔 / 上限 | 失败后等待秒数；上限 0 = 无限重启 |
| 会话等待上限 | 目标会话运行中 / 有排队消息时最多等待的分钟数（0 = 不限，默认 30）；超时后继续发送并告警 |
| 提示词 | 每轮传给 opencode 的指令，支持 `{{project}}` 等变量 |
| 完成标记 | 输出中出现该字样即本轮完成（默认 `DONE`） |
| 完成后 | 停止守护，或自动下一轮（迭代模式 + 总轮数上限） |
| 自动批准 | `--auto`，无人值守必备；关闭则每轮等待手动授权 |

## 项目结构

```
src/
  main/            # Electron 主进程
    index.js       # 窗口/托盘/菜单/IPC/DaemonManager
    daemon.js      # 守护引擎（状态机：stopped→running⇄waiting→done|error）
    sessiongate.js # 会话闸门与会话租约（纯函数：运行/排队检测、等待上限）
    errpolicy.js   # 错误分类与分级恢复策略（纯函数）
    opencode.js    # opencode CLI / 本地 API / 项目配置桥接
    store.js       # 配置持久化（原子写盘，v1→v2 迁移）
    orphan.js      # 孤儿守护进程清理
    attachctl.js   # attach 服务重启 / 端口冲突修复
    envdetect.js   # 环境诊断
  preload/         # contextBridge 桥接
  renderer/src/    # Vue 3 渲染层（任务/会话/权限/提示词/设置五视图）
tests/             # vitest 单元测试
scripts/           # dist-win.mjs 打包 / UxKit 别名与同步
```

## 打包说明

`npm run dist`（即 `scripts/dist-win.mjs`）= `electron-vite build` + `electron-builder --win`，并自动处理三件事：

1. 规避 Vite 在含空格共享名（如 `\\vmware-host\Shared Folders`）上的 `net use` 路径误映射
2. `node_modules/electron/dist` 缺失时回退 `%LOCALAPPDATA%\electron\Cache` 的运行时 zip
3. 项目在网络盘时产物先落本地临时目录，完成后回拷 `dist/`（文件名空格转连字符）

## 数据与日志位置

| 内容 | 位置 |
|---|---|
| 应用配置 | 便携模式：`<exe>\data\config.json`；否则 `%APPDATA%\opencodeloop\config.json` |
| 主进程日志 | `<userData>\logs\main-YYYYMMDD.log` |
| 任务守护日志 | 默认 `<项目>\keep-alive.log`，可按任务自定义 |
| opencode 凭据 | `~/.local/state/opencode/service.json`（只读） |

## License

MIT © Aides
