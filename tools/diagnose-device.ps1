# Collect everything needed to diagnose a stuck or failed engine start on a phone.
#
# Written to be run with the phone simply plugged in and USB debugging allowed --
# no knowledge of adb flags or file layout required.
#
#   .\tools\diagnose-device.ps1
#
# Produces a single text report on stdout and saves it next to this script's
# workspace, so it can be pasted into a bug report or handed back for analysis.

[CmdletBinding()]
param(
    [string] $Serial,
    [string] $OutFile
)

$ErrorActionPreference = 'Continue'
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$env:ANDROID_USER_HOME = Join-Path $WorkspaceRoot '.toolchain\android-user-home'
$env:ANDROID_PREFS_ROOT = $env:ANDROID_USER_HOME
$adb = Join-Path $WorkspaceRoot '.toolchain\sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found at $adb - run .\tools\android-env.ps1 setup first" }

$deviceArgs = @()
if ($Serial) { $deviceArgs = @('-s', $Serial) }

function Invoke-Adb {
    param([string[]] $Arguments, [switch] $Raw)
    $all = $deviceArgs + $Arguments
    $text = (& cmd.exe /c ("`"$adb`" " + (($all | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ }) -join ' ') + ' 2>&1') | Out-String)
    if ($Raw) { return $text }
    return ($text -split "`r?`n" | Where-Object { $_ -notmatch '^\s*$' })
}

$report = New-Object System.Collections.Generic.List[string]
function Section { param([string] $Title) $report.Add(""); $report.Add("========== $Title ==========") }
function Line { param([string] $Text) $report.Add($Text) }

# ---- device presence --------------------------------------------------------
Section "devices"
$devices = Invoke-Adb @('devices', '-l')
$devices | ForEach-Object { Line $_ }
$online = $devices | Where-Object { $_ -match '\sdevice$' -or $_ -match '\sdevice\s' }
if (-not $online) {
    $report | ForEach-Object { Write-Host $_ }
    Write-Host ""
    Write-Host "No device in 'device' state. Check the USB cable and that USB debugging is allowed" -ForegroundColor Yellow
    Write-Host "on the phone (it may need you to accept a prompt on screen)." -ForegroundColor Yellow
    exit 1
}

# ---- device facts -----------------------------------------------------------
Section "device"
Invoke-Adb @('shell', 'getprop', 'ro.product.model') | ForEach-Object { Line "model   : $_" }
Invoke-Adb @('shell', 'getprop', 'ro.build.version.release') | ForEach-Object { Line "android : $_" }
Invoke-Adb @('shell', 'getprop', 'ro.product.cpu.abi') | ForEach-Object { Line "abi     : $_" }
Invoke-Adb @('shell', 'getprop', 'ro.build.version.sdk') | ForEach-Object { Line "sdk     : $_" }

# ---- installed build --------------------------------------------------------
Section "installed app"
$pkg = Invoke-Adb @('shell', 'dumpsys', 'package', 'dev.dsh.mobile')
$versionLine = $pkg | Select-String -Pattern 'versionName=' | Select-Object -First 1
Line ("version : " + ($versionLine -replace '.*versionName=', ''))
$apkPath = Invoke-Adb @('shell', 'pm', 'path', 'dev.dsh.mobile')
$apkPath | ForEach-Object { Line "path    : $_" }

# ---- process state ----------------------------------------------------------
Section "processes"
Invoke-Adb @('shell', 'ps', '-A') | Where-Object { $_ -match 'dsh.mobile' } | ForEach-Object { Line $_ }

# ---- ui state ---------------------------------------------------------------
Section "current activity"
Invoke-Adb @('shell', 'dumpsys', 'activity', 'activities') |
    Select-String -Pattern 'mResumedActivity|topResumedActivity|mFocusedApp' |
    Select-Object -First 4 | ForEach-Object { Line $_.ToString().Trim() }

# ---- engine state file (what the UI is polling) -----------------------------
Section "engine-state.txt (what the UI reads)"
$state = Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine-state.txt')
if ($state -match 'No such file|Permission denied|not debuggable') {
    Line "unavailable: $($state -join ' ')"
} else {
    $state | ForEach-Object { Line $_ }
}

# ---- boot failure log -------------------------------------------------------
Section "engine-boot-failure.log (the reason it failed)"
$fail = Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine-boot-failure.log')
if ($fail -match 'No such file|Permission denied|not debuggable') {
    Line "not present (the engine may never have reached a failure)"
} else {
    $fail | Select-Object -First 60 | ForEach-Object { Line $_ }
}

# ---- engine logs ------------------------------------------------------------
Section "logcat (engine tags)"
$logcat = Invoke-Adb @('logcat', '-d', '-s', 'DshEngineService:*', 'DshEngineRuntime:*', 'DshMainActivity:*')
if ($logcat.Count -gt 120) { $logcat = $logcat | Select-Object -Last 120 }
$logcat | ForEach-Object { Line $_ }

# ---- webview console --------------------------------------------------------
Section "logcat (webview console, last 40)"
Invoke-Adb @('logcat', '-d') | Select-String -Pattern 'CONSOLE' | Select-Object -Last 40 | ForEach-Object {
    Line (($_.ToString() -replace '", source:.*', '') -replace '^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+ I chromium: \[INFO:CONSOLE\(\d+\)\] ', '')
}

# ---- webview version --------------------------------------------------------
Section "webview"
Invoke-Adb @('shell', 'dumpsys', 'webviewupdate') |
    Select-String -Pattern 'Current WebView package' | ForEach-Object { Line $_.ToString().Trim() }

# ---- unpacked tree ----------------------------------------------------------
Section "unpacked engine tree"
Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'ls', 'files/engine/node_modules/@deepseek-ai/dsh/lib/bin.js') | ForEach-Object { Line "entry   : $_" }
Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine/node_modules/ENGINE-VERSION') | ForEach-Object { Line "version : $_" }
Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'ls', 'files/engine/node_modules/@dsh-mobile') | ForEach-Object { Line "plugins : $_" }
Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'ls', 'files/dsh-home/profiles/node_modules/@dsh-mobile') | ForEach-Object { Line "in profile: $_" }

if (-not $OutFile) {
    $OutFile = Join-Path $WorkspaceRoot ("device-report-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")
}
$report | Set-Content -Path $OutFile -Encoding utf8
$report | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "Report saved to: $OutFile" -ForegroundColor Green
Write-Host "Send that file back and it will pinpoint the failure." -ForegroundColor Green
