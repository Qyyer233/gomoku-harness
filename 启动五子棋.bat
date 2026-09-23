@echo off
rem 双击这个文件就能开始下棋。真正的逻辑在 tools\launch.ps1 里。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launch.ps1" %*
