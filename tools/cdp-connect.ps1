# Reconnect the WebView DevTools socket and write .m1/ws-url.txt.
#
#   .\tools\cdp-connect.ps1 [-Serial <serial>]
#
# The forwarding has to be re-established after every app restart (the socket name
# embeds the process id), and the /json endpoint is not up the instant the activity
# starts, so this retries. Kept as a script because doing it inline in a larger
# command is where this session repeatedly lost time.

[CmdletBinding()]
param([string] $Serial, [int] $TimeoutSec = 90)

$ErrorActionPreference = 'Stop'
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$env:ANDROID_USER_HOME = Join-Path $WorkspaceRoot '.toolchain\android-user-home'
$adb = Join-Path $WorkspaceRoot '.toolchain\sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found at $adb" }

function Invoke-Adb {
    param([string[]] $Arguments)
    $out = & $adb @DeviceArgs @Arguments 2>$null
    if ($null -eq $out) { return @() }
    return @($out | ForEach-Object { $_.ToString() })
}

$DeviceArgs = @()
if ($Serial) {
    $DeviceArgs = @('-s', $Serial)
} else {
    $serials = @((Invoke-Adb @('devices')) | Where-Object { $_ -match '\sdevice$' } |
        ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })
    $hw = @($serials | Where-Object { $_ -notmatch '^emulator-' })
    if ($hw.Count -ge 1) { $DeviceArgs = @('-s', $hw[0]) }
    elseif ($serials.Count -ge 1) { $DeviceArgs = @('-s', $serials[0]) }
    else { throw "no device in 'device' state" }
}
Write-Host "device: $($DeviceArgs -join ' ')" -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$wsUrl = $null
while (-not $wsUrl -and (Get-Date) -lt $deadline) {
    $pidText = ((Invoke-Adb @('shell', 'pidof', 'dev.dsh.mobile')) -join ' ').Trim()
    $mainPid = ($pidText -split '\s+')[0]
    if ($mainPid) {
        Invoke-Adb @('forward', '--remove-all') | Out-Null
        Invoke-Adb @('forward', 'tcp:9222', "localabstract:webview_devtools_remote_$mainPid") | Out-Null
        try {
            $pages = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
            $page = $pages | Where-Object { $_.url -like 'http://127.0.0.1*' } | Select-Object -First 1
            if ($page) { $wsUrl = $page.webSocketDebuggerUrl }
        } catch { }
    }
    if (-not $wsUrl) { Start-Sleep -Seconds 3 }
}

if (-not $wsUrl) { throw "DevTools socket did not come up within ${TimeoutSec}s" }
$outFile = Join-Path $WorkspaceRoot '.m1\ws-url.txt'
[System.IO.File]::WriteAllText($outFile, $wsUrl, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "connected: $wsUrl" -ForegroundColor Green
