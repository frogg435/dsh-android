# dsh-adb

给 DeepSeek Harness 的 Android 设备操作插件：**用语义节点和选择器操控设备，而不是"截图 → 猜坐标 → 点屏幕"**。

模型侧的流程变成：`android_ui` 读出带 id 的界面树 → `android_action` 按 `node` 或 `match={rid|text|desc}` 直接命中控件 → 用结果里的 `focus_after` / `screen_changed` 确认界面真的动了。截图降级为"确实需要看像素"时的备选。

## 安装的工具

| 工具 | 作用 |
|---|---|
| `android_ui` | 用 `uiautomator dump` 读出**节点可寻址**的界面树：`<id> d<depth> <class> "text" rid=... [box] flags=click scroll`。自动丢弃无标签的纯布局容器（保留层级），`interactive_only` 只列可操作节点，`refresh:false` 复用上次结果不碰设备。 |
| `android_action` | 执行动作：`tap` / `long_press` / `swipe` / `text` / `clear` / `key` / `back` / `home` / `recents`。目标按优先级解析：`match` 选择器（重新 dump，跨刷新稳定）→ `node` id（复用 `android_ui` 的缓存 dump，`verify:true` 可先校验再点）→ `x/y`（最后手段）。点标签会自动上溯到最近的可点击祖先；返回值包含真正执行的命令与 `focus_before` / `focus_after`。 |
| `android_app` | `current`（前台组件）/ `launch`（自动解析 launcher activity 再 `am start -W`）/ `stop` / `list`（全部可启动应用）/ `info`（版本号等）。 |
| `android_state` | 一次读取设备身份、屏幕尺寸/密度/旋转、电量、亮屏状态、当前焦点组件。 |
| `android_screenshot` | 截屏存成本地 PNG 并返回路径，配合内置 `read_image` 查看（不占对话上下文）。 |
| `android_shell` | 原始 `adb shell` 兜底（dumpsys / pm / logcat / settings …），可由配置关闭。 |
| `android_devices` | 面向 adb server 的设备管理：`list`（列出已连接设备的 serial/状态/型号）、`connect` / `disconnect`（TCP/IP）、`pair`（无线调试配对码）。这是"第二台设备"进入视野的入口。 |

另外注册一段 system prompt 指导（`guidance: true`），告诉模型先读界面树、优先选择器、动作后校验、以及多设备时用 `serial` 指定目标。

## 连接别的设备

插件按"每台设备一个 client"工作：任何工具都能用 `serial` 参数临时指定目标；不传则用配置里的 `serial`，再退回"唯一在线设备"。显式点名的设备会先做一次可用性校验，不存在/掉线会立刻报错，而不是静默返回空结果。

**Android 11+（无线调试，推荐）** —— 目标机 `开发者选项 → 无线调试`，点"使用配对码配对设备"拿到 `IP:配对端口` 和 6 位码：

```jsonc
// android_devices
{ "action": "pair", "host": "192.168.2.77:37xxx", "code": "123456" }
{ "action": "connect", "host": "192.168.2.77:5555" }   // 端口是无线调试主界面那个，和配对端口不同
{ "action": "list" }                                    // → 192.168.2.77:5555  device
```

之后所有工具都能 `{ "serial": "192.168.2.77:5555" }` 指到它；想让它成为默认目标就写进配置 `serial`。

**Android 10 或更早** —— 先用电脑 USB 连一次 `adb tcpip 5555`，再 `{ "action": "connect", "host": "<目标IP>:5555" }`。

**USB-OTG 不可用** —— 这个沙箱里没有 `/dev/bus/usb`（已实测），只能走 TCP/IP。

### `adbHome`：为什么必须固定

这套环境里 `/system/bin/adb` 是个 shim，内容是 `export HOME=$PWD`——**adb 的密钥身份跟着进程工作目录走**，而 `$HOME/.android/adbkey` 就是配对身份。DSH 的 workspace 会变，工作区一换等于换密钥，之前 pair 过的远端设备会掉授权。

插件因此把每次 adb 调用的 `cwd`、`PWD`、`HOME` 一起钉在 `adbHome`：

- 默认 `adbHome: ''`：自动选择"已经存在 `.android/adbkey` 的目录"（沿用现在可用的身份，不会平白要求重新授权），都没有才落到 `$DSH_HOME/adb-home`；
- 显式设置：`adbHome: '/data/user/0/com.dsh.launcher/files/adb-home'`，彻底与工作区解耦；想换身份就删掉该目录重新 pair。

## 安装方式

插件是一个 profile bundle（`package.json` 里声明 `dsh.bundle.patch`），所以：

```sh
# 方式一：dsh 的插件管理（需要 pnpm）
dsh plugin --profile web add /path/to/dsh-adb

# 方式二：手工安装（本机没有 pnpm 时）
cp -r dsh-adb "$DSH_HOME/profiles/web/node_modules/dsh-adb"
# 再把 "dsh-adb" 加进 $DSH_HOME/profiles/web/package.json 的 dsh.profile.bundles
```

验证组合结果（不启动服务）：

```sh
dsh --profile web --dump-config | grep -A3 dsh-adb
```

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id `adb` 覆盖（`cordis.patch.yml` 会替换整段 config，所以要么只改需要的键，要么把其余键一起写上）：

```yaml
- id: adb
  config:
    adbPath: adb          # adb 可执行文件
    serial: ''            # 固定设备序列号；空=自动选唯一在线设备
    timeoutMs: 20000      # 普通 adb 命令预算
    dumpTimeoutMs: 40000  # uiautomator dump 预算（明显更慢）
    maxOutputChars: 8000  # shell 输出上限
    maxNodes: 400         # 单次 android_ui 最多列出的节点数
    shotDir: ''           # 截图目录，空=$TMPDIR/dsh-adb
    enableShell: true     # 是否注册 android_shell
    guidance: true        # 是否注册 system prompt 指导段
```

## 自测

```sh
node scripts/selftest.mjs
```

覆盖模块契约、六个工具的注册、XML 解析、节点裁剪与格式化、选择器匹配、shell 转义、dumpsys 解析；一旦 `adb devices` 里有在线设备，还会真实跑一遍只读的 `android_state` 与 `android_ui`。

## 设计要点

- **节点 id 属于某一次 dump**，所以 `node` 只对最后一次 `android_ui` 的结果有效；界面可能变了就用 `match`，或带 `verify: true` 让插件先复核再动手。
- **不猜坐标**：屏幕尺寸/旋转来自 dump 根节点与 `wm size`，滑动按方向 + 比例在目标框内计算起止点。
- **命令不经过主机 shell**：adb 以 argv 方式 spawn；只有设备侧必须的文本注入才做单引号转义（`input text` 的空格写成 `%s`）。
- **失败要能看懂**：dump 失败会依次尝试 `/data/local/tmp`、`/sdcard`、`/dev/tty` 三种配方并回报每一次的原始报错；选不到设备会列出所有设备及其状态。
