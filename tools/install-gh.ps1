# Download the GitHub CLI into the workspace.
#
# Kept local rather than installed system-wide: it is one 15 MB zip, it is only
# needed for publishing releases, and the toolchain in this repository is already
# self-contained by design (JDK, SDK, NDK, Gradle and the emulator all live under
# .toolchain/).
#
# Usage:  .\tools\install-gh.ps1
# Then:   . .\tools\gh-env.ps1

$ErrorActionPreference = 'Stop'

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$Toolchain = Join-Path $WorkspaceRoot '.toolchain'
$Downloads = Join-Path $Toolchain 'downloads'
$Target = Join-Path $Toolchain 'gh'
$Zip = Join-Path $Downloads 'gh.zip'

if (Test-Path (Join-Path $Target 'bin\gh.exe')) {
    Write-Host "gh already installed at $Target"
    & (Join-Path $Target 'bin\gh.exe') --version | Select-Object -First 1
    exit 0
}

New-Item -ItemType Directory -Force -Path $Downloads | Out-Null

if (-not (Test-Path $Zip)) {
    Write-Host "resolving the latest gh release ..."
    # Node's TLS stack is used because curl.exe fails in this environment with
    # "schannel: AcquireCredentialsHandle failed (SEC_E_NO_CREDENTIALS)".
    $script = @'
const fs = require('fs');
const [zip] = process.argv.slice(2);
fetch('https://api.github.com/repos/cli/cli/releases/latest', {
  headers: { 'User-Agent': 'dsh-android' }
}).then((r) => r.json()).then(async (release) => {
  const asset = (release.assets || []).find((a) => /windows_amd64\.zip$/.test(a.name));
  if (!asset) throw new Error('no windows_amd64 asset in ' + release.tag_name);
  const download = await fetch(asset.browser_download_url);
  if (!download.ok) throw new Error('HTTP ' + download.status);
  const body = Buffer.from(await download.arrayBuffer());
  fs.writeFileSync(zip, body);
  console.log('  ' + release.tag_name + ' -> ' + (body.length / 1048576).toFixed(1) + ' MB');
}).catch((error) => { console.log('  FAIL ' + error.message); process.exit(1); });
'@
    $runner = Join-Path $env:TEMP ("dsh-gh-" + [guid]::NewGuid().ToString('N') + '.cjs')
    [System.IO.File]::WriteAllText($runner, $script, (New-Object System.Text.UTF8Encoding($false)))
    try {
        & node $runner $Zip | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "download failed" }
    } finally {
        Remove-Item $runner -Force -ErrorAction SilentlyContinue
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
[System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Target)

$exe = Join-Path $Target 'bin\gh.exe'
if (-not (Test-Path $exe)) { throw "unexpected archive layout: $exe missing" }
Write-Host "installed:" -ForegroundColor Green
& $exe --version | Select-Object -First 1
Write-Host ""
Write-Host "activate with:  . .\tools\gh-env.ps1"
