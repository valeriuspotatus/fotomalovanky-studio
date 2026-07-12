# Register (or update) the Windows Scheduled Task that runs the overnight autopilot every ~15 minutes.
#
# The autopilot polls Shopify for new PAID photo orders and runs the existing pipeline so finished
# books are waiting for review in the morning. Nothing is ever sent - it stops at "ready for review".
#
# Idempotent: run it as many times as you like. If the task already exists it is replaced with the
# current settings, so re-running after moving the repo or bumping the interval just works. It does
# NOT touch config.json, the token, or any order data.
#
# Usage (from the repo root, in PowerShell):
#     powershell -ExecutionPolicy Bypass -File tools\installAutopilotTask.ps1
#     powershell -ExecutionPolicy Bypass -File tools\installAutopilotTask.ps1 -IntervalMinutes 15
#     powershell -ExecutionPolicy Bypass -File tools\installAutopilotTask.ps1 -Remove
#
# See docs/autopilot-setup.md for the sleep/wake + Windows Update settings that keep it firing
# overnight, and for the token rotation runbook.

param(
    [int]$IntervalMinutes = 15,
    [string]$TaskName = "FotomalovankyAutopilot",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

# Repo root = the parent of this tools\ folder, resolved absolutely so the task works whatever the
# current directory was when it fired.
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Entry    = Join-Path $RepoRoot "src\autopilot.js"

function Remove-ExistingTask {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed existing task '$TaskName'."
        return $true
    }
    return $false
}

if ($Remove) {
    if (-not (Remove-ExistingTask)) { Write-Host "No task named '$TaskName' to remove." }
    return
}

# --- sanity checks (a clear message beats a task that silently never works) ---------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    throw "Could not find 'node' on PATH. Install Node.js (the same one you run 'npm test' with) and try again."
}
if (-not (Test-Path $Entry)) {
    throw "Could not find the autopilot entry at $Entry. Run this from inside the fotomalovanky-studio repo."
}
if (-not (Test-Path (Join-Path $RepoRoot "config.json"))) {
    Write-Warning "No config.json in $RepoRoot yet. The task will register, but the autopilot exits inert until you add config.json with a shopify block (see docs/autopilot-setup.md)."
}

# --- (re)register the task ----------------------------------------------------------------------
Remove-ExistingTask | Out-Null

$NodePath = $node.Source
# Run node with the working directory set to the repo so loadConfig() finds config.json.
$action = New-ScheduledTaskAction -Execute $NodePath -Argument "src\autopilot.js" -WorkingDirectory $RepoRoot

# Repeat every N minutes, effectively forever, starting a minute from now. A one-off trigger with a
# repetition interval is the most compatible shape across Windows 10 builds.
#
# NB: do NOT use [TimeSpan]::MaxValue for the duration - PowerShell serializes it to
# "P99999999DT23H59M59S", which Task Scheduler rejects as out-of-range (HRESULT 0x80041318). A large
# finite duration (~27 years) means the same thing in practice and registers cleanly on Win 10.
$start   = (Get-Date).AddMinutes(1)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 9999)

# StartWhenAvailable catches up a slot missed while the machine was asleep/off; the task tolerates
# running whether or not anyone is logged in. No battery gating so a laptop on mains still runs.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Fotomalovanky overnight autopilot: poll paid photo orders and run the pipeline every $IntervalMinutes min. Never sends." | Out-Null

Write-Host ""
Write-Host "Registered scheduled task '$TaskName':"
Write-Host "    every $IntervalMinutes min  ->  $NodePath src\autopilot.js  (in $RepoRoot)"
Write-Host ""
Write-Host "Run it once now to check it works:"
Write-Host "    Start-ScheduledTask -TaskName $TaskName"
Write-Host "Then open the dashboard - the morning banner shows the run. See docs/autopilot-setup.md"
Write-Host "for the sleep/wake + Windows Update settings that keep it firing overnight."
