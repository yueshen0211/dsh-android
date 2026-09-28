# Stage the DSH engine dependency tree into the app's assets.
#
# The engine is ESM and resolves `@deepseek-ai/*` through a node_modules tree, so
# the tree must ship inside the APK and be unpacked to a writable location on
# first launch (assets are not directly importable).
#
# A production-only install (`--omit=dev --omit=optional`) is intentional:
#   * dev dependencies are not needed at runtime;
#   * optional dependencies are the platform-specific prebuilds (sharp's
#     android-arm64 bindings, node-addon-system's per-platform launchers) --
#     none of which apply to this target, and pulling them in would only bloat
#     the APK with binaries the engine cannot load.
#
# Usage:  . .\tools\m1\common.ps1 ; .\tools\m1\stage-engine.ps1

. "$PSScriptRoot\common.ps1"

$engineSrc = Join-Path $script:M1Toolchain 'engine-stage'
$assetsDir = Join-Path $script:M1Workspace 'android\app\src\main\assets\engine'
$dshVersion = '0.1.5-rc.3'

New-Item -ItemType Directory -Force -Path $engineSrc | Out-Null

$pkgJson = Join-Path $engineSrc 'package.json'
if (-not (Test-Path $pkgJson)) {
    $manifest = @{
        name    = 'dsh-android-engine'
        private = $true
        dependencies = @{ '@deepseek-ai/dsh' = $dshVersion }
    } | ConvertTo-Json -Depth 5
    # ASCII only: PowerShell 5.1 reads .ps1 as ANSI, and a stray non-ASCII
    # character in a generated file is an easy way to break a later parse.
    [System.IO.File]::WriteAllText($pkgJson, $manifest, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "installing engine dependencies (production only, android-arm64) ..."
$env:npm_config_cache = Join-Path $script:M1Toolchain 'npm-cache'
Push-Location $engineSrc
try {
    # --os/--cpu make npm resolve optional platform packages for the *target*
    # instead of the host. That matters because six engine packages depend on
    # koffi (FFI), whose install script rebuilds from source when it cannot find
    # a prebuilt for the running platform -- which needs CMake and fails. With
    # the target set to android/arm64 npm fetches @koromix/koffi-android-arm64,
    # which is exactly the binary the phone will load, and no build is attempted.
    & npm install --omit=dev --omit=optional --no-audit --no-fund `
        --os=android --cpu=arm64 --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

$modules = Join-Path $engineSrc 'node_modules'
if (-not (Test-Path $modules)) { throw "no node_modules produced at $modules" }

# --- work around aapt2 dropping dot-prefixed files ---------------------------
# aapt2's `-A` packaging silently omits entries whose name starts with a dot.
# Most of the 69 such files npm leaves in the tree are inert configuration
# (eslintrc, nycrc, travis, npmignore...), but a dependency may also IMPORT one,
# and then the engine dies at load with ERR_MODULE_NOT_FOUND:
#
#   Cannot find module '.../@earendil-works/pi-ai/dist/providers/data/.manifest.json'
#   imported from        '.../@earendil-works/pi-ai/dist/providers/all.js'
#
# So any dot-prefixed file that some shipped module references by name is renamed
# to its un-dotted equivalent and every reference is rewritten. Anything still
# referenced after that fails the build, rather than producing an APK that dies
# on device.
$dottedRenames = @(
    @{ Old = '@earendil-works\pi-ai\dist\providers\data\.manifest.json'; New = 'manifest.json' }
)
foreach ($rename in $dottedRenames) {
    $old = Join-Path $modules $rename.Old
    if (-not (Test-Path $old)) {
        Write-Host "  dotfile rename target absent, skipping: $($rename.Old)"
        continue
    }
    $new = Join-Path (Split-Path -Parent $old) $rename.New
    Move-Item $old $new -Force
    Write-Host "  renamed drop-prone dotfile: $($rename.Old) -> $($rename.New)"
    # Rewrite references: the quoted specifier and the bare token, so both
    # `import x from "./data/.manifest.json"` and any path built from the name
    # keep working.
    $oldLeaf = Split-Path -Leaf $rename.Old
    $touched = 0
    foreach ($file in Get-ChildItem $modules -Recurse -File -Include '*.js', '*.mjs', '*.cjs') {
        $text = [System.IO.File]::ReadAllText($file.FullName)
        if ($text.IndexOf('./data/' + $oldLeaf, [System.StringComparison]::Ordinal) -lt 0 -and
            $text.IndexOf($oldLeaf, [System.StringComparison]::Ordinal) -lt 0) {
            continue
        }
        $updated = $text.Replace('./data/' + $oldLeaf, './data/' + $rename.New).Replace($oldLeaf, $rename.New)
        if ($updated -ne $text) {
            [System.IO.File]::WriteAllText($file.FullName, $updated, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "    rewrote reference in $($file.FullName.Replace("$modules\", ''))"
            $touched++
        }
    }
    Write-Host "    references rewritten: $touched file(s)"
}

# Fail loudly if a dot-prefixed file is still imported from a shipped module: the
# APK would drop it and the engine would fail only once installed.
$remaining = 0
foreach ($file in Get-ChildItem $modules -Recurse -File -Include '*.js', '*.mjs', '*.cjs') {
    $text = [System.IO.File]::ReadAllText($file.FullName)
    foreach ($match in [regex]::Matches($text, '["'']\.?\.?/[^"'']*/\.[A-Za-z0-9_-][^"'']*\.(?:json|mjs|cjs|js|wasm|node)["'']')) {
        Write-Host "  WARNING: $($file.FullName.Replace("$modules\", '')) imports dot-prefixed $($match.Value)" -ForegroundColor Yellow
        $remaining++
    }
}
if ($remaining -gt 0) {
    throw "$remaining import(s) of dot-prefixed files remain; aapt2 will drop them from the APK. Add a rename entry above."
}
Write-Host "  dot-prefixed import check: clean"

# --- install the project's own Android plugins -------------------------------
# These replace native-only or desktop-only upstream rows; shipping them inside
# the engine tree keeps them resolvable by the same ESM resolution as everything
# else (`@dsh-mobile/*` resolves like any other package).
$pluginSource = Join-Path $script:M1Workspace 'android\plugins'
if (Test-Path $pluginSource) {
    Get-ChildItem $pluginSource -Directory | ForEach-Object {
        $scopeDir = Join-Path $modules '@dsh-mobile'
        New-Item -ItemType Directory -Force -Path $scopeDir | Out-Null
        $target = Join-Path $scopeDir $_.Name
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        Copy-Item $_.FullName $target -Recurse -Force
        Write-Host "  installed plugin @dsh-mobile/$($_.Name)"
    }
}

# --- replace native-only modules with Android stand-ins ----------------------
# Two packages in the tree reach for a native binding that has no Android build.
# Neither failure is survivable by configuration, because in both cases the
# import is static and the plugin tree loads every row eagerly, so a failed
# import aborts the whole boot:
#
#   node-pty            `dsh-subprocess-local` imports it statically.
#                       Failed to load native module: pty.node, checked:
#                       build/Release, build/Debug, prebuilds/android-arm64
#
#   node-addon-system   `dsh-session-persistence-jsonl` imports `./flock`
#                       statically, and upstream's entry refuses Android by
#                       platform before reaching the kernel. The lock is a
#                       required step of creating a session, so this breaks every
#                       run, not a degraded feature:
#                         flock is not supported on android-arm64
#
# See android/shims/node-pty/index.js and android/shims/node-addon-system/lib/flock.js
# for exactly what each stand-in does and does not provide.
$shimsSource = Join-Path $script:M1Workspace 'android\shims'
if (Test-Path $shimsSource) {
    Get-ChildItem $shimsSource -Directory | ForEach-Object {
        # Install at the path the shim's DECLARED package name implies, not at its
        # folder name. The folder under android/shims is a flat label for humans,
        # so a scoped upstream package can be replaced without needing a scoped
        # folder on disk -- and a mismatch here would silently leave the original
        # package in place, which is a failure that only shows up at runtime.
        $declared = Get-OwnPackageName $_.FullName
        if (-not $declared) { throw "shim $($_.Name) has no package.json name; cannot resolve its install path" }
        $target = Get-NodeModulesPath $modules $declared
        if (Test-Path $target) {
            Write-Host "replacing node_modules/$declared with the Android shim ($($_.Name))"
            Remove-Item $target -Recurse -Force
        } else {
            Write-Host "adding node_modules/$declared from the Android shim ($($_.Name))"
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item $_.FullName $target -Recurse -Force
    }
}

# --- koffi's native bindings, fetched directly -------------------------------
# Koffi is FFI and is depended on by six engine packages (fs-local,
# session-persistence-jsonl -- which needs it for the POSIX flock lease --
# subprocess-local, and the native pickers). At load time it probes
#   node_modules/@koromix/koffi-<process.platform>-<process.arch>
# so on a phone it looks for @koromix/koffi-android-arm64 and in an x86_64
# emulator it looks for @koromix/koffi-android-x64. BOTH ship in the one tree:
# Node picks the right one at runtime from process.arch, and together they cost
# about 2.6 MB, which is cheaper than maintaining two engine trees.
#
# These packages cannot be installed through npm here: their os/cpu fields are
# android/*, and npm validates those against the *host*, failing with
# EBADPLATFORM regardless of --os/--cpu. Each is only a few files, so the
# tarball is unpacked into place directly. koffi's own install script is skipped
# entirely (`--ignore-scripts`), which is also what keeps its CMake rebuild from
# running on Windows.
$koffiVersion = '3.3.2'
foreach ($koffiAbi in @(@{ Dir = 'koffi-android-arm64'; Arch = 'arm64' }, @{ Dir = 'koffi-android-x64'; Arch = 'x64' })) {
    $koffiDir = Join-Path $modules "@koromix\$($koffiAbi.Dir)"
    if (Test-Path $koffiDir) { continue }
    Write-Host "fetching @koromix/$($koffiAbi.Dir)@$koffiVersion ..."
    New-Item -ItemType Directory -Force -Path $koffiDir | Out-Null
    $tarball = Join-Path $script:M1Downloads "$($koffiAbi.Dir)-$koffiVersion.tgz"
    Get-FileOnce -Url "https://registry.npmjs.org/@koromix/$($koffiAbi.Dir)/-/$($koffiAbi.Dir)-$koffiVersion.tgz" -OutFile $tarball
    # npm tarballs are gzipped tars rooted at `package/`.
    Push-Location $koffiDir
    try {
        & tar -xzf $tarball --strip-components=1
        if ($LASTEXITCODE -ne 0) { throw "koffi tarball extraction failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
    $node = Get-ChildItem $koffiDir -Recurse -File -Filter '*.node' | Select-Object -First 1
    Write-Host ("    binding: {0}  {1:N2} MB" -f $node.Name, ($node.Length / 1MB))
}

$files = @(Get-ChildItem $modules -Recurse -File -ErrorAction SilentlyContinue)
$totalMb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "engine tree: $($files.Count) files, $totalMb MB"

Write-Host "copying into assets (this is the slow part) ..."
if (Test-Path $assetsDir) { Remove-Item $assetsDir -Recurse -Force }
# The tree must land at assets/engine/node_modules/...
#
# Node's ESM resolver only searches directories literally named `node_modules`,
# walking up from the importing file. An earlier layout put the tree directly at
# assets/engine/@deepseek-ai/..., which unpacks to
# files/engine/@deepseek-ai/... -- a directory the resolver never consults, so
# the engine died at its first import with:
#
#   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-app-boot'
#   imported from .../files/engine/@deepseek-ai/dsh/lib/bin.js
#
# The packaged tree already IS a node_modules directory, so it is copied into a
# directory of that name rather than flattened.
$nodeModulesDest = Join-Path $assetsDir 'node_modules'
New-Item -ItemType Directory -Force -Path $nodeModulesDest | Out-Null

# /E copies the empty directory structure too, which ESM resolution relies on.
& robocopy $modules $nodeModulesDest /E /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

# A version marker lets the app detect when it must re-unpack after an upgrade.
#
# The marker is CONTENT-DERIVED, not just the engine package version. A static
# version string silently defeated itself during development: the asset layout
# and the node-pty shim both changed while `@deepseek-ai/dsh` stayed at
# 0.1.5-rc.3, so the app saw "already unpacked" and kept running the previous,
# broken tree on device. Folding in the tree's file count and total size means
# any real change to what ships triggers a re-unpack.
#
# Deliberately NOT dot-prefixed: aapt2 silently drops hidden entries when
# packaging assets (`-A`), so a `.engine-version` marker never reaches the APK.
# The dot-files npm leaves in the tree (eslintrc, travis, nycrc, npmignore and
# similar) are inert configuration and are dropped along with it.
$marker = Join-Path $nodeModulesDest 'ENGINE-VERSION'
$treeFiles = @(Get-ChildItem $nodeModulesDest -Recurse -File)
$treeBytes = ($treeFiles | Measure-Object Length -Sum).Sum
$fingerprint = "{0} files={1} bytes={2}" -f $dshVersion, $treeFiles.Count, $treeBytes
[System.IO.File]::WriteAllText($marker, "$fingerprint`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "engine fingerprint: $fingerprint"

# The Android profile overlay ships next to the tree and is passed to the engine
# as an absolute `--patch` path. It lives outside node_modules so the unpack step
# can place it anywhere; only the tree's location is constrained.
$profileSource = Join-Path $script:M1Workspace 'profile\android.patch.yml'
$profileDest = Join-Path $assetsDir 'android.patch.yml'
Copy-Item $profileSource $profileDest -Force
Write-Host "staged profile: android.patch.yml"

# --- Android support modules (preloads the engine is started with) -----------
# Not profile config: these are Node-level corrections the loader cannot express,
# because an ESM named import from a builtin is a snapshot rather than a live
# binding, so the consumer has to be transformed as it loads.
#
# Staged INSIDE node_modules on purpose. These modules require `koffi` and resolve
# `@deepseek-ai/*`, and Node's ESM/CJS resolution only walks up through
# directories literally named node_modules -- so anywhere else in the tree would
# leave them unable to resolve their own dependencies. The directory is a plain
# folder, not a package the engine resolves by name: it is handed to Node as an
# absolute --import path (see EngineRuntime).
$supportSource = Join-Path $script:M1Workspace 'android\support'
$supportDest = Join-Path $nodeModulesDest 'android-support'
if (Test-Path $supportSource) {
    if (Test-Path $supportDest) { Remove-Item $supportDest -Recurse -Force }
    & robocopy $supportSource $supportDest /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy of android/support failed ($LASTEXITCODE)" }
    $stagedSupport = @(Get-ChildItem $supportDest -Recurse -File)
    Write-Host "staged android-support: $($stagedSupport.Count) file(s)"
    # The entry point EngineRuntime passes to --import must exist, or the engine
    # silently starts without the corrections.
    foreach ($required in @('android-fs\register.mjs', 'android-fs\link.js')) {
        if (-not (Test-Path (Join-Path $supportDest $required))) {
            throw "android support incomplete: missing $required"
        }
    }
    Write-Host "  ok  android-fs/register.mjs + link.js"
}

$staged = @(Get-ChildItem $assetsDir -Recurse -File)
$stagedMb = [math]::Round((($staged | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "staged assets/engine: $($staged.Count) files, $stagedMb MB"
# Sanity: the engine entry points must exist, or the app will unpack a tree it
# cannot run.
foreach ($required in @(
        'node_modules\@deepseek-ai\dsh\lib\bin.js',
        'node_modules\@deepseek-ai\dsh-web-app\lib\index.js',
        'node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html',
        'node_modules\@deepseek-ai\dsh-app-boot\lib\index.js',
        'node_modules\@koromix\koffi-android-arm64\android_arm64\koffi.node')) {
    $p = Join-Path $assetsDir $required
    if (Test-Path $p) { Write-Host "  ok  $required" }
    else { throw "engine tree incomplete: missing $required" }
}

# The flock stand-in must have REPLACED the upstream package, not landed beside
# it. If it did not, the APK ships the platform-refusing entry and fails on device
# with the same message this shim exists to remove.
#
# Verified by hash against the source shim, not by searching for the upstream
# error string: the shim's own comments quote that string to explain what it
# replaces, so a substring search over the file false-positives on the fix.
$stagedNas = Join-Path $assetsDir 'node_modules\@deepseek-ai\node-addon-system'
$stagedFlock = Join-Path $stagedNas 'lib\flock.js'
$sourceFlock = Join-Path $M1Workspace 'android\shims\node-addon-system\lib\flock.js'
if (-not (Test-Path $stagedFlock)) { throw "flock shim missing at $stagedFlock" }
if ((Get-FileHash $stagedFlock).Hash -ne (Get-FileHash $sourceFlock).Hash) {
    throw "node-addon-system was not replaced by the Android shim: staged lib/flock.js differs from android/shims/node-addon-system/lib/flock.js"
}
# It must also be reachable under the name the consumer imports, and the
# landlock half must still be present or dsh-sandbox-local fails to import.
$nasManifest = Get-Content -LiteralPath (Join-Path $stagedNas 'package.json') -Raw | ConvertFrom-Json
if ($nasManifest.name -ne '@deepseek-ai/node-addon-system') {
    throw "node-addon-system shim declares the wrong package name: $($nasManifest.name)"
}
foreach ($sub in @('flock', 'landlock-run')) {
    if (-not $nasManifest.exports."./$sub") { throw "node-addon-system shim is missing the ./$sub export" }
}
if (-not (Test-Path (Join-Path $stagedNas 'lib\index.js'))) {
    throw "node-addon-system shim is missing lib/index.js (the landlock-run export)"
}
Write-Host "  ok  node-addon-system replaced by the Android flock shim (hash-verified)"
