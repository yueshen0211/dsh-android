# Run the M1 device capability baseline on the connected phone.
#
#   .\tools\device\run-baseline.ps1
#
# Pushes tools/device/baseline.mjs into the app's engine tree and runs it with the
# app's own libnode.so, so the answers describe the shipping runtime rather than
# this host. Requires a debug build (for `run-as`) and a running engine, because
# the engine tree only exists after first launch.

[CmdletBinding()]
param([string] $Serial)

$ErrorActionPreference = 'Stop'
$WorkspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$env:ANDROID_USER_HOME = Join-Path $WorkspaceRoot '.toolchain\android-user-home'
$env:ANDROID_PREFS_ROOT = $env:ANDROID_USER_HOME
$adb = Join-Path $WorkspaceRoot '.toolchain\sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found at $adb" }

$deviceArgs = @()
if ($Serial) { $deviceArgs = @('-s', $Serial) }

# adb writes ordinary progress ("1 file pushed") to stderr, and with
# $ErrorActionPreference = 'Stop' PowerShell turns that into a terminating error
# that aborts the script after a *successful* push. So stderr is discarded here
# rather than captured or merged.
function Invoke-Adb {
    param([string[]] $Arguments)
    $out = & $adb @deviceArgs @Arguments 2>$null
    if ($null -eq $out) { return @() }
    return @($out | ForEach-Object { $_.ToString() })
}

function Invoke-AdbPush {
    param([string] $From, [string] $To)
    # Routed through cmd.exe so adb's "1 file pushed" notice (stderr) is captured
    # by cmd rather than reaching PowerShell, which would raise it as a
    # terminating error under -ErrorActionPreference Stop. adb has no quiet flag
    # for push, and `2>$null` on the native call does not prevent this.
    $line = "`"$adb`" " + (($deviceArgs + @('push', "`"$From`"", "`"$To`"")) -join ' ')
    & cmd.exe /c "$line >nul 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "adb push failed ($LASTEXITCODE): $From" }
}

# Pick a real device over an emulator: with both attached, a bare `adb shell`
# fails and every query silently comes back empty.
if (-not $Serial) {
    $serials = @((Invoke-Adb @('devices')) | Where-Object { $_ -match '\sdevice$' } |
        ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
    if ($serials.Count -gt 1) {
        $hw = @($serials | Where-Object { $_ -notmatch '^emulator-' })
        $chosen = if ($hw.Count -ge 1) { $hw[0] } else { $serials[0] }
        Write-Host "multiple devices; using '$chosen'" -ForegroundColor Yellow
        $deviceArgs = @('-s', $chosen)
    } elseif ($serials.Count -eq 1) {
        $deviceArgs = @('-s', $serials[0])
    } else {
        throw "no device in 'device' state"
    }
}

$base = ((Invoke-Adb @('shell', 'pm', 'path', 'dev.dsh.mobile')) -join '') -replace 'package:', '' -replace '/base.apk', '' -replace '\s', ''
if (-not $base) { throw "dev.dsh.mobile is not installed" }
Write-Host "device base: $base"

$source = Join-Path $PSScriptRoot 'baseline.mjs'
# Copied into the engine tree so `@deepseek-ai/*` and koffi resolve. Invoked by
# bare name, because the command below already cds into files/engine.
$onDeviceRelative = 'dsh-baseline.mjs'
$onDevice = "files/engine/$onDeviceRelative"
Invoke-AdbPush $source '/data/local/tmp/dsh-baseline.mjs'
Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'cp', '/data/local/tmp/dsh-baseline.mjs', $onDevice) | Out-Null

# TMPDIR must point somewhere the app can write: the Termux build defaults to its
# own /data/data/com.termux path, which does not exist here.
#
# Routed through cmd.exe and captured wholesale, then sliced between markers.
# Going through PowerShell directly would be hijacked: anything the child writes
# to stderr (including a Node stack trace) is raised as a terminating error under
# -ErrorActionPreference Stop, so the report would be lost precisely when a check
# FAILS -- which is when it matters most.
$inner = "cd files/engine && TMPDIR=/data/user/0/dev.dsh.mobile/files/workspace " +
         "LD_LIBRARY_PATH=$base/lib/arm64 $base/lib/arm64/libnode.so $onDeviceRelative"
$line = "`"$adb`" " + (($deviceArgs + @('shell', "`"run-as dev.dsh.mobile sh -c '$inner'`"")) -join ' ')
$captured = & cmd.exe /c "$line 2>&1"

$begin = '---DSH-BASELINE-JSON-BEGIN---'
$end = '---DSH-BASELINE-JSON-END---'
$text = ($captured | ForEach-Object { $_.ToString() }) -join "`n"
$start = $text.IndexOf($begin)
$stop = $text.IndexOf($end)
if ($start -lt 0 -or $stop -lt 0) {
    Write-Host "raw output (no JSON markers found):" -ForegroundColor Yellow
    Write-Host $text
    throw "baseline did not complete; see raw output above"
}
$json = $text.Substring($start + $begin.Length, $stop - $start - $begin.Length).Trim()

$outFile = Join-Path $WorkspaceRoot ("device-baseline-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".json")
[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))

# Summarise rather than dumping the whole document, and make failures loud -- the
# point of this gate is to notice a broken facility before it is depended on.
$parsed = $json | ConvertFrom-Json
Write-Host ""
Write-Host "runtime: $($parsed.runtime.node)  $($parsed.runtime.platform)/$($parsed.runtime.arch)  napi $($parsed.runtime.napi)" -ForegroundColor Cyan
$failed = 0
foreach ($name in $parsed.checks.PSObject.Properties.Name) {
    $c = $parsed.checks.$name
    if ($c.status -eq 'ok') {
        Write-Host ("  ok    {0,-38} {1}" -f $name, $c.evidence)
    } else {
        $failed++
        Write-Host ("  FAIL  {0,-38} {1}" -f $name, $c.error) -ForegroundColor Red
    }
}
Write-Host ""
Write-Host "saved: $outFile" -ForegroundColor Green
if ($failed -gt 0) { throw "$failed baseline check(s) FAILED" }
Write-Host "all checks passed" -ForegroundColor Green

# Clean up so the tree matches what shipped.
Invoke-Adb @('shell', 'run-as', 'dev.dsh.mobile', 'rm', '-f', $onDevice) | Out-Null
Invoke-Adb @('shell', 'rm', '-f', '/data/local/tmp/dsh-baseline.mjs') | Out-Null
