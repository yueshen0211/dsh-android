# Upload the release APK, then the checksums -- in that order, and only on success.
#
# Why this is a script rather than two gh calls:
#
#   * `--clobber` DELETES the existing asset and re-uploads. If the upload then
#     fails -- this sandbox drops large transfers with a bare EOF -- the release
#     is left with NO apk, which is worse than a stale one.
#   * The checksum file must never be newer than the apk it describes. Uploading
#     the sums first briefly publishes a digest for a file that does not exist,
#     which is exactly how a downloader ends up reporting a mismatch on a
#     perfectly good build.
#   * The upload needs retries: a 140 MB POST to uploads.github.com is the single
#     most network-sensitive step in this project.
#
# The APK is verified against GitHub's own computed digest before the checksum
# file is allowed anywhere near the release.
#
# Usage:
#   . .\tools\gh-env.ps1
#   .\tools\publish-release.ps1

[CmdletBinding()]
param(
    [string] $Tag      = 'v0.1.0-m1',
    [string] $Repo     = 'yueshen0211/dsh-android',
    [string] $Apk      = 'D:\Work\DSHapk\.m1\release\dsh-android-0.1.0-m1-arm64-v8a-debug.apk',
    [string] $Sums     = 'D:\Work\DSHapk\.m1\release\SHA256SUMS.txt',
    [int]    $Attempts = 5
)

$ErrorActionPreference = 'Stop'

if (-not $env:GH_TOKEN) { throw "GH_TOKEN not set -- run: . .\tools\gh-env.ps1" }
$gh = Join-Path (Split-Path -Parent $PSScriptRoot) '.toolchain\gh\bin\gh.exe'
if (-not (Test-Path $gh)) { $gh = 'gh' }
foreach ($f in @($Apk, $Sums)) {
    if (-not (Test-Path $f)) { throw "missing: $f" }
}

$apkName = Split-Path -Leaf $Apk
$expected = (Get-FileHash $Apk -Algorithm SHA256).Hash.ToLower()
Write-Host "APK      : $apkName"
Write-Host "sha256   : $expected"
Write-Host "expecting: $((Get-Item $Apk).Length) bytes"

# Assert the checksum file actually describes this artifact before publishing it.
$sumLine = (Get-Content $Sums | Where-Object { $_ -match [regex]::Escape($apkName) })
if (-not $sumLine) { throw "$Sums does not mention $apkName" }
if ($sumLine -notmatch $expected) { throw "$Sums does not carry the current digest of $apkName" }
Write-Host "sums     : consistent with the APK on disk" -ForegroundColor Green

# gh reports the digest it computed server-side; retry until it matches, so a
# truncated or corrupted transfer can never be mistaken for a good upload.
$uploaded = $false
for ($i = 1; $i -le $Attempts -and -not $uploaded; $i++) {
    Write-Host ""
    Write-Host "upload attempt $i/$Attempts ..." -ForegroundColor Cyan
    # cmd.exe, because a native command's non-zero exit must not become a
    # terminating error here: a failed attempt is retried, not fatal.
    & cmd.exe /c "`"$gh`" release upload $Tag `"$Apk`" --repo $Repo --clobber 2>&1" | ForEach-Object { "    $_" }

    $json = (& $gh release view $Tag --repo $Repo --json assets 2>$null) -join ''
    $asset = ($json | ConvertFrom-Json).assets | Where-Object { $_.name -eq $apkName }
    if ($asset -and $asset.digest -eq "sha256:$expected") {
        $uploaded = $true
        Write-Host "verified : GitHub digest matches ($($asset.size) bytes)" -ForegroundColor Green
        break
    }
    $got = if ($asset) { $asset.digest } else { '(asset absent)' }
    Write-Host "mismatch : $got" -ForegroundColor Yellow
    if ($i -lt $Attempts) { Start-Sleep -Seconds 10 }
}
if (-not $uploaded) { throw "APK upload did not verify after $Attempts attempts; checksums NOT published" }

# Only now is the digest file true.
& cmd.exe /c "`"$gh`" release upload $Tag `"$Sums`" --repo $Repo --clobber 2>&1" | ForEach-Object { "    $_" }
Write-Host ""
Write-Host "PUBLISHED $apkName + SHA256SUMS.txt to $Tag" -ForegroundColor Green
# Via --json rather than --template: gh's Go templates need `{{"\n"}}`, and the
# backslash does not survive this shell's quoting. JSON always does.
$final = (& $gh release view $Tag --repo $Repo --json assets 2>$null) -join ''
($final | ConvertFrom-Json).assets | ForEach-Object { "  $($_.name)"; "    $($_.digest)" }
