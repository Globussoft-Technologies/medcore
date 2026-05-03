# Quick "is Claude / the cloud actually working?" status check.
#
# Run this from any PowerShell terminal at the repo root any time you
# want to peek at what's going on without touching Claude's terminal.
# Read-only - never starts/kills processes.
#
#   .\claude.ps1           # one-shot snapshot
#   .\claude.ps1 -Watch    # auto-refresh every 5s (Ctrl+C to exit)
#
# Six sections:
#   1. Live tail of the unified test runner's log (.test-local/run-full.out)
#   2. Per-job log mtimes (newest = the job currently writing)
#   3. Docker test container state (medcore-test-pg on :54322)
#   4. Local test-related processes (node / vitest / playwright / next / tsc)
#   5. Background bash processes (Claude's run_in_background tasks)
#   6. GitHub Actions runs in flight on this repo (the "cloud agents")
#
# What this CAN'T see:
#   - Claude Code subagents I spawn via the Agent tool: they run only
#     during my turn and disappear when they report back. No persistent
#     process to watch.
#   - Anthropic-side scheduled routines: visible only via the schedule
#     skill or the Anthropic console.

param(
    [switch]$Watch
)

Set-Location -Path $PSScriptRoot

function Show-Snapshot {
    Clear-Host
    Write-Host "=== claude.ps1 @ $(Get-Date -Format 'HH:mm:ss') ==="
    Write-Host

    Write-Host "--- 1. Live test runner output (last 25 lines) ---"
    if (Test-Path .test-local/run-full.out) {
        Get-Content .test-local/run-full.out -Tail 25
    } else {
        Write-Host "(no .test-local/run-full.out - no test run in progress)"
    }
    Write-Host

    Write-Host "--- 2. Per-job log mtimes (newest first) ---"
    $logs = Get-ChildItem .test-local/*.log -ErrorAction SilentlyContinue
    if ($logs) {
        $logs | Sort-Object LastWriteTime -Descending |
            Select-Object -First 8 |
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

    Write-Host "--- 4. Local test processes (node/vitest/playwright/next/tsc) ---"
    $procs = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match 'node|vitest|playwright|next|tsc' } |
        Sort-Object -Property CPU -Descending |
        Select-Object -First 6 ProcessName, Id,
                      @{n='CPU(s)';e={[int]$_.CPU}},
                      @{n='Mem(MB)';e={[int]($_.WorkingSet64/1MB)}}
    if ($procs) {
        $procs | Format-Table -AutoSize
    } else {
        Write-Host "(no test processes)"
    }
    Write-Host

    Write-Host "--- 5. Background bash processes (Claude's run_in_background) ---"
    $bashProcs = Get-Process bash -ErrorAction SilentlyContinue |
        Sort-Object -Property StartTime |
        Select-Object Id,
                      @{n='Started';e={$_.StartTime.ToString('HH:mm:ss')}},
                      @{n='CPU(s)';e={[int]$_.CPU}},
                      @{n='Mem(MB)';e={[int]($_.WorkingSet64/1MB)}}
    if ($bashProcs) {
        $bashProcs | Format-Table -AutoSize
        Write-Host "(Each row is a backgrounded shell; check Claude's terminal for what each one is doing)"
    } else {
        Write-Host "(no bash processes)"
    }
    Write-Host

    Write-Host "--- 6. GitHub Actions in flight (cloud agents) ---"
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        # Pre-format with --jq so PowerShell doesn't have to wrestle with
        # ConvertFrom-Json + Format-Table column projection.
        $jq = '.[] | "\(.createdAt[11:16])  \(.status | (. + "          ")[0:11])  \(.conclusion // "..."   | (. + "         ")[0:9])  \(.headSha[:8])  \(.workflowName)"'
        Write-Host "Started  Status       Result     SHA       Workflow"
        Write-Host "-------  -----------  ---------  --------  --------"
        gh run list --repo Globussoft-Technologies/medcore --limit 6 `
            --json status,conclusion,headSha,workflowName,createdAt `
            --jq $jq 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "(gh not authenticated or repo unreachable)"
        }
    } else {
        Write-Host "(gh CLI not on PATH)"
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
