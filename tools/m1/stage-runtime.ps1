# Stage the Android Node runtime into the app's jniLibs, ready for packaging.
#
# Three things happen here, each for a specific Android constraint:
#
#  1. Only the DT_NEEDED closure resolved by tools/elf-closure.mjs is copied, so
#     the APK does not carry ICU/Option sets nothing links against.
#  2. GNU `node` is renamed to `libnode.so`. Android's packaging only extracts
#     `lib*.so` files from jniLibs into nativeLibraryDir, and nativeLibraryDir is
#     the one app-writable location that is mounted executable -- so this rename
#     is what makes the binary runnable at all on Android 10+ (app-private data
#     directories are mounted noexec).
#  3. The executable's DT_RUNPATH is rewritten from Termux's hardcoded
#     `/data/data/com.termux/files/usr/lib` to `$ORIGIN`, so the loader finds the
#     sibling .so files inside nativeLibraryDir without any environment help.
#     `$ORIGIN` is shorter than the path it replaces, so the string is
#     overwritten in place and NUL-padded; no ELF offsets change.
#
# Usage:
#   . .\tools\m1\common.ps1
#   .\tools\m1\stage-runtime.ps1                  # arm64-v8a (shipping target)
#   .\tools\m1\stage-runtime.ps1 -Abi x86_64      # emulator target

param([string] $Abi = 'arm64-v8a')

. "$PSScriptRoot\common.ps1"

$facts = Get-AbiFacts -Abi $Abi
$rt = Join-Path $script:M1Toolchain "termux-runtime-$($facts.Abi)"
$nodeSrc = Join-Path $rt 'nodejs\node'
if (-not (Test-Path $nodeSrc)) { throw "runtime not fetched: $nodeSrc missing (run fetch-runtime.ps1 -Abi $Abi)" }

$out = Join-Path $script:M1Workspace "android\app\src\main\jniLibs\$($facts.Abi)"
Write-Host "staging $($facts.Abi) into $out"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Resolve which shared objects to ship.
$poolArgs = @()
Get-ChildItem $rt -Directory | ForEach-Object { $poolArgs += @('--pool', $_.FullName) }
$jsonPath = Join-Path $script:M1Toolchain "runtime-closure-$($facts.Abi).json"
$elfClosure = Join-Path $script:M1Workspace 'tools\elf-closure.mjs'
$closureJson = & node $elfClosure --root $nodeSrc @poolArgs --json $jsonPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $closureJson; throw "dependency closure failed" }
$closure = Get-Content $jsonPath -Raw | ConvertFrom-Json

$staged = @()
foreach ($lib in $closure.ships) {
    $dest = Join-Path $out $lib.name
    Copy-Item $lib.path $dest -Force
    $staged += $lib.name
    Write-Host ("  ship {0,-20} {1,8:N2} MB" -f $lib.name, ((Get-Item $dest).Length / 1MB))
}

# The node executable itself, renamed so Android extracts it as a native library.
$nodeDest = Join-Path $out 'libnode.so'
Copy-Item $nodeSrc $nodeDest -Force
Write-Host ("  ship {0,-20} {1,8:N2} MB  (from node)" -f 'libnode.so', ((Get-Item $nodeDest).Length / 1MB))
$staged += 'libnode.so'

# The loader resolves DT_NEEDED by exact soname, and the closure reports those
# versioned ("libcrypto.so.3", "libz.so.1", ...). Android's package manager,
# however, only extracts native library entries named `lib*.so` from the APK --
# versioned names are silently dropped at install time, which is exactly how the
# first device run failed:
#
#   CANNOT LINK EXECUTABLE: library "libz.so.1" not found: needed by main executable
#
# Shipping duplicate files under the versioned names does not work, because the
# filter runs at install time. So the DT_NEEDED strings are rewritten in place to
# the unversioned names that do ship (see tools/elf-patch-needed.mjs for the
# safety argument).
Write-Host "  patching versioned DT_NEEDED entries:"
$elfPatch = Join-Path $script:M1Workspace 'tools\elf-patch-needed.mjs'
foreach ($so in Get-ChildItem $out -File -Filter '*.so') {
    $result = & node $elfPatch $so.FullName 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host $result; throw "DT_NEEDED patch failed for $($so.Name)" }
    $applied = @($result | Where-Object { $_ -match '->' })
    if ($applied.Count -gt 0) {
        Write-Host "    $($so.Name)"
        $applied | ForEach-Object { Write-Host "  $_" }
    }
}

# The node executable itself was copied above (as libnode.so) so that the
# DT_NEEDED rewrite below covers it too.

# --- rewrite DT_RUNPATH to $ORIGIN ------------------------------------------
$temuxLibPath = '/data/data/com.termux/files/usr/lib'
$replacement = '$ORIGIN'
$bytes = [System.IO.File]::ReadAllBytes($nodeDest)
$text = [System.Text.Encoding]::ASCII.GetString($bytes)
$idx = $text.IndexOf($temuxLibPath)
if ($idx -lt 0) {
    throw "expected DT_RUNPATH '$temuxLibPath' not found in $nodeDest; refusing to guess"
}
if ([System.Text.Encoding]::ASCII.GetByteCount($replacement) -gt [System.Text.Encoding]::ASCII.GetByteCount($temuxLibPath)) {
    throw 'replacement path is longer than the original; in-place patching would corrupt the ELF'
}
# Overwrite in place and NUL-pad the remainder: the string table entry keeps its
# size, so every ELF offset and the dynamic symbol hashes stay valid.
$enc = [System.Text.Encoding]::ASCII.GetBytes($replacement)
for ($i = 0; $i -lt $enc.Length; $i++) { $bytes[$idx + $i] = $enc[$i] }
for ($i = $enc.Length; $i -lt $temuxLibPath.Length; $i++) { $bytes[$idx + $i] = 0 }
[System.IO.File]::WriteAllBytes($nodeDest, $bytes)
Write-Host "  patched DT_RUNPATH: '$temuxLibPath' -> '$replacement'"

# --- verify the patch and the final closure ---------------------------------
Write-Host ""
Write-Host "=== staged libnode.so ==="
& node (Join-Path $script:M1Workspace 'tools\elf-inspect.mjs') $nodeDest
Write-Host "=== closure of staged tree (must report no missing) ==="
& node $elfClosure --root $nodeDest --pool $out

$total = (Get-ChildItem $out -File | Measure-Object Length -Sum).Sum
Write-Host ""
Write-Host ("staged {0} files, {1:N1} MB total" -f (Get-ChildItem $out -File).Count, ($total / 1MB))
