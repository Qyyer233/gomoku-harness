# finish.ps1 — 收工：停掉防熄屏，然后尝试关机
#
# 用户的要求是「任务完成后尝试关机电脑，关机不了就让他自动熄屏就行了」。
#
# 关机是不可逆的，所以这里**一定留一个可取消的窗口**（默认 120 秒），
# 期间随时 `shutdown /a` 就能中止。关机命令失败（权限不够、策略禁止等）
# 也不当成错误 —— 按要求退回到「让系统自己熄屏」，也就是把防熄屏进程停掉就够了。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/finish.ps1            # 120 秒后关机
#   powershell -ExecutionPolicy Bypass -File tools/finish.ps1 -Delay 300
#   powershell -ExecutionPolicy Bypass -File tools/finish.ps1 -NoShutdown  # 只解除防熄屏

param(
    [int]$Delay = 120,
    [switch]$NoShutdown
)

# 1) 先解除防熄屏 —— 无论后面关不关得成，都得把系统交还给它自己的电源策略
$stopped = 0
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
    Where-Object { $_.CommandLine -like '*stay-awake*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $stopped++
    }
if ($stopped -gt 0) { "已停止 $stopped 个防熄屏进程，系统恢复默认的熄屏/休眠策略。" }
else { "没有在跑的防熄屏进程。" }

# 2) 顺手收掉可能残留的引擎进程，免得它们拖着不让关机
$eng = @(Get-Process -Name 'pbrain-rapfi-*' -ErrorAction SilentlyContinue)
if ($eng.Count -gt 0) {
    $eng | Stop-Process -Force -ErrorAction SilentlyContinue
    "已结束 $($eng.Count) 个残留的 Rapfi 进程。"
}

if ($NoShutdown) { "（-NoShutdown：不关机）"; exit 0 }

# 3) 尝试关机，留出取消窗口
"`n将在 $Delay 秒后关机。"
"要取消请在这段时间内执行：  shutdown /a"
$out = & shutdown.exe /s /t $Delay /c "五子棋项目任务已完成，自动关机。取消请执行 shutdown /a" 2>&1
if ($LASTEXITCODE -eq 0) {
    "关机已排定（$Delay 秒后）。"
} else {
    "关机命令失败（退出码 $LASTEXITCODE）：$out"
    "按要求不再强求 —— 防熄屏已解除，系统会按自己的电源策略熄屏/休眠。"
}
