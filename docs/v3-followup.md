# 修复点（v3 收口，Lead 亲自改，改完立即真机验收）

## 目标（三条，不许扩大范围）

1. **`processes` 首帧必须 ≤ 400 ms，且不准出现 `partial:true` 的长期空表**
   现状：首次调用 `material=19013 ms`（冷），期间 `partial:true` 且 `items=0`；一旦 material 热了之后 `items=2` 稳定。
   要求：
   - `processesPayload` **永远不等待 material**：`getMaterial({ allowCold:false })` 拿不到就返回 `items: []` + `partial:true`，同时在后台预热；
   - **冷启动时主动预热**：`lib/procs.js` 增加一个幂等 `warmUp()`，在模块第一次被调用时 `setImmediate`/`queueMicrotask` 触发一次 `getMaterial({ allowCold:true })` 与一次 `refreshWith`，让后续 3 s 轮询首帧就命中；
   - `lib/api.js` 在 `snapshot` 成功返回后（异步、不阻塞）调用 `warmUp()`，保证用户打开面板后 3 s 内 `processes` 就有绑定；
   - `material` 的 19 s 主要是 `managerSnapshot` 冷启动（winget 一条命令就要 3 s 级）——**不要**在 `processes` 路径里再触发一次全量；只复用 `snapshot` 已经产出的 items（必要时让 `lib/api.js` 把 `snapshot` 的 items 直接传给 `warmUp(items)`，避免重复 `managerSnapshot`）。
2. **`process-detail` 的 5 s 降到 1.5 s 以内**
   现状：一次查 24 个进程的 env（psutil 638 ms）+ 首次冷 material。
   要求：
   - detail **不要**再调 `getMaterial({allowCold:true})`，改用 `lastSnapshotView()`（最近一次绑定快照），没有就返回 `bad-request '尚未采集到进程快照'`；
   - 一次 detail **最多查前 8 个进程**的 env（其余进程 `env:null, envCode:'limited'`，并在响应里 `truncated: {envPids: 8, total: N}`），用户点击某个进程行可再按需单查（新增可选参数 `pid`，只查该 PID 的 env）；
   - psutil 侧改成**一次调用返回全部信息**（一个 `python -c` 处理所有 PID，而不是每进程一次 spawn）。
3. **probe 补齐**：`tools/probe.mjs` 增加 `--action processes`、`--action process-detail --id <id>`（可选 `--pid`）、`--action process-kill --pid <id> [--force]`、`--action launch --id <id> [--dry-run]`，默认 dry-run。

## 验收（必须贴数字）
- `node tools/probe.mjs --action processes` 两次：首帧（冷）≤ 400 ms、热帧 ≤ 80 ms，且第二次 `items > 0`。
- `node tools/probe.mjs --action process-detail --id winget:OpenJS.NodeJS.LTS` ≤ 1500 ms，`envSource=psutil`、`envCount>0`、`cwd` 非空。
- `--action process-kill --pid <自己起的 node -e setInterval> --force` 返回 killed 且进程消失；不加 `--force` 时只 dry-run。
- 不改 `client.js`、不改契约语义、不装 bundle、不重启 Host。
