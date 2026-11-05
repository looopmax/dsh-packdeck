# Packdeck — 契约（Host ⇄ Client）

本文件是前端（`client.js`）与后端（`index.js` / `lib/*`）之间的唯一接口约定。
两侧都必须严格按本文件实现；任何一侧想改协议，都先改本文件。

设计稿（视觉与交互的唯一权威）：
`C:\Users\Administrator\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\3b48dc3a-17a2-4f7d-8a8c-52bf4137d244\index.html`
（`<title>Packdeck — 本地程序管理`，CSS 在第 8–790 行，结构在 792–955 行，渲染逻辑在 956 行之后）

## 0. 文件归属（写作用域，勿越界）

| 文件 | 归属 |
|---|---|
| `package.json`, `cordis.patch.yml`, `locale/*.json`, `icon.svg`, `docs/CONTRACT.md` | Lead |
| `index.js`, `lib/**`, `tools/**` | 后端子智能体 |
| `client.js` | 前端子智能体 |

## 1. 传输

- 浏览器 `POST /packdeck/api`，JSON body。
- Host 侧用 `ctx.webServer.register({ kind: 'exact', path: '/packdeck/api', handler })` 注册；`handler(req, res)` 自己写响应。
- 响应 `Content-Type: application/json; charset=utf-8`。
- 只接受 `POST`；其它方法 405。`Origin` 存在时必须与请求 `Host` 同源，否则 403（防跨站）。
- 请求体积上限 64 KiB；响应允许最大 ~256 KiB。
- 每个请求必须是对象 `{ "action": string, ... }`。

成功：`{"ok":true,"data":{...}}`
失败：`{"ok":false,"error":{"code":"...","message":"...","log":"..."}}`
`code` 取值：`bad-request` `unknown-action` `unavailable` `timeout` `command-failed` `parse-failed` `internal`。
`message` 面向用户，中文、一句话；`log` 可选，原样命令输出尾部（≤ 12 KB，仅排错用）。

## 2. Actions

### 2.1 `snapshot`
请求：`{"action":"snapshot"}`
本地快速读取，**不做网络请求**，目标 < 6 s。

```json
{
  "at": 1762300000000,
  "platform": "win32",
  "managers": [
    {
      "id": "winget",
      "label": "winget",
      "vendor": "Microsoft",
      "scopeLabel": "系统应用",
      "available": true,
      "version": "v1.29.380",
      "root": "C:\\Program Files",
      "error": null
    }
  ],
  "items": [
    {
      "id": "winget:7zip.7zip",
      "manager": "winget",
      "name": "7-Zip 26.03 (x64 edition)",
      "packageId": "7zip.7zip",
      "source": "winget",
      "kind": "app",
      "scope": "系统应用",
      "cwd": null,
      "path": "C:\\Program Files\\7-Zip",
      "version": "26.03.00.0",
      "latest": "26.05",
      "hasUpdate": true,
      "description": null,
      "sizeBytes": null,
      "installedAt": null,
      "managerVersion": "v1.29.380"
    }
  ],
  "stats": {
    "total": 149,
    "updatable": 28,
    "managersAvailable": 4,
    "disk": { "freeBytes": 137000000000, "totalBytes": 512000000000, "mount": "C:" }
  }
}
```

规则：
- `manager` ∈ `winget` | `npm` | `pnpm` | `bun`；`kind`：winget → `"app"`，node 系 → `"pkg"`。
- `id` 必须为 `manager + ":" + packageId`，全局唯一，前端用它做 key。
- `source`：winget 行取 winget 输出里的 Source（`winget` / `msstore`，缺省 `winget`）；node 系取 `manager`。
- `version` 未知时用 `""`；`latest` 未知时用 `null`（前端显示「—」）；`hasUpdate` 由后端给出，等价于 `latest != null && latest !== version && semverishGreater(latest, version)`（非 semver 时退化为字符串不相等）。
- 不可用的管理器出现在 `managers` 里且 `available:false`，`error` 写原因；不产出 items。
- `sizeBytes` 允许为 `null`（在线列表不做体积统计）；`detail` 动作才计算。
- node 系 `installedAt` 不做保证，可为 `null`。
- `items` 只包含**全局**安装的包（winget list / npm、pnpm、bun 的 global root）。
- 排序：前端自己排，后端按 `manager` 分组输出即可。

### 2.2 `check-updates`
请求：`{"action":"check-updates","manager":"npm"}`
需要网络，最长 90 s。返回：

```json
{ "manager":"npm", "checkedAt":1762300000000,
  "updates":[{"id":"npm:typescript","packageId":"typescript","version":"5.7.2","latest":"5.9.3"}],
  "failed":[{"packageId":"@scope/x","message":"404 Not Found"}] }
```
- winget：跑一次 `winget upgrade --include-unknown --accept-source-agreements --disable-interactivity`，解析出 `packageId → available`。
- node 系：并发 8 个去 registry 查询（`GET {registry}/{name}/latest`，4 s 超时，UA `packdeck/1.0`）；registry 取 `npm config get registry`（失败用 `https://registry.npmjs.org/`），确保结尾带 `/`。
- 端点失败不该整体失败：进 `failed`。
- 前端拿到后只更新对应 items 的 `latest` / `hasUpdate`，不整表重建。

### 2.3 `install`
请求：`{"action":"install","manager":"winget","packageId":"7zip.7zip","name":"7-Zip","version":null}`
返回：`{"ok":true,"data":{"id":"...","manager":"...","packageId":"...","log":"...","durationMs":18422}}`
- winget：`winget install --id <packageId> -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`
  （`version` 非空时加 `--version <version>`）
- npm：`npm install -g <packageId>[@version] --no-fund --no-audit`
- pnpm：`pnpm add -g <packageId>[@version]`
- bun：`bun add -g <packageId>[@version]`
- 超时：winget 15 min，node 系 10 min。退出码 ≠ 0 → `command-failed`，`log` 带输出尾部。

### 2.4 `update`
请求：`{"action":"update","manager":"winget","packageId":"7zip.7zip","version":"26.05"}`
- winget：`winget upgrade --id <packageId> -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`（带 `--version` 当给出）
- npm：`npm install -g <packageId>@latest --no-fund --no-audit`
- pnpm：`pnpm update -g <packageId> --latest`
- bun：`bun update -g <packageId>`
- 返回结构同 `install`。

### 2.5 `uninstall`
请求：`{"action":"uninstall","manager":"winget","packageId":"7zip.7zip"}`
- winget：`winget uninstall --id <packageId> -e --silent --accept-source-agreements --disable-interactivity`
- npm：`npm uninstall -g <packageId>`
- pnpm：`pnpm remove -g <packageId>`
- bun：`bun remove -g <packageId>`
- 返回结构同 `install`。

### 2.6 `search`
请求：`{"action":"search","manager":"winget","query":"7zip"}`
```json
{ "manager":"winget","query":"7zip",
  "results":[{"packageId":"7zip.7zip","name":"7-Zip","version":"26.05","source":"winget","description":null}] }
```
- winget：`winget search --query <query> --accept-source-agreements --disable-interactivity`，解析同样的定宽表（列：Name Id Version Match Source），最多 40 行。
- node 系：registry 搜索 `GET {registry}-/v1/search?text=<q>&size=30`，取 `objects[].package`（`name`、`version`、`description`）。失败退化为 `npm view <q> version` 不可用时直接返回错误。
- `query` 长度 1–120。

### 2.7 `detail`
请求：`{"action":"detail","manager":"npm","packageId":"typescript"}`
```json
{ "id":"npm:typescript","manager":"npm","packageId":"typescript",
  "description":"...", "sizeBytes":23874560, "path":"C:\\...\\node_modules\\typescript",
  "license":"Apache-2.0", "homepage":"https://...", "repository":"...",
  "dependencies":[{"name":"@eslint/js","version":"9.17.0"}],
  "dependents":[], "installedAt":null, "otherVersions":null }
```
- node 系：读全局 root 下该包的 `package.json`（`description/license/homepage/repository/dependencies`），`path` 为包目录，`sizeBytes` 递归求和目录（跳过 `.bin`、符号链接跟随一次、> 40 000 项则停止并返回已统计值）。
- winget：`winget list --id <packageId> -e` 拿版本，`path` 由 `winget show`？不要求；`description` 可为 `null`，`sizeBytes` 为 `null`。
- 失败一律 `ok:false`，不要抛未捕获异常。

### 2.8 `reveal`
请求：`{"action":"reveal","manager":"winget","packageId":"7zip.7zip","path":"C:\\Program Files\\7-Zip"}`
- 仅 win32；用 `explorer.exe /select,<path>` 或 `explorer.exe <path>`（目录存在时）。返回 `{ "ok": true, "data": { "revealed": true } }`；路径未知返回 `bad-request`。
- 这是「在文件夹中显示」按钮，前端失败只弹 toast，不阻塞。

## 3. 后端实现约束

- 纯 ESM，Node ≥ 22，只允许 `node:*` 内置模块（`node:child_process`、`node:fs/promises`、`node:path`、`node:os`）。
- `apply(ctx, config)` 形态；`ctx.effect(() => { const off = ctx.webServer.register(...); return () => off?.(); })`。
  `ctx.get('webServer')` 不存在时插件安静不激活（`inject` 里列 `webServer` 亦可，但要能容忍缺失 → 用 `ctx.get` + 判空）。
- 所有外部命令统一走 `lib/run.js`：
  - `spawn`，`windowsHide: true`，`shell: false`；Windows 上 `.cmd`/`.ps1` 只有 `.cmd` 可直接 spawn（`npm.cmd`、`pnpm.cmd`），解析时优先 `.cmd` 再 `exe`，最后才 `shell:true`。
  - 环境：`{ ...process.env, NO_COLOR:'1', CI:'1', FORCE_COLOR:'0' }`，并给 `winget` 加 `--disable-interactivity`。
  - 收集 stdout/stderr（各自 ≤ 256 KiB，超出截断并标记 `truncated`），resolve `{code, stdout, stderr, durationMs, timedOut}`；超时 kill 子进程树（`taskkill /pid <pid> /T /F` on win32）。
  - 输出必须 strip ANSI（`\x1b\[[0-9;?]*[ -/]*[@-~]`）与 `\r` 覆写（保留最后一个 `\r` 之后的内容）。
- 命令解析（关键，已在本机实测）：
  - winget 表是**定宽列**、按显示宽度对齐（CJK 占 2 格）。解析步骤：找含 `Name` + `Id` 的表头行 → 下一行是全 `-` 的分隔行 → 用分隔行每段 `-` 的**字符区间**转换成显示宽度区间 → 每行按显示宽度切片（CJK/全角算 2）。分隔行可能带前导空格，需按同样偏移。尾部统计行（`28 upgrades available.`、`N 个包`）与空行跳过。
  - `winget list` 列：`Name Id Version Available Source`；`Available` 为空表示已最新。`winget upgrade` 列：`Name Id Version Available Source`（都带 Available）。
  - `npm ls -g --depth=0 --json`：`dependencies` 对象的 key 为包名，value 含 `version`；`file:`/`link:` 的 `resolved` 要保留在 note 里。
  - pnpm：`pnpm root -g` 得到 `.../global/5/node_modules`，扫描其中目录（含 `@scope/name` 两层），读 `package.json`。
  - bun：`bun pm ls -g` 首行形如 `C:\Users\x\.bun\install\global node_modules (331)` → 取路径；解析失败退回 `bun pm bin -g` 的父目录 `install/global/node_modules`。
  - npm/pnpm 的版本号取 `<cmd> --version`；bun 用 `bun --version`；winget 用 `winget --version`。
  - 可用性探测：`--version` 10 s 超时；失败则 `available:false` 且 `error` 写明。
- 互斥：所有变更类 action（install/update/uninstall）串行执行（模块内 Promise 队列），避免并发写同一个包管理器；执行中再次请求 → `command-failed`? 不，应当排队（前端本来也会串行）。
- 缓存：`snapshot` 结果缓存 15 s（按 manager），`check-updates` 结果缓存 5 min；任何变更成功后清空对应 manager 缓存。
- 日志里不要泄露完整环境变量。
- 提供 `tools/probe.mjs`：直接调用适配器打印 JSON（不依赖 cordis），供 Lead 与后端自测。**不得**在 probe 中执行 install/uninstall。

## 4. 前端实现约束

- 产物是 `client.js`，浏览器模块工厂形态，**不能用 JSX/TS/打包器**：
```js
window.__ModuleLoader__.load({
  id: '@local/packdeck',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    /* ... */
    return { inject: ['slots'], apply(ctx) { /* ctx.slots.inject(...) */ } };
  },
});
```
- 只注册两个 slot：
  - `sidebar.panellist`：`{ name:'sidebar.panellist', id:'packdeck', order: 30, label: () => 'Packdeck' }`，组件签名 `function Icon({ size, active })`，返回一个尺寸为 `size` 的 SVG（立方体 + 向下箭头，线宽 1.6，`currentColor`；`active` 时用 `var(--dsw-alias-brand-primary)`，否则 `currentColor`）。
  - `main`：`{ name:'main', key:'packdeck' }`，组件为整页 `Page`。
  - 注册必须包在 `ctx.slots.inject('sidebar.panellist'|'main', () => ctx.slots.register(...))` 内，返回 disposer 交给框架。
- 不可 `require` 任何 `@deepseek-ai/dsh-client-*` 包（React 除外）；不可读写 `document.body`；不可注入全局 CSS 之外的东西。样式通过组件内 `<style>` 元素渲染（`h('style', null, CSS)`），卸载即移除。
- 所有颜色只用：`--dsw-alias-bg-base` `--dsw-alias-bg-layer-1` `--dsw-alias-bg-layer-2` `--dsw-alias-bg-overlay` `--dsw-alias-border-l1` `--dsw-alias-border-l2` `--dsw-alias-label-primary` `--dsw-alias-label-secondary` `--dsw-alias-brand-primary` `--dsw-alias-state-error-primary` `--dsw-alias-state-success-primary` `--dsw-alias-state-warn-primary` `--dsw-alias-state-idle-primary`，外加设计稿强调色（仅强调/主按钮/选中态）：
  `--pk-amber: #f2a541; --pk-amber-ink: #191207;`（浅色主题下同样可用；不要用它做文字正文色）。
- 数字/版本号用等宽字体栈：`"Cascadia Mono", Consolas, "JetBrains Mono", monospace`；标题用 `"Bahnschrift", "Segoe UI Variable Display", system-ui, sans-serif`。
- 无障碍：`aria-current`、`role="tab"`、`role="dialog"` + `aria-modal`、`aria-live="polite"` 状态条、`aria-label` 关闭按钮、键盘 Esc 关闭抽屉/对话框、焦点还原。

### 4.1 信息架构（把设计稿的左侧栏搬进面板内部）

面板占满中间列（`height:100%; min-height:0; display:grid; grid-template-columns: 196px minmax(0,1fr)`），两栏：

**左内栏 `pk-rail`**（设计稿 `.sidebar` 的等价物）
- 品牌行：立方体图标 + `PACKDECK` + `本地程序管理`。
- 导航（`aria-current` 跟随）：
  - `概览`（全部）badge = 全部条数
  - `可更新` badge = 可更新条数
  - 分组标题 `包管理器`，其下列出 winget / npm / pnpm / bun；每行带 14px 官方 logo（用内联 SVG，见 4.4）、名称、数量 badge；`available:false` 的行整体 `opacity:.45`，右侧显示 `不可用` 小字并 `title` 写原因，点击仍可筛选（显示空态与原因）。
- 底部：磁盘用量条（`stats.disk`）+ `本地索引 · <相对时间>`。

**主栏 `pk-main`**（`display:grid; grid-template-rows:auto minmax(0,1fr) auto`）
- `topbar`：标题（概览/可更新/具体管理器名）+ 副标题（`N 个包 · M 项可更新 · 检查于 x 前`）；右侧：搜索框（262px，placeholder 随范围变化）、排序 `select`（待更新优先 / 名称 A–Z / 版本 / 来源）、`更新全部` 主按钮（badge 数量，0 时 disabled）、`安装` 次按钮。
- 滚动区：4 张统计卡（当前项目 / 待更新 / 可管理来源 / 磁盘可用）→ 列头 → 行列表 → 空态 → 脚注。
- 底部 `content-status`：`aria-live`，显示最近一次操作结果（`就绪` / `正在更新 X…` / `X 已更新至 Y` / 失败原因），右侧 `查看输出` 打开输出面板。

**行 `pk-row`**（列宽：`36px minmax(0,1.6fr) 86px 104px 172px 92px 104px 30px`）
1. 图标：`kind==='app'` 用来源字形，`kind==='pkg'` 用管理器的字形块（圆角 6px、`--dsw-alias-bg-layer-2` 底、字形色按 tone 轮转）。
2. 名称按钮：主名 + 次行（`manager · scope`），点击打开抽屉。
3. 来源 chip（`app` 显示 `source`，`pkg` 显示 `scope`）。
4. 当前版本（等宽）。
5. 最新版本：有待更新 → 版本号 + 小号 `更新` 按钮（`btn-mini`）；无 → `✓ 已是最新`；未知 → `—` + `检查`。
6. 体积：`sizeBytes` 有值 → `fmtSize`，否则 `—`。
7. 状态：`可更新`（warn 色）/ `已最新`（success 色）/ `不可用`。
8. 末尾 `›` chevron（打开抽屉）。

**抽屉 `pk-drawer`**：右侧 396px 面板 + scrim，`role="dialog" aria-modal="true"`；头部（28px 图标、名称、`manager · scope · v版本`、关闭按钮）、动作行（`更新至 X` 主按钮 / `安装` / `卸载` 危险按钮 / `在文件夹中显示`）、tabs（概览 / 命令）、概览内容（基本信息 `path`、`license`、`installedAt`、`sizeBytes`、`description`、依赖计数），命令 tab 显示该包的最近一次命令输出（等宽、可滚动、`pre`）。

**批量更新对话框**：原生 `<dialog>`；标题 `更新所选项目`，副标 `将依次执行 N 项更新`；列表每行 checkbox + 名称 + `当前 → 最新` + 来源；底部汇总 `N 项`，按钮 `取消` / `开始更新`；开始后锁定，进度条 + `正在更新 X（i / N）`；全部结束后关闭 + toast `N 项更新完成`。

**安装对话框**：标题 `安装包`；管理器切换（segmented，不可用置灰）+ 搜索框 + `搜索` 按钮 → 结果列表（名称、packageId、版本、来源、`安装` 按钮）；安装中该行显示 `安装中…`；成功后关闭 + toast + 刷新快照。

**Toast**：右下角，3.2 s 自动消失，`role="status"`。

### 4.2 状态机
- `loading`（首次 snapshot）：主区骨架 3 行 + 状态条 `正在读取本地索引…`。
- `ready`：正常。
- `error`：顶部内联错误条（`无法读取本地索引：<message>`）+ `重试` 按钮；结果为空时保留空态。
- 每个变更动作的行级状态：`idle | running | done | failed`，只影响该行按钮与状态列；批量时锁定所有行按钮。
- `check-updates` 进行中：`更新全部` 旁的按钮显示 `检查中…`；`检查` 按钮转圈。

### 4.3 文案（中文，标点用中文全角）
`概览 / 可更新 / 包管理器 / 更新全部 / 安装 / 搜索 / 排序 / 待更新优先 / 名称 A–Z / 版本 / 来源 / 当前项目 / 待更新 / 可管理来源 / 磁盘可用 / 已是最新 / 更新 / 检查 / 更新至 / 检查更新 / 读取索引 / 重试 / 卸载 / 在文件夹中显示 / 概览 / 命令 / 依赖 / 基本信息 / 版本 / 体积 / 许可证 / 安装时间 / 路径 / 描述 / 暂无依赖 / 安装包 / 搜索 registry / 安装中… / 更新中… / 已更新至 / 已卸载 / 已安装 / 不可用 / 本地索引 · 刚刚 / 数据来自本机包管理器 · 操作会真实修改系统`

### 4.4 图标
- 侧栏入口图标：立方体 + 向下箭头（`<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.2 7.7 7.8 4.4 7.8-4.4"/><path d="M12 12.1V21"/>` 加 `M12 17v4m0 0-2-2m2 2 2-2` 之类，24×24 viewBox）。
- 管理器 logo（内联 SVG，简化几何，不追求商标细节）：
  - npm：红色圆角方块 + 白色 `npm` 字母形（用 `<text>` 会受字体影响 → 用矩形拼 `n p m` 的像素块或路径）。
  - pnpm：橙色/琥珀色方块 + 白色 `pnpm` 字样块。
  - bun：奶油色圆 + 深色 `B` 形。
  - winget：四格蓝色方块（设计稿里的路径：`M3 5.4 10.4 4.3v7.1H3zM11.5 4.1 21 2.8v8.6h-9.5zM3 12.7h7.4v7L3 18.6zM11.5 12.7H21v8.5l-9.5-1.3z`）。
- `icon.svg`（插件清单图标）已由 Lead 提供，前端不需要引用它。

### 4.5 数据流
1. `apply` 时：建一个轻量 store（`useSyncExternalStore` 或 `useState` + 订阅），`Page` 挂载时 `snapshot`。
2. 任何变更成功 → 重新 `snapshot`（整表），并合并行级 `done` 状态；失败 → 保留旧数据 + toast + 状态条。
3. `check-updates` 返回 → 合并 `latest/hasUpdate`。
4. 自动刷新：面板可见且 60 s 未操作时可再取一次 snapshot（可选，失败静默）。
5. 所有 fetch 都带 `Content-Type: application/json`、`cache: 'no-store'`，超时用 `AbortController`（snapshot 20 s，变更 16 min）。

## 5. 验收

- `node --check index.js` / `node --check client.js` 通过。
- 安装后 `Slots.listSubTree` 的 `sidebar.panellist` occupants 出现 `packdeck`，`main` occupants 出现 `packdeck`，`active: true`。
- 页面无 `slot entry crashed`（由 Lead 检查激活状态与日志）。
- 真实数据：`snapshot` 返回本机 winget / npm / pnpm / bun 的实际全局包；`check-updates` 至少一个管理器能给出真实最新版本。
- 视觉与交互遵循设计稿：两栏、统计卡、表格列、抽屉、批量对话框、toast。

## 6. As built（实现后追认的偏差）

两侧实现完成后，以下偏差被采纳；它们不改变 §1–§4 的对外契约。

1. 传输鉴权：路由注册在 `ctx.webServer` 的 exact 路由上（`GET` 返回健康探针），并用
   `Origin`/`Host` 同源校验拦截跨站 POST；未使用 `ctx.connection.fetch`（其路径前缀语义未在
   已安装包中提供可验证的类型声明）。loopback 是本机部署的现状，非浏览器本地进程仍可直接调用。
2. `detail` 的管理器参数之外增加可选 `source`（winget 的 msstore 行区分来源）。
3. `reveal` 先 `fs.stat` 校验路径存在，再 `explorer.exe /select,<path>`；非 win32 返回 `unavailable`。
4. 变更失败的错误消息同时给出十进制与十六进制退出码（winget HRESULT），例如
   `退出码 2316632084 / 0x8A150014`；`log` 仍为输出尾部。
5. `dryRun` 仅存在于 `tools/probe.mjs`，HTTP 动作永不接受（避免 UI 误把变更当演练）。
6. 快照 `sizeBytes` 恒为 `null`（在线列表不统计体积），体积只在 `detail` 里按包目录递归求和；
   界面该列显示 `—`。
7. 面板内栏新增「安装」入口（设计稿没有）：管理器分段选择 + 搜索 + 结果行内安装，调用同一套
   `search` / `install` 动作。
8. 未实现设计稿里的「运行中 / 进程」维度：winget 与 node 全局包没有可靠的「包 → 进程」映射，
   用「状态」列（可更新 / 已最新 / 不可用）替代，避免展示编造数据。

## 7. v2：语言分组 + 包管理器自动检索 + 编辑器扩展

v2 在 v1 之上扩展目录模型与协议；§1–§6 仍然有效，冲突时以本节为准（新字段都是**新增**，v1 字段语义不变）。

### 7.1 目录模型：分类 → 语言组 / 扩展组 → 管理器

`groups`（有序）与每个 manager 的归属由后端给出，前端不要硬编码分组：

| group.id | label | kind | managers |
|---|---|---|---|
| `system` | 系统 | `system` | winget |
| `node` | Node.js | `language` | npm、pnpm、bun、yarn |
| `python` | Python | `language` | uv、pip |
| `rust` | Rust | `language` | cargo |
| `go` | Go | `language` | go |
| `ruby` | Ruby | `language` | gem |
| `dotnet` | .NET | `language` | dotnet |
| `editors` | 编辑器扩展 | `editor` | vscode、cursor、pink（检测到才出现；`code-insiders`、`windsurf` 同 descriptor） |

- `kind: 'editor'` 的条目是**编辑器扩展宿主**：一个 manager 代表一个编辑器，它的 items 是该编辑器里安装的扩展（`kind: 'ext'`）。
- 分组只为呈现与筛选；`scope` 仍然是 `all | updates | mgr:<id>`（v1 语义），v2 增加 `grp:<groupId>` 以便点击分组标题筛选。

### 7.2 自动检索（detect）

- 后端启动后第一次 `snapshot` 以及每次显式 `detect` 都要重新探测**整个目录**（不是只探测已存在的）。
- 探测规则（每个 manager）：在 `PATH` 中按 `PATHEXT` 解析可执行文件 → 跑它的版本命令（超时 6 s）→ 解析版本号。编辑器额外确认 CLI 可用（允许 `--version` 成功即可）。
- 并发上限 6，总预算 15 s；单个 manager 失败只标记该 manager（`detected:false` + `reason`），不影响其它。
- 探测结果缓存 60 s（进程内）；`detect` 强制绕过缓存。
- 未检测到的 manager 仍然出现在 `managers[]` 里（`detected:false, available:false`），`itemCount: 0`，不出现在 `groups[].managerIds` 的**可用**子集里（前端把它放进「未检测到」折叠区）。

### 7.3 协议增量

`snapshot`（与 `detect`，二者 `data` 相同，前者带 items）：

```json
{
  "at": 1762300000000,
  "platform": "win32",
  "groups": [
    { "id": "node", "label": "Node.js", "kind": "language", "order": 20,
      "managerIds": ["npm", "pnpm", "bun", "yarn"] }
  ],
  "managers": [
    { "id": "cargo", "label": "cargo", "vendor": "Rust Foundation", "kind": "language",
      "groupId": "rust", "groupLabel": "Rust", "available": true, "detected": true,
      "version": "cargo 1.85.0", "root": "C:\\Users\\x\\.cargo\\bin",
      "error": null, "reason": null, "itemCount": 0, "scopeLabel": "全局 crate",
      "capabilities": { "list": true, "checkUpdates": true, "search": true, "install": true,
                        "update": true, "uninstall": true, "detail": true, "reveal": true } }
  ],
  "items": [
    { "id": "vscode:dbaeumer.vscode-eslint", "manager": "vscode", "groupId": "editors",
      "kind": "ext", "name": "dbaeumer.vscode-eslint", "packageId": "dbaeumer.vscode-eslint",
      "source": "vscode", "scope": "编辑器扩展", "version": "3.0.34", "latest": null,
      "hasUpdate": false, "description": null, "sizeBytes": null, "path": null }
  ],
  "stats": { "total": 0, "updatable": 0, "managersAvailable": 0, "managersDetected": 0,
             "disk": { "freeBytes": 0, "totalBytes": 0, "mount": "C:" } },
  "detection": { "at": 1762300000000, "probed": 12, "found": 9, "durationMs": 2100 }
}
```

- `kind` 取值扩展为 `app | pkg | ext`。
- `capabilities` 决定 UI 是否显示某个按钮；不要用 manager id 判断。
- `itemCount` 用于内栏 badge，避免前端为了计数重算（前端仍可自行过滤）。

`detect`：请求 `{"action":"detect"}`，返回与 snapshot 同构（`items` 可以为空数组以节省负载；前端随后再取一次 snapshot）。

`check-updates`：新增 `"unsupported": true` 情形（编辑器扩展不支持版本检查）：
```json
{ "manager": "vscode", "checkedAt": 0, "updates": [], "failed": [], "unsupported": true }
```
`search`：`capabilities.search=false` 的 manager 返回 `ok:false, code:"unavailable"`；前端据 capability 隐藏搜索框，改为「输入 ID 直接安装」。

### 7.4 管理器命令表（后端实现依据）

| id | 探测（版本） | 列表 | 最新版本来源 | 安装 | 更新 | 卸载 |
|---|---|---|---|---|---|---|
| winget | `winget --version` | `winget list`（v1 解析器） | `winget upgrade --include-unknown` | `winget install --id X -e --silent --accept-…` | `winget upgrade --id X -e --silent --accept-…` | `winget uninstall --id X -e --silent` |
| npm | `npm --version` | `npm ls -g --depth=0 --json` | registry `/<pkg>/latest` | `npm install -g X[@v]` | `npm install -g X@latest` | `npm uninstall -g X` |
| pnpm | `pnpm --version` | 扫描 `pnpm root -g` | registry | `pnpm add -g X[@v]` | `pnpm update -g X --latest` | `pnpm remove -g X` |
| bun | `bun --version` | 扫描 `bun pm ls -g` 根 | registry | `bun add -g X[@v]` | `bun update -g X` | `bun remove -g X` |
| yarn | `yarn --version` | 扫描 `yarn global dir` 下的 `node_modules` | registry | `yarn global add X[@v]` | `yarn global upgrade X --latest` | `yarn global remove X` |
| cargo | `cargo --version` | `cargo install --list`（`name vX:` + 缩进二进制行） | `https://crates.io/api/v1/crates/X`（`crate.max_stable_version \|\| crate.max_version`，UA `packdeck/1.0`） | `cargo install X` | `cargo install X --force` | `cargo uninstall X` |
| uv | `uv --version` | `uv tool list`（`name vX`，`No tools installed` = 空） | `https://pypi.org/pypi/X/json`（`info.version`） | `uv tool install X` | `uv tool upgrade X` | `uv tool uninstall X` |
| pip | `pip --version` | `pip list --format=json`（**容错**：只取首个 `[...]` 块，忽略尾随文本） | PyPI | `pip install X` | `pip install --upgrade X` | `pip uninstall -y X` |
| go | `go version` | `go env GOPATH` → 扫 `bin`，逐个 `go version -m <file>` 取 `path`/`mod` 行 | 无（`latest:null`，更新=重装最新） | `go install X@latest` | `go install X@latest` | 不支持（`uninstall` 能力 false） |
| gem | `gem --version` | `gem list --local`（`name (1.2.3)`，逗号分隔多版本取第一个） | `https://rubygems.org/api/v1/gems/X.json`（`version`） | `gem install X` | `gem update X` | `gem uninstall -x X -I` |
| dotnet | `dotnet --version` | `dotnet tool list -g`（固定列：包 ID / 版本 / 命令） | `https://api.nuget.org/v3-flatcontainer/X/index.json`（最后一个非预览版本） | `dotnet tool install -g X` | `dotnet tool update -g X` | `dotnet tool uninstall -g X` |
| vscode | `code --version`（首行） | `code --list-extensions --show-versions`（`id@ver`） | 无 | `code --install-extension X --force` | `code --install-extension X --force`（重装为最新） | `code --uninstall-extension X` |
| cursor | `cursor --version` | `cursor --list-extensions --show-versions` | 无 | 同上 | 同上 | 同上 |
| pink | `PinK --version` | `PinK --list-extensions --show-versions` | 无 | 同上 | 同上 | 同上 |
| code-insiders / windsurf | 同 vscode descriptor，探测到才出现 | | | | | |

补充规则：
- 编辑器条目：`capabilities.checkUpdates=false`、`search=false`、`update=true`（语义为「重装为最新」）；`scopeLabel` = `编辑器扩展`。
- editor items 的 `id` = `<manager>:<扩展 id>`，`packageId` = 扩展 id，`name` 同 packageId（前端可缩短显示，如去掉发布者前缀前的冗余）。
- pip 的语义是「当前 Python 环境（site-packages）」，`scopeLabel` 写 `Python 环境`；条目可能上百，前端要能撑住（虚拟化不强制，但列表要轻）。
- cargo/uv/go 的空输出要当成「0 个条目」，不是错误。
- 所有新 manager 的 `--version`/list 输出都要 strip ANSI 与 `\r`（v1 `lib/text.js` 已有工具，复用）。
- 变更类命令超时：node/pip/uv/cargo/gem/dotnet 10 min，编辑器扩展 10 min，winget 15 min。
- 未检测到的 manager 一律拒绝执行任何动作（`unavailable`），不要尝试 spawn。

### 7.5 前端变更

1. **内栏分组**：把原来的「包管理器」单组拆成后端 `groups[]` 驱动的多组；每组标题右侧显示可用数/总数（如 `3/4`）。组内 manager 行沿用现有样式；`detected:false` 的 manager 不显示在组内。
2. **未检测到**：内栏底部（磁盘条之上）一个可折叠区块 `未检测到（N）`，列出未检测到的 manager 名称与 `reason`（hover 显示），标题右侧一个 `重新检测` 小按钮；折叠状态默认收起，展开后每个条目是禁用的灰行。
3. **重新检测**：topbar 的 `检查更新` 左侧新增一个图标按钮（`重新检测`，scan 图标，`aria-label`），点击调 `detect` 再取 snapshot；进行中显示旋转与 `检测中…`，完成后 toast `已检测到 N 个来源`。
4. **分组筛选**：点击分组标题 → `scope = 'grp:<id>'`；面包屑/标题显示组名；`可更新` 范围排除 `checkUpdates=false` 的 manager（它们永远不会有更新）。
5. **能力差异**（全部读 `capabilities`，不许写死 manager id）：
   - `checkUpdates=false` → 该 manager 范围下 `检查更新` 按钮隐藏，行内 `—` 不显示 `检查`。
   - `update=true && latest===null`（扩展）→ 最新版本列显示 `—`，按钮文案 `更新`，点击即 `update`（重装为最新）；`更新全部` 不计入这类条目。
   - `search=false` → 安装对话框隐藏搜索框，改成「输入扩展 ID / 包名」+ `安装` 按钮（可直接带 `@版本`）。
   - `uninstall=false`（go）→ 抽屉里隐藏 `卸载`。
   - `reveal=false` → 隐藏「在文件夹中显示」。
6. **行次行文案**：`kind==='ext'` 显示 `扩展 · <编辑器名>`；`kind==='pkg'` 保持 `manager · scope`；`kind==='app'` 保持 `来源 · 供应商`。
7. **统计卡**：第 3 张改为「可用来源」显示 `detected/known`（如 `9/14`），副行列出已检测到的组名。

### 7.6 验收

- `node --check` 全通过；`tools/probe.mjs --action detect` 打印每个 manager 的 `detected/version/reason`；`--action snapshot` 打印分组与计数。
- 本机应检测到：winget、npm、pnpm、bun、yarn、cargo、uv、pip、vscode（code）、cursor、pink；未检测到：go、gem、dotnet、code-insiders、windsurf。
- 真实数据：`cargo install --list`=0、`uv tool list`=0、`pip list`>0、`code --list-extensions`=11、`cursor`=2、`pink`=0。
- 编辑器扩展的列表/安装/卸载要真实跑通一次（用可卸载的临时扩展或直接重装一个已安装扩展），并把系统还原。

## 8. v2.1：自动检索应用 logo

目标：条目图标尽量显示**真实 logo**，全自动、懒加载、失败静默回退。

### 8.1 来源与优先级

| 条目类型 | logo 来源 | 备注 |
|---|---|---|
| `ext`（编辑器扩展） | 扩展目录里的 `package.json` 的 `icon` 字段（相对路径） | 扩展目录：`~/.vscode/extensions`、`~/.vscode-insiders/extensions`、`~/.cursor/extensions`、`~/.windsurf/extensions`、以及 PinK 的 user-data `extensions` 目录；目录名形如 `<publisher>.<name>-<version>` |
| `app`（winget/ARP 应用） | ARP `DisplayIcon`：`.ico` 直接返回；`.exe`（含 `,0` / `,-101` 资源号）用 `System.Drawing.Icon.ExtractAssociatedIcon` 提取为 PNG | ARP 扫描一次（HKLM/WOW6432Node/HKCU），缓存 5 分钟；未命中则 `null` |
| `pkg`（npm/pnpm/bun/yarn/cargo/uv/pip/go/gem/dotnet） | 无 | 前端回退到管理器 glyph |

### 8.2 协议

- `snapshot.items[]` 新增可选 `logoUrl`（同源相对路径 `string`，无则 `null`）。**只在能廉价确认存在时**给出，避免大量 404：
  - `ext`：图标文件 `stat` 存在才给；
  - `app`：ARP 映射里命中 `DisplayIcon` 才给；
  - `pkg`：恒为 `null`。
- 新路由：`GET /packdeck/icon?id=<urlencoded itemId>&r=<rev>`（与 `/packdeck/api` 同一 webServer exact 路由机制）。
  - 200：`content-type` 为 `image/png` / `image/x-icon` / `image/svg+xml` / `image/webp`，`cache-control: public, max-age=86400, immutable`。
  - 404：无图标；响应体为 JSON `{ok:false,error:{code:'not-found'}}`。
  - 仅按 **itemId** 解析，绝不接受客户端传入的任意文件路径；解析结果必须仍在允许的根目录内（扩展目录 / ARP 给出的图标路径），并做 `realpath` 越界检查。
  - `.exe` 提取的 PNG 落到 `<TEMP>\packdeck-icons\<sha1>.png` 复用（同进程内再加一层内存缓存）；提取失败按 404 处理，绝不抛 500。
- `detect`/`snapshot` 的性能预算不变：ARP 扫描与扩展目录扫描的结果都要缓存（5 分钟），首次扫描 ≤ 1 s。

### 8.3 前端

- `logoUrl` 存在时 `<img class="pk-logo-img" loading="lazy" decoding="async" alt="">`；`onError` 置为该行"无图"状态并回退 glyph；不得出现破图图标，也不得因为图片加载失败影响行高（容器固定 32/36 px，`object-fit: contain`）。
- 不拼 URL、不请求外部域名；只消费 `logoUrl`。

## 9. As built（v2 / v2.1 追认）

实现落地后采纳的偏差，均不改变 §7/§8 的对外契约语义：

1. `managers[].kind` 取**组类别**（`system|language|editor`），条目类别放在 `items[].kind`（`app|pkg|ext`），另给 `items[].itemKind` 作为同值别名。前端按 `items[].kind` 判断。
2. `groups[]` 增加 `availableIds`（检测到的子集，便于组头 `可用/总数` 与筛选）；`managerIds` 仍是完整目录顺序。
3. `detect` 返回 `items: []`，`itemCount/stats` 复用 60 s 的分管理器快照缓存，不额外 spawn 列表命令。
4. `pip` 的“当前环境”语义按实际环境解释（本机为 Python 3.11 用户/系统 site-packages，35 个分发）；`pip --version` 的空行尾（`\r\r\n`）与 App Execution Alias（WindowsApps 下的 winget）解析问题在 v2 一并修复。
5. `detail` 对所有管理器都可用，但只对能落到磁盘的来源返回真实 `path/sizeBytes/license`，其余返回缓存行的最小信息（避免为详情再跑一次命令）。
6. logo 解析来源与覆盖率（本机实测）：`app` 41/133（ARP `DisplayIcon` 43 条中 42 条可服务，`.dll` 与失效项剔除）、`ext` 12/13、`pkg` 0；扩展目录实测为 `~/.vscode/extensions`、`~/.cursor/extensions`、`~/.pink/extensions`（PinK 为空）。
7. 图标缓存分三层：进程内 memo、`<TEMP>\packdeck-icons\<sha1>` 磁盘 PNG、HTTP `immutable` 响应头；ARP 与扩展根扫描 TTL 5 分钟，因此新装的程序/扩展最多 5 分钟后才有 logo。
8. `GET /packdeck/icon` 对 `POST` 回复 405 + `allow: GET, HEAD`；`HEAD` 只回头。任何解析失败一律 404（JSON），不抛 500。
9. 冷快照约 4.4–4.6 s（winget `list` + `upgrade` 占大头），热快照 0–1 ms；装饰 logo 的 ARP 扫描约 0.6 s，每 5 分钟一次。
10. Host 代码更新后必须重启 DSH 应用：Loader 在进程内缓存已导入的模块代次，重新启用 bundle 不会重新导入；`client.js` 的改动由 HMR 自动替换。

## 10. As built（v2.2：冷启动修复与表格收窄）

1. **Host 插件导出形式（血泪教训）**：只能有命名导出 `name` / `inject` / `apply`。曾因额外写了 `export default { apply }`，
   Loader 取了 default 对象而丢掉 `inject`，导致访问 `ctx.webServer` 抛
   `cannot get property "webServer" without inject`，冷启动后"条目 active 但路由 404"。
   另需 `export const inject = ['webServer']`：既让 Cordis 等服务就绪后再激活，也允许读取该服务属性。
2. **入口文件**：`package.json` 的 `exports["."]` 指向 `entry.js`（实现），`index.js` 仅为其再导出别名。
   原因是运行中的 Host 不会重新求值已缓存的 ESM URL；换入口文件名是唯一"不重启换代码"的手段。若日后不再需要，
   可让 `exports` 指回 `index.js` 并删除 `entry.js`（两者内容必须保持一致）。
3. **表格收窄**：去掉"体积"列（只有 `detail` 能算出大小，列表里恒为 `—`，改在抽屉展示）；视口 ≤ 1500px 隐藏"来源"列
   （面板旁还有应用侧栏，窄屏下名称会被压到 50px 级）。当前列宽：`36px minmax(0,1.7fr) 84px 96px 160px 88px 28px`，
   ≤1500px 变 6 列，≤1180px 进一步收窄并把统计卡改为两列。
4. **本次真机验收结果**（2026-11-05，重启后）：`snapshot` 200 条 / 8 组 / 11 个来源 / 28 项可更新 / 53 条带 `logoUrl`；
   `detect` 16 探 / 11 中，579 ms；`/packdeck/icon` 扩展 PNG 31.9 KB、Cursor PNG 13.7 KB、winget ICO 118 KB / 89.7 KB、
   pkg 404、路径穿越 404、`HEAD` 200、`POST` 405 + `Allow: GET, HEAD`；冷快照 5.4 s。
5. 临时"自动选中面板"探针 bundle 已卸载并删除，profile 只保留 `@local/packdeck`。





## 11. v3：进程绑定与自动刷新

目标：把"哪些程序/包正在运行"绑到对应条目上，并展开看到进程详情（启动命令、PID 树、内存、CPU、启动时间、工作目录、环境变量）。设计稿里的「运行中」导航与「进程」标签页在这一节落地。

### 11.1 性能基线（本机实测，必须遵守）

| 方案 | 全量进程读取 |
|---|---|
| PowerShell `Get-CimInstance Win32_Process`（全量） | **1514 ms**（472 进程） |
| `[Diagnostics.Process]::GetProcesses()` + `Id/ProcessName/WorkingSet64/TotalProcessorTime/StartTime` | **18 ms 拿对象，全量属性 30 ms** |
| `Get-Process`（PowerShell cmdlet 管线） | 150 ms |
| CIM 只对命中的进程查 `CommandLine/ExecutablePath/ParentProcessId` | **258 ms（47 行）** |
| psutil 逐进程 `name()/ppid()` | 3709 ms（**禁止**在刷新路径使用） |
| psutil 逐进程 7 个 accessor（10 个进程） | 24 ms（详情路径可用，仅在展开时） |

结论：**刷新走 .NET 快照 + 定向 CIM**，总预算 400 ms，刷新间隔 3 s；详情（环境变量等）走 psutil，**只在展开某个条目时按需触发**。

### 11.2 后端

新增 `lib/procs.js`（进程快照与绑定）与 `lib/procdetail.js`（单进程详情）：

1. **快照**：一次 PowerShell 调用完成
   - `[Diagnostics.Process]::GetProcesses()` 全量取 `Id / ProcessName / WorkingSet64 / TotalProcessorTime / StartTime / SessionId`；
   - 对上一步得到的候选 PID，**一次性** `Get-CimInstance Win32_Process -Filter "(ProcessId=1 OR ProcessId=2 ...)"` 取 `ParentProcessId / CommandLine / ExecutablePath`（分批，每批 ≤ 120 个 PID，避免命令行过长）；
   - 输出 JSON 行（`-Compress`），Node 侧解析；**不要**用 `ConvertTo-Json` 整个大对象（慢且易截断），逐行 `[pscustomobject]@{...} | ConvertTo-Json -Compress` 即可。
   - 退出码非 0 / 超时（20 s）/ 输出不可解析 → `command-failed`，但**不能**让 `snapshot` 失败：运行态是附加信息。

2. **绑定规则**（`item.running` / `item.procCount`）：
   - `kind === 'app'`：进程 `ExecutablePath` 或 `CommandLine` 的规范化路径位于该应用的安装目录（`item.path` 或 ARP `InstallLocation`）之下；或可执行文件名（去扩展名）与 `packageId` 末段/`name` 首词大小写不敏感相等。
   - `kind === 'pkg'`：命令行包含 `\<manager 全局根>\` 下的包目录（例如 `...\npm\node_modules\<pkg>\`），或命令行的脚本路径落在该包目录内，或可执行文件是 `<全局根>\.bin\<name>`。
   - `kind === 'ext'`：不绑定（扩展不常驻）；`procCount` 恒 0。
   - 一个进程最多绑一个条目（取最长匹配前缀），避免误标。
   - 绑定用**规范化**路径：小写、`/`→`\`、去掉引号与尾部空格。

3. **`processes` 动作**：`{"action":"processes"}` →
```json
{ "at": 1762300000000, "durationMs": 212,
  "items": [ { "id": "npm:typescript", "procCount": 2, "cpuPercent": 12.4, "rssBytes": 214748364
     } ],
  "totals": { "processes": 472, "matched": 48, "runningItems": 6 } }
```
   - 只有 `procCount > 0` 的条目出现在 `items`；按 `procCount` 降序、再按 `rssBytes` 降序。
   - `cpuPercent` = 两次采样（间隔 ≥ 500 ms）之间 `TotalProcessorTime` 增量 / 墙钟间隔 / 逻辑核数 × 100，保留 1 位；首帧没有历史时可给 `null`。
   - `processes` 走独立缓存 TTL 3 s，`snapshot` 不要等它（见 §11.4）。

4. **`process-detail` 动作**：`{"action":"process-detail","id":"npm:typescript"}` →
```json
{ "id": "npm:typescript", "at": 1762300000000,
  "processes": [ {
    "pid": 53368, "ppid": 58692, "name": "node.exe", "exe": "C:\\Program Files\\nodejs\\node.exe",
    "cmdline": ["C:\\Program Files\\nodejs\\node.exe", "-e", "..."], "cwd": "C:\\Users\\x\\proj",
    "startedAt": 1762290000000, "rssBytes": 5217521664, "cpuPercent": 43.2, "user": "Administrator",
    "threads": 34, "status": "running",
    "env": { "NODE_OPTIONS": "--max-old-space-size=8192", "PATH": "..." }, "envCount": 48,
    "envError": null, "children": [ 32124, 42768 ] } ] }
```
   - 实现：`spawn('python', ['-c', SCRIPT])`，脚本用 psutil 针对给定 PID 列表取详情；**python 或 psutil 缺失时**：
     - 回退为 CIM 版本（`cmdline/cwd(WorkingDirectory 无)/内存/启动时间/用户`），`env: null`，`envError: '需要 psutil'`，并给 `installHint`；
     - 仍然 `ok: true`，不要报错，因为除环境变量外的信息仍然可用。
   - `env` 取不到（AccessDenied/进程是管理员进程）→ `env: null, envError: '拒绝访问'`。
   - 环境变量值可能含敏感信息：**原样返回给本机界面**，但服务端日志绝不能记录；`log` 字段也不要带 env。
   - 超时 8 s；psutil 调用两次（一次样例、一次取值）用于 `cpuPercent`。
   - `installHint`：`{"manager":"pip","packageId":"psutil","reason":"环境变量需要 psutil"}`，前端用它弹一个「安装 psutil」按钮，调用既有 `install` 动作（`manager: 'pip'`——**注意**：这是 Packdeck 管理的包，属于本机 Python 环境，安装是真实变更，需要用户点击确认）。

5. **`process-kill` 动作**：`{"action":"process-kill","pid":53368}` → `{"pid":53368,"killed":true}`。
   - 只允许 kill 当前绑定到某条目上的 PID（用最近的快照校验），否则 `bad-request '该 PID 不属于任何已管理条目'`；
   - `taskkill /PID <pid> /F`（单进程；**不要** `/T`，避免误杀子进程树）；
   - 这是不可逆操作，前端必须二次确认。

6. **`snapshot` 增量**：`data.processes` 字段（与 §11.3 相同结构）在可用时一并返回，**但最多等 600 ms**；超过就返回 `null`，由前端随后单独 `processes` 拉取。`snapshot` 的冷/热预算因此不变（热 ≤ 1 ms 的前提是进程数据走独立缓存：进程快照与包快照分别缓存，互不等待）。

### 11.3 前端

1. **内栏**：`概览` 与 `可更新` 之间新增 `运行中`，badge = 有进程的条目数；范围 `scope='running'`。
2. **行状态列**：有条目正在运行 → 显示 `● N 进程`（`--dsw-alias-state-success-primary` 点 + 等宽数字）；否则与现在一致（可更新 / 已最新 / 已安装 / —）。
3. **自动刷新**：页面可见时每 **3 s** 调 `processes`（与 60 s 的 `snapshot` 互不阻塞）；不可见（`document.visibilityState === 'hidden'`）时暂停；失败静默重试（连续 3 次失败才在状态条提示，且不打断当前行状态）。刷新时不要整表重渲染：把运行态放在独立 state 切片里，只有 `procCount/rss/cpu` 变化才触发对应行更新。
4. **抽屉新增「进程」标签页**（顺序：概览 / 进程 / 命令）：打开时若条目在运行，自动请求 `process-detail`。
   - 顶部三张小结：`CPU 合计`、`内存合计`、`进程数`；
   - 进程行：`PID`、进程名、`CPU%`、`内存`、启动时间（相对 + 绝对 tooltip）；点击某行展开该进程的 `启动命令`（等宽可换行）、`工作目录`、`父进程 PID`、`用户`、`线程数`；
   - 环境变量：折叠区，键值两列等宽展示，支持按关键字过滤与「复制值」；`env === null` 时显示 `envError` 与「安装 psutil」按钮（调 `install`，成功后重试本动作）；
   - 每个进程行有一个 `结束进程` 危险按钮，二次确认（行内展开的确认条，不用 `window.confirm`），调用 `process-kill`。
   - 不在运行：保留现有空态文案，并给出 `启动程序` 动作（若有 `item.path`，调用 `reveal` 的反向能力改用新动作 `launch`——见下）。
5. **`launch` 动作**（配套）：`{"action":"launch","id":"winget:7zip.7zip"}`：用 `item.path` 或 ARP 的 `DisplayIcon`/`InstallLocation` 找到可执行文件后 `spawn(detached:true)`；找不到可执行文件 → `bad-request '找不到可执行文件'`。前端按钮文案 `启动程序`，仅 `kind==='app'` 且能定位可执行文件时显示。

### 11.4 验收

- `node tools/probe.mjs --action processes` 打印 `durationMs`（应 ≤ 400 ms）、命中的条目数与样例；`--action process-detail --id <有条目的 id>` 打印进程、`envCount`、是否有 `installHint`。
- 前端面板截图：内栏出现 `运行中`、行上有 `● N 进程`、抽屉「进程」页有 CPU/内存/启动命令/环境变量。
- 边界：psutil 不存在时的降级文案与「安装 psutil」按钮；权限不足的进程显示 `拒绝访问` 而不是崩；结束进程后 3 s 内该行回到未运行。
- 性能：`processes` ≤ 400 ms；`process-detail` ≤ 1.5 s（含两次采样）；`snapshot` 热路径不因进程数据变慢。

### 11.5 As built（v3 进程数据的实现取舍）

1. **原生读取器优先**：插件自带 `native/packdeck-procs.exe`（C# 5 单文件，用本机 `csc.exe`（Roslyn 4.8）编译，25 KB），由 `native/build.ps1` 幂等构建（源文件比 exe 新才重建）。JS 侧调用链：**exe → PowerShell → psutil**，响应带 `engine` 字段。
2. **性能实测**：`processes` 冷 313 ms（首次 WMI 补齐候选命令行），**热 47 ms（内部 18 ms，磁盘缓存命中后完全不走 WMI）**；WMI 的类物化下限约 230–270 ms，与 PID 数量关系不大，所以只对候选进程查、并把命令行缓存到磁盘是唯一能进 3 s 轮询的办法。
3. **环境变量来源**：`envSource` 取值 `peb | psutil | access-denied | no-psutil | unsupported`。PEB 读取置于尽力而为（本机 Windows 构建上 `RTL_USER_PROCESS_PARAMETERS` 与经典偏移不一致，取到的是碎片）；**稳定来源是 psutil**（实测 3 ms/进程、48 个变量）。`cwd` 同理：exe 优先，psutil 兜底。
4. `detail` 的 WMI 成本从 ~440 ms 降到复用 `processes` 的磁盘缓存（miss 才补查），目标 ≤ 150 ms。
5. `process-kill` 只接受最近一次绑定快照里的 PID，`OpenProcess(PROCESS_TERMINATE)+TerminateProcess` 单进程，不杀进程树；拒绝自我 kill。probe 里默认 dry-run，真杀要 `--force`。
6. 数据安全：环境变量只在 `detail` 响应里返回给本机界面，不写日志、不进 `error.log`、不落盘。

## 12. v3 真机验收与已知边界（2026-11-05）

按「用户打开面板」的真实时序（snapshot → warmUp(items) → 3 s 轮询）实测：

| 指标 | 结果 |
|---|---|
| `processes` 冷帧（无 snapshot 预热） | 130–209 ms（`partial:true`，`materialSource:empty`） |
| `processes` 首帧（snapshot 之后） | 1–68 ms，`materialSource:full`，`items` 立即有绑定 |
| `processes` 热帧 | 68–74 ms（exe 原生 47–77 ms） |
| `process-detail` | 320–430 ms（原 5085 ms），`envSource=psutil`、`envCount=48`、`cwd` 非空、`truncated{envPids:8,total:19..21,limited:11..13}` |
| `snapshot` | 3.5–10 s（winget + 编辑器 CLI 探测主导，与 v2 相同） |

实现要点：`getMaterial()` 两级加载（tier1 复用 `snapshot:<id>` 缓存立即发布，tier2 加载其余目录）；`warmUp(items)` 由 `lib/api.js` 在 snapshot 成功后 fire-and-forget 调用，因此不再重复扫管理器；`processesPayload` 对「占位期间算出的 partial 缓存」会重新派生，不会把 `items: []` 缓存 3 s。

已知边界：
1. `probe --action processes` 单独跑永远是 `materialSource:empty`（每次都是新进程、没有 snapshot 预热），这是探针测法的限制，不代表 UI 行为。要验证真实时序用 `probe --action process-detail --id <itemId>`：它按 UI 的做法先跑一次 `snapshot` 再轮询 `processes`，`warmUpMs` 单独计时，不计入动作预算。
2. 环境变量来自 psutil（PEB 在本机 Windows 构建上不稳定，`envSource` 会如实报告 `peb`/`psutil`）；psutil 未安装时返回 `envError` + `installHint`，其余字段照常。
3. `detail` 每行 env 只取前 8 个进程，其余 `envCode:'limited'`，展开单行时可用 `pid` 参数补取。
4. `process-kill` 只接受最近一次绑定快照中的 PID，单进程 kill，不杀进程树；probe 默认 dry-run。
5. `winget:OpenJS.NodeJS.LTS` 会绑定较多 node 进程（`C:\Program Files\nodejs\node.exe` 确实在其安装目录内），属于正确绑定而非误绑。

### 12.1 `process-detail` 的 `envCode` / `truncated` 契约（前端必须区分）

每个进程的 `env` 状态由 `envCode` 决定，前端**不得**把 `env === null` 统一当作「环境变量不可读」：

| `envCode` | `env` | 含义 | 前端应显示 |
|---|---|---|---|
| `psutil` / `peb` / `cim` | `{KEY: value}` | 已读取，`envSource` 记录来源 | 可折叠环境变量表 |
| `limited` | `null` | 超出单帧上限被跳过（不是失败） | 灰色预算提示，**不得**出现「安装 psutil」按钮 |
| `error` | `null` | 真的读不到（权限/psutil 缺失） | `envError` 文案 + 必要时 `installHint` 安装按钮 |

`payload.truncated = {envPids, total, limited}` 只描述这一帧的采样预算：`envPids` 是实际读到的进程数（当前 8），`total` 是绑定的进程总数，`limited = total - envPids`。前端文案 `只显示前 {envPids} 个进程的环境变量（共 {total} 个）`，`truncated` 缺失时降级为 `该进程的环境变量未读取`。

> 这个区分是刚需：v3 首版前端把 `env:null` 一律走 psutil 缺失分支，导致第 9 个及以后的进程错误地提示「需要 psutil 以读取环境变量」并给出安装按钮——psutil 其实工作正常。已于 §14 修复。

## 13. 待清理物

无。开发期的 `.tmp-bench/`（PEB 实验目录）已清理完毕。当时删不掉的真实原因不是 exe 映射缓存，而是一个 11:23 启动的**无头 `Notepad.exe` 把该目录当成了工作目录**（`psutil` 查 `cwd()` 定位到 PID 16664）；结束它之后目录可正常删除。

## 14. v3 完成度复核（2026-11-05 收尾）

按「任务是否真的做完」逐项复核，不依赖截图取证：

| 项 | 结论 | 证据 |
|---|---|---|
| Host 进程链接口 | 通过 | `snapshot`（201 项 / 8 组）后轮询 `processes`：2 条目、41 进程、`materialReady:true`、`materialSource:full`、115 ms，连续三次轮询稳定 |
| `process-detail` | 通过 | `winget:OpenJS.NodeJS.LTS`：22 进程、`envSource=peb`、`envCount=48`、`cwd`/`cmdline` 齐全、`truncated{envPids:8,total:22,limited:14}` |
| 进程 kill 越权保护 | 通过 | 非绑定 PID → `bad-request 该 PID 不属于任何已管理条目` |
| 前端能力门控 | 通过 | 全链路只经 `can()/capsOf()`，无 manager-id 硬编码（仅图标画稿与 psutil 兜底字面量） |
| 运行中轮询 | 通过 | 仅在页面可见时 3 s 轮询；隐藏即清定时器 + 中止在途请求；`mergeRunning` 保持未变条目身份，只有真实变化的行才重渲染 |
| 启动程序按钮 | 通过 | `kind==='app' && path && isUsable && can('launch')` 四重门控，失败走 toast + 状态栏，成功后重新轮询 |
| `envCode:'limited'` 呈现 | **本轮修复** | 原先第 9 个及以后的进程被误显示为「需要 psutil」并带安装按钮；现改为灰色预算提示、无按钮（见 §12.1） |
| `.tmp-bench/` | **本轮清理** | 已删除；插件目录现只有 `docs/ lib/ locale/ native/ tools/ client.js cordis.patch.yml entry.js icon.svg index.js package.json README.md` |
| 失效探针 bundle | **本轮清理** | `profile/node_modules/@local/packdeck-select` 悬空软链已移除，profile 依赖仅剩 `@local/packdeck` |

复核中排除的两个假阳性，记录以免后人重复踩：

1. **单独跑 `probe --action processes` 得到 `matched:0`** —— probe 是短进程，内存缓存不跨进程，从没跑过 `snapshot` 就没有条目物料。这是**测法错误**，不是回归；进程内按 UI 时序（snapshot → warmUp → 轮询）执行完全正常。要验证真实时序请用 `probe --action process-detail --id <itemId>`，它内置了 snapshot 预热且单独计时。
2. **窗口截图全白** —— DSH 窗口被全屏的 ChatGPT/Orca 窗口反复抢占前台，鼠标点击事件被丢弃；`PrintWindow` 对 Electron 返回空白，`PostMessage` 不进 Chromium 事件循环。最终改用「接口时序 + 代码静态审计」取证，结论等价且可重复。

## 15. 列表体积列（`sizeBytes`）的数据来源与成本边界

设计稿每行都有「体积」列（`index.html` 第 89/899-908/1794 行，`fmtSize` 在第 1597-1601 行）。早期实现判定「不做体积列」，理由是当时 `snapshot` 不提供体积、逐行扫盘会把冷启动拖垮。**该前提已被推翻**：体积现在能在与基线持平的耗时间内拿到。

### 15.1 三级来源（优先级从高到低）

| 优先级 | 对象 | 来源 | 实测覆盖 |
|---|---|---|---|
| 1 | `kind==='app'`（winget/ARP） | 注册表 `EstimatedSize`（REG_DWORD，单位 KiB，安装器写入） | 54/133 |
| 2 | `kind==='pkg'`（npm/pnpm/bun/yarn/pip/cargo/uv/go/gem/dotnet） | 包目录有界遍历 | 15/55 |
| 3 | `kind==='ext'`（编辑器扩展） | 扩展目录有界遍历（目录由扩展索引直接给出） | 13/13 |
| — | 无来源者 | `sizeBytes: null` → 界面渲染 `—`，**绝不编数** | 119/201 |

合计 **82/201**。剩余 119 条中，51 条是 MSIX/Store 应用（注册表无 ARP 记录也无安装目录），其余是没有 `EstimatedSize` 且没有 `InstallLocation` 的条目 —— 这些**在系统层面就没有体积数据**，不是实现缺陷。

### 15.2 为什么它没有明显拖慢 snapshot

冷快照基线约 4.4 s，加入体积后实测 **4.6-6.0 s**（波动区间与基线重叠）。做法：

1. **复用已有扫描**：ARP 三键的 `reg query /s` 本来就要为图标跑一次，`EstimatedSize` 在同一次解析里顺带取出，**零额外成本**。顺带给 ARP 索引补了 `byCompact` 精确命中表，替掉原先每个条目都线性扫 `compact[]` 的回退路径——这一项单独就把冷快照从 9.9 s 拉回 5.8 s。
2. **目录遍历三重限流**：全局预算 `PASS_BUDGET=12000` 条目、单包上限 `ITEM_BUDGET=6000`、并发 `POOL=8`，且 `stat` 按目录批量 `Promise.all`（串行 await 每个文件才是最初版本 13 s 的元凶）。
3. **按 kind 优先**：`ext → pkg → tool → app`。全局 node 包（几百个文件）绝不能输给一个整程序的安装根目录去抢预算。
4. **按路径缓存**（TTL 5 min，与 `checkUpdates` 对齐）；`detail` 走完精确遍历后会 `rememberDirectorySize()` 回填，因此**打开过详情的包，下一次快照直接命中**，不再走有界遍历。

预算标定过程（201 条目实测）：`0 → 4.4 s`、`12k → 4.6 s`、`25k → 5.8 s`、`200k → 17.6 s`。覆盖率在 12k 之后就不再增长（瓶颈是数据本身不存在，不是预算），因此最终定在 **12k**。

### 15.3 精度约束

- ARP 的 `EstimatedSize` 是**安装器自报值**，与真实磁盘占用可能偏差，只用于排序/概览，界面上不作为精确测量呈现。
- 抽屉「概览」里的体积来自 `detail` 的**真实递归遍历**，两者数值可以不同（实测 `claude-code`：列表 645.2 MB ↔ 详情 645.2 MB 一致，因为已回填缓存）。
- 遍历**跳过符号链接**：pnpm 的全局包大量软链到内容寻址存储，跟随链接会把整个 store 算进单个包。
- 未完成的遍历（超预算）**不写缓存、不返回部分值**，保持 `null`，避免给出偏小的假数。

### 15.4 一个 Node 版本陷阱

`lib/sizes.js` 最初 `import fs from 'node:fs'` 后写 `await fs.readdir(p, {withFileTypes:true})`，在 Node v24 下抛 `ERR_INVALID_ARG_TYPE`（promise 重载已移除，只剩 `fs.promises.*` 或 `node:fs/promises` 默认导入）。**该异常被 `try/catch` 吞掉**，表现为「访问 0 个条目、体积永远是 null」且毫无报错。仓库内其它模块（`detail.js`/`iconres.js`/`nodepkgs.js` 等 6 个文件）都正确地导入了 `node:fs/promises`，只有这次新写的文件踩中。新增文件时务必沿用同样的导入方式。

## 16. 首帧进程为空：warmUp 与首轮轮询的竞态（2026-11-05 修复）

### 16.1 现象

面板打开后的**前 3 秒内没有任何「● N 进程」标记**，`运行中` 徽标是 0；第 4 秒起才突然全部出现。接口层表现为：`snapshot.processes` 返回 `items=0`，紧接着的第一次 `processes` 返回 `matched:0`，第二次才 `matched:34`。

### 16.2 根因

`snapshotAction` 里 `warmUp(items)` 是 fire-and-forget（`lib/api.js` 第 91 行），它在同一 tick 启动但**尚未**把 material 写进 `materialCache`。紧接着的 `snapshotProcesses(600ms)` 调 `processesPayload()`，后者走 `getMaterial({allowCold:false})` 拿到 `emptyMaterial()`（`partial:true`、无 targets），于是按空绑定算出 `matched:0`，并把这个**空结果写进 3 秒缓存**。

`processesPayload` 原本有一段「冷主机自动预热」分支，但条件是 `material.partial === true && !warmUpKicked` —— 而 `snapshot` 的 `warmUp(items)` 已把 `warmUpKicked` 置为 true，所以这段永远不执行，只能拿着空 material 出结果。

### 16.3 修复

`processesPayload` 的 material 阶段改为：当 material 仍为占位（`partial:true`）**且**存在正在进行的 warm-up（`warmUpKicked || materialInflight`）时，**等待那个 warm-up**（`Promise.race`，上限 `WARM_JOIN_MS = 1200 ms`），完成后再读一次 material 绑定；只有确实没有任何 warm-up 在进行时，才退回「自己发起预热并立即返回 partial」。

### 16.4 修复后实测

| 路径 | 修复前 | 修复后 |
|---|---|---|
| `snapshot.processes` | `items=0` | **`items=2`** |
| 紧跟的首次 `processes` | `matched:0`（并缓存 3 s） | **`matched:34`，`items=2`，111 ms** |
| 冷主机直接轮询（无 snapshot） | 首帧空 3 s | 前两帧 `partial:true`（各约 1.3 s，前端显示加载态）→ 第三帧满数据；**空结果不入缓存** |

等待上限 1200 ms 只在冷主机首帧支付一次；稳态路径（material 已被 `snapshot` 建好）往返仍 < 100 ms，不影响 3 秒轮询预算。

### 16.5 排查记录：两次「看起来没修好」都不是修复失效

修复上线后第一次重测仍报 `items=0`，容易被误判成没生效。实际有两条独立的干扰因素，记录在此以免重复排查：

1. **Host 模块代次**：`lib/**` 属于 Host 半，Loader 缓存在进程内，改完必须**完整重启应用**（`tools/restart-dsh.ps1`）。判断是否生效的可靠方法是比对「Host 进程启动时间」与「文件 mtime」，而不是看结果对不对。
2. **冷启动首轮一次性现象**：应用刚启动、进程枚举尚未稳定时，第一轮 `snapshot.processes` 可能仍是 0，从第二轮起稳定为正确值（实测连续三轮均 `snapshot.procs=1`）。这是冷启动固有的一次性开销，不是竞态回归。

钉住修复是否生效的行为特征：冷主机 `processes` 的 `durationMs ≈ 1400 ms`（即 `WARM_JOIN_MS` 生效后放弃等待），以及 `snapshot.processes` 在第二轮起恒为非空。

### 16.6 「只有一个条目在运行」是正确结果，不是缺陷

实测 `runningItems=1`、`procCount=16`，对应 `winget:OpenJS.NodeJS.LTS` 绑定了 16 个 `C:\Program Files\nodejs\node.exe`。另一个经常出现的 `winget:ARP\…PinK…_is1`（18 进程）**只在 PinK 编辑器真的开着时**才出现；PinK 退出后绑定为空是正确行为。

同时验证了绑定的精度：Codex 自带运行时 `C:\Users\...\.cache\codex-runtimes\...\node.exe` **没有**被误绑到 NodeJS.LTS，说明绑定走的是可执行文件真实路径而非进程名匹配。
