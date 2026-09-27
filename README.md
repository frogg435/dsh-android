# dsh-apk —— 把 DeepSeek Harness 装进一个自包含的安卓 APK

在 WebView 里运行 DSH，**所有运行时都打进 APK**：不需要 Termux、不需要 root、
不需要联网安装。首次启动会把约 487 MB 解压到应用私有目录，然后拉起内置的 node。

## 环境要求

- **Android 11+（API 30），arm64。** 内置的 `node`、`bash` 以及前缀里的每一个
  二进制都是 aarch64 动态库，32 位和 x86 设备跑不起来。APK 里放了一个 3.8 KB 的
  ABI 标记（见下），所以这类设备**连安装都会被挡掉**，不会白白下 160 MB。
- 首次启动前需 **约 1.5 GB 可用空间**；再装一套 C/C++ 工具链会额外占约 680 MB。
- 不需要 root、不需要 Termux、不依赖任何外部文件。

## 里面有什么

| 资源 | 作用 |
|---|---|
| `runtime/bin/node`、`runtime/lib/*.so` | aarch64 版 Node 26，以及它传递依赖的全部共享库 |
| `runtime/bin/bash`、`runtime/bin/rg` | 安卓两条都没有；DSH 的 `bash` 工具写死了 `bash -c`，文件搜索兜底会扫 `PATH` 上的 `rg` |
| `usr/` | 重定位后的 Termux 前缀（约 2320 个文件）：apt、dpkg、python 3.14、coreutils、bash、openssl…… |
| `usr-links.txt` | 前缀需要的 1009 条符号链接 —— APK 资源存不了符号链接，所以首次启动时重建 |
| `setup-prefix.sh` | 重建上面这些符号链接，以及下面两棵垫片树 |
| `dsh-adb/` + `setup-plugin.sh` | `android_*` 设备控制插件，安装进 dsh profile |

## 两棵垫片树

前缀是按 `/data/data/com.termux/files/usr` 构建的 —— 那是另一个应用的私有目录，
在这里读不到。靠两样东西让它就地可用：

**`dpk/`** —— 每个重定位过的 ELF，其 `DT_RUNPATH` 里那个旧路径都被改写了。
替换值 `/data/data/com.dsh.launcher/dpk` 与原路径**恰好都是 31 字节**，所以替换是
等长的，可以直接在 `.dynstr` 里进行，不需要重构 ELF。`dpk/{bin,lib,etc,var}`
是指回真实前缀的符号链接。

**`.termux-root/`** —— `.deb` 的载荷路径以构建期路径为根，所以 dpkg 通过一棵影子
树来安装，把 `./data/data/com.termux/files/usr`（以及重定位后的等价路径）映射回
真实前缀。只因为 dpkg 始终以 `--root` 运行才需要它。

## 四个值得知道的坑

1. **用 `targetSdk 28`，不是 35。** 当 `targetSdk >= 29` 时，Android 10+ 会拒绝
   `exec()` 应用可写目录里的任何文件（`EACCES`，错误码 13）。Termux 自己也停在
   28 就是同一原因；还要让 `lint` 闭嘴。
2. **`aapt2` 会丢点文件。** 它默认的 `ignoreAssetsPattern` 静默删掉了 70 个文件，
   其中 `pi-ai/dist/providers/data/.manifest.json` 是插件加载器必需的。通过覆盖该
   模式修好。
3. **`OPENSSL_CONF=/dev/null`。** 内置 node 的 `OPENSSLDIR` 编译期指向 Termux 前缀，
   而本应用读不到 → node 启动即死，报 `BIO_new_file: Permission denied`。所有拉起
   它的入口都要带这个覆盖，包括 `usr/var/lib/dsh-apt/bin/` 里的重定位工具。
4. **dpkg 的 `chroot` 会被 Android seccomp 杀掉。** 维护脚本死于 `SIGSYS`；
   `--force-script-chrootless` 是必须的。

## 安装软件包

```sh
apt-get-dsh install <包名>   # 装单个包，快
dsh-pkg install <包名>       # 重装整条依赖闭包
```

当 dpkg 声称某个包已安装、但文件其实不存在时，用 `dsh-pkg`：继承来的数据库里有
约 120 条记录，其中只有约 20 个包真正解压出过文件。dpkg 包装脚本**每个 apt 事务
做一次全量重定位扫描**（约 13000 个文件约 2.7 秒，所以不是每个包扫一次）；直接
`dpkg -i` 则当场扫一次详细说明见「C/C++ 工具链」一节。

## 动画

面板带两个动画，两者的时长都乘以系统的「动画程序时长缩放」（开发者选项）——
由原生侧读 `ANIMATOR_DURATION_SCALE` 后以 `window.__dshAnimScale` 注入页面：
1 为正常、0.5 减半、0 关闭。`animMs()` 在小于 8ms 时返回 0，所以「关闭动画」是
真的瞬间完成。

- **终端面板。** 上滑 14px 并淡入。它保持挂载，且**只动 `transform`/`opacity`** ——
  因为键盘处理每帧都在改 `bottom` 和 `height`，给这两个加过渡会让它抽搐。
- **侧边栏。** 外壳是 CSS Grid，列宽由应用内联写入，并且已经声明了
  `transition: grid-template-columns .3s` —— **但实测宽度在 t=0ms 就从 56 跳到 280**，
  一个中间值都没有，它自己的过渡根本没跑。用 rAF 逐帧写中间值也没用：写进去立刻
  读回来还是原值，说明 React 在重新提交这个属性。最后改用 **Web Animations API
  动 `transform`**（React 不写这个属性）—— 底层布局仍是瞬间切换，但观感正确，
  而且没有任何东西能覆盖它。

用 50ms 轮询来检测变化，因为 frame 元素会随状态变化被重新挂载，挂在某个节点上的
观察器会停止触发。

## C/C++ 工具链

`pkg install clang llvm lld make ndk-sysroot libc++ libcompiler-rt` 就能得到一套可
用的工具链：clang 21.1.8 能编 C++17（含 STL）、`make` 正常、产物能直接运行。
但在此之前有两处是坏的，现在都由 `relocate-all` 修好了：

- **Python C 扩展加载不了。** Termux 的 `python3` 是个 4 KB 的启动器，`NEEDED`
  了 `libpython3.14.so`；而 CPython 在 Linux 上从不把扩展链接到 libpython ——
  它指望解释器把 `Py*` 符号导出，可 bionic **不会**把这些暴露给 `dlopen`。于是
  每一次 pip 构建都以 `cannot locate symbol "PyModule_Create2"` 告终。
  `fix-python-ldshared` 会往 sysconfig 数据的 `LDSHARED` 里补 `-lpython3.14`，
  并且在 python 升级替换掉那个文件之后会重新补。
- **新装的文件从来不被重定位。** 变更检测用的是 mtime，但 dpkg 会保留 `.deb` 里
  记录的时间戳（某个 clang 包装脚本安装数月后 `mtime` 仍是 `2026-07-01`，而
  `ctime` 才是解包时间）。结果什么都没匹配上，新装的二进制继续带着 Termux 的
  shebang 和 RUNPATH —— `aarch64-linux-android-clang` 一直是个 201 字节的脚本、
  shebang 指向 `/data/data/com.termux/...`，pip 拿它当 `LDSHARED` 时就返回 EACCES。
  现在改为**每个 apt 事务全量扫一次**（`DPkg::Post-Invoke`），直接 `dpkg -i` 仍然
  当场扫。全量扫约 13000 个文件要 2.7 秒，这就是它不能按包执行的原因。

仍然做不到的：

- **静态链接。** `-static` 会失败，因为 ndk-sysroot 里没有 `crtbegin_static.o`、
  `libc.a` 或 `libm.a`。
- **可移植的产物。** 产物链接的是前缀里的 `libc++_shared.so`，运行时需要它。
- **把工具链打进去。** 光 `libLLVM.so` 就 128 MB，整套工具链会让前缀从 117 MB 涨到
  797 MB —— 所以按需安装。

## 内置终端

应用在每次页面加载后把 `assets/terminal.js` 注入 WebView：侧边栏里、**搜索按钮正
下方**一个 `>_` 按钮，点开是一个面板，用与 dsh 服务端相同的环境执行 shell 命令。
也就是说整套内置前缀都能手动使用 —— bash、coreutils、apt、dpkg、python、curl ——
而且不消耗对话上下文。

它刻意做成原生注入而不是 dsh 客户端插件（不需要前端构建工具链，也不改动 dsh 内部）。
命令通过 `@JavascriptInterface` 桥逐行回传，并与 agent 相互独立地运行。

**按钮只在侧边栏收起成窄轨道时显示**：侧边栏展开时、以及打开设置页时会自动隐藏 ——
展开态下图标会挪进标题行，而全屏页面上一个高 z-index 的浮动按钮会压在内容之上，
两种都很难看，所以直接隐藏而不是另找一个位置。

有三件事必须实测而不能想当然，因为第一次都猜错了，而且都是截图看出来的：

- **设置席位没有任何标签。** 探针实测 `aria='' txt=''`，只能靠 CSS-module 类名
  `VOzbGW_trigger` 认出来。早先按「最底部控件」锚定，导致输入区的按钮一显隐按钮
  就乱跳。
- **横屏几乎不剩空间。** 350px 高的视口减去 293px 的键盘只剩 77px。所以打字时面板
  会收成只剩输入行；键盘收起后标题栏和输出区再回来。
- **键盘高度不能补偿两次。** `adjustResize` 确实收缩了布局视口（350 → 77），
  此时再叠加原生 `getWindowVisibleDisplayFrame` 的偏移，会把面板推到屏幕上方
  255px。现在原生测量只在视口**没有**收缩时才使用。

**让 agent 也能读到终端**：面板里每条命令跑完后，会把
`{时间, 命令, 退出码, 耗时, 输出}` 追加到 `~/.dsh/terminal-panel.jsonl`；同时应用
会在首次启动时放置一份 `AGENTS.local.md`，而 dsh 自带的
`@deepseek-ai/dsh-agent-instructions` 会自动加载它。于是 agent 用普通的文件工具
就能看到用户手动跑过什么 —— 不需要插件，也不需要轮询。

如果存在 `files/terminal.js`，它会覆盖 APK 里那份，所以有 root 的设备可以热改这个
覆盖层而不用重新打包。

另外记一个坑：`adb shell input tap` 用的是**物理像素**，而
`getBoundingClientRect()` 返回的是 **CSS 像素** —— 在 dpr 为 2.625 的设备上两者相差
这个倍数，盲点坐标会静默点空。

## 余额插件（dsh-balance）

侧边栏底部显示当前 AI 服务商的账户余额，**凭据只在 host 端解析，永不进入浏览器**。

它内置了 **38 家服务商**的目录，但要说清楚一件事：**只有 11 家能用 API Key 查到余额** ✗，
其余 27 家根本没有提供余额接口。

| 能力 | 数量 | 说明 |
|---|---|---|
| 货币余额 | 9 | DeepSeek、Moonshot/Kimi、阶跃星辰、硅基流动、OpenRouter、Ofox.ai、Novita AI、xAI，以及 NewAPI/OneAPI 中转站 |
| 配额（百分比）| 2 | MiniMax、智谱 GLM |
| 间接查询 | 5 | Anthropic（需 Admin Key）、Gemini（需 OAuth）、Together（仅用量）、Azure（需 Consumption API）、AWS（需 GetPaymentInstrumentBalance）|
| 无接口 | 22 | OpenAI、Mistral、Cohere、Perplexity、Groq、Cerebras、Fireworks、ModelScope、七牛、百炼、火山、千帆、混元、百川、零一、LongCat、MiMo、AiHubMix、DMXAPI、302.AI、Vercel、Cloudflare |

**NewAPI / OneAPI 中转站**那一行值得单独说：它用 `/dashboard/billing/credit_grants`
—— 也就是 OpenAI 兼容的计费端点 —— 所以**用调用模型的同一把 API Key 就能查** ✓，
把 `baseURL` 指向你的中转站即可。

对「无接口」的服务商，插件会如实显示**「不提供余额接口」**，而不是猜一个数字 ——
API Key + Base URL 依然可以正常调用模型，只是没有余额可显示。

厂商表是纯数据（`lib/providers.js`），加一家就是加一行。

## 窄视口 UI 补丁

`patches/` 里是这里唯一的前端改动：两个 CSS 块，修的是手机宽度下的布局。上游包是
编译后发布的，所以改动以补丁形式保存，而不是 fork。

- **侧边栏改为浮层。** 1024px 以下，侧边栏原本会占据一个网格列、把对话列挤到文字
  在右边缘被截断（实测 CSS 视口约 425px）。现在它浮在内容之上，并带一个
  `pointer-events:none` 的遮罩，保证点击仍能落到页面上。
- **设置改为全屏页。** 700px 以下，设置原本是个 800px 居中面板加 32px 圆角，手机
  上大片留白。现在它铺满屏幕，导航变成横向标签条。

`patches/README.md` 解释了这两个块以及 dsh 升级后如何重新应用。已验证：把
`patches/narrow-viewport.patch` 应用到纯净的 `0.1.2-rc.1` 包上，能逐字节复现出
当前发布的文件。

## 组装资源

本仓库携带的是「胶水」，不是大件：`assets/runtime/`（约 400 MB）和 `assets/usr/`
（约 120 MB、约 4400 个文件）太大，不适合入库，但都可以重建。其余部分可以直接从
仓库构建。

### 1. `assets/runtime/` —— node、bash、rg 及其共享库闭包

从一份 Termux 安装里把二进制拷出来，并**传递地**补齐它们需要的每一个库：

```sh
cp $PREFIX/bin/node assets/runtime/bin/
cp $PREFIX/bin/bash assets/runtime/bin/     # DSH 写死了 `bash -c`
cp $PREFIX/bin/rg   assets/runtime/bin/     # 文件搜索兜底会扫 PATH
```

然后用 `readelf -d <文件> | grep NEEDED` 迭代到不动点，把每个能在 `$PREFIX/lib`
下解析到的库拷进 `assets/runtime/lib/`。跳过传递依赖这一步会在**加载时**失败而不是
构建时 —— 这里被 `libicudata.so.78` 咬过一次。**不要拷贝同时存在于
`assets/usr/lib/` 里的库**：`LD_LIBRARY_PATH` 把 `runtime/lib` 排在前面，为的是让
node 永远不会误用前缀里的 `libssl`/`libcrypto`/`libz`。

### 2. `assets/runtime/dsh-termux/` —— harness 本身

一棵普通的安装树（`lib/`、`node_modules/`、`package.json`），例如来自
`npm i dsh-termux` 或 `npm i @deepseek-ai/dsh`。它以
`node --expose-internals <目录>/lib/bin.js web` 运行。

### 3. `assets/usr/` —— Termux 前缀

最好在一台前缀已经能用的设备上做：先快照，再把整棵树拆成「文件 + 清单」，因为
**APK 载不了符号链接，而 aapt2 会静默丢掉空目录**。

```sh
# 在设备上
tar --exclude='*.cursed' -cf /sdcard/usr.tar usr

# 在构建机上解开之后
A=app/src/main/assets
find usr -type f -exec cp -a {} $A/usr/{} \;            # 只拷普通文件
find usr -type l | while read -r l; do                   # 符号链接 -> 清单
  t=$(readlink "$l")
  t=${t//\/data\/data\/com.termux\/files\/usr//data\/data\/com.dsh.launcher\/dpk}
  printf '%s\t%s\n' "${l#./}" "$t"
done | sort > $A/usr-links.txt
find usr -type d | sed 's|^\./||' | sort > $A/usr-dirs.txt
```

第 2 步的改写不是可选的：Termux 构建出的前缀里，符号链接是指向
`/data/data/com.termux/...` 的绝对路径 —— 在没有 Termux 的设备上那是别的应用的私有
目录。`setup-prefix.sh` 会在首次启动时把它们全部重建出来。

之后跑一下 `tools/closure-audit.sh` —— 它会检查每个 ELF 的共享库闭包，并标出会让
aapt2 报 "Duplicate resources" 的 `x` / `x.gz` 同名对。

### 4. `assets/dsh-adb/` —— 设备控制插件

把包目录整个拷过来（`lib/`、`package.json`、`cordis.patch.yml`）。
`setup-plugin.sh` 会把它装进 profile。

## 构建

```sh
export JAVA_HOME=$PREFIX/lib/jvm/java-21-openjdk
export ANDROID_HOME=$HOME/android-sdk
gradle assembleRelease
```

签名口令从 gradle properties 读取：`RELEASE_STORE_PASSWORD` / `RELEASE_KEY_ALIAS` /
`RELEASE_KEY_PASSWORD`。**密钥库不在本仓库里** —— 构建 release 之前请先生成自己的。

## 存储权限

应用申请并获得了共享存储的读写权限 —— 照片、视频、音频、文档都能直接访问，
终端面板和 agent 因此可以读写手机上的文件，而不只是应用私有目录。

**关键点：不需要 `MANAGE_EXTERNAL_STORAGE`（"管理所有文件"）。**

那个权限要求 `targetSdk >= 30`，而 **`targetSdk >= 29` 会让 node 起不来**
（Android 10+ 禁止 `exec()` 可写目录里的文件）。两者不可兼得。

但 `targetSdk 28` 本身带来了更好的结果：**Android 11+ 对 targetSdk ≤ 29 的应用
保留传统存储模型**，`READ/WRITE_EXTERNAL_STORAGE` + `requestLegacyExternalStorage`
即可广泛读写共享存储 —— 效果上等价于"管理所有文件"。

实测（应用进程内，SELinux 上下文 `untrusted_app_27`）：

```
ls /sdcard        → Alarms, Android, Audiobooks, DCIM, Documents, Download…
ls /sdcard/DCIM   → Camera, QuarkScan, Screenshots
ls /sdcard/Pictures → IMG_20260826_100105.jpg …
touch /sdcard/.x  → 写成功
```

manifest 同时声明了 Android 13+ 的 `READ_MEDIA_IMAGES/VIDEO/AUDIO`：targetSdk 28
的应用其实靠上面那条传统权限就能拿到媒体访问，声明它们是为了让分项开关存在，
并且将来万一提升 targetSdk 时不会静默丢失媒体权限。

**够不到的地方**：`/sdcard/Android/data/<其他应用>/` —— Android 11 起即使在传统
模型下也隔离。

## ABI 标记

`app/src/main/jniLibs/arm64-v8a/libdshabi.so` 是一个 3.8 KB 的占位库，没有任何代码
链接或加载它。它存在的唯一目的是让 APK 声明 `native-code: 'arm64-v8a'`。

本应用发布出去的每一个二进制 —— node 运行时、bash、以及整个 Termux 前缀 —— 都是
从应用私有目录执行的 aarch64 动态库。如果 `lib/` 下什么都没有，APK 就**完全没有**
ABI 声明，于是一台 32 位或 x86 设备可以把这 160 MB 全下下来装好，然后在启动时才
发现跑不了。有了这个标记，安装器会直接按 ABI 过滤掉。

源码在 `tools/abi-marker/libdshabi.c`，重建命令：

```sh
clang -shared -fPIC -O2 -s --target=aarch64-linux-android30 \
  -o app/src/main/jniLibs/arm64-v8a/libdshabi.so tools/abi-marker/libdshabi.c
```

请把这个 `.so` 一起提交 —— 重新生成它需要 NDK，而 Gradle 并不构建它。

## debug 与 release 变体

两者都存在，就是 Gradle 的默认两个 build type，没有 flavor 拆分。

| | `assembleDebug` | `assembleRelease` |
|---|---|---|
| 产物 | `app/build/outputs/apk/debug/app-debug.apk` | `app/build/outputs/apk/release/app-release.apk` |
| 签名 | 自动生成的 `~/.android/debug.keystore` | `release.keystore`（见「构建」）|
| `android:debuggable` | true，`adb run-as com.dsh.launcher` 可用 | false |
| 压缩优化 | 无 | 无（`minifyEnabled false`）|

两个值得知道的后果：

- **两者的 `applicationId` 相同**（都是 `com.dsh.launcher`），但签名密钥不同，所以
  互相覆盖安装会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。要先卸载，或者给 debug
  加一个 `applicationIdSuffix ".debug"` 让它们并存。
- **只有 release 能覆盖 release。** debug 密钥库是本机生成的，别处构建的 debug
  APK 无法更新你手上这个。
