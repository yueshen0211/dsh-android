# DeepSeek Harness for Android

Run the full [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) coding agent **on a phone**, offline from any desktop: the Node engine and the Web GUI are packaged inside a single APK and start on the device itself.

No companion PC. No Termux. No LAN connection. The engine binds `127.0.0.1` and the app renders its own GUI in a `WebView`.

> **Status: working prototype (M1).** Verified end to end on an Android 14 x86_64 emulator: engine boots, GUI renders, connection is stable. The arm64 path used by real phones is built but still needs on-device confirmation. See [Status](#status).

---

## Table of contents

- [What this is](#what-this-is)
- [Architecture](#architecture)
- [The hard parts](#the-hard-parts)
- [Repository layout](#repository-layout)
- [Build from scratch](#build-from-scratch)
- [Run and test](#run-and-test)
- [Configuration](#configuration)
- [Status](#status)
- [Limitations](#limitations)
- [Design notes](#design-notes)

---

## What this is

DSH ships as a Node application: a profile launcher that composes a plugin tree and serves a browser UI. Porting it to Android is not a rewrite — the [Android overlay](profile/android.patch.yml) plus a small Java shell are enough, and **no upstream package is forked or modified**.

Three pieces make it work:

| Piece | What it does |
|---|---|
| **`libnode.so`** | Node 26 (from Termux's Android build) renamed and patched to load as an executable from the APK's native library directory |
| **The engine tree** | The DSH dependency closure, unpacked from APK assets into app-private storage on first launch |
| **The Java shell** | Starts the engine in its own process, waits for the URL it prints, and points a WebView at it |

The engine is the *unmodified* published `@deepseek-ai/dsh@0.1.5-rc.3`. All platform difference lives in one overlay file plus one small plugin.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│ APK                                                                       │
│                                                                           │
│  ┌─ app process ─────────────────────┐   ┌─ :engine process ────────────┐  │
│  │ MainActivity                      │   │ EngineService (foreground)   │  │
│  │  WebView ── HTTP/WS ──────────────┼──▶│  EngineRuntime               │  │
│  │  polls files/engine-state.txt ◀───┼───│   └─ libnode.so --expose-…   │  │
│  └───────────────────────────────────┘   │        dsh --profile web     │  │
│                                          │          --patch android.yml │  │
│                                          └──────────────────────────────┘  │
│                                                                           │
│  lib/<abi>/libnode.so + 10 .so      the runtime, stored uncompressed      │
│  assets/engine/node_modules/…       the DSH tree, unpacked on first run   │
│  files/engine/                      unpacked tree (app-private)           │
│  files/dsh-home/                    sessions, settings, credentials       │
└───────────────────────────────────────────────────────────────────────────┘
```

The engine keeps its normal design: it binds loopback, mints a per-process launch token, prints
`dsh web: http://127.0.0.1:<port>/?token=…`, and exchanges that token for an HttpOnly session
cookie when the WebView loads it. The app only has to read that one line.

**Why the engine runs in its own process:** a runtime crash cannot take the UI down with it, the
long-lived engine survives backgrounding, and its memory peaks do not compete with the WebView's.

---

## The hard parts

Everything below was found empirically, on device. Most are not visible from a desktop.

### Node ≥ 20 is mandatory, and no prebuilt libnode is new enough

`dsh-app-boot` statically imports `parseEnv` from `node:util`. Node 18 does not export it:

```
SyntaxError: The requested module 'node:util' does not provide an export named 'parseEnv'
```

Every prebuilt Android libnode is too old — [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)
stops at 18.20.4, [puerts/backend-nodejs](https://github.com/puerts/backend-nodejs) at 16.16 — so the
runtime comes from **Termux packages** (`nodejs` 26.4.0 for both `aarch64` and `x86_64`). `commander@15`
additionally requires `>= 22.12.0`, which Node 26 satisfies.

### Android will not execute a binary from app storage

App data directories are mounted `noexec` on Android 10+. The one app-writable location that is
executable is `nativeLibraryDir`, and only `lib*.so` entries are extracted there. So GNU `node` is
shipped as **`lib/<abi>/libnode.so`** and executed from that directory.

Its `DT_RUNPATH` is rewritten in place from Termux's hardcoded prefix to `$ORIGIN`, so the loader
finds its siblings. `$ORIGIN` is shorter than the path it replaces, so the string table entry keeps
its size and no ELF offset moves.

### Android drops versioned sonames at install time

`libnode.so` needs `libz.so.1`, `libcrypto.so.3`, `libicuuc.so.78`… but the package manager only
extracts entries named `lib*.so`, so those names never exist on disk:

```
CANNOT LINK EXECUTABLE: library "libz.so.1" not found: needed by main executable
```

Shipping duplicate files under the versioned names does not help — the filter runs at install. The
fix is to rewrite each `DT_NEEDED` string to the unversioned name that does ship
(`tools/elf-patch-needed.mjs`), which is safe because every replacement is strictly shorter.

### A patch entry cannot change a row's `name`

This one is silent, and it is what kept the app on "starting the DSH engine" for hours:

```
patch: name mismatch for "attachment-local"
  (expected "@deepseek-ai/dsh-attachment-local",
   got "@dsh-mobile/attachment-android"), skipping
```

An id-targeted patch accepts **only `config` and `disabled`**. A changed `name` makes the loader drop
the *entire* entry with a single warning, so the original provider keeps loading. Replacing a plugin
therefore means **disabling the upstream row and inserting your own**
([the overlay](profile/android.patch.yml) does exactly that).

### Two `node_modules` trees resolve plugin names

The engine entry resolves its own imports through the engine tree, but the **loader** resolves a
configured row's package name relative to the profile directory:

```
Cannot find package '@dsh-mobile/attachment-android' imported from
  .../dsh-home/profiles/web/
```

On desktop pnpm links the profile's `node_modules` to the install tree; an APK cannot carry
symlinks. The shell stages the bundled plugins into the profile tree at startup.

### Missing natives, and the cascade from removing them

| Package | Problem | Resolution |
|---|---|---|
| `node-pty` | no android-arm64 prebuild, and `dsh-subprocess-local` **statically imports** it | a child_process-backed [shim](android/shims/node-pty/index.js) — honest about not being a pty |
| `sharp` | no android-arm64 build | [replaced](android/plugins/attachment-android/index.js) by a pure-JS provider |
| `koffi` | needs `@koromix/koffi-android-{arm64,x64}`, which npm refuses to install on a Windows host (`EBADPLATFORM`) | fetched from the registry directly |

Disabling the `sharp`-backed row is **not** an option: `attachments` is a *consumed* service, and
removing it cascades into `file-upload` and `session-controller`, which fails the whole boot. Replace
the provider; do not delete the row.

### aapt2 rewrites paths in two surprising ways

- **Backslashes.** On Windows, aapt2 writes asset entry names with the host separator
  (`assets/engine\@scope\pkg\file`). Legal in a zip, invisible to Android: `AssetManager` walks the
  archive by splitting on `/`. The first build produced **135,178 backslash bytes** across 25k
  entries and would have shipped an app with no assets at all. Normalized during packaging.
- **Dot-files are dropped.** Hidden entries silently vanish from `-A` packaging. Inert for the ~70
  npm config files, fatal for `pi-ai`'s `.manifest.json`, which is imported by name. The staging
  script renames that file, rewrites its importers, and **fails the build** if any dot-prefixed
  import remains.

### The UI lives in a different process from the engine

`EngineService` runs in `:engine`; the activity runs in the main process. Sharing state through a
`static` field therefore shares nothing — each process gets its own copy. The engine reported its URL
correctly while the UI polled a field that was never written in *its* process, so the app sat on the
boot screen forever with healthy logs. The handoff is now a file
(`files/engine-state.txt`, published atomically) that the activity polls.

This is also why the bug never reproduced on desktop, where service and UI share a process.

### Old WebViews need polyfills

The bundled UI targets a modern browser. On the emulator image's WebView (Chrome 113) the shell
rendered but could not connect:

| API | Needs | Symptom |
|---|---|---|
| `AbortSignal.any` | Chrome 116 | `connection lost, retry #1…#7` |
| global `Iterator` **object** | Chrome 122 | `Failed to load plugins` — PDF.js does `Iterator.prototype.join = …` and throws on the missing object |
| `Promise.withResolvers` | Chrome 119 | uncaught `TypeError` |

[`WebViewPolyfills.java`](android/app/src/main/java/dev/dsh/mobile/WebViewPolyfills.java) injects
them from `onPageStarted`. Note the second row: it is a missing *global*, not a missing helper, so a
guarded `if (typeof Iterator === 'undefined') return` polyfill silently does nothing.

A phone is likely to have a newer WebView, but WebView version is not something an app controls, so
the app carries the polyfills rather than assuming a baseline.

---

## Repository layout

```
profile/
  android.patch.yml           ← THE platform layer. The only file to maintain per upstream release
  m0/                         experimental overlays kept as a record of the M0 investigation
android/
  app/                        Java shell: WebView + EngineService(:engine) + EngineRuntime
  shims/node-pty/             stand-in for a native module with no Android build
  plugins/attachment-android/ pure-JS attachment provider (replaces the sharp-backed one)
tools/
  android-env.ps1             activates the workspace-local toolchain
  build-apk-cli.ps1           Gradle-free APK build: aapt2 → javac → d8 → zipalign → apksigner
  zip-add-nativelibs.mjs      packs lib/<abi>/ entries and normalizes separators
  elf-closure.mjs             resolves a binary's DT_NEEDED closure
  elf-inspect.mjs             ELF headers, interpreter, RUNPATH
  elf-patch-needed.mjs        rewrites versioned sonames in place
  verify-engine.mjs           M0 verification suite
  ws-probe.mjs                trust fence and WebSocket upgrade probe
  m1/                         fetch → stage runtime → stage engine → open emulator GUI
  device/                     on-device diagnostics (run through `run-as`)
docs/
  设计文档.md                  design document (Chinese)
  M0-报告.md                   engine porting verification
  M1-报告.md                   APK milestone
  NEXT-SESSION-HANDOFF.md     working handoff: findings, conventions, next steps
```

Generated and intentionally not committed: `.toolchain/` (17 GB of JDK/SDK/NDK/emulator),
`android/app/src/main/assets/engine/` (the DSH tree), `android/app/src/main/jniLibs/*/`
(the Node runtime). All are reproduced by the scripts below.

---

## Build from scratch

Requires Windows with PowerShell and Node.js on `PATH`. Everything else is downloaded into the
workspace; nothing is installed system-wide.

### 1. Toolchain

| Component | Version | Where from |
|---|---|---|
| JDK | Temurin 21 | `https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse` |
| cmdline-tools | 22.0 | `https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip` |
| SDK packages | `platform-tools`, `platforms;android-35`, `build-tools;35.0.0`, `ndk;27.0.12077973` | `sdkmanager` |

Two environment details matter, and both are handled by `tools/android-env.ps1`:

- `ANDROID_USER_HOME` / `ANDROID_PREFS_ROOT` / `GRADLE_USER_HOME` / `npm_config_cache` are redirected
  into the workspace. `sdkmanager` writes `%USERPROFILE%\.android` by default and reports
  `Failed to download any source lists!` when it cannot — which looks like a network fault but is a
  permissions one.
- `adb` hardcodes `~/.android` and ignores those variables, so that directory must exist.

```powershell
. tools/android-env.ps1      # activate for the current shell
```

### 2. Runtime, engine, APK

```powershell
# Native Node runtime for each ABI you want (arm64-v8a for phones, x86_64 for the emulator)
. tools/m1/fetch-runtime.ps1 -Abi arm64-v8a
. tools/m1/stage-runtime.ps1 -Abi arm64-v8a
. tools/m1/fetch-runtime.ps1 -Abi x86_64
. tools/m1/stage-runtime.ps1 -Abi x86_64

# DSH dependency tree into assets (installs, patches, stages plugins)
. tools/m1/stage-engine.ps1

# APK
. tools/build-apk-cli.ps1 -ProjectDir android -Module app `
    -PackageName dev.dsh.mobile -MinSdk 29 -TargetSdk 35 `
    -Label 'DeepSeek Harness' -VersionName '0.1.0' -VersionCode 1
```

Output: `android/app/build/cli-debug/dsh-debug.apk` (~233 MB with both ABIs, ~140 MB with one).

### Why not Gradle

Gradle's daemon cannot start in this environment (`Couldn't open current thread, error = 5`, from
`native-platform.dll` opening a thread with elevated rights), so the build drives the SDK tools
directly. That is sufficient here: the shell is plain Java with no AndroidX and no Kotlin. Two
consequences worth knowing:

- Sources must be Java 8 bytecode compiled with `-bootclasspath android.jar`, which keeps Android API
  discipline but **hides `java.lang.invoke`** — so the shell uses anonymous classes, not lambdas.
- The debug configuration injects `android:debuggable="true"` so `adb shell run-as` works, which is
  what makes the device diagnostics below possible.

Adding Kotlin, AndroidX, or real resources means returning to Gradle.

---

## Run and test

### Emulator

```powershell
$env:ANDROID_AVD_HOME = "$PWD/.toolchain/android-user-home/avd"

& "$env:ANDROID_HOME/emulator/emulator.exe" -avd dsh-test -no-audio -no-boot-anim `
    -gpu swiftshader_indirect -no-snapshot-load

# Open the on-device GUI in your desktop browser (resolves the live port and token)
. tools/m1/open-emulator-gui.ps1 -Open
```

`-gpu swiftshader_indirect` avoids the hardware path deliberately: hosts with virtual display
adapters (Oray, GameViewer, …) can make the Vulkan interop path crash with
`Failed to find ColorBuffer`.

An x86_64 image is used because running an arm64 image on an x86_64 host means QEMU instruction
translation, which turns each iteration (≈190 MB unpack, then a Node boot) into tens of minutes.
The same pipeline builds both ABIs, and both ship in one APK.

### Device

```powershell
$adb = "$env:ANDROID_HOME/platform-tools/adb.exe"
& $adb install -r android/app/build/cli-debug/dsh-debug.apk
& $adb logcat -c
& $adb shell am start -n dev.dsh.mobile/.MainActivity
& $adb logcat -s DshEngineService:* DshEngineRuntime:* DshMainActivity:*
```

Expected:

```
DshEngineRuntime: launching: […/libnode.so, --expose-internals, <entry>, --profile, web,
                            --patch, <abs>, --no-open, --port, 0]
DshEngineService: dsh web: http://127.0.0.1:<port>/?token=…
DshEngineRuntime: engine ready on port <port>
DshMainActivity: loading engine url: http://127.0.0.1:<port>/?token=…
```

### On-device diagnostics

Far faster than rebuilding an APK, and the only way to see what the device actually has:

```powershell
$base = ((& $adb shell pm path dev.dsh.mobile) -join '') -replace 'package:','' -replace '/base.apk','' -replace '\s',''
& $adb push tools/device/dump-tree.sh /data/local/tmp/ ; & $adb shell chmod 755 /data/local/tmp/dump-tree.sh

# Does the overlay actually apply? (this is what exposed the `name` restriction)
& $adb shell run-as dev.dsh.mobile sh /data/local/tmp/dump-tree.sh $base/lib/arm64

# Boot the engine in the foreground and read its full output
& $adb shell run-as dev.dsh.mobile sh /data/local/tmp/boot-engine.sh $base/lib/arm64

# The failure log the service writes
& $adb shell run-as dev.dsh.mobile cat files/engine-boot-failure.log

# Screenshot — turns "logs look fine but the UI is wrong" into a fact
& $adb shell screencap -p /sdcard/s.png ; & $adb pull /sdcard/s.png .
```

---

## Configuration

### The Android overlay

[`profile/android.patch.yml`](profile/android.patch.yml) is the whole platform layer. It is applied
as a `--patch` overlay, so it must be a top-level YAML array of loader patch entries. What it does:

| Row | Action | Why |
|---|---|---|
| `sandbox-policy`, `approval` | pin to `danger-full-access` / `never` | a working sandbox provider cannot be removed (see below); both rows must be pinned together or `permission-presets` refuses to construct |
| `attachment-local` | **disable**, then insert `@dsh-mobile/attachment-android` | sharp has no Android build; the row is replaced, not removed, because `attachments` is consumed |
| `hmr` | disable | desktop dev machinery; also the reason the engine needs `--expose-internals` |
| `directory-picker`, `open-in-app` | disable | desktop OS integrations the shell owns |
| `sandbox` | **left enabled** | disabling it removes the only `ctx.shell` provider and the engine will not boot at all |

The `sandbox` decision is the counter-intuitive one. Landlock is a Linux LSM that Android does not
expose, so the obvious move is to disable that row — and it fails hard:

```
@deepseek-ai/dsh-pwsh-sandbox: pending (waiting for service: sandbox)
@deepseek-ai/dsh-permission-presets: pending (waiting for service: shell)
```

The shell providers inject `sandbox`, and `permission-presets` injects `shell`. Keeping the provider
mounted while pinning the permission mode to full access never reaches the Landlock probe, because
that chain is only walked when confinement is actually requested.

### Permissions on the device

The app runs the agent with the app's own uid and the workspace in app-private storage, so the OS
sandbox replaces the DSH one. The engine binds `127.0.0.1` only, and the WebView is locked down:
no file access, no content access, navigation pinned to loopback. Cleartext HTTP is permitted for
`127.0.0.1` alone.

---

## Status

**M0 — engine porting verification: passed.**

The engine boots with the overlay applied, prints its URL, and completes the browser handshake
(`303` + HttpOnly cookie, `401` without, `200` with). Node capability baseline confirmed:
`node:sqlite`, `worker_threads`, `child_process`, WebCrypto, `fetch`, `AbortSignal.timeout`.

**M1 — installable APK: working, verified on an x86_64 emulator.**

Verified end to end on Android 14 (emulator): engine ready in ~10 s (first launch ~60 s to unpack),
full GUI rendered, WebSocket stable, every error counter at zero:

```
Iterator: 0   AbortSignal.any: 0   Promise.withResolvers: 0
connection lost: 0   uncaught: 0   plugin import failures: 0   engine exits: 0
```

**Not yet verified on arm64 hardware.** The arm64 runtime is built, staged, and packaged by the same
code path, but the real-device run is outstanding. The most likely remaining differences are that
`lib/arm64` holds a different set of `.so` files and that a production WebView is newer than Chrome
113 (in which case the polyfills are a harmless no-op).

---

## Limitations

| Area | Limitation |
|---|---|
| **Images** | The replacement attachment provider stores bytes verbatim and validates dimensions from container headers, but does **not** transcode. Phone photos are sent at full resolution, costing tokens, and EXIF orientation is not applied. Downscaling belongs in the shell's import path (planned, using Android's `ImageDecoder`). |
| **Terminal** | The `node-pty` shim is `child_process`-backed: no controlling terminal, so no line editing, job control, or `resize`. Costs nothing in the shipped `web` profile, which mounts no terminal row and disables both shell tools. |
| **Sandbox** | Every session runs with full access and no approval prompt, because Android cannot enforce the DSH sandbox. The OS sandbox and app-private storage are the boundary. Do not expose the engine off-device. |
| **Size** | ~233 MB with both ABIs, ~140 MB with one. The largest single item is `libicudata.so` (31.6 MB), which can be pruned to a few MB with ICU's `icupkg`; the rest is Node (47 MB) and the engine tree (165 MB). |
| **First launch** | Unpacks 25k files / ~165 MB, about 60 s on the test device. Correctness first; a single archive would be the next step. |
| **ABI** | `arm64-v8a` and `x86_64` only. No 32-bit build. |
| **Notifications** | The runtime never requests `POST_NOTIFICATIONS`, so on Android 13+ the foreground-service notification may not appear. The service still runs. |

---

## Design notes

Conventions that the code depends on, worth keeping if you extend it:

1. **Never fork an upstream package.** Every platform difference belongs in the overlay, a shim, or a
   plugin. That is what lets the port track upstream releases.
2. **A patch entry may change `config` and `disabled` only.** To replace a provider, disable the
   upstream row and insert your own.
3. **Before disabling a row, check whether its service is consumed.** `attachments` cascades;
   replacing the provider is the correct move.
4. **Treat aapt2's behaviour as a hard constraint.** It drops dot-prefixed entries and writes host
   path separators. The staging script's "fail loudly on a dot-prefixed import" check exists to catch
   the next instance of this at build time rather than on a phone.
5. **Keep version markers content-derived.** The marker folds in the tree's file count and byte
   total; a bare package version once let a device keep running a stale tree with no indication.
6. **Prefer on-device diagnosis to guesswork.** `run-as` plus `pm path` plus running `libnode.so`
   directly answers in seconds what an APK rebuild answers in minutes — and screenshots settle
   arguments that logs cannot.

---

## Acknowledgements

The engine, the plugin architecture, and the entire UI are
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by DeepSeek. This repository
contains only the Android packaging layer.

The Node runtime is the [Termux](https://github.com/termux/termux-packages) build, which is the only
maintained prebuilt Node for Android new enough to run the engine.

## License

The packaging layer in this repository is MIT. Upstream components keep their own licenses: DSH is
MIT, the Termux Node runtime and its bundled libraries (ICU, OpenSSL, libc++, …) retain theirs.
