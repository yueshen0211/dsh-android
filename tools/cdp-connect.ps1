# Reconnect the WebView DevTools socket and write .m1/ws-url.txt.
#
#   .\tools\cdp-connect.ps1                  # the phone, if attached
#   .\tools\cdp-connect.ps1 -Serial <serial>
#   .\tools\cdp-connect.ps1 -List            # show what is attached, change nothing
#
# The forwarding has to be re-established after every app restart, because the
# socket name embeds the main process id, and the /json endpoint is not up the
# instant the activity starts -- hence the retry loop.
#
# The device selector is passed to Invoke-Adb as a PARAMETER rather than read from
# the enclosing scope. Reading it from the scope does not work: PowerShell resolves
# a bare `$DeviceArgs` inside a function against the caller's frames, so when the
# caller's variable was still unset the function splatted the function's own
# parameter names into the command line. adb then reported
#
#   unknown host service ' unknown command unknown:features'
#
# which looks like an adb fault and is not.

[CmdletBinding()]
param(
    [string] $Serial,
    [switch] $List,
    [int]    $TimeoutSec = 90,
    [switch] $AllowEmulator
)

$ErrorActionPreference = 'Stop'
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$env:ANDROID_USER_HOME = Join-Path $WorkspaceRoot '.toolchain\android-user-home'
$adb = Join-Path $WorkspaceRoot '.toolchain\sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found at $adb" }

function Invoke-Adb {
    param(
        [string[]] $DeviceSelector = @(),
        [string[]] $Arguments
    )
    $out = & $adb @DeviceSelector @Arguments 2>$null
    if ($null -eq $out) { return @() }
    return @($out | ForEach-Object { $_.ToString() })
}

$attached = @((Invoke-Adb -Arguments @('devices')) | Where-Object { $_ -match '\sdevice$' } |
    ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ })

if ($List) {
    Write-Host "attached: $($attached -join ', ')"
    exit 0
}

# A real device is preferred over an emulator: this project's bugs have all been
# device-only, and silently connecting to the emulator makes a stale build look
# like a fresh one.
$target = $null
if ($Serial) {
    if ($attached -notcontains $Serial) { throw "device '$Serial' is not attached (attached: $($attached -join ', '))" }
    $target = $Serial
} else {
    $hardware = @($attached | Where-Object { $_ -notmatch '^emulator-' })
    if ($hardware.Count -ge 1) { $target = $hardware[0] }
    elseif ($AllowEmulator -and $attached.Count -ge 1) { $target = $attached[0] }
    elseif ($attached.Count -ge 1) {
        throw "only an emulator is attached ($($attached -join ', ')). Plug the phone in, or pass -AllowEmulator."
    } else {
        throw "no device attached. Check the USB cable."
    }
}
$selector = @('-s', $target)
Write-Host "device: $target" -ForegroundColor Cyan

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$wsUrl = $null
while (-not $wsUrl -and (Get-Date) -lt $deadline) {
    $pidText = ((Invoke-Adb -DeviceSelector $selector -Arguments @('shell', 'pidof', 'dev.dsh.mobile')) -join ' ').Trim()
    $mainPid = ($pidText -split '\s+')[0]
    if ($mainPid) {
        Invoke-Adb -DeviceSelector $selector -Arguments @('forward', '--remove-all') | Out-Null
        Invoke-Adb -DeviceSelector $selector -Arguments @('forward', 'tcp:9222', "localabstract:webview_devtools_remote_$mainPid") | Out-Null
        try {
            $pages = (Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json' -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json
            $page = $pages | Where-Object { $_.url -like 'http://127.0.0.1*' } | Select-Object -First 1
            if ($page) { $wsUrl = $page.webSocketDebuggerUrl }
        } catch { }
    }
    if (-not $wsUrl) { Start-Sleep -Seconds 3 }
}

if (-not $wsUrl) { throw "DevTools socket did not come up within ${TimeoutSec}s (is the app running?)" }
$outFile = Join-Path $WorkspaceRoot '.m1\ws-url.txt'
[System.IO.File]::WriteAllText($outFile, $wsUrl, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "connected: $wsUrl" -ForegroundColor Green
