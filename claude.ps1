# Quick "is Claude still working?" status check (PowerShell version).
#
# Run this from any PowerShell terminal at the repo root any time you
# want to peek at what Claude is doing without touching its terminal.
# Read-only - never starts/kills processes.
#
#   .\claude.ps1           # one-shot snapshot
#   .\claude.ps1 -Watch    # auto-refresh every 5s (Ctrl+C to exit)
#
# (POSIX / Git Bash equivalent: bash claude.sh)

param(
    [switch]$Watch
)

Set-Location -Path $PSScriptRoot

function Show-Snapshot {
    Clear-Host
    Write-Host "=== claude.ps1 @ $(Get-Date -Format 'HH:mm:ss') ==="
    Write-Host

    Write-Host "--- 1. Live test runner output (last 30 lines) ---"
    if (Test-Path .test-local/run-full.out) {
        Get-Content .test-local/run-full.out -Tail 30
    } else {
        Write-Host "(no .test-local/run-full.out - no test run in progress)"
    }
    Write-Host

    Write-Host "--- 2. Per-job log mtimes (newest first) ---"
    $logs = Get-ChildItem .test-local/*.log -ErrorAction SilentlyContinue
    if ($logs) {
        $logs | Sort-Object LastWriteTime -Descending |
            Select-Object -First 10 |
            Format-Table @{n='Mtime';e={$_.LastWriteTime.ToString('HH:mm:ss')}},
                         @{n='Size';e={$_.Length}},
                         Name -AutoSize
    } else {
        Write-Host "(no per-job logs)"
    }
    Write-Host

    Write-Host "--- 3. Docker test container ---"
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        docker ps --filter "name=medcore-test-pg" `
                  --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}" 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "(docker not running or unreachable)"
        }
    } else {
        Write-Host "(docker not on PATH)"
    }
    Write-Host

    Write-Host "--- 4. Test-related processes ---"
    $procs = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match 'node|vitest|playwright|next|tsc' } |
        Sort-Object -Property CPU -Descending |
        Select-Object -First 8 ProcessName, Id,
                      @{n='CPU(s)';e={[int]$_.CPU}},
                      @{n='Mem(MB)';e={[int]($_.WorkingSet64/1MB)}}
    if ($procs) {
        $procs | Format-Table -AutoSize
    } else {
        Write-Host "(no test processes)"
    }
}

if ($Watch) {
    while ($true) {
        Show-Snapshot
        Write-Host
        Write-Host "(refresh every 5s - Ctrl+C to exit)"
        Start-Sleep -Seconds 5
    }
} else {
    Show-Snapshot
}
