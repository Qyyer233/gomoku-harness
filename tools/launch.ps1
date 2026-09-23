# launch.ps1 — 一键开局：收拾干净 -> 起服务器 -> 开浏览器
#
# 为什么要有这个脚本：
#   原来的流程是「开终端 -> npm start -> 开浏览器 -> 记得强制刷新」，四步，
#   而且漏掉最后一步不会报错，只会**静默跑旧代码**。实战里已经坑过一次：
#   用户跑了一个多小时改之前的版本，日志里少了一半字段，我还差点去怪他没重启。
#
# 所以这里把四步合成双击一次，并且每次都：
#   1. 杀掉上次残留的服务器和引擎进程（不然新旧两套会抢端口和 CPU）
#   2. 起服务器，等它真的听上了再往下走
#   3. 把本机和局域网两个地址都打出来（手机用后者）
#   4. 把服务器日志留在窗口里 —— [慢手] / [会话] 这些提示要看得见
#
# 用法：双击根目录的「启动五子棋.bat」，或者
#   powershell -ExecutionPolicy Bypass -File tools/launch.ps1 [-Port 8080] [-Browser]

param(
    [int]$Port = 8080,
    # 默认**不**开浏览器：用手机还是用电脑是当场决定的，
    # 替用户打开一个用不上的窗口只会添乱。要开就显式加 -Browser。
    [switch]$Browser
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null                      # 控制台用 UTF-8，否则中文是乱码
$Root = Split-Path -Parent $PSScriptRoot

# ---- 关掉这个窗口的「快速编辑」----
# 快速编辑开着时，在窗口里点一下或拖选文字，下一次往窗口写日志的进程就会被**整个挂起**，
# 直到你在窗口里按回车 / 右键。服务器和这个窗口共用一个控制台，于是它也跟着停：
# 2026-09-23 实测事件循环被堵 5083ms，那一手浏览器等了 7.6 秒（上限 6 秒），
# 服务端自己只算了 2.2 秒 —— 剩下 5 秒全在排队。
# 关掉之后窗口里不能直接拖选复制了（需要的话右键标题栏 -> 编辑 -> 标记），换来服务器不会被点停。
try {
    Add-Type -Namespace Gomoku -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
    $h = [Gomoku.ConsoleMode]::GetStdHandle(-10)          # STD_INPUT_HANDLE
    $mode = [uint32]0
    if ([Gomoku.ConsoleMode]::GetConsoleMode($h, [ref]$mode)) {
        # 去掉 ENABLE_QUICK_EDIT_MODE(0x40)，带上 ENABLE_EXTENDED_FLAGS(0x80) 才会生效
        [void][Gomoku.ConsoleMode]::SetConsoleMode($h, ($mode -band (-bnot [uint32]0x40)) -bor [uint32]0x80)
    }
} catch { }   # 关不掉（比如不是真控制台）也不影响启动

Write-Host ''
Write-Host '  五子棋 — 启动中' -ForegroundColor Cyan
Write-Host '  ----------------------------------------'

# ---- 1. 收拾上一次的残留 ----
$old = @(Get-Process node, pbrain-rapfi-windows-avxvnni, pbrain-rapfi-windows-avx2, pbrain-rapfi-windows-sse -ErrorAction SilentlyContinue)
# 只杀跑在这个项目下的 node，别误伤用户其它的 node 程序
$mine = @($old | Where-Object {
    $_.Name -ne 'node' -or (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine -like "*$([regex]::Escape($Root))*"
})
if ($mine.Count -gt 0) {
    Write-Host "  清掉上次残留的 $($mine.Count) 个进程（服务器 + 引擎）" -ForegroundColor DarkGray
    $mine | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 600
}

# ---- 2. 起服务器 ----
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Write-Host '  找不到 node —— 需要先装 Node.js（https://nodejs.org）' -ForegroundColor Red
    Read-Host '  按回车退出'
    exit 1
}

Write-Host "  启动服务器（端口 $Port）…"
$srv = Start-Process -FilePath $node.Source -ArgumentList @((Join-Path $Root 'tools\serve.js'), "$Port") `
                     -WorkingDirectory $Root -PassThru -NoNewWindow

# 等它真的听上了再开浏览器，否则会看到「无法连接」
$ok = $false
foreach ($i in 1..60) {
    Start-Sleep -Milliseconds 250
    if ($srv.HasExited) { break }
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/engine/info" -TimeoutSec 2 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}

if (-not $ok) {
    Write-Host '  服务器没起来。上面若有报错信息，把它发给我。' -ForegroundColor Red
    Read-Host '  按回车退出'
    exit 1
}

# ---- 3. 把地址打出来 ----
# 局域网地址是给手机/副机用的。只取真实网卡，排掉回环、自动私有地址
# 和各种 VPN/代理虚拟网卡（那些地址手机连不上）。
$lan = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and
        $_.InterfaceAlias -notmatch "Loopback|TUN|TAP|VPN|Virtual|vEthernet"
    } | Select-Object -ExpandProperty IPAddress)

Write-Host ""
Write-Host "  在这台电脑上打开：" -NoNewline
Write-Host "  http://localhost:$Port/" -ForegroundColor Yellow
if ($lan.Count -gt 0) {
    foreach ($ip in $lan) {
        Write-Host "  在手机/副机上打开：" -NoNewline
        Write-Host "  http://${ip}:$Port/" -ForegroundColor Yellow
    }
    Write-Host "  （手机要和这台电脑在同一个网络里；手机上别开代理/VPN）" -ForegroundColor DarkGray
} else {
    Write-Host "  没找到局域网地址 —— 手机暂时连不上" -ForegroundColor DarkGray
}
if ($Browser) { Start-Process "http://localhost:$Port/" }

# ---- 4. 服务器跑着的时候，别让电脑熄屏进待机 ----
# 这台笔记本支持「新型待机」(S0 低电量待机)：屏幕一熄，系统就进低功耗状态，
# 桌面程序会被间歇挂起。用手机当界面时电脑没人碰，几分钟就熄屏 ——
# 2026-09-23 16:46:50 进待机、16:53:55 退出，中间 16:51:25 服务器被挂起 5 秒，
# 那一手浏览器等了 7.6 秒（上限 6 秒）。系统日志 Kernel-Power 506/507 可查。
# 屏幕也得亮着：新型待机就是由熄屏触发的，只拦「睡眠」拦不住它。
# 和 stay-awake.ps1 同一个机制（SetThreadExecutionState），不改任何电源设置，
# 这个窗口一关就自动恢复原样。
$awake = $false
try {
    Add-Type -Namespace Gomoku -Name Awake -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
    # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
    $awake = [Gomoku.Awake]::SetThreadExecutionState([uint32]'0x80000003') -ne 0
} catch { }

Write-Host '  ----------------------------------------'
Write-Host '  服务器跑起来了。这个窗口不要关。' -ForegroundColor Green
if ($awake) {
    Write-Host '  服务器运行期间电脑不会自动熄屏/待机（关掉这个窗口即恢复）。' -ForegroundColor DarkGray
    Write-Host '  别手动按电源键关屏 —— 那一样会进待机，服务器会被挂起。' -ForegroundColor DarkGray
} else {
    Write-Host '  ⚠ 没能阻止电脑熄屏待机：熄屏后服务器可能被挂起，请手动把熄屏时间调长。' -ForegroundColor Yellow
}
Write-Host '  下面会实时打出这些：'
Write-Host '    [会话] 新建/关闭      —— 换局时的引擎进程管理'
Write-Host '    [慢手] …              —— 某一手超过了思考上限，附带耗时拆解'
Write-Host '    [预备] …              —— 超前思考的异常'
Write-Host ''
Write-Host '  下完棋想收工：在这个窗口按 Ctrl+C。' -ForegroundColor DarkGray
Write-Host ''

# 把服务器的输出留在这个窗口里
try { Wait-Process -Id $srv.Id } catch { }
# 交回系统默认的熄屏/待机行为（进程退出本来也会自动清掉，这里显式做一次）
if ($awake) { try { [void][Gomoku.Awake]::SetThreadExecutionState([uint32]'0x80000000') } catch { } }
Write-Host ''
Write-Host '  服务器已停止。' -ForegroundColor DarkGray
Start-Sleep -Seconds 2
