# 窄屏 UI 补丁（设置全屏页 + 侧边栏遮罩）

针对 `dsh 0.1.2-rc.1` 的两处前端改动，**只改 CSS 字符串，不动 JS 逻辑**。

## 为什么需要补丁而不是直接改源码

这两个包是 **npm 发布的构建产物**（`lib/client.js` 里是编译后的 JS + 内联 CSS 字符串），
上游没有对应的可读源码可提交。所以改动以 patch 形式保存，升级 dsh 后重新应用即可。

补丁基于以下精确版本：

| 包 | 版本 | 文件 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-layout` | `0.1.2-rc.1` | `lib/client.js` |
| `@deepseek-ai/dsh-client-ui-settings-general` | `0.1.2-rc.1` | `lib/client.js` |

## 两处改动

### 1. `ui-layout` — 窄屏侧边栏改为浮层 + 内容遮罩

原版在窄屏下侧边栏占据网格列，把主内容**挤到右边被截断**（实测 425px CSS 视口下文字被切）。
新增 `@media (max-width:1023px)` 块：

```css
@media (max-width:1023px){
  /* 主内容列保持相对定位，作为遮罩的定位锚点 */
  .centerCol{position:relative}
  /* 侧边栏展开时网格列宽归零，改由绝对定位浮在上层 */
  .frame:not([data-sidebar-collapsed]){
    grid-template-columns:minmax(0,1fr) 0 0!important}
  .frame:not([data-sidebar-collapsed]) .sidebarCol{
    position:absolute;left:0;top:0;bottom:0;z-index:21;
    box-shadow:var(--dsw-elevation-prominent)}
  /* 主内容上盖一层遮罩，表明"侧边栏是覆盖层" */
  .frame:not([data-sidebar-collapsed]) .centerCol:after{
    content:"";position:absolute;inset:0;
    background:var(--dsw-alias-bg-mask-1);z-index:1;pointer-events:none}
  /* 浮层模式下拖拽调宽无意义，隐藏手柄 */
  .frame:not([data-sidebar-collapsed]) .handle[data-side=sidebar]{display:none}
}
```

关键点：遮罩层 `pointer-events:none`，所以**不阻挡点击**，只做视觉提示。

### 2. `ui-settings-general` — 窄屏设置改为全屏独立页

原版是 `width:800px; border-radius:32px` 的居中弹窗，手机上显得局促且两侧留白浪费。
新增 `@media(max-width:700px)` 块：

```css
@media(max-width:700px){
  /* 面板铺满整屏，去掉圆角 */
  .panel{flex-direction:column;width:100vw;max-width:100vw;height:100vh;border-radius:0}
  .content{min-height:0}
  .options{overscroll-behavior:contain}
  /* 左侧竖向导航改为顶部横向滚动标签栏 */
  .nav{flex-direction:row;align-items:center;gap:8px;width:100%;height:auto;
       padding:14px 16px 8px;overflow-x:auto;
       border-bottom:.5px solid var(--dsw-alias-border-l3)}
  .navList{flex-direction:row;gap:6px}
  .navTitle{flex:none;padding:0;white-space:nowrap}
  .navCell{flex:none;white-space:nowrap}
}
```

`overscroll-behavior:contain` 防止全屏页内滚动时把滚动传递给背后的页面。

## 应用方式

补丁路径以 `@deepseek-ai/` 开头，相对于 `node_modules/`：

```sh
cd <安装目录>/node_modules
patch -p1 < narrow-viewport.patch
```

实际安装目录视部署方式而定：

- Termux 全局安装：`$PREFIX/lib/node_modules/dsh-termux/node_modules/`
- APK 内置：`app/src/main/assets/runtime/dsh-termux/node_modules/`

**APK 场景下还要注意**：`aapt2` 默认的 `ignoreAssetsPattern` 会丢弃点开头的文件，
本项目已在 `app/build.gradle` 里覆写，否则插件加载会失败（见主 README）。

## 验证补丁已生效

浏览器打开 dsh web，缩到 700px 以下，两个现象：

1. 侧边栏展开时，主内容上出现一层半透明遮罩
2. 设置面板铺满整个视口，导航在顶部横向排列

## 升级 dsh 后

上游若更新了这两个包，补丁**大概率不再适用**（`lib/client.js` 是压缩产物，行号和内容都会变）。
届时按上面的 CSS 重新定位并替换即可 —— 改动本身只有两条 `@media` 规则，
对照 `narrow-viewport.patch` 里的新增内容手工重打不超过五分钟。
