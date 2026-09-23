# stay-awake.ps1 — 长任务跑着的时候别让屏幕熄掉 / 系统睡眠
#
# 用的是 Windows 自己的 SetThreadExecutionState，等同于播放器「正在放视频，别睡」
# 的那套机制。**不改任何电源设置** —— 这个进程一停，一切自动恢复原样，
# 不留痕迹、不用善后。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/stay-awake.ps1
#   （Ctrl+C 或关掉进程即恢复）

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class Awake {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS       = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED  = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$flags = [Awake]::ES_CONTINUOUS -bor [Awake]::ES_SYSTEM_REQUIRED -bor [Awake]::ES_DISPLAY_REQUIRED
$prev = [Awake]::SetThreadExecutionState($flags)
if ($prev -eq 0) { Write-Output "设置失败"; exit 1 }

Write-Output "已阻止熄屏与休眠（PID $PID）。结束本进程即恢复。"
try {
    while ($true) {
        # 有些系统会在长时间后重置状态，隔一会儿重申一次
        [void][Awake]::SetThreadExecutionState($flags)
        Start-Sleep -Seconds 50
    }
} finally {
    # 只保留 ES_CONTINUOUS = 清除我们加的那两个要求，交回系统默认行为
    [void][Awake]::SetThreadExecutionState([Awake]::ES_CONTINUOUS)
    Write-Output "已恢复系统默认的熄屏/休眠行为。"
}
