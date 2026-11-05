# 彻底重启 DeepSeek Harness（v3 进程功能需要新 Host 模块代次）
#
# 用法（Win+R 或独立终端）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Administrator\Code\SUD-GLOBAL\plugins\dsh-package-manager\tools\restart-dsh.ps1"
#
# 为什么必须这样做：DSH 的 Host（承载 /packdeck/api 路由）在主进程里，Loader 会缓存已导入的
# 模块代次；只关窗口/重载界面不会重新导入 entry.js，于是旧进程里仍是 v2 的动作表，
# 新加的 processes / process-detail / process-kill / launch 会返回 unknown-action。

$ErrorActionPreference = 'SilentlyContinue'
$exe = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'

Write-Host '结束 DeepSeek Harness 进程…'
Get-Process 'DeepSeek Harness' | Stop-Process -Force
Start-Sleep -Seconds 3
$left = Get-Process 'DeepSeek Harness'
if ($left) {
  Write-Host '强制结束残留进程…'
  $left | Stop-Process -Force
  Start-Sleep -Seconds 2
}
if (Get-Process 'DeepSeek Harness') {
  Write-Host '仍有进程未退出，请到任务管理器手动结束后重试。'
  exit 1
}
Write-Host '进程已清空，重新启动…'
Start-Process $exe
Write-Host '已发出启动命令。界面出现后回到会话继续即可。'
