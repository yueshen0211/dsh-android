# Build an APK by driving the Android SDK command-line tools directly
# (aapt2 -> javac -> d8 -> zipalign -> apksigner).
#
# Why this exists: the Gradle daemon cannot start in this workspace (the file
# sandbox denies native-platform.dll's OpenThread call, so every Gradle build
# dies with "Couldn't open current thread, error = 5"). The SDK tools below are
# plain processes, so they work. Keep this even after Gradle runs, as a
# no-daemon fallback and as the release-signing driver.
#
# Usage:
#   . .\tools\android-env.ps1
#   .\tools\build-apk-cli.ps1 -ProjectDir android -Module app `
#       -PackageName dev.dsh.mobile -Label 'DeepSeek Harness'
#
# Constraints: Java sources only (javac). Kotlin would need kotlinc, which the
# SDK does not ship.

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $ProjectDir,
    [string] $Module        = 'app',
    [Parameter(Mandatory)] [string] $PackageName,
    [int]    $MinSdk        = 29,
    [int]    $TargetSdk     = 35,
    [string] $Label         = 'DSH',
    [string] $VersionName   = '0.0.1',
    [int]    $VersionCode   = 1,
    [string] $Configuration = 'debug',
    [string[]] $ExtraJniLibDirs = @(),
    # Which ABIs to package under lib/. Empty means "everything staged in
    # jniLibs", which is what a dev build wants. A release names its ABIs
    # explicitly so the shipping artifact does not depend on what happens to be
    # staged in the working tree at the time -- both runtimes can be staged at
    # once (the emulator needs x86_64), and silently shipping a 93 MB runtime
    # for the wrong architecture is the kind of mistake worth designing out.
    [string[]] $Abis = @()
)

$ErrorActionPreference = 'Stop'

# ---- locate the toolchain ----------------------------------------------------
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$ToolchainRoot = Join-Path $WorkspaceRoot '.toolchain'

$JdkBin = (Get-ChildItem -LiteralPath $ToolchainRoot -Recurse -Depth 3 -Filter 'javac.exe' -File -ErrorAction SilentlyContinue |
           ForEach-Object { $_.DirectoryName } | Select-Object -First 1)
if (-not $JdkBin) { throw "javac.exe not found under $ToolchainRoot" }
$JdkHome = Split-Path -Parent $JdkBin

$Sdk       = Join-Path $ToolchainRoot 'sdk'
$BuildTool = (Get-ChildItem (Join-Path $Sdk 'build-tools') -Directory |
              Sort-Object Name -Descending | Select-Object -First 1).FullName
$Platform  = (Get-ChildItem (Join-Path $Sdk 'platforms') -Directory |
              Sort-Object Name -Descending | Select-Object -First 1).FullName

$Aapt2     = Join-Path $BuildTool 'aapt2.exe'
$D8        = Join-Path $BuildTool 'd8.bat'
$Zipalign  = Join-Path $BuildTool 'zipalign.exe'
$ApkSigner = Join-Path $BuildTool 'apksigner.bat'
$AndroidJar = Join-Path $Platform 'android.jar'

foreach ($t in @($Aapt2, $D8, $Zipalign, $ApkSigner, $AndroidJar)) {
    if (-not (Test-Path $t)) { throw "missing tool: $t" }
}

# ---- paths -------------------------------------------------------------------
$ProjRoot = Join-Path $WorkspaceRoot $ProjectDir
$ModRoot  = Join-Path $ProjRoot $Module
$SrcDir   = Join-Path $ModRoot 'src\main\java'
$Manifest = Join-Path $ModRoot 'src\main\AndroidManifest.xml'
$ResDir   = Join-Path $ModRoot 'src\main\res'
$AssetsDir = Join-Path $ModRoot 'src\main\assets'
$LibsDir  = Join-Path $ModRoot 'libs'

if (-not (Test-Path $Manifest)) { throw "manifest not found: $Manifest" }

$BuildDir = Join-Path $ModRoot "build\cli-$Configuration"
$GenDir   = Join-Path $BuildDir 'gen'
$ClassDir = Join-Path $BuildDir 'classes'
$DexDir   = Join-Path $BuildDir 'dex'
$ResCompiled = Join-Path $BuildDir 'res-compiled'
foreach ($d in @($BuildDir, $GenDir, $ClassDir, $DexDir, $ResCompiled)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$UnsigedApk  = Join-Path $BuildDir 'unsigned.apk'
$AlignedApk  = Join-Path $BuildDir 'aligned.apk'
$FinalApk    = Join-Path $BuildDir "dsh-$Configuration.apk"

# aapt2 requires a `package` attribute in the source manifest and refuses the
# AGP-style namespace-only manifest. Normalize into a working copy so the
# checked-in manifest can stay namespace-only; -PackageName remains the single
# source of truth for the application id.
#
# The debug configuration also forces android:debuggable, which is what makes
# `adb shell run-as <pkg>` work. Without it the app's private files (the unpacked
# engine tree and the boot-failure log) cannot be inspected on device, which is
# most of the diagnostic value of a debug build. AGP injects this flag in a
# normal Gradle build; here the manifest is hand-authored, so it is added here.
$ManifestSrc = Get-Content -LiteralPath $Manifest -Raw
if ($ManifestSrc -notmatch '<manifest[^>]*\spackage\s*=') {
    $ManifestSrc = $ManifestSrc -replace '(<manifest\b)', "`$1 package=`"$PackageName`""
}
if ($Configuration -eq 'debug') {
    if ($ManifestSrc -match '<application\b') {
        $ManifestSrc = $ManifestSrc -replace '(<application\b)', '$1 android:debuggable="true"'
    } else {
        throw "manifest has no <application> element to attach android:debuggable to"
    }
}
$ManifestWork = Join-Path $BuildDir 'AndroidManifest.work.xml'
[System.IO.File]::WriteAllText($ManifestWork, $ManifestSrc, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "== toolchain ==" -ForegroundColor Cyan
Write-Host "   JDK        : $JdkHome"
Write-Host "   build-tools: $(Split-Path -Leaf $BuildTool)"
Write-Host "   platform   : $(Split-Path -Leaf $Platform)"

# ---- 1. compile resources (res/ -> .flat) -----------------------------------
$aapt2Args = @('link',
    '-o', (Join-Path $BuildDir 'resources.apk'),
    '-I', $AndroidJar,
    '--manifest', $ManifestWork,
    '--java', $GenDir,
    '--min-sdk-version', $MinSdk,
    '--target-sdk-version', $TargetSdk,
    '--version-code', $VersionCode,
    '--version-name', $VersionName,
    '--rename-manifest-package', $PackageName)

if (Test-Path $ResDir) {
    Write-Host "== aapt2 compile ==" -ForegroundColor Cyan
    & $Aapt2 compile --dir $ResDir -o $ResCompiled
    if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed ($LASTEXITCODE)" }
    $flatFiles = @(Get-ChildItem $ResCompiled -Recurse -Filter '*.flat' | ForEach-Object { $_.FullName })
    if ($flatFiles.Count -gt 0) { $aapt2Args += $flatFiles }
}

# Assets are packaged verbatim; the engine tree and its runtime ride here.
if (Test-Path $AssetsDir) {
    $assetFiles = @(Get-ChildItem $AssetsDir -Recurse -File)
    $assetMb = [math]::Round((($assetFiles | Measure-Object Length -Sum).Sum) / 1MB, 1)
    Write-Host "== assets ==" -ForegroundColor Cyan
    Write-Host "   $($assetFiles.Count) file(s), $assetMb MB"
    $aapt2Args += @('-A', $AssetsDir)
}

Write-Host "== aapt2 link ==" -ForegroundColor Cyan
& $Aapt2 @aapt2Args
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed ($LASTEXITCODE)" }
$ResApk = Join-Path $BuildDir 'resources.apk'

# ---- 2. javac ---------------------------------------------------------------
Write-Host "== javac ==" -ForegroundColor Cyan
$javaSources = @(Get-ChildItem $SrcDir -Recurse -Filter '*.java' -ErrorAction SilentlyContinue |
                 ForEach-Object { $_.FullName })
$genSources  = @(Get-ChildItem $GenDir -Recurse -Filter '*.java' -ErrorAction SilentlyContinue |
                 ForEach-Object { $_.FullName })
if ($javaSources.Count -eq 0) { throw "no .java sources under $SrcDir" }

$cp = @($AndroidJar)
if (Test-Path $LibsDir) {
    $cp += (Get-ChildItem $LibsDir -Filter '*.jar' | ForEach-Object { $_.FullName })
}
# Java 8 bytecode + android.jar as bootclasspath is the classic Android javac
# invocation, and the only combination JDK 21 still allows: -bootclasspath is
# rejected for target 17+, and --release cannot be combined with it.
# NOTE: with android.jar as the bootclasspath, java.lang.invoke is absent, so
# lambdas and method references do not compile in this project -- use anonymous
# classes. That is the price of keeping Android API discipline at compile time.
#
# ErrorActionPreference is relaxed around this call because javac writes notes
# and warnings to stderr, and PowerShell 5.1 turns native stderr into a
# terminating NativeCommandError; the exit code is the real signal.
$ErrorActionPreference = 'Continue'
& (Join-Path $JdkBin 'javac.exe') -source 8 -target 8 -Xlint:-options -encoding UTF-8 `
    -bootclasspath $AndroidJar -classpath ($cp -join ';') `
    -d $ClassDir @javaSources @genSources 2>&1 | ForEach-Object { "   $_" }
$javacExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($javacExit -ne 0) { throw "javac failed ($javacExit)" }

# ---- 3. dex -----------------------------------------------------------------
Write-Host "== d8 ==" -ForegroundColor Cyan
$ClassesJar = Join-Path $BuildDir 'classes.jar'
Push-Location $ClassDir
& (Join-Path $JdkBin 'jar.exe') cf $ClassesJar .
Pop-Location
$d8Args = @('--min-api', $MinSdk, '--output', $DexDir, $ClassesJar)
if (Test-Path $LibsDir) {
    $d8Args += (Get-ChildItem $LibsDir -Filter '*.jar' | ForEach-Object { $_.FullName })
}
& $D8 @d8Args
if ($LASTEXITCODE -ne 0) { throw "d8 failed ($LASTEXITCODE)" }

# ---- 4. package -------------------------------------------------------------
Write-Host "== package ==" -ForegroundColor Cyan
Copy-Item $ResApk $UnsigedApk -Force
Push-Location $DexDir
& (Join-Path $JdkBin 'jar.exe') uf $UnsigedApk 'classes.dex'
Pop-Location

# Native libraries: aapt2 does not package jniLibs (that is an AGP feature), and
# `jar` cannot write entries into a subdirectory, so lib/<abi>/ entries are added
# by a small zip pass that stores each .so uncompressed and mmap-able.
$JniRoot = Join-Path $ModRoot 'src\main\jniLibs'
# Resolve the ABI filter into an explicit list of directories. The zip helper
# names each abi after its directory basename, so pointing it at a staged
# `jniLibs/<abi>` directory is all that is needed.
$JniDirs = @()
if ($Abis.Count -gt 0) {
    foreach ($abi in $Abis) {
        $dir = Join-Path $JniRoot $abi
        if (-not (Test-Path $dir)) {
            $staged = if (Test-Path $JniRoot) { (Get-ChildItem $JniRoot -Directory | ForEach-Object Name) -join ', ' } else { '(none)' }
            throw "abi '$abi' is not staged at $dir (staged: $staged). Run .\tools\m1\stage-runtime.ps1 -Abi $abi"
        }
        $JniDirs += $dir
    }
    Write-Host "   abis       : $($Abis -join ', ')" -ForegroundColor Cyan
} else {
    foreach ($d in (Get-ChildItem $JniRoot -Directory -ErrorAction SilentlyContinue)) { $JniDirs += $d.FullName }
}
$JniDirs += $ExtraJniLibDirs

if ($JniDirs.Count -gt 0 -or $ExtraJniLibDirs.Count -gt 0) {
    Write-Host "== native libs ==" -ForegroundColor Cyan
    $zipHelper = Join-Path $PSScriptRoot 'zip-add-nativelibs.mjs'
    # Pass a non-existent jniRoot so only the resolved directories are used; the
    # helper treats an unreadable root as "no jniLibs".
    & node $zipHelper $UnsigedApk (Join-Path $BuildDir 'no-such-jni-root') @JniDirs
    if ($LASTEXITCODE -ne 0) { throw "native lib packaging failed ($LASTEXITCODE)" }
}

# ---- 5. zipalign + sign -----------------------------------------------------
Write-Host "== zipalign ==" -ForegroundColor Cyan
& $Zipalign -f -p 4 $UnsigedApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed ($LASTEXITCODE)" }

Write-Host "== apksigner ==" -ForegroundColor Cyan
$Keystore = Join-Path $ToolchainRoot 'debug.keystore'
if (-not (Test-Path $Keystore)) {
    Write-Host "   creating debug keystore"
    $ErrorActionPreference = 'Continue'
    & (Join-Path $JdkBin 'keytool.exe') -genkeypair -v `
        -keystore $Keystore -storepass android -keypass android `
        -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
        -dname "CN=Android Debug,O=Android,C=US" 2>&1 | Out-Null
    $ErrorActionPreference = 'Stop'
    if (-not (Test-Path $Keystore)) { throw "keytool did not produce $Keystore" }
}
& $ApkSigner sign --ks $Keystore --ks-pass pass:android --key-pass pass:android `
    --ks-key-alias androiddebugkey --out $FinalApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "apksigner failed ($LASTEXITCODE)" }

$size = [math]::Round((Get-Item $FinalApk).Length / 1MB, 1)
Write-Host ""
Write-Host "BUILD OK: $FinalApk ($size MB)" -ForegroundColor Green
Write-Host "install: adb install -r `"$FinalApk`""
