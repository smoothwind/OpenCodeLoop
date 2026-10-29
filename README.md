# OpenCodeLoop

OpenCode 无人值守守护管理台 — 让 `opencode run` 像守护进程一样持续迭代你的项目，直到任务完成。

OpenCodeLoop 是 [OpenCode](https://opencode.ai) 的桌面伴生工具（Electron + Vue 3）：为每个项目配置一条提示词，守护进程循环拉起 `opencode run`，退出即按间隔重启，直到输出中出现完成标记（默认 `DONE`）才停。前身是单任务脚本 `keep-alive.ps1`，现已进程化为多任务管理台。

[![Release](https://github.com/smoothwind/OpenCodeLoop/actions/workflows/release.yml/badge.svg)](https://github.com/smoothwind/OpenCodeLoop/actions/workflows/release.yml)
[![Pages](https://github.com/smoothwind/OpenCodeLoop/actions/workflows/pages.yml/badge.svg)](https://github.com/smoothwind/OpenCodeLoop/actions/workflows/pages.yml)
[![GitHub release](https://img.shields.io/github/v/release/smoothwind/OpenCodeLoop)](https://github.com/smoothwind/OpenCodeLoop/releases)

## 功能特性

### 多任务守护

- **任务卡片 / 列表**：同时守护多个项目，逐任务启停、立即重启、查看轮数 / 退出码 / 本轮时长 / 实际模型
- **会话策略**：最近会话（`-c` 续写）/ 指定会话（`-s`）/ 每轮新会话
- **会话闸门**：每轮发送前通过 opencode 本地 API 检测目标会话是否正在运行（TUI / 桌面端）或仍有排队消息；忙碌时等待空闲再发送（默认最多 30 分钟，可配置），避免 `opencode run` 以 steer 方式插入正在执行的回合
- **停止即中断**：停止守护 / 立即重启时调用 opencode 的 interrupt 接口结束服务器端 agent loop，而不是只杀掉本地 CLI 进程
- **模型链**：主力模型 + 可选模型列表。运行中一旦识别到额度不足 / 鉴权失败，**立即中止本轮并切到备选**（不再等 CLI 重试或重启间隔）；为该模型记录冷却窗口（取错误里的恢复时间，但不超过探活间隔，默认 60 秒可调）；探活到恢复即自动切回主力，避免在两模型之间反复摇摆。全部备选也都受限时按最早解封时刻继续探活，不会停止守护；只有全部模型都鉴权失败才停止。充值或提前解封后，也可在任务卡片点「切回主力」立即重试。其他错误仍按「连续失败顺延、成功一轮后回到主力」处理
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
5. 等待超过任务的「会话等待上限」（默认 30 分钟，0 = 不限）后，按任务的「等待超时后」处置：继续发送并告警（默认），或停止守护

**等待期处置手段**（任务卡片在会话等待中显示）：

- **中断会话**：调用 opencode 的 interrupt 接口打断目标会话正在执行的回合（TUI/其他客户端），其空闲后本轮自动发送
- **跳过等待**：本轮不再等待会话空闲，立即发送提示词（进程内租约仍然生效，不会与其他守护任务并发投递）
- **立即重启**：唤醒并重新探测目标会话状态，不结束守护

其他保护：

- **单会话租约**：进程内同一会话同时只允许一个守护发送，避免多个任务共用同一会话时并发投递
- **停止即中断**：停止 / 立即重启时调用 `POST /api/session/{id}/interrupt` 结束服务器端执行；只 kill CLI 不会终止服务器端 agent loop
- **降级**：`service.json` 或 API 不可用时记录一次警告并退回旧行为（直接发送），避免守护被卡死
- 等待原因、排队条数、5 分钟心跳与超时都会写入应用内日志；界面显示「等待空闲 X 分 Y 秒」

> 若 TUI 使用 `--standalone` 或连接了另一个独立 opencode 服务，闸门无法看到该服务上的会话状态；默认 TUI 与守护共用同一个托管服务，不受影响。

### 更新检测（只提醒，不自动下载）

- 启动后自动检查一次（可在「设置 → 更新检测」关闭）；也可在设置页或菜单「帮助 → 检查更新…」手动检查
- 更新源为 GitHub Releases（读取打包生成的 `app-update.yml`），仅比较版本号并展示发布说明，**绝不自动下载 / 安装**
- 发现新版本时弹出提醒并在设置页提供「前往发布页」按钮，升级由用户自行下载完成
- 更新源不可达 / 尚无发布版本时安静降级，说明原因即可，不影响守护运行

### 错误分级处理

守护会对每轮累计的错误文本做分类，按类别执行不同恢复策略（详见 `src/main/errpolicy.js`）：

| 分类 | 典型错误 | 处理策略 |
|---|---|---|
| 额度不足 | 套餐/配额用尽、欠费、GLM 1308/1310/1113 | 运行中一旦识别即**中止本轮并立即切换备选**（有备选时不再等重启间隔）；无可用备选（没配置，或备选都在冷却）则**继续等待/探活，不停止、不消耗重启次数**——有恢复时间就取恢复时间，没有也按探活间隔（默认 60 秒）重试。充值/解封后**自动切回**，也可手动「切回主力」 |
| 鉴权失败 | 401/403、密钥无效、套餐过期 1309/1311 | 有可用备选则切换；其他模型只是额度/限流冷却时，等它解封后重试；只有所有模型都是鉴权问题（或没有任何其他模型）才停止并给出明确原因 |
| 触发限流 | 429、并发超限、GLM 1302 | 带时间窗则等待，否则退避 ≥ 60 秒 |
| 服务端过载 | 5xx、GLM 1305 | 常规间隔重启 |
| 网络异常 | 连接重置 / 超时 / DNS 失败 | 常规间隔重启 |
| 端口冲突 | opencode 托管服务端口被僵死进程占用 | 自动结束僵死进程后立即重试（最多 3 次） |

**全部模型都不可用时**：守护不会盲目停止。额度/限流受限的模型会按各自冷却时间排队，守护在**最早解封时刻**提前试探（冷却上限即探活间隔，默认 60 秒），界面显示「模型链均受限」与预计重试时间；期间可随时点「切回主力」或「停止」。唯一会主动停止的情况是**所有模型都鉴权失败**（密钥/套餐问题，等待无意义）。非额度类错误（网络/服务端/未知）仍按模型链顺延 + 常规重启间隔重试，受任务的重启次数上限约束。

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
- 配置位置：安装版默认存系统 userData（`%APPDATA%\opencodeloop`），**重装/升级保留任务、预设与设置**；需要随目录携带时，在 exe 同级放一个 `portable` 标记文件即启用便携模式（配置写 `<exe>\data\`，只读时回退 userData）
- 孤儿守护清理：异常退出后下次启动回收残留的 opencode 进程

## 快速开始

### 安装使用（推荐）

从 `dist/OpenCodeLoop-Setup-0.1.3.exe` 安装（NSIS，可选安装目录，创建桌面快捷方式）；或从 [GitHub Releases](https://github.com/smoothwind/OpenCodeLoop/releases/latest) 下载最新版本。

前置要求：本机已安装 `opencode` CLI（PATH 可见，或在设置中指定完整路径）。

1. 新建任务 → 选择项目目录，名称自动取目录名
2. 按需调整提示词 / 会话策略 / 模型链（默认提示词即「读 `.progress.md` 续做直到 DONE」实战版）。模型统一通过「查询模型」候选列表点选：点击候选设为主力，点右侧 + 加入备选；备选可添加多个并调整顺位/移除，无需手动输入
3. 启动守护，最小化到托盘即可

### 开发运行

```powershell
npm install       # 安装依赖
npm run dev       # 开发模式（electron-vite dev）
npm run test      # vitest 单元测试（139 例）
npm run dist      # 打包 Windows 安装包
```

> UxKit 组件库通过 `@ux/*` 别名解析：优先取本地 `../UX-FRW/packages`（源码直连），否则回退 `vendor/uxkit`（可用 `npm run sync-ux` 从上游同步生成）。

## 任务配置速查

| 字段 | 说明 |
|---|---|
| 项目目录 | 守护的工作目录，也是默认日志位置 `<项目>\keep-alive.log` |
| 会话策略 | `last` 每轮 `-c` 续最近会话；`id` 固定 `-s`；`new` 每轮新会话 |
| 主力/可选模型 | `provider/model` 格式；不配置则用会话默认模型。主力额度/限流/鉴权失败后立即按可选列表降级（默认每 60 秒探活主力），解封/充值后自动切回，也可手动「切回主力」 |
| 重启间隔 / 上限 | 失败后等待秒数；上限 0 = 无限重启 |
| 会话等待上限 | 目标会话运行中 / 有排队消息时最多等待的分钟数（0 = 不限，默认 30） |
| 等待超时后 | 等待超过上限仍忙碌时：继续发送并告警（默认），或停止守护 |
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
    updater.js     # 更新检测（GitHub Releases 版本比较，只提醒不下载）
    errpolicy.js   # 错误分类与分级恢复策略（纯函数）
    opencode.js    # opencode CLI / 本地 API / 项目配置桥接
    store.js       # 配置持久化（原子写盘，v1→v2 迁移）
    orphan.js      # 孤儿守护进程清理
    attachctl.js   # attach 服务重启 / 端口冲突修复
    envdetect.js   # 环境诊断
  preload/         # contextBridge 桥接
  renderer/src/    # Vue 3 渲染层（任务/会话/权限/提示词/设置五视图）
tests/             # vitest 单元测试
scripts/           # dist-win.mjs 打包 / after-pack.mjs 体积裁剪 / UxKit 别名与同步
site/              # GitHub Pages 落地页（静态站点）
vendor/uxkit/      # 内置 UxKit（CI 构建用，npm run sync-ux 生成）
.github/workflows/ # CI：Release（构建+发布）/ Pages（站点部署）
```

## 打包说明

`npm run dist`（即 `scripts/dist-win.mjs`）= `electron-vite build` + `electron-builder --win`，并自动处理三件事：

1. 规避 Vite 在含空格共享名（如 `\\vmware-host\Shared Folders`）上的 `net use` 路径误映射
2. `node_modules/electron/dist` 缺失时回退 `%LOCALAPPDATA%\electron\Cache` 的运行时 zip
3. 项目在网络盘时产物先落本地临时目录，完成后回拷 `dist/`（文件名空格转连字符）

安装包统一命名为 `OpenCodeLoop-Setup-<version>.exe`（`electron-builder.yml` 的 `artifactName`），与 Release 资产和更新检查保持一致。

### 安装包体积

Electron 运行时本身约占 90 MB（`OpenCodeLoop.exe` 235 MB 经 LZMA 压缩），是本项目安装包的主要体积来源。已做的裁剪：

| 措施 | 效果 |
|---|---|
| `win.electronLanguages: [zh-CN, en-US]` | Electron 语言包 48.3 MB → 1.1 MB |
| `vue` 移到 devDependencies + `!node_modules/**` | `app.asar` 15.5 MB → 0.6 MB（渲染层已由 Vite 打包） |
| `compression: maximum` | 7za 以最高压缩级别打包应用 |
| `scripts/after-pack.mjs` 删除 `dxcompiler.dll` / `dxil.dll` | 再减约 6 MB（仅 WebGPU/DX12 使用；界面与 WebGL 不受影响） |
| `build/installer.nsh` 清理旧版本残留 | 覆盖升级时删除旧语言包与 DXIL 编译器，避免磁盘残留约 73 MB |

当前安装包 91.6 MB。若后续需要 WebGPU，移除 `electron-builder.yml` 中的 `afterPack` 即可恢复；进一步显著缩小体积只能更换运行时（如 Tauri）或改用 `nsis-web` 在线安装包（首次安装需联网）。

## 自动构建与发布

仓库内置两条 GitHub Actions 工作流：

| 工作流 | 触发条件 | 作用 |
|---|---|---|
| `Release` | 推送 `v*` tag / 手动运行 | Windows 上执行 `npm ci` → `npm test` → `npm run dist`；tag 构建自动创建 GitHub Release 并上传安装包、blockmap、`latest.yml`；手动运行只上传构建产物（artifact） |
| `Deploy Pages` | 推送 `site/**` 或手动运行 | 将 `site/` 发布到 GitHub Pages |

### 发布新版本

1. 升级版本号并更新 README 中的安装包文件名：
   ```powershell
   npm version patch --no-git-tag-version
   ```
2. 提交并推送
3. 打 tag 并推送：
   ```powershell
   git tag v0.1.3
   git push origin v0.1.3
   ```

工作流会先校验 tag 与 `package.json` 版本一致，再构建并发布。发布产物包括 `OpenCodeLoop-Setup-<version>.exe`、`*.exe.blockmap`、`latest.yml`。

### GitHub Pages

首次使用需在仓库 **Settings → Pages → Source** 选择 **GitHub Actions**（私有仓库需所在计划支持 Pages）。

站点地址：`https://smoothwind.github.io/OpenCodeLoop/`。页面仅依赖静态文件，版本号与下载链接会在浏览器端从 GitHub Releases API 自动更新。

### 更新源与发布仓库

应用内更新检测读取打包生成的 `app-update.yml`（`publish` 配置见 `electron-builder.yml`），查询 GitHub Releases 最新版本。**发布仓库需要公开**（私有仓库的未认证 API 查询会返回 404）；否则应用会提示「更新源还没有发布版本」或检查失败。更新检测只提醒，不自动下载。

### CI 与 UxKit

渲染层通过 `@ux/*` 别名引用 UxKit：本地优先 `../UX-FRW/packages`，否则回退 `vendor/uxkit`。`vendor/uxkit` 已随仓库提交，CI 不依赖外部目录。更新组件库后执行：

```powershell
npm run sync-ux
```

## 数据与日志位置

| 内容 | 位置 |
|---|---|
| 应用配置 | 默认 `%APPDATA%\opencodeloop\config.json`（重装/升级保留）；exe 同级存在 `portable` 标记文件时用 `<exe>\data\config.json` |
| 主进程日志 | `<userData>\logs\main-YYYYMMDD.log` |
| 任务守护日志 | 默认 `<项目>\keep-alive.log`，可按任务自定义 |
| opencode 凭据 | `~/.local/state/opencode/service.json`（只读） |

新版配置默认落在系统 userData：覆盖安装或卸载重装时，安装器会先把旧版 `<exe>\data\config.json` 备份到 `%APPDATA%\opencodeloop\reinstall-backup.json`，新版启动后自动恢复到正式配置；卸载时不会删除 `%APPDATA%\opencodeloop`。旧版遗留的 `data/config.json` 也会在首次启动时自动迁移。

## License

MIT © Aides
