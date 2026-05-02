@echo off
REM Quick "is Claude still working?" status check (Windows batch wrapper).
REM
REM Double-click from Explorer for a one-shot snapshot, or run from any
REM shell:
REM   claude.bat            one-shot snapshot
REM   claude.bat -Watch     auto-refresh every 5s (Ctrl+C to exit)
REM
REM Just forwards to claude.ps1 with execution policy bypassed for this
REM invocation only - no machine-wide policy change. Read-only;
REM never starts/kills processes.

setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude.ps1" %*

REM Pause only when invoked with no args (typical double-click case) so
REM the window stays open long enough to read. -Watch loops forever and
REM never reaches this line, which is what we want there.
if "%~1"=="" (
    echo.
    pause
)
endlocal
