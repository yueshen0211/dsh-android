# DeepSeek Harness for Android — 0.1.0 (M1)

Run the DeepSeek Harness coding agent **entirely on an Android phone**: the Node engine and the
Web GUI ship inside the APK and start on the device. No desktop, no Termux, no LAN.

This is a **pre-release**, but it runs. The engine and UI are verified end to end on a real arm64
phone — including a full model round trip. Read [Verification](#verification) for exactly what was
and was not exercised.

---

## Download

| File | ABI | Size |
|---|---|---|
| `dsh-android-0.1.0-m1-arm64-v8a-debug.apk` | `arm64-v8a` | 140 MB |
| `SHA256SUMS.txt` | — | checksums for the above |

`arm64-v8a` covers essentially every phone made since ~2017. There is no 32-bit build.

## Requirements

| | |
|---|---|
| Android | **10 (API 29)** or newer |
| ABI | `arm64-v8a` |
| Free storage | ~500 MB (the APK plus ~165 MB of engine files unpacked on first launch) |
| Network | needed for model calls, and for nothing else |
| WebView | Android System WebView — see [WebView](#webview) |

## Install

```bash
adb install -r dsh-android-0.1.0-m1-arm64-v8a-debug.apk
```

Or copy the APK to the phone and open it (you will need to allow installing from this source).

On first launch the app unpacks about 25,000 files (~165 MB) into app-private storage. This takes
about 75 seconds on the test device; later launches start in roughly 25 seconds. The app shows
progress and, if anything fails, a screen with the reason and a "copy diagnostics" button.

The GUI then asks for a **DeepSeek API key**. That key is the only thing this app needs from you; it
is stored in app-private storage at `files/dsh-home/.credentials.yaml`.

> **This build is signed with the standard Android debug key.** It is fine for personal use and
> testing. It is not suitable for distribution, cannot be published to Google Play, and cannot be
> upgraded in place to a differently-signed build. A release signing configuration is on the
> roadmap.

---

## What works

- The agent engine runs natively on the device — sessions, tools, file operations, subagents,
  goals, workflows.
- The full DSH Web GUI, rendered in an in-app WebView. Nothing is reduced or reimplemented.
- **Full conversation**: send a prompt, get a model reply, with the session log persisted.
- Workspace selection, including browsing and picking a directory on the device.
- Fully offline from any other machine: the engine binds `127.0.0.1` and the app authenticates to
  it with the engine's own per-process launch token.
- Sessions and settings persist in app-private storage across restarts.

## Verification

**Verified end to end on a real arm64 phone** (Motorola XT2537-4, Android 16, `arm64-v8a`):

```
engine ready ~25 s warm; ~75 s cold from a wiped install (includes the asset unpack)
full GUI rendered, workspace picker works, WebSocket stable

an actual prompt returned an actual reply:
  "我是 DeepSeek Harness 里的编码智能体，由 deepseek-flash 模型驱动，可以帮你读代码、改文件、跑命令和查资料。"
  1 turn, 1 step, 213 tok/s, 8.2K tok

session written to disk: session.v3.jsonl.zstd + session.lock

Iterator: 0   AbortSignal.any: 0   Promise.withResolvers: 0
connection lost: 0   uncaught: 0   plugin import failures: 0   engine exits: 0
```

Also verified on an Android 14 x86_64 emulator (engine ready in ~10 s), which is what made the
arm64-only bugs visible by contrast: every one of them was a platform difference, and none was
architecture-related.

**Not exercised:** image attachments with a real photo, and the shell tools (the shipped profile
mounts no terminal row). Neither blocks normal use.

If something does not start, the reason is recorded on the device:

```bash
adb shell run-as dev.dsh.mobile cat files/engine-boot.log
```

The app also shows this log on its boot screen, so no cable is needed to see where it stalled.

## Known limitations

| Area | Limitation |
|---|---|
| **Images** | Attachments are stored verbatim: no downscaling and no EXIF orientation. Photos are sent at full resolution, which costs tokens. |
| **Terminal** | The `node-pty` shim is `child_process`-backed: no controlling terminal, so no line editing or job control. The shipped profile mounts no terminal row, so this is invisible unless you add one. |
| **Sandbox** | Sessions run with full access and no approval prompt, because Android cannot enforce the DSH sandbox. The OS sandbox and app-private storage are the boundary. **The engine binds loopback only — do not expose it off-device.** |
| **Workspace** | Files live in app-private storage; there is no shared-storage access yet. Import and export arrive with the native file bridge. |
| **Notifications** | The runtime does not request `POST_NOTIFICATIONS`, so on Android 13+ the foreground-service notification may not appear. The service still runs. |
| **Size** | 140 MB. Most of it is Node (47 MB), the engine tree (165 MB unpacked) and ICU data (32 MB), which can be trimmed. |

## WebView

The GUI targets a modern browser and uses three APIs that older WebViews lack
(`AbortSignal.any`, the global `Iterator` object, `Promise.withResolvers`). The app injects
polyfills for all three, so it also works on the emulator image's Chrome 113. Keeping Android System
WebView up to date is still recommended.

## How it works

The unmodified published DSH engine runs on a Node 26 runtime taken from Termux's Android build,
shipped as `lib/arm64-v8a/libnode.so` because Android only extracts `lib*.so` entries into the one
app-writable directory that is executable. Its `DT_RUNPATH` is rewritten to `$ORIGIN`, and its
versioned `DT_NEEDED` sonames are rewritten in place because the package manager drops `lib*.so.N`
names at install time.

Platform differences live in a single profile overlay
([`profile/android.patch.yml`](https://github.com/yueshen0211/dsh-android/blob/main/profile/android.patch.yml)):
the permission policy pair is pinned, the sharp-backed attachment provider is replaced by a pure-JS
one, and desktop/dev-only rows are disabled.

Two POSIX calls needed more than configuration, because Android refuses them outright and both sit
on the session path — so before they were fixed, *every* agent run failed:

- **`flock(2)`**, which upstream's entry rejects by platform before reaching the kernel, and for
  which it ships no Android prebuild. Replaced with a shim that calls bionic's `flock` through
  Koffi. It is a real lock, not a stub: a second descriptor on the same inode gets `EAGAIN`.
- **`link(2)`**, which Android denies in app storage for any destination, including a
  non-existent one. It is the session log's atomic no-clobber publish, so it is replaced with
  `renameat2(RENAME_NOREPLACE)` — the same operation without a hardlink.

**No upstream package is forked or modified.** These are external stand-ins and a preload, not
patches to DSH: the profile overlay keeps every platform decision in one reviewable file, and the
engine tree is left as published.

Full write-up, including the failure modes that cost the most time, is in the
[README](https://github.com/yueshen0211/dsh-android#readme).

## Build it yourself

```powershell
. tools/android-env.ps1
. tools/m1/fetch-runtime.ps1 -Abi arm64-v8a
. tools/m1/stage-runtime.ps1 -Abi arm64-v8a
. tools/m1/stage-engine.ps1
. tools/build-apk-cli.ps1 -ProjectDir android -Module app -PackageName dev.dsh.mobile `
    -MinSdk 29 -TargetSdk 35 -Label 'DeepSeek Harness' -VersionName '0.1.0' -VersionCode 1 `
    -Abis arm64-v8a
```

## Credits and licence

The engine, plugin architecture and entire UI are
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by DeepSeek. The Node runtime is
the [Termux](https://github.com/termux/termux-packages) build, the only maintained prebuilt Node for
Android new enough to run the engine. This project contributes only the Android packaging layer
(MIT); upstream components keep their own licences.
