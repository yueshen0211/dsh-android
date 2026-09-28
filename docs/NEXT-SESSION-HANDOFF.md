# 交接说明（NEXT-SESSION HANDOFF）

> 用途：固化进度，便于随时中断/恢复。

---

# ⏸ 从这里继续（RESUME HERE）

**当前唯一未完成项：arm64 真机验证。**

真机上 app **卡在启动页**，但手机在本次会话中不可用（`adb devices` 只有模拟器），
所以**还没拿到真机的失败日志**。必须在拿到日志之后才能继续，不要盲改代码 ——
前两轮"盲改"的代价已经证明过了（补丁 name、跨进程 static 都是靠日志才定位的）。

## 回来后的第一步

手机插上 USB、允许 USB 调试，然后：

```powershell
. D:\Work\DSHapk\tools\diagnose-device.ps1
```

一条命令就能收齐定位所需的一切（设备信息、安装版本、进程与界面状态、UI 轮询的 state 文件、
引擎失败日志、引擎 logcat、WebView 控制台与版本、解包后的目录结构），
并把报告文件路径打印出来。**把那个文件发回来即可定位。**

> 若只想手工看一眼，最关键的一条：
> `adb shell run-as dev.dsh.mobile cat files/engine-boot-failure.log`

## 已经排除的可能（不必重查）

静态检查全部通过，所以问题只在运行时：

| 检查 | 结果 |
|---|---|
| Releases 里的 APK 是否含全部修复 | ✅ 含 `publishState` / `engine-state.txt` / WebView polyfill / `ensurePluginsInProfile` |
| manifest 关键属性 | ✅ `extractNativeLibs=true`、`debuggable=true`、`:engine` 独立进程、网络安全配置在位 |
| 资产关键文件 | ✅ 引擎入口 / patch / 插件 / koffi arm64 绑定 / ENGINE-VERSION 全在 |
| arm64 `.so` 依赖闭包 | ✅ **0 缺失** |
| koffi 绑定路径 | ✅ 符合运行时查找路径 `@koromix/koffi-android-arm64/android_arm64/koffi.node` |

## 备选路径：arm64 模拟器

手机若迟迟不方便，可以复现 arm64 代码路径而不需要真机 —— 这也是**唯一**能在没有手机时
验证 arm64 的办法。系统镜像（Android 14 / arm64-v8a）已在下载。

**注意预期**：x86_64 主机上跑 arm64 镜像只能靠 QEMU 指令翻译，首次解包 + 启动可能要
**20–40 分钟**（x86_64 镜像只要 10 秒）。慢，但有效。

## 若修复后要发新版本

```powershell
. D:\Work\DSHapk\tools\android-env.ps1
# 精简为 arm64-only（真机不需要 x86_64 那 93 MB）
Remove-Item android\app\src\main\jniLibs\x86_64 -Recurse -Force
& .\tools\build-apk-cli.ps1 -ProjectDir android -Module app -PackageName dev.dsh.mobile `
    -MinSdk 29 -TargetSdk 35 -Label 'DeepSeek Harness' -VersionName '0.1.0' -VersionCode 1
. .\tools\gh-env.ps1
& gh release upload v0.1.0-m1 <新APK> --repo yueshen0211/dsh-android --clobber
# 恢复 x86_64 以便继续用模拟器
. tools\m1\stage-runtime.ps1 -Abi x86_64
```

### 关于「双 ABI 安装包」

**现在磁盘上没有双 ABI 的 APK** —— 做 arm64 精简版时 `jniLibs\x86_64` 被删后重新构建，
把 232.8 MB 那个覆盖了。要重建只需先 `. tools\m1\stage-runtime.ps1 -Abi x86_64` 再构建，
产物约 232.8 MB（两套运行时都在，同一个包真机与模拟器都能装）。

---

| 项 | 状态 |
|---|---|
| 日期 | 2026-09-28 |
| 当前里程碑 | **M1 完成 —— 完整 DSH GUI 在 x86_64 模拟器上端到端验证通过** |
| 仓库 | **https://github.com/yueshen0211/dsh-android**（public，4 个提交） |
| 发布 | **https://github.com/yueshen0211/dsh-android/releases/tag/v0.1.0-m1**（pre-release） |
| APK | Releases 里是 **arm64-only 140.2 MB**；本地当前构建也是 arm64-only（双 ABI 版已被覆盖，可重建） |
| 真机 | `ZS22224CG6`（Android 16 / arm64-v8a）—— **卡在启动页，待取日志** |
| 模拟器 | `dsh-test`（Android 14 / **x86_64**），WHPX 加速，带窗口 —— 已验证通过 |
| arm64 镜像 | `system-images;android-34;google_apis;arm64-v8a`，下载中/已装 |

---

## 仓库、推送与发布

**仓库**：https://github.com/yueshen0211/dsh-android （public，43 文件）
**发布**：https://github.com/yueshen0211/dsh-android/releases/tag/v0.1.0-m1 （pre-release，arm64 APK）

### 凭据情况（重要）

- **SSH 不可用**：本机 `~/.ssh/id_ed25519` 未在 GitHub 授权
  （`Permission denied (publickey)`）。想改用 SSH 需先把这把公钥加到账号：
  `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILo1bUwJTeIAsX/HzRf1jlpeDuoY2IsuPhGkG3/nJJ2s yue@DESKTOP-SNLOA2S`
- **HTTPS 可用**：Windows 凭据管理器里存有 GitHub OAuth token（`gho_`，scopes: `gist, repo, workflow`）。
  `credential.helper=manager` 来自**系统级**配置，未改动，正常 `git push` 即可。
- **`gh auth login` 用不了**：它要求 `read:org` scope，而该 token 没有。
  但通过 `GH_TOKEN` 环境变量注入就绕过这个校验，`gh release` / `gh api` 均正常。

### 发布工具

`gh` CLI 已装在工作区（`.toolchain\gh\`）。它必须用，不能只用 REST API：
**GitHub 的 REST API 上传资产上限 100 MB**，而 APK 有 140 MB；`gh` 会分块上传。

```powershell
.\tools\install-gh.ps1        # 下载安装（一次性）
. .\tools\gh-env.ps1          # 激活：从凭据管理器取 token 注入 GH_TOKEN（仅当前 shell）

# 发布 / 更新资产
gh release upload v0.1.0-m1 <文件> --repo yueshen0211/dsh-android --clobber
```

`gh-env.ps1` 不把 token 落盘、不打印、不进命令行。

### 发布用的 arm64-only 构建

Releases 里的 APK 只含 arm64-v8a（140.2 MB），因为真机不需要 x86_64 那 93 MB：

```powershell
Remove-Item android\app\src\main\jniLibs\x86_64 -Recurse -Force   # 精简
. tools/android-env.ps1
. tools\build-apk-cli.ps1 -ProjectDir android -Module app -PackageName dev.dsh.mobile `
    -MinSdk 29 -TargetSdk 35 -Label 'DeepSeek Harness' -VersionName '0.1.0' -VersionCode 1
# 之后若要跑模拟器，重新 stage：
. tools\m1\stage-runtime.ps1 -Abi x86_64
```

GitHub 侧计算的资产摘要与本地 `SHA256SUMS.txt` 一致：
`facf34888ec75993a527bb388f6668e7158266b23ba39eab1850a0b4e5298ec6`

---

## 一句话现状

**跑通了。** 模拟器截图确认：DSH 界面完整渲染，弹出「Add an API key to get started」，
左侧栏图标齐全，WebSocket 连接稳定（`connection lost: 0`），引擎常驻。

错误统计全部归零：

```
Iterator: 0   AbortSignal.any: 0   Promise.withResolvers: 0
connection lost: 0   未捕获错误: 0   插件加载失败: 0   引擎退出: 0
```

## 本轮修掉的 4 个「卡在 starting」根因

按发现顺序，**前两个是用户真机上卡住的直接原因**：

### 1. 补丁不能改 `name`（真机根因）

```
patch: name mismatch for "attachment-local"
  (expected "@deepseek-ai/dsh-attachment-local",
   got "@dsh-mobile/attachment-android"), skipping
```

加载器的补丁条目**只接受 `config` 和 `disabled`**；改 `name` 会被整条跳过、只发一条警告，
于是原版 sharp 后端照样加载、照样失败，而 UI 只表现为停在启动页。
正确做法：**`disabled` 掉上游行 + 用 `insert` 插入自己的行**。

### 2. 跨进程 static 不共享（真机根因，也是"引擎明明好了 UI 却不动"的元凶）

`EngineService` 跑在 `:engine` 进程，`MainActivity` 在主进程 —— **两个进程各有一份 static**。
原来用 `EngineService.LocalState.url` 做交接，所以：

- 引擎进程：`LocalState.url` 有值 ✓（日志里 `engine ready on port N`）
- UI 进程：**永远是 null** → 永不加载 WebView → 永远停在启动页

修法：服务把状态写进 `filesDir/engine-state.txt`（临时文件 + rename 原子发布），
UI 轮询该文件。**这是 UI 与引擎跨进程的测试缺口** —— 桌面上两者同进程，所以没暴露。

### 3. 旧 WebView 缺三个 API（模拟器暴露；真机取决于 WebView 版本）

模拟器镜像自带 **Chrome 113**，而 DSH 前端用了更新的 API：

| API | 需要版本 | 症状 |
|---|---|---|
| `AbortSignal.any` | Chrome 116 | `connection lost, retry #1..#7`（连接永远建不起来） |
| **全局 `Iterator` 对象** | Chrome 122 | `Failed to load plugins`：PDF.js 写 `Iterator.prototype.join = ...`，对象不存在直接抛 |
| `Promise.withResolvers` | Chrome 119 | 未捕获 TypeError |

注意第 2 项不是"缺方法"而是**缺整个全局对象** —— 我第一版 polyfill 在
`typeof Iterator === 'undefined'` 时静默跳过，所以它根本没生效。
现已在 `WebViewPolyfills.java` 里先建对象、再挂方法。

### 4. 残留 state 文件导致加载死端口

state 文件比进程活得久。App 重启时 UI 先读到**上一次的 URL**，去连一个已经关掉的端口 →
`ERR_CONNECTION_REFUSED`。修法：服务启动第一步就发布 `preparing`（清掉旧 URL），
UI 只在 `status == "running"` 时才加载，并加 `onReceivedError` 回退到启动页重试。

## 怎么用模拟器

```powershell
. D:\Work\DSHapk\tools\android-env.ps1

# 启动（带窗口，软件渲染 —— 宿主有 Oray/GameViewer 虚拟显示适配器，
#        硬件 GPU 路径曾出现 Failed to find ColorBuffer 崩溃）
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd dsh-test -no-audio -no-boot-anim `
    -gpu swiftshader_indirect -no-snapshot-load

# 在桌面浏览器打开手机版 GUI（token 每次重启都变，脚本取实时值）
. D:\Work\DSHapk\tools\m1\open-emulator-gui.ps1 -Open
```

## 下一步

**把这版 APK 装回真机。** 真机此前卡住的两个根因（补丁 name、跨进程 static）都已修复，
而且真机的 WebView 大概率比 Chrome 113 新，polyfill 对它只是无害的兜底。

```powershell
$adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
& $adb devices
& $adb install -r D:\Work\DSHapk\android\app\build\cli-debug\dsh-debug.apk
& $adb logcat -c
& $adb shell am start -n dev.dsh.mobile/.MainActivity
```

期望日志：
```
DshEngineRuntime: launching: [... libnode.so, --expose-internals, <entry>, --profile, web, --patch, <abs>, --no-open, --port, 0]
DshEngineService: dsh web: http://127.0.0.1:<port>/?token=...
DshEngineRuntime: engine ready on port <port>
DshMainActivity: loading engine url: http://127.0.0.1:<port>/?token=...
```
然后应看到 GUI（首次会问 API key）。

失败时：`adb shell run-as dev.dsh.mobile cat files/engine-boot-failure.log`。

## 设备端诊断手法（本轮靠它定位了全部问题）

```powershell
$base = ((& $adb shell pm path dev.dsh.mobile) -join '') -replace 'package:','' -replace '/base.apk','' -replace '\s',''
& $adb push .m1\dump-tree.sh /data/local/tmp/ ; & $adb shell chmod 755 /data/local/tmp/dump-tree.sh
& $adb shell run-as dev.dsh.mobile sh /data/local/tmp/dump-tree.sh $base/lib/x86_64   # 组合树
& $adb shell run-as dev.dsh.mobile sh /data/local/tmp/boot-engine.sh $base/lib/x86_64 # 前台启引擎
& $adb shell screencap -p /sdcard/s.png ; & $adb pull /sdcard/s.png .   # 截图看真实界面
```

**截图这一步特别值** —— 它把"日志看着正常但界面不对"直接变成可见事实。

## 根因：补丁不能改 `name`（本项目最关键的发现）

```
dsh: [android.patch.yml] patch: name mismatch for "attachment-local"
     (expected "@deepseek-ai/dsh-attachment-local",
      got "@dsh-mobile/attachment-android"), skipping
```

**加载器的补丁条目只接受 `config` 和 `disabled`；改 `name` 会被当成"名字不匹配"整条跳过，只发一条警告。**
所以之前"用 patch 把 provider 换成自己的"完全没生效 —— 原版 sharp 后端照样加载、照样失败，
而 UI 只表现为无限停在启动页。

正确做法：**`disabled` 掉上游行 + 用 `insert` 插入自己的行**（两个不同的 id）。

## 配套修掉的三个隐蔽缺陷

1. **启动超时形同虚设。** 原来在调用线程上用 `readLine()` 阻塞读、在循环里检查 deadline；
   引擎"活着但不说话"时永远读不到行 → 超时永不触发。已改为**独立读取线程 + 主线程轮询**。
2. **`--expose-internals` 必须走命令行。** 引擎会实例化 `cordis-plugin-hmr`（即使组合树里该行
   `disabled`），它要求该标志；放进 `NODE_OPTIONS` 会被 Node 拒绝
   （`not allowed in NODE_OPTIONS`，退出码 9）。症状极隐蔽：**先打印 URL 再退出 1**。
3. **插件要装在两棵树里。** 加载器从 **profile 目录**（`dsh-home/profiles/web/`）解析插件包名，
   引擎入口从**引擎树**解析。桌面靠 pnpm 软链让两者重合，APK 没有软链，
   所以启动时会把 `@dsh-mobile/*` 复制到 profile 树下（`ensurePluginsInProfile`）。

## 怎么用模拟器（可反复使用）

```powershell
. D:\Work\DSHapk\tools\android-env.ps1

# 启动（带窗口、WHPX 加速、保留已安装 app 与已解包引擎树）
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd dsh-test -no-audio -no-boot-anim -gpu auto

# 在桌面浏览器打开手机版 GUI（token 每次重启都变，脚本会取实时值）
. D:\Work\DSHapk\tools\m1\open-emulator-gui.ps1 -Open
```

`open-emulator-gui.ps1` 从设备日志解析当前端口与 token、重建 `adb forward`、
打印并打开 `http://127.0.0.1:8080/?token=...`。

> **为什么有 x86_64 这一路**：app 只有 arm64 库时，x86_64 主机只能用 QEMU 翻译跑 arm64 镜像，
> 一次迭代（解包 ~190 MB + 启 Node）要几十分钟。x86_64 镜像走 WHPX 原生速度，
> 编辑-运行循环才可用。Termux 有 x86_64 包、NDK 有对应预编译、koffi 有 `android-x64`，
> 两个 ABI 共用同一套流水线（`-Abi` 参数），APK 里同时带两套 `.so`。

## 实测结果（模拟器 x86_64）

```
engine ready on port 33741        （启动约 10 秒；首次解包约 60 秒）
GET /?token      -> 303 See Other, location: /, HttpOnly + SameSite=Strict cookie
GET / (cookie)   -> 200, 27343 bytes, __DSH_BOOT__ ✓  __ModuleLoader__ ✓
```

## 下一步

1. **回到真机验证 arm64。** 本轮所有修复只在 x86_64 模拟器上验证过；
   真机路径（`lib/x86_64` vs `lib/arm64`）走的是同一套代码，但 arm64 的 `.so` 是另一份文件。
2. 真机需重新 `adb install -r`（新 APK 才有修复）。

```powershell
$adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
& $adb devices
& $adb install -r D:\Work\DSHapk\android\app\build\cli-debug\dsh-debug.apk
& $adb logcat -c
& $adb shell am start -n dev.dsh.mobile/.MainActivity
# 期望：launching: [... --profile web --patch <abs> --no-open --port 0]
#       dsh web: http://127.0.0.1:<port>/?token=...
#       engine ready on port <port>
```

失败时：`adb shell run-as dev.dsh.mobile cat files/engine-boot-failure.log`
（完整失败原因会写在这里，本轮非常有效）。

## 设备端诊断手法（很有效，建议保留）

```powershell
$base = ((& $adb shell pm path dev.dsh.mobile) -join '') -replace 'package:','' -replace '/base.apk','' -replace '\s',''
& $adb push .m1\dump-tree.sh /data/local/tmp/ ; & $adb shell chmod 755 /data/local/tmp/dump-tree.sh
& $adb shell run-as dev.dsh.mobile sh /data/local/tmp/dump-tree.sh $base/lib/x86_64   # 导出组合树
& $adb shell run-as dev.dsh.mobile sh /data/local/tmp/boot-engine.sh $base/lib/x86_64 # 前台启引擎，看完整输出
```

比反复重建 APK 快一个数量级，而且能直接看到设备上的真实文件与真实组合结果。

## 历史障碍清单（避免重复踩）

| 症状 | 根因 | 修法 |
|---|---|---|
| patch 静默失效 | **补丁不能改 `name`**，整条被跳过 | `disabled` + `insert` |
| UI 无限停在 starting | 超时逻辑被阻塞读卡死 | 独立读取线程 + 轮询 |
| 打印 URL 后退出 1 | `--expose-internals` 放进 `NODE_OPTIONS` 遭拒 | 改为命令行参数 |
| `Cannot find package '@dsh-mobile/...'` | 加载器从 **profile 树**解析，插件只在引擎树 | 启动时复制到 profile 树下 |
| `Cannot find package '@deepseek-ai/dsh-app-boot'` | 资产解包后不在任何 `node_modules/` 里 | 布局改为 `assets/engine/node_modules/` |
| 资产全不可见 | aapt2 写出 **135,178 个反斜杠**路径，AssetManager 按 `/` 遍历 | 重打包时规范化 |
| `ENOENT mkdtemp` | TMPDIR 未创建，spill store 启动期就要用 | 每次启动前创建 |
| `.manifest.json` 找不到 | aapt2 **丢弃点号开头的资产** | 改名+改写引用；加 fail-loud 检查 |
| `pty.node` 加载失败 | node-pty 无 android-arm64，且被**静态 import** | `android/shims/node-pty/` |
| sharp 加载失败 | 无 android-arm64；且**禁用会级联** | 替换 provider |
| `libz.so.1` / `libicudata.so` 找不到 | 带版本号 soname 被安装期丢弃；传递依赖不查 RUNPATH | 改写 DT_NEEDED + `LD_LIBRARY_PATH` |
| 设备跑过期 profile | 只在文件不存在时写 patch | 每次启动重写 |

## 关键工程约定

1. **绝不 fork 上游包**；平台差异只在 `profile/android.patch.yml` + 自己的 shim/plugin。
2. **补丁只能改 `config` / `disabled`**；换 provider 必须 `disabled` + `insert`。
3. **禁用上游行前先确认它是不是"被消费的服务"**（`attachments` 会级联到 file-upload / session-controller）。
4. **aapt2 的隐藏行为是真实约束**：丢点号资产、写反斜杠路径；fail-loud 检查别删。
5. **版本标记必须内容相关**（现含 `files=` 与 `bytes=`）。
6. **设备侧定位优先于盲改**。
7. **不要杀 `dsh web` 的 node 进程** —— 那是当前 GUI 本身。

## 交付产物索引

| 文件 | 作用 |
|---|---|
| `docs/设计文档.md` | 总体设计（含 M0 修正） |
| `docs/M0-报告.md` | M0 引擎移植验证报告 |
| `docs/M1-报告.md` | M1 报告 |
| `docs/NEXT-SESSION-HANDOFF.md` | 本文件 |
| `profile/android.patch.yml` | **手机版平台层**，唯一需要跟随上游维护的文件 |
| `android/app/` | Java 壳：WebView + EngineService(`:engine`) + EngineRuntime |
| `android/plugins/attachment-android/` | 纯 JS attachment provider（无 sharp） |
| `android/shims/node-pty/` | node-pty 替身 |
| `tools/m1/fetch-runtime.ps1` / `stage-runtime.ps1` / `stage-engine.ps1` | 运行时与引擎装配（`-Abi`） |
| `tools/m1/open-emulator-gui.ps1` | 打开模拟器里的 DSH GUI |
| `tools/elf-closure.mjs` / `elf-inspect.mjs` / `elf-patch-needed.mjs` | ELF 闭包解析与原地改写 |
| `tools/build-apk-cli.ps1` | 无 Gradle 的 APK 构建驱动 |
| `tools/zip-add-nativelibs.mjs` | 打包 `lib/<abi>/`（stored）+ 路径规范化 |
| `.m1/boot-engine.sh` / `dump-tree.sh` | 设备端诊断脚本 |

## 环境备忘

- 构建链全在工作区 `.toolchain\`：JDK 21 / SDK 35 / NDK 27 / Gradle 8.9 /
  **emulator 37.1.11** / **system-images;android-34;google_apis;x86_64**。
  每次新 shell 先 `. D:\Work\DSHapk\tools\android-env.ps1`。
- **Gradle 在本沙箱不可用**（守护进程起不来），走 `tools/build-apk-cli.ps1` 直驱 SDK 工具链。
- AVD 是**手工建的**（`avdmanager` 在这套环境里写不出配置）：
  `.toolchain\android-user-home\avd\dsh-test.ini` + `dsh-test.avd\config.ini`。
- 本机外网**间歇性**可用；下载脚本都带重试。
- 沙箱拒绝写 `C:\Users\yue\.android`；`ANDROID_USER_HOME` / `ANDROID_PREFS_ROOT` /
  `ANDROID_AVD_HOME` / `GRADLE_USER_HOME` / `npm_config_cache` 全部重定向到工作区。
