# Android build environment for this workspace.
# Self-contained: no admin rights, does not touch system environment variables.
#
# Usage (dot-source it, so the variables land in your current shell):
#   . D:\Work\DSHapk\tools\android-env.ps1
#
# NOTE: this file is intentionally ASCII-only. The shell here is Windows
# PowerShell 5.1, which decodes .ps1 files as ANSI unless they carry a BOM;
# non-ASCII characters can corrupt string terminators.

$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot          # D:\Work\DSHapk
$ToolchainRoot = Join-Path $WorkspaceRoot '.toolchain'     # D:\Work\DSHapk\.toolchain
$SdkRoot       = Join-Path $ToolchainRoot 'sdk'

# JDK: find the directory that actually contains bin\javac.exe.
# Two pitfalls handled here:
#   1. The zip nests a versioned folder (jdk-21\jdk-21.0.12.1+1\bin), so do not
#      assume the JDK home is the top-level folder.
#   2. Do not glob a path through the ".toolchain" segment: "." is a wildcard
#      character there, which silently matches nothing.
$JdkHome = Get-ChildItem -LiteralPath $ToolchainRoot -Recurse -Depth 3 -Filter 'javac.exe' -File -ErrorAction SilentlyContinue |
           Where-Object { $_.DirectoryName -like '*\bin' } |
           ForEach-Object { Split-Path -Parent $_.DirectoryName } |
           Select-Object -First 1

if (-not $JdkHome) {
    throw "JDK not found. Expected a bin\javac.exe under $ToolchainRoot\jdk-21"
}

$SdkManager = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $SdkManager)) {
    throw "cmdline-tools not found. Expected $SdkManager"
}

$JdkBin        = Join-Path $JdkHome 'bin'
$CmdlineBin    = Join-Path $SdkRoot 'cmdline-tools\latest\bin'
$PlatformTools = Join-Path $SdkRoot 'platform-tools'
$NdkHome       = Join-Path $SdkRoot 'ndk\27.0.12077973'
$GradleHome    = Join-Path $ToolchainRoot 'gradle-home'
$AndroidUser   = Join-Path $ToolchainRoot 'android-user-home'

$env:JAVA_HOME        = $JdkHome
$env:ANDROID_HOME     = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:ANDROID_NDK_HOME = $NdkHome

# Android tools (sdkmanager, adb, avdmanager) default their user home to
# %USERPROFILE%\.android, which the file sandbox denies. Redirecting it into
# the workspace is what makes them work at all here. adb (platform-tools 35)
# reads ANDROID_PREFS_ROOT, while newer sdkmanager uses ANDROID_USER_HOME, so
# both are set.
if (-not (Test-Path $AndroidUser)) { New-Item -ItemType Directory -Force -Path $AndroidUser | Out-Null }
$env:ANDROID_USER_HOME  = $AndroidUser
$env:ANDROID_SDK_HOME   = $AndroidUser
$env:ANDROID_PREFS_ROOT = $AndroidUser

# Gradle user home must live inside the workspace: the file sandbox only
# allows writes under D:\Work\DSHapk.
$env:GRADLE_USER_HOME = $GradleHome

# npm's default cache/logs live under %LOCALAPPDATA%, which the sandbox denies.
# Redirecting them keeps npm usable from this workspace.
$env:npm_config_cache = Join-Path $ToolchainRoot 'npm-cache'
if (-not (Test-Path $env:npm_config_cache)) { New-Item -ItemType Directory -Force -Path $env:npm_config_cache | Out-Null }

$env:PATH = $JdkBin + ';' + $CmdlineBin + ';' + $PlatformTools + ';' + $env:PATH

Write-Host "Android environment ready (current session only):" -ForegroundColor Green
Write-Host "  JAVA_HOME        = $JdkHome"
Write-Host "  ANDROID_HOME     = $SdkRoot"
Write-Host "  ANDROID_NDK_HOME = $NdkHome"
Write-Host "  GRADLE_USER_HOME = $GradleHome"
