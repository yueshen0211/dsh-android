# Shared helpers for the M1 runtime-packaging scripts.
#
# Kept free of build system assumptions: plain functions, ASCII-only, no
# external modules. Dot-source it:
#   . "$PSScriptRoot\common.ps1"

$ErrorActionPreference = 'Stop'

$script:M1Workspace   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # D:\Work\DSHapk
$script:M1Toolchain   = Join-Path $script:M1Workspace '.toolchain'
$script:M1Downloads   = Join-Path $script:M1Toolchain 'downloads'
$script:M1TermuxPool  = 'https://packages.termux.dev/apt/termux-main'

# Two ABIs are built from the same pipeline:
#
#   arm64-v8a  the shipping target (phones)
#   x86_64     the emulator target
#
# The x86_64 variant exists purely for development speed. An arm64 system image
# can run on an x86_64 host, but only under QEMU instruction translation, which
# makes every iteration (unpacking ~190 MB, then booting Node) take tens of
# minutes. The x86_64 image runs on the host hypervisor at native speed, so the
# edit/run loop becomes usable. Termux publishes x86_64 packages, the NDK has
# prebuilts for both architectures, and koffi ships an android-x64 binding, so
# nothing about the approach is arm64-specific.
function Get-AbiFacts {
    param([Parameter(Mandatory)] [string] $Abi)
    switch ($Abi) {
        'arm64-v8a' {
            return @{ Abi = 'arm64-v8a'; TermuxArch = 'aarch64'; AndroidTriple = 'aarch64-linux-android' }
        }
        'x86_64' {
            return @{ Abi = 'x86_64'; TermuxArch = 'x86_64'; AndroidTriple = 'x86_64-linux-android' }
        }
        default { throw "unsupported ABI '$Abi' (expected arm64-v8a or x86_64)" }
    }
}

# Extract a Termux package index for one architecture, caching it on disk.
# Returns exactly one path: Get-FileOnce emits to the pipeline, so without the
# explicit Write-Output -NoEnumerate the caller would receive an array and the
# downstream [string] parameter would fail to bind.
function Get-TermuxPackageIndex {
    param([Parameter(Mandatory)] [string] $TermuxArch)
    $index = Join-Path $script:M1Toolchain "_pkgs-$TermuxArch.txt"
    if (-not ((Test-Path $index) -and (Get-Item $index).Length -gt 0)) {
        Get-FileOnce -Url "$($script:M1TermuxPool)/dists/stable/main/binary-$TermuxArch/Packages" -OutFile $index
    }
    Write-Output -NoEnumerate $index
}

# Download one URL to a file, skipping when the file already exists non-empty.
# Uses Node's TLS stack: curl.exe in this environment fails with
# "schannel: AcquireCredentialsHandle failed (SEC_E_NO_CREDENTIALS)".
# Retries because this sandbox's outbound network is intermittently unavailable.
function Get-FileOnce {
    param(
        [Parameter(Mandatory)] [string] $Url,
        [Parameter(Mandatory)] [string] $OutFile,
        [int] $Attempts = 4
    )
    if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) {
        Write-Host "    cached: $(Split-Path -Leaf $OutFile)"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
    # The URL travels Base64-encoded. Debian filenames may contain an epoch
    # colon (`openssl_1:3.6.3_aarch64.deb`) and PowerShell splits a native
    # command argument at a colon even when it is quoted, which reached node as
    # the scheme "https" -> "unknown scheme". Base64 has no colon, so the value
    # survives the command-line round trip intact.
    $script = @'
const fs = require('fs');
const url = Buffer.from(process.argv[2], 'base64').toString('utf8');
const out = process.argv[3];
// Construct via URL so any character that is legal in a Debian filename but
// not in a URL path is percent-encoded for us.
const href = new URL(url).href;
fetch(href).then(async (r) => {
  if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + href);
  const b = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(out, b);
  console.log('    saved ' + (b.length / 1048576).toFixed(1) + ' MB -> ' + out.split(/[\\/]/).pop());
}).catch((e) => { console.log('    FAIL ' + e.message + (e.cause ? ' | cause: ' + e.cause : '')); process.exit(1); });
'@
    $tmp = Join-Path $env:TEMP ("dsh-dl-" + [guid]::NewGuid().ToString('N') + '.cjs')
    [System.IO.File]::WriteAllText($tmp, $script, (New-Object System.Text.UTF8Encoding($false)))
    $urlB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Url))
    try {
        for ($i = 1; $i -le $Attempts; $i++) {
            # The downloader's own stdout is discarded: it would otherwise join
            # this function's pipeline output, and a caller that expects one path
            # back would receive an array instead.
            & node $tmp $urlB64 "$OutFile" | Out-Null
            if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) { return }
            if ($i -lt $Attempts) { Write-Host "    retry $i/$Attempts ..."; Start-Sleep -Seconds 5 }
        }
        throw "download failed after $Attempts attempts: $Url"
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

# Extract selected members of a Debian package into one flat directory.
#
# Windows cannot create the absolute symlinks these packages contain (GNU tar
# aborts without Developer Mode/elevation), and the deep
# `data/data/com.termux/files/usr/lib` tree can exceed MAX_PATH under this
# workspace. Both are handled by _tar-flat-extract.py, which materialises links
# as real copies and collapses the tree to basenames.
function Expand-DebFlat {
    param(
        [Parameter(Mandatory)] [string] $DebFile,
        [Parameter(Mandatory)] [string] $DestDir,
        [string[]] $Patterns = @()
    )
    if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

    $helper = Join-Path $script:M1Toolchain '_deb-extract.py'
    $flat = Join-Path $script:M1Toolchain '_tar-flat-extract.py'
    foreach ($h in @($helper, $flat)) { if (-not (Test-Path $h)) { throw "missing helper: $h" } }

    $tmp = Join-Path $script:M1Toolchain ("_debwork-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
        & python $helper $DebFile $tmp
        if ($LASTEXITCODE -ne 0) { throw "deb data extraction failed: $DebFile" }
        $tar = Join-Path $tmp 'data.tar'
        if (-not (Test-Path $tar)) { throw "no data.tar produced from $DebFile" }
        if ($Patterns.Count -gt 0) {
            & python $flat $tar $DestDir @Patterns
        } else {
            & python $flat $tar $DestDir
        }
        if ($LASTEXITCODE -ne 0) { throw "flat extraction failed: $DebFile" }
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Look up a Termux package's Filename by exact package name.
function Get-TermuxPackageFile {
    param(
        [Parameter(Mandatory)] [string] $PackagesIndex,
        [Parameter(Mandatory)] [string] $PackageName
    )
    $cur = $null
    foreach ($line in Get-Content $PackagesIndex) {
        if ($line -match '^Package: (.+)$') { $cur = $Matches[1].Trim() }
        elseif ($line -match '^Filename: (.+)$' -and $cur -eq $PackageName) { return $Matches[1].Trim() }
    }
    throw "package '$PackageName' not found in $PackagesIndex"
}
