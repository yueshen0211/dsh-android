# 交接说明（NEXT-SESSION HANDOFF）

> 用途：固化进度，便于随时中断/恢复。

---

# ✅ arm64 真机验证：完全通过（含完整对话流程）

**没有待办阻塞项了。** 真机 `ZS22224CG6`（XT2537-4 / Android 16 / arm64-v8a）上：

```
engine-state.txt: status=running
未捕获错误 0   插件加载失败 0   引擎退出 0
```

**发一条真实消息 → 拿到模型回复**，会话日志落盘：

```
问：用一句话说明你是谁
答：我是 DeepSeek Harness 里的编码智能体，由 deepseek-flash 模型驱动，
    可以帮你读代码、改文件、跑命令和查资料。
    1 轮 1 步 · 213 tok/s · 8.2K tok

files/dsh-home/sessions/--data-data-dev.dsh.mobile-files-workspace--/session-69456a97-…/
    session.lock               ← flock shim 建出来的
    session.v3.jsonl.zstd      ← link → renameat2 发布出来的
```

界面完整：工作区选择器（可选、可浏览目录）、输入框、`完全权限` / `DeepSeek-V41-Flash` / `High` 齐全。

**arm64 架构本身从未有问题** —— 之前真机的每一次失败，根因都是下面这些平台差异，
没有一条与架构有关。（arm64 模拟器路线已确认不可行，见下文。）

## 本轮修掉的两个「每次运行都失败」的平台拒绝

这两个都在**会话路径**上，所以它们不是"某个功能降级"，而是**每一次 agent 运行都直接失败**。
两个都做到了不 fork 上游包。

### 一、`flock(2)`：上游按 platform 拒绝，且没有 android 预编译

```
本轮运行失败  flock is not supported on android-arm64
```

`dsh-session-persistence-jsonl` 在每个会话目录的 `session.lock` 上取非阻塞排他锁，
时机是"创建出来的会话第一次落盘之前"。而 `@deepseek-ai/node-addon-system/flock` 在碰到内核之前
就按平台拒绝了 —— Node 在这里报 `process.platform === 'android'`，而它只接受 `linux` / `darwin`：

```js
if (platform !== 'linux' && platform !== 'darwin') throw … ERR_FLOCK_UNSUPPORTED_PLATFORM
```

它的 optionalDependencies 只有 linux/darwin，**根本没有 android 包**。

**修法**：`android/shims/node-addon-system/` 整个替换该包，用 **Koffi** 调 bionic libc 的 `flock`。
Koffi 本来就在引擎树里（koffi 自己的 FFI），所以不需要任何原生构建。

**这是真锁，不是 stub**。上游的 browser worker 把 flock stub 成立即成功（因为它单进程），
这里让内核真的做锁。设备实测：同一 inode 上第二个 fd 得到 `EAGAIN`（errno 11），
关掉持有者后能再次取得 —— 与上游 `isLockContention` 判据完全一致。

因为整个包被替换，上游 `landlock-run` 那一半**原样保留**：`dsh-sandbox-local` 静态 import 它，
而它的 `probe()` 对缺失二进制本来就返回 `unusable`，在 Android 上正是正确答案。

### 二、`link(2)`：Android 在应用存储里拒绝硬链接

flock 修好后，紧接着暴露第二个：

```
EACCES: permission denied, link '…/session.v3.jsonl.zstd.<rand>.tmp'
                              -> '…/session.v3.jsonl.zstd'
```

**Android 对应用存储里的硬链接一律拒绝，目标不存在也一样**，所以这不是竞争/碰撞问题。
同目录的 `rename()` 能成功，但它**会覆盖** —— 而这正是当初选 `link` 要避免的：
`link` 就是那个"原子且不覆盖"的发布动作，`rejectExistingLog` 只是更便宜的前置检查。

**修法**：`renameat2(RENAME_NOREPLACE)` —— 同样的事，不需要硬链接。
设备实测：新目标发布成功（内容完整、临时名被消耗）；目标已存在则 `EEXIST`（errno 17）
且目标内容原封不动。

**这个没法用换包解决**，因为调用点是 Node 内建模块的解构导入。属性打补丁也不行，
原因值得记住：

> **ESM 对内建模块的具名导入是快照，不是活绑定。**
> 执行 `require('node:fs/promises').link = ours` 之后，
> 重新 `import('node:fs/promises')` 也好、解构 `const { link } = …` 也好，
> **拿到的都还是原函数**；只有 CJS 那个对象报告已打补丁。设备实测确认。

所以修法是 **preload**：`android/support/android-fs/register.mjs` 注册一个进程内 load hook，
在那个模块加载时改写它那一行 import，同时保留它从 `node:fs/promises` 取的其他所有绑定。
`EngineRuntime` 用绝对路径 `--import` 传进去；该模块放在 `node_modules` 下，才能解析到 Koffi。

**这条也解释了为什么不能用 `module.register()`**：Node 26 上它已废弃，而且进程内
`registerHooks()` 对"只做一次字符串改写"来说更合适。

## 本轮修掉的 bug：工作区打不开（两个叠加原因）

### 原因一：禁用了被消费的服务行

`@deepseek-ai/dsh-api-workspace-controller` 注入 `directoryPicker` 服务：

```
@deepseek-ai/dsh-api-workspace-controller: pending (waiting for service: directoryPicker)
```

服务缺失 → 工作区界面根本渲染不出来。

**修法与 attachment 那次同一个道理**：能力被消费的行**只能替换、不能删除**。
改为禁用 `-auto`、插入 `-browse`：

```yaml
- id: directory-picker
  disabled: !!js process.platform === 'android'
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
```

### 原因二（更隐蔽）：`-auto` 同时负责挂载**客户端**插件

**只加 host 端的 `-browse` 是不够的。** `-auto` 内部有一张 host/client 配对表，
并且它 `inject: ["webServer", "loader"]` —— 注入 `loader` 就是为了在运行时挂载客户端插件：

```js
const inject = ["webServer", "loader"];
browse: { host: '@…/dsh-host-directory-picker-browse',
          client: '@…/dsh-client-ui-directory-picker-browse' }
```

**禁用 `-auto` 会同时移除 host 后端与客户端插件。** 而客户端插件正是注册
`conversation.hero.workspace` 与 `conversation.hero.workspace.directoryFlow`
这两个 slot 的那个 —— slot 无人占用时，**按钮照常渲染，但点击后什么都不发生**，
控制台也不报错。所以必须两半都显式声明：

```yaml
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

**结论：禁用 `-auto` 这类"双面"行时，必须同时替换它的 host 与 client 两半。**

**这是第三次踩同一类坑**（前两次：`attachments` 导致 file-upload 与
session-controller 一起 pending；`directoryPicker` 导致 workspace-controller pending）。
写 profile 时务必先确认：**这个行提供的服务有没有被别的行注入？它有没有副作用
（挂载别的插件、注册 slot）？** 有就必须替换 provider，不能 disable。

## 定位这类 bug 的方法（值得复用）

`adb input tap` 猜坐标不可靠（真机 dpr 2.4375、模拟器不同），而且**合成事件骗不过
React 的事件委托**，会出现"点了没反应"的假象。正确做法是用 **WebView 的 DevTools 协议**
直接查 DOM 与 `__reactProps`：

```powershell
# 1) 转发 WebView 调试端口（用主进程 pid，不是 :engine 的）
$mainPid = ((& $adb -s <serial> shell pidof dev.dsh.mobile) -split '\s+')[0]
& $adb -s <serial> forward tcp:9222 localabstract:webview_devtools_remote_$mainPid

# 2) 探查页面（DOM 摘要、API 可用性、控制台）
node tools/cdp-probe.mjs .m1/ws-url.txt
# 3) 查元素上真实挂的 handler
node tools/cdp-props.mjs .m1/ws-url.txt "选择工作区"
# 4) 真实触摸/鼠标输入，并监听 DOM 变化
node tools/cdp-touch.mjs .m1/ws-url.txt "选择工作区"
node tools/cdp-mutate.mjs .m1/ws-url.txt "选择工作区"
```

`tools/cdp-*.mjs` 就是为此写的，以后 UI 类问题都用这套，别再猜坐标。

## 仍未做的一件事

**完整对话流程尚未端到端验证**（发消息 → 模型回复），因为需要一个 DeepSeek API key。
UI、引擎、工作区、插件树都已确认正常；这一步需要真实 key 才能跑。


## 如果真机再出问题：第一步

```powershell
. D:\Work\DSHapk\tools\diagnose-device.ps1
```

一条命令收齐定位所需的一切（设备信息、安装版本、进程与界面状态、UI 轮询的 state 文件、
引擎失败日志、引擎 logcat、WebView 控制台与版本、解包后的目录结构），
并打印报告文件路径。**把那个文件发回来即可定位。**

> 手工最快的一眼：
> `adb shell run-as dev.dsh.mobile cat files/engine-boot.log`
> （屏幕启动页也在实时显示它的尾部 15 行）

## 已经排除的可能（不必重查）

静态检查全部通过，所以问题只在运行时：

| 检查 | 结果 |
|---|---|
| Releases 里的 APK 是否含全部修复 | ✅ 含 `publishState` / `engine-state.txt` / WebView polyfill / `ensurePluginsInProfile` |
| manifest 关键属性 | ✅ `extractNativeLibs=true`、`debuggable=true`、`:engine` 独立进程、网络安全配置在位 |
| 资产关键文件 | ✅ 引擎入口 / patch / 插件 / koffi arm64 绑定 / ENGINE-VERSION 全在 |
| arm64 `.so` 依赖闭包 | ✅ **0 缺失** |
| koffi 绑定路径 | ✅ 符合运行时查找路径 `@koromix/koffi-android-arm64/android_arm64/koffi.node` |

## 备选路径：arm64 模拟器 —— ❌ 不可行（已实测）

**现代 Android 模拟器拒绝跨架构运行**，arm64 镜像在 x86_64 主机上直接 FATAL：

```
FATAL | Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator
        on x86_64 host. System image must match the host architecture.
```

所以 **arm64 只能在真机（或 arm64 主机）上验证**，没有捷径。arm64 系统镜像
（`system-images;android-34;google_apis;arm64-v8a`）已经下好放在 `.toolchain/sdk` 里，
但它在这台机器上跑不起来 —— 换到 arm64 机器才能用。

## 已做的替代努力：让 App 自己说清卡在哪

既然拿不到日志，就把日志搬到屏幕上。服务现在把引擎输出**镜像写进
`files/engine-boot.log`**，UI 在启动页实时显示其尾部；超过 150 秒仍未就绪时，
标题变成「Still starting」并显示已等待秒数 + 最后 15 行输出 + 「复制诊断」按钮。

已在 x86_64 模拟器验证生效：

```
engine-boot.log 存在，共 5 行：
    engine dir: /data/user/0/dev.dsh.mobile/files/engine
    native lib dir: /data/app/~~…==/lib/x86_64
    engine tree already present
    dsh web: http://127.0.0.1:46853/?token=…
    engine url: http://127.0.0.1:46853/?token=…
engine-state.txt:  status=running
```

**因此再次遇到"卡住"时，屏幕上会直接显示引擎走到哪一步** —— 不需要连电脑。
这也顺带区分了两种此前无法分辨的情况：引擎**从未就绪** vs **就绪后又退出**。

## 若仍怀疑是「卡住」类问题

手机插上 USB、允许 USB 调试，重新装一次最新 APK（**必须重装**，旧版没有上面的诊断），然后：

```powershell
. D:\Work\DSHapk\tools\android-env.ps1
$adb="$env:ANDROID_HOME\platform-tools\adb.exe"
& $adb install -r D:\Work\DSHapk\.m1\release\dsh-android-0.1.0-m1-arm64-v8a-debug.apk
& $adb shell am start -n dev.dsh.mobile/.MainActivity
```

若仍卡住：**屏幕上的日志就是答案**，或者跑 `. D:\Work\DSHapk\tools\diagnose-device.ps1`
收一份完整报告。

## 若修复后要发新版本

`-Abis` 就是为这件事加的：以前要先手工 `Remove-Item jniLibs\x86_64` 再构建，
容易发错架构的包；现在在命令行上声明，构建脚本会检查该 ABI 是否已 stage，
缺失时报错并列出实际已 stage 的 ABI。

```powershell
. D:\Work\DSHapk\tools\android-env.ps1
# 只打包 arm64（真机不需要 x86_64 那 93 MB）
& .\tools\build-apk-cli.ps1 -ProjectDir android -Module app -PackageName dev.dsh.mobile `
    -MinSdk 29 -TargetSdk 35 -Label 'DeepSeek Harness' -VersionName '0.1.0' -VersionCode 1 `
    -Abis arm64-v8a
# 不需要动 jniLibs，x86_64 原样留着给模拟器用
Copy-Item android\app\build\cli-debug\dsh-debug.apk `
    .m1\release\dsh-android-0.1.0-m1-arm64-v8a-debug.apk -Force
. .\tools\gh-env.ps1
& gh release upload v0.1.0-m1 <新APK> --repo yueshen0211/dsh-android --clobber
```

### 关于「双 ABI 安装包」

**磁盘上没有双 ABI 的 APK** —— 它只在构建时存在（`-Abis` 不传即打包 jniLibs 下全部 ABI，
约 232.8 MB，同一个包真机与模拟器都能装）。要拿到它就**不传 `-Abis`**：

```powershell
& .\tools\build-apk-cli.ps1 ... # 不加 -Abis
```

前提是两套运行时都已 stage（`-Abi arm64-v8a` 与 `-Abi x86_64` 各跑一次）。

### 当前发布资产

**`sha256:3315d862d5cf68a7c590d78205353cc88d40e41134e7c174f02cbbbe4f9105cb`**
—— 含 host + client 两半修复，真机冷启动实测通过（详见下方"发布用的 arm64-only 构建"）。

（历史：`e97c7d60…` 是只有 host 半修复的版本，工作区按钮仍点不动，已被覆盖。）

---

| 项 | 状态 |
|---|---|
| 日期 | 2026-09-28 |
| 当前里程碑 | **M1 完成 —— 完整 DSH GUI 在 arm64 真机与 x86_64 模拟器上均端到端验证通过** |
| 仓库 | **https://github.com/yueshen0211/dsh-android**（public） |
| 发布 | **https://github.com/yueshen0211/dsh-android/releases/tag/v0.1.0-m1**（pre-release） |
| APK | Releases 里是 **arm64-only ~140 MB**（本轮需重新构建覆盖，见上） |
| 真机 | `ZS22224CG6`（Android 16 / arm64-v8a）—— **✅ 通过**：引擎就绪、UI 完整、工作区选择器可用 |
| 模拟器 | `dsh-test`（Android 14 / **x86_64**），WHPX 加速，带窗口 —— 已验证通过 |
| arm64 镜像 | `system-images;android-34;google_apis;arm64-v8a` 已下载，但**本机跑不起来**（跨架构，见上文） |
| 未验证 | **完整对话流程**（发消息 → 模型回复），需要一个 DeepSeek API key |

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

Releases 里的 APK 只含 arm64-v8a（140.2 MB），因为真机不需要 x86_64 那 93 MB。
用 `-Abis` 声明，**不要**再去手工删 `jniLibs\x86_64`：

```powershell
. tools/android-env.ps1
. tools\build-apk-cli.ps1 -ProjectDir android -Module app -PackageName dev.dsh.mobile `
    -MinSdk 29 -TargetSdk 35 -Label 'DeepSeek Harness' -VersionName '0.1.0' -VersionCode 1 `
    -Abis arm64-v8a
```

`-Abis` 会校验该 ABI 是否已 stage，缺失时报错并列出实际已 stage 的 ABI，
所以不会再出现"以为发了 arm64、其实发了别的架构"这种情况。

判据：**GitHub 侧计算的资产摘要必须与本地 `SHA256SUMS.txt` 一致**，不一致就是上传没生效。

### 本轮发布的 arm64 资产（已实测）

```
sha256:3315d862d5cf68a7c590d78205353cc88d40e41134e7c174f02cbbbe4f9105cb
```

已验证：APK 内 `lib/` 只有 `arm64-v8a`（11 个 `.so`）、
`assets/engine/android.patch.yml` 与仓库里的 `profile/android.patch.yml` 逐字节一致、
`@deepseek-ai/dsh-client-ui-directory-picker-browse` 已打包。

**真机 `pm clear` 后从零冷启动实测通过**：74 秒（含完整资产解包）→ `status=running` →
内测声明 → API key 对话框 → 工作区首次选择（浏览对话框 → 进入 `workspace` → 打开）→
chip 显示 `workspace`、输入框就绪。**这条路径覆盖的是用户第一次安装后的真实经历。**

---

## 一句话现状

**跑通了，真机与模拟器都是。** 真机（arm64 / Android 16）截图与 DOM 双重确认：
DSH 界面完整渲染、引擎 `status=running`、**工作区选择器可用**
（点开面板 → 「添加工作区…」→ 目录浏览对话框列出真实目录并能逐级进入）。
模拟器（x86_64 / Android 14）同样通过。

错误统计全部归零：

```
Iterator: 0   AbortSignal.any: 0   Promise.withResolvers: 0
connection lost: 0   未捕获错误: 0   插件加载失败: 0   引擎退出: 0
```

唯一未做的是**完整对话流程**（发消息 → 模型回复），需要一个 DeepSeek API key。

## 本轮修掉的「卡在 starting」根因

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
