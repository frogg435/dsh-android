# 缺陷：DSH Web 在 ~425px CSS 视口下布局塌缩

状态：**已复现，未修改**（决定只记录，不从 APK 侧兜底）

## 环境

| 项 | 值 |
|---|---|
| 设备 | V2548A / PD2548，1080×2400 |
| 物理 density | 480 dpi |
| **覆盖 density** | **406 dpi**（`wm density` 覆盖） |
| density 比例 | 406 / 160 = 2.5375 |
| **CSS 视口宽** | 1080 / 2.5375 ≈ **425.6 px** |
| 宿主 APK | `com.dsh.launcher`（DSH WebView 壳） |
| dsh 版本 | `dsh-termux` 0.1.2-rc.1-termux.1 |
| 页面 viewport 声明 | `<meta name="viewport" content="width=device-width, initial-scale=1" />` |

APK 侧 WebView 未覆写任何视口参数（`setUseWideViewPort` / `setLoadWithOverviewMode` / `setInitialScale` 均未设置，走默认），因此 CSS 视口完全由上面的 meta + 系统 density 决定。任何手机浏览器打开同一 URL 都会得到相同结果，**与 APK 无关**。

## 复现步骤

1. 打开 `http://127.0.0.1:3080/`（或宿主 APK）
2. 展开左侧会话列表
3. 左下角「设置」→「通用设置」
4. 观察右侧面板

## 症状 1：设置对话框标签竖排（主缺陷）

`label | control` 两列布局中，**label 列被压塌到约 1 个字符宽**（实测 x=595–630 物理 px ≈ 14 CSS px），中文逐字换行：

```
权
限
选
择
新
会
话
的
默
认
权
限
模
式
```

同屏对照：对话框左侧导航（`通用设置`/`模型`/`插件`/`Agent 预设`）横向正常，顶部 `打开配置文件` 按钮正常 —— **只有设置项的标签列塌了**，说明是该行 grid/flex 的列宽计算问题，不是整体视口问题。

- 截图：`/storage/emulated/0/Pictures/Screenshots/Screenshot_20260926_003907.jpg`

## 症状 2：侧边栏展开挤压主内容

侧边栏展开后主内容列仅剩 ~80–100 CSS px（估算），正文/代码块逐字换行：

```
路径均在
/data/dat
a/com.ter
mux/files
/home/dsh
-apk/
```

- 截图：`/storage/emulated/0/Pictures/Screenshots/Screenshot_20260926_003855.jpg`

## 非缺陷（已排除）

- **深色模式抽屉**：`Screenshot_20260926_003917.jpg` 显示正常 —— 抽屉覆盖式，背后内容变暗，无挤压。说明抽屉本身有正确的 overlay 实现，浅色场景下挤压可能来自不同的布局分支。
- **主聊天界面**：`dsh_release.png` 渲染正常，`对话`/`轨迹` 标签、会话标题、消息流均完整。
- **APK 三个已修问题**：转圈、顶部被状态栏遮挡、冗余 ActionBar，均已修复并实测，与本缺陷无关。

## 建议修法（供 DSH 网页端参考）

1. 设置行的标签列改用 `minmax(min-content, 1fr)` 或加 `min-width: max-content`，避免在窄列下塌到 1 字宽。
2. 为 `~425px`（常见 Android 手机）补一个断点：侧边栏应走 overlay 抽屉而非 `flex-shrink` 挤压主内容。
3. 或在对话框上给一个 `min-width`，窄屏下改为全屏 sheet。

## 为何不从 APK 侧兜底

评估过的两条路都放弃：

- **调视口参数拉宽 CSS 视口** —— 视口拉到桌面宽度后，`initial-scale` 会把页面整体缩小到 1080 物理像素内，正文字号掉到不可读。治一个对话框、坏整个界面。
- **`evaluateJavascript` 注入 CSS 修补标签列** —— 立刻能好，但依赖 DSH 当前的 DOM 结构，DSH 改版后选择器失效会静默回归，且没人会记得这里有补丁。

修在 DSH 网页端才是根治，且对所有客户端（手机浏览器、桌面、此 APK）同时生效。
