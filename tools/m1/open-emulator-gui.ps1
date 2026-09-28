# Open the on-device DSH GUI in the desktop browser, via the emulator.
#
# The token rotates on every engine start, and the engine port is assigned by the
# OS, so a fixed URL would go stale immediately. This resolves both from the live
# device, (re)establishes the port forward, and prints a ready-to-open URL.
#
# Usage:  . .\tools\m1\open-emulator-gui.ps1
#         . .\tools\m1\open-emulator-gui.ps1 -Open
#
# Exit codes: 0 URL resolved, 1 no device, 2 engine not running yet.

[CmdletBinding()]
param(
    [int] $HostPort = 8080,
    [switch] $Open,
    [string] $AvdName = 'dsh-test'
)

. "$PSScriptRoot\common.ps1"
. "$(Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'tools\android-env.ps1')" | Out-Null

$env:ANDROID_USER_HOME = Join-Path $script:M1Toolchain 'android-user-home'
$env:ANDROID_PREFS_ROOT = $env:ANDROID_USER_HOME
$env:ANDROID_AVD_HOME = Join-Path $env:ANDROID_USER_HOME 'avd'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'

$devices = (& cmd.exe /c "`"$adb`" devices 2>&1" | Out-String)
if ($devices -notmatch 'emulator-\d+\s+device') {
    Write-Host "No running emulator. Start one first:" -ForegroundColor Yellow
    Write-Host "  & `"$env:ANDROID_HOME\emulator\emulator.exe`" -avd $AvdName -no-audio -no-boot-anim -gpu auto"
    exit 1
}

# Recover the port and token from the engine's own startup line, which is the
# only place the OS-assigned port appears.
$log = (& cmd.exe /c "`"$adb`" logcat -d -s DshEngineService:* 2>&1" | Out-String)
$match = [regex]::Match($log, 'dsh web:\s*http://127\.0\.0\.1:(\d+)/\?token=(\S+)')
if (-not $match.Success) {
    Write-Host "The engine has not reported a URL yet." -ForegroundColor Yellow
    Write-Host "Start the app and wait for 'engine ready on port N':"
    Write-Host "  & `"$adb`" shell am start -n dev.dsh.mobile/.MainActivity"
    exit 2
}

$enginePort = $match.Groups[1].Value
$token = $match.Groups[2].Value

& cmd.exe /c "`"$adb`" forward --remove-all 2>&1" | Out-Null
& cmd.exe /c "`"$adb`" forward tcp:$HostPort tcp:$enginePort 2>&1" | Out-Null

# The browser must load the token URL once: the engine exchanges it for an
# HttpOnly session cookie and redirects to the clean root.
$url = "http://127.0.0.1:$HostPort/?token=$token"

Write-Host "Emulator engine  : 127.0.0.1:$enginePort" -ForegroundColor Green
Write-Host "Forwarded to host: 127.0.0.1:$HostPort" -ForegroundColor Green
Write-Host ""
Write-Host "Open this URL in your desktop browser:"
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ""
Write-Host "Note: the port forward points at THIS engine instance. Restarting the app"
Write-Host "      assigns a new port and token; re-run this script to refresh both."

if ($Open) { Start-Process $url }
