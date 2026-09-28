# Fetch and unpack the Android Node runtime: the Termux nodejs package plus the
# shared libraries its DT_NEEDED list requires.
#
# Why Termux packages: they are the only maintained prebuilt Node for Android
# that is new enough. nodejs-mobile stops at 18.20.4 and puerts at 16.16, while
# the DSH engine hard-requires Node >= 20 (`dsh-app-boot` statically imports
# `parseEnv` from `node:util`, which Node 18 does not export).
#
# Usage:
#   . .\tools\m1\common.ps1
#   .\tools\m1\fetch-runtime.ps1                    # arm64-v8a (default)
#   .\tools\m1\fetch-runtime.ps1 -Abi x86_64        # emulator target
#
# Output: .toolchain\termux-runtime-<abi>\<pkg>\... (flat, see Expand-DebFlat)

param([string] $Abi = 'arm64-v8a')

. "$PSScriptRoot\common.ps1"

$facts = Get-AbiFacts -Abi $Abi
$runtimeRoot = Join-Path $script:M1Toolchain "termux-runtime-$($facts.Abi)"
$PkgIndex = Get-TermuxPackageIndex -TermuxArch $facts.TermuxArch
Write-Host "fetching runtime for $($facts.Abi) (termux arch $($facts.TermuxArch))"

# nodejs itself, then its declared runtime dependencies. libicu is split into
# the data package; the symbol libraries are what node links against.
$wanted = @(
    'nodejs',
    'openssl',
    'libicu',
    'libsqlite',
    'libffi',
    'c-ares',
    'libc++',
    'zlib'
)

New-Item -ItemType Directory -Force -Path $runtimeRoot, $script:M1Downloads | Out-Null

foreach ($pkg in $wanted) {
    Write-Host "== $pkg =="
    $rel = Get-TermuxPackageFile -PackagesIndex $PkgIndex -PackageName $pkg
    # The Filename field already carries the pool-relative path.
    $url = "https://packages.termux.dev/apt/termux-main/$rel"
    $deb = Join-Path $script:M1Downloads ("termux-$($facts.TermuxArch)-$pkg.deb")
    Get-FileOnce -Url $url -OutFile $deb

    $dest = Join-Path $runtimeRoot $pkg
    $marker = Join-Path $dest '.extracted'
    if (Test-Path $marker) { Write-Host "    already extracted"; continue }
    # Only the runtime pieces matter: the node executable, and shared objects.
    Expand-DebFlat -DebFile $deb -DestDir $dest -Patterns @('*/usr/bin/*', '*/usr/lib/*.so*')
    New-Item -ItemType File -Path $marker -Force | Out-Null
}

Write-Host ""
Write-Host "=== extracted package trees ($($facts.Abi)) ==="
Get-ChildItem $runtimeRoot -Directory | ForEach-Object {
    $files = @(Get-ChildItem $_.FullName -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.extracted' })
    "  {0,-12} {1} file(s)" -f $_.Name, $files.Count
    foreach ($f in $files) { "      $($f.Name) ($([math]::Round($f.Length/1MB,1)) MB)" }
}
