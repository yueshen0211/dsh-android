# Collect everything needed to diagnose a stuck or failed engine start on a phone.
#
# Written to be run with the phone simply plugged in and USB debugging allowed --
# no knowledge of adb flags or file layout required.
#
#   .\tools\diagnose-device.ps1
#
# Produces a single text report on stdout and saves it in the workspace, so it can
# be pasted into a bug report or handed back for analysis.
#
# Note on the adb invocation style: this script calls adb directly with splatted
# argument arrays instead of going through cmd.exe. The earlier cmd.exe version
# built a command line by string concatenation and did not survive the PowerShell
# parser (nested quoting inside a subexpression). Direct invocation also keeps
# stderr out of the pipeline, where PowerShell would turn adb's warnings into
# terminating errors.

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

# Run adb, returning its lines. stderr is discarded so that adb's own chatter
# cannot abort the script.
function Invoke-Adb {
    param([string[]] $Arguments)
    $out = & $adb @DeviceArgs @Arguments 2>$null
    if ($null -eq $out) { return @() }
    return @($out | ForEach-Object { $_.ToString() })
}

# Pick the target device before anything else. This matters: with an emulator
# running alongside the phone (a normal state in this workspace), a bare
# `adb shell ...` errors out with "more than one device" -- and because that
# message goes to stderr, every single query would silently come back empty.
# Prefer a real device over an emulator, and let -Serial override.
$DeviceArgs = @()
if ($Serial) {
    $DeviceArgs = @('-s', $Serial)
} else {
    $rows = @(Invoke-Adb @('devices') | Where-Object { $_ -match '\sdevice$' })
    $serials = @($rows | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
    if ($serials.Count -gt 1) {
        $hardware = @($serials | Where-Object { $_ -notmatch '^emulator-' })
        $chosen = if ($hardware.Count -ge 1) { $hardware[0] } else { $serials[0] }
        Write-Host "Multiple devices attached; using '$chosen'. Override with -Serial." -ForegroundColor Yellow
        $DeviceArgs = @('-s', $chosen)
    } elseif ($serials.Count -eq 1) {
        $DeviceArgs = @('-s', $serials[0])
    }
}

# Run adb and return everything as one string, for `cat`-style payloads.
function Invoke-AdbText {
    param([string[]] $Arguments)
    return ((Invoke-Adb $Arguments) -join "`n")
}

$report = New-Object System.Collections.Generic.List[string]
function Section { param([string] $Title) $report.Add(""); $report.Add("========== $Title ==========") }
function Line { param([string] $Text) $report.Add([string]$Text) }

# ---- device presence --------------------------------------------------------
Section "devices"
$devices = Invoke-Adb @('devices', '-l')
$devices | ForEach-Object { Line $_ }
$online = @($devices | Where-Object { $_ -match "`tdevice" -or $_ -match '\sdevice($|\s)' })
if ($online.Count -eq 0) {
    $report | ForEach-Object { Write-Host $_ }
    Write-Host ""
    Write-Host "No device in 'device' state. Check the USB cable and that USB debugging is allowed" -ForegroundColor Yellow
    Write-Host "on the phone (it may need you to accept a prompt on screen)." -ForegroundColor Yellow
    exit 1
}

# ---- device facts -----------------------------------------------------------
Section "device"
foreach ($prop in @('ro.product.model', 'ro.build.version.release', 'ro.product.cpu.abi', 'ro.build.version.sdk')) {
    $value = (Invoke-Adb @('shell', 'getprop', $prop)) -join ' '
    Line ("{0,-24}: {1}" -f $prop, $value.Trim())
}

# ---- installed build --------------------------------------------------------
Section "installed app"
$versionLine = (Invoke-Adb @('shell', 'dumpsys', 'package', 'dev.dsh.mobile')) |
    Select-String -Pattern 'versionName=' | Select-Object -First 1
if ($versionLine) {
    Line ("version : " + ($versionLine.ToString() -replace '.*versionName=', ''))
} else {
    Line "version : (package not installed?)"
}
(Invoke-Adb @('shell', 'pm', 'path', 'dev.dsh.mobile')) | ForEach-Object { Line "path    : $_" }

# ---- process state ----------------------------------------------------------
Section "processes"
(Invoke-Adb @('shell', 'ps', '-A')) | Where-Object { $_ -match 'dsh\.mobile' } | ForEach-Object { Line $_ }

# ---- ui state ---------------------------------------------------------------
Section "current activity"
(Invoke-Adb @('shell', 'dumpsys', 'activity', 'activities')) |
    Select-String -Pattern 'mResumedActivity|topResumedActivity|mFocusedApp' |
    Select-Object -First 4 | ForEach-Object { Line $_.ToString().Trim() }

# ---- engine state file (what the UI polls) ----------------------------------
Section "engine-state.txt (what the UI reads)"
$state = Invoke-AdbText @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine-state.txt')
if ($state -match 'No such file|Permission denied|not debuggable|package not debuggable') {
    Line "unavailable: $state"
} else {
    $state -split "`n" | ForEach-Object { Line $_ }
}

# ---- boot log (live output, shown on the splash screen) ---------------------
Section "engine-boot.log (last 40 lines)"
$boot = Invoke-AdbText @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine-boot.log')
if ($boot -match 'No such file|Permission denied|not debuggable') {
    Line "not present (the service never started the engine)"
} else {
    $bootLines = @($boot -split "`n")
    Line "(total $($bootLines.Count) lines)"
    $bootLines | Select-Object -Last 40 | ForEach-Object { Line $_ }
}

# ---- boot failure log -------------------------------------------------------
Section "engine-boot-failure.log (the recorded reason)"
$fail = Invoke-AdbText @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine-boot-failure.log')
if ($fail -match 'No such file|Permission denied|not debuggable' -or -not $fail.Trim()) {
    Line "not present (the engine may never have recorded a failure)"
} else {
    $fail -split "`n" | Select-Object -First 60 | ForEach-Object { Line $_ }
}

# ---- engine logs ------------------------------------------------------------
Section "logcat (engine tags)"
$logcat = Invoke-Adb @('logcat', '-d', '-s', 'DshEngineService:*', 'DshEngineRuntime:*', 'DshMainActivity:*')
if ($logcat.Count -gt 120) { $logcat = $logcat | Select-Object -Last 120 }
$logcat | ForEach-Object { Line $_ }

# ---- webview console --------------------------------------------------------
Section "logcat (webview console, last 40)"
(Invoke-Adb @('logcat', '-d')) | Select-String -Pattern 'CONSOLE' | Select-Object -Last 40 | ForEach-Object {
    Line (($_.ToString() -replace '", source:.*', '') -replace '^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+\d+\s+\d+ I chromium: \[INFO:CONSOLE\(\d+\)\] ', '')
}

# ---- webview version --------------------------------------------------------
Section "webview"
(Invoke-Adb @('shell', 'dumpsys', 'webviewupdate')) |
    Select-String -Pattern 'Current WebView package' | ForEach-Object { Line $_.ToString().Trim() }

# ---- unpacked tree ----------------------------------------------------------
Section "unpacked engine tree"
(Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'ls', 'files/engine/node_modules/@deepseek-ai/dsh/lib/bin.js')) |
    ForEach-Object { Line "entry     : $_" }
(Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/engine/node_modules/ENGINE-VERSION')) |
    ForEach-Object { Line "version   : $_" }
(Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'ls', 'files/engine/node_modules/@dsh-mobile')) |
    ForEach-Object { Line "plugins   : $_" }
(Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'ls', 'files/dsh-home/profiles/node_modules/@dsh-mobile')) |
    ForEach-Object { Line "profile   : $_" }
(Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'cat', 'files/android.patch.yml')) |
    Select-Object -First 6 | ForEach-Object { Line "patch     : $_" }
Line "patch     : (truncated - the full overlay lives in profile/android.patch.yml)"

if (-not $OutFile) {
    $OutFile = Join-Path $WorkspaceRoot ("device-report-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")
}
$report | Set-Content -Path $OutFile -Encoding utf8
$report | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "Report saved to: $OutFile" -ForegroundColor Green
Write-Host "Send that file back and it will pinpoint the failure." -ForegroundColor Green
