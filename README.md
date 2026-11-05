# Packdeck — DSH 本地程序管理插件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/looopmax/dsh-packdeck)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#平台要求)

在 DeepSeek Harness 左侧栏加入 **Packdeck** 入口，用一个面板统一管理本机的程序、语言生态包与编辑器扩展：
winget 应用，Node.js / Python / Rust / Go / Ruby / .NET 的全局包，以及 VS Code / Cursor / PinK 的扩展。
查看版本、检查更新、安装、更新、卸载，应用与扩展的**真实 logo 自动检索**，并把**正在运行的进程绑定到对应程序**。

界面按设计稿 `Packdeck — 本地程序管理` 落地：内栏（概览 / 可更新 / 运行中 / **按语言与类别分组的来源**）＋ 主栏
（统计卡、表格、抽屉详情、批量更新、安装对话框、toast、底部状态条）。

## 快速开始

```powershell
plugin_manager install_bundle target=github:looopmax/dsh-packdeck
```

装好后左侧栏出现 **Packdeck** 图标，点开即是面板。其他安装方式见[安装](#安装)。

## 平台要求

- **Windows 10/11**（进程绑定与 winget 依赖 Win32 API；其余包管理器在任何平台都由各自 CLI 决定）
- **DeepSeek Harness** 已安装并可运行
- 可选：`python` + `psutil`（用于读取进程环境变量；缺失时自动降级，不会报错）

## 能力矩阵

| 分组 | 管理器 | 列表 / 版本 | 检查更新 | 搜索安装 | 更新 | 卸载 | 备注 |
|---|---|---|---|---|---|---|---|
| 系统 | winget | ✓ | ✓ `winget upgrade` | ✓ | ✓ | ✓ | 定宽表按显示宽度解析 |
| Node.js | npm / pnpm / bun / yarn | ✓ | ✓ registry | ✓ | ✓ | ✓ | 四种全局根目录各自解析 |
| Python | uv（tool）/ pip | ✓ | ✓ PyPI | ✗（uv/pip） | ✓ | ✓ | pip 覆盖当前解释器 site-packages |
| Rust | cargo | ✓ | ✓ crates.io | ✓ | ✓ | ✓ | `cargo install --list` |
| Go | go | ✓ | ✗ | ✗ | ✓（重装最新） | ✗ | 无官方卸载 |
| Ruby | gem | ✓ | ✓ rubygems | ✓ | ✓ | ✓ | |
| .NET | dotnet tool | ✓ | ✓ NuGet | ✓ | ✓ | ✓ | |
| 编辑器扩展 | vscode / cursor / pink（+ code-insiders / windsurf 描述符） | ✓ | ✗ | ✗（按 ID 直装） | ✓（重装为最新） | ✓ | 由 CLI 的 `--list-extensions --show-versions` 驱动 |

- **自动检索**：启动与 `重新检测` 时并行探测整个目录（PATH+PATHEXT 解析可执行文件 → 版本命令 → 解析版本），
  并发 ≤ 6、总预算 15 s、结果缓存 60 s。没装的管理器不会消失，而是收进内栏底部「未检测到（N）」折叠区并给出原因；
  未检测到的管理器**永不 spawn**。
- **能力驱动 UI**：`checkUpdates / search / install / update / uninstall / reveal` 由后端 `capabilities` 决定，
  前端不含任何按管理器 id 分支的逻辑。
- **语言分组**：内栏按后端 `groups[]` 渲染（系统 / Node.js / Python / Rust / Go / Ruby / .NET / 编辑器扩展），
  组头显示 `可用/总数`，点击即按组筛选。
- **logo 自动检索**：扩展取扩展目录 `package.json.icon`；winget 应用取 ARP `DisplayIcon`（`.ico` 直出，
  `.exe` 用 `System.Drawing` 提取成 PNG 并缓存）；语言生态包没有通用 logo，回退到管理器字形。

## 安装

包名 `dsh-packdeck`，产物是一个标准 npm tarball（46 个文件，约 178 KB，无运行时依赖）。

```powershell
# 推荐：直接从 GitHub 安装（无需 npm 账号，全网可访问）
plugin_manager install_bundle target=github:looopmax/dsh-packdeck

# 从本地目录（开发用，pnpm link 进 profile）
plugin_manager install_bundle target=C:\Users\Administrator\Code\SUD-GLOBAL\plugins\dsh-package-manager

# 从打包产物
npm pack
plugin_manager install_bundle target=<绝对路径>\dsh-packdeck-1.0.0.tgz
```

- 首次安装通过 HMR 立即生效（无需重启）。
- **修改过 Host 代码（`index.js`/`lib/**`）后需要重启 DSH 应用**：Loader 会在进程内缓存已导入的模块代次，
  单纯重新启用 bundle 不会加载新的 Host 模块。前端代码（`client.js`）改动由 HMR 自动替换。
- 卸载：`plugin_manager remove_bundle target=dsh-packdeck`。
- 发布前自检：`npm pack --dry-run --json` 确认 `native/*.cs`、`native/*.ps1`、`tools/*`、`client.js`、
  `cordis.patch.yml`、`locale/*.json`、`icon.svg` 都在清单里 —— 缺 `native/` 会让进程功能整体失效（见 CONTRACT §15）。

## 架构

```
左侧栏 sidebar.panellist[id=packdeck]  ──┐
                                        ├─ client.js（浏览器半：纯 JS + React.createElement，无构建）
主栏 main[key=packdeck]  ──────────────┘        │
                                                │ POST /packdeck/api   {action, ...}
                                                │ GET  /packdeck/icon?id=…&r=…   （真实 logo 字节）
                                                ▼
                          entry.js（Host 半入口）+ lib/*（仅 node:* 内置模块）
                                                │
                    winget / npm / pnpm / bun / yarn / uv / pip / cargo / go / gem / dotnet
                    code / cursor / pink（编辑器扩展 CLI）
```

- **Host 入口是 `entry.js`**，`index.js` 只是同名再导出别名（`package.json` 的 `exports["."]` 指向 `entry.js`）。这样 Loader 导入的模块 URL 在容器里保持稳定：运行中的 Host 不会重新求值已缓存的 ESM URL，入口换名是唯一不重启就换代码的办法。
- 导出形式必须是**命名导出** `export const name / export const inject / export function apply`，**不要加 `export default`**：Loader 若拿到 default 对象就会丢掉 `inject`，表现为"插件已激活但路由不存在"。
- 路由：`ctx.webServer.register({ kind:'exact', path })` 注册 `/packdeck/api`（POST 动作、GET 健康探针）与 `/packdeck/icon`（GET 图片）；同源校验（`Origin` 必须匹配 `Host`），无第三方依赖、无构建步骤。
- 协议：[`docs/CONTRACT.md`](docs/CONTRACT.md)（§1–§6 v1，§7 v2 分组/检测，§8 v2.1 logo，§11–§12 v3 进程，§14 收尾复核）。
  动作：`snapshot` `detect` `check-updates` `install` `update` `uninstall` `search` `detail` `reveal`
  `processes` `process-detail` `process-kill` `launch`。
- 样式：只使用 `--dsw-alias-*` 主题 token + 一个强调色 `--pk-amber`，跟随浅色/深色主题。
- 表格列：项目 / 来源 / 当前版本 / 最新版本 / 体积 / 状态。体积来自三级来源（winget 的注册表 `EstimatedSize`、包目录有界遍历、扩展目录遍历），实测 82/201 个条目有值，其余显示 `—`（系统层面就没有体积数据，不编数）；冷快照成本约 +0.2~1.6 s，详见 [`docs/CONTRACT.md`](docs/CONTRACT.md) §15。视口 ≤ 1500px 时隐藏"来源"列，更窄时先隐藏"体积"列，把宽度让给名称，因为面板旁边还有应用自己的侧栏。
- **进程绑定**：`lib/procs.js` 把进程按可执行文件路径映射到条目（winget 走 ARP 的 `DisplayIcon`/`InstallLocation`，包管理器走各自的全局目录，编辑器走扩展/宿主进程），`processes` 有独立的 3 s 缓存，界面可见时轮询、隐藏即停。
  读取器优先级：**`native/packdeck-procs.exe`（C#/.NET，`native/build.ps1` 按需幂等编译）→ PowerShell（`Diagnostics.Process`）→ psutil**，三级都会报告自己是哪一级。
  实测：枚举 452 个进程的全部属性，.NET 约 16 ms，而全量 `Get-CimInstance Win32_Process` 约 1.5 s。
  `native/` 必须随包发布（`package.json` 的 `files` 已包含 `native/*.cs` 与 `native/*.ps1`）——运行时是从 `lib/../native` 读取源码并自行编译的，漏了这一段进程功能会整体失效。

## 正确性边界

- 服务只监听 loopback（DSH Web 服务的现状），路由做同源校验；非浏览器本地进程仍可直接 POST，与本机其它 CLI 等价。
- 交互式提示一律关闭（winget `--disable-interactivity --accept-source-agreements`，安装另加 `--accept-package-agreements --silent`；
  pip `uninstall -y`；gem `uninstall -x -I`）；变更类操作串行执行并带超时与进程树终止。
- 失败会把退出码（十进制 + 十六进制）与输出尾部（≤ 12 KB）带回界面。
- logo 路由只按 itemId 解析，绝不接受客户端传入的任意路径；解析结果 `realpath` 后必须仍在允许的根目录内。
- 进程 kill 只接受**最近一次绑定快照里出现过的 PID**，一次只杀一个进程（不带 `/T`），探针默认 dry-run。
- 环境变量只回传给本机界面、从不写日志；单帧最多读 8 个进程的环境变量，其余标记 `envCode:'limited'`（这是采样预算，不是失败——前端必须与 `envError` 区分，见 CONTRACT §12.1）。

## 开发与自测

```powershell
node --check index.js ; node --check client.js
node tools\probe.mjs                                  # 快照摘要 + 解析断言
node tools\probe.mjs --action detect                  # 逐个管理器的 detected/version/reason
node tools\probe.mjs --action icons                   # 每个来源有多少条目拿到了 logoUrl
node tools\probe.mjs --action icon --id vscode:dbaeumer.vscode-eslint
node tools\probe.mjs --action check-updates --manager pip
node tools\probe.mjs --action search --manager winget --query 7zip
node tools\probe.mjs --action commands                # 只构造命令行，不执行
node tools\probe.mjs --action process-detail --id <itemId>        # 含 snapshot 预热，等价 UI 时序
node tools\probe.mjs --action process-kill --pid <pid>            # 默认 dry-run，--force 才真杀
node tools\probe.mjs --action launch --id <itemId> --dry-run       # 只解析可执行文件，不启动
```

> 单独跑 `--action processes` 永远得到 `materialSource:empty` / `matched:0`：probe 是短进程，内存缓存不跨进程，从没跑过 `snapshot` 就没有条目物料。这是**探针测法的限制**，不是缺陷；验证真实时序请用 `--action process-detail`（它内置 snapshot 预热，`warmUpMs` 单独计时）。

`tools/probe.mjs` 的 `--dry-run` 只存在于探针：HTTP 接口永远不接受 dryRun，避免 UI 误把变更当演练。
