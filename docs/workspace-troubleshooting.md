# 添加工作区失败 —— 排查记录

**现象**（第三台手机）：能打开目录选择器、能选中目录，但选完「没有效果」，也不报错。
选的是**默认的 `home`**，没有改路径。

## 已排除的假设

在本项目的两台设备（vivo V2548A / Android 16，小米 2210132C / Android 17）上实测：

| 假设 | 结果 |
|---|---|
| `$HOME` 与 `realpath` 不一致 | **排除**。`HOME` = `readlink -f $HOME` = `pwd -P` = `/data/user/0/com.dsh.launcher/files/home`，三者完全相同 |
| SELinux 缺少 MCS 类别 | **排除**。用 root 造出 `app_data_file:s0`（无 `c114,c257,c512,c768` 类别）的文件与目录后，app 仍能读、写、删、建子目录 |

两台设备上的 `workspace.json` 都正常，`home` 工作区已注册。

## 唯一的确定约束

`@deepseek-ai/dsh-workspace` 第 98 行的校验非常严：

```js
cwd = await realpathNormalize(header.cwd);          // realpath 解析
if (!(await stat(cwd)).isDirectory()) throw ...     // 必须存在且是目录
if (cwd !== this.record.path) throw new Error(      // 必须完全相等
  `its cwd resolves to '${cwd}'`);
```

所以「选完没效果」= 这三步中某一步抛错，而**前端没有把错误显示出来**。

## 复现失败时需要的证据

在那台手机的内置终端（侧边栏 `>_`）里跑：

```sh
cat > /sdcard/ws.txt 2>&1 <<'X'
echo "HOME=$HOME"
echo "realpath=$(readlink -f "$HOME")"
cd ~ && echo "pwdP=$(pwd -P)"
ls -la ~/.dsh/storages/ 2>&1
cat ~/.dsh/storages/workspace.json 2>&1 | head -30
df -h ~ | tail -1
X
cat /sdcard/ws.txt
```

把 `/sdcard/ws.txt` 的内容贴出来即可定位。

## 仍未排除的可能

1. 那台机器的 `$HOME` 路径中含符号链接（不同 ROM 对 `/data/user/0` 的处理不同）
2. `~/.dsh/storages/workspace.json` 写不进去（磁盘满 / 标签异常）
3. dsh 启动时的 cwd 不是 `$HOME`
4. 上游前端的错误被静默吞掉 —— 无论根因是什么，这一点都值得单独修

## 重要前提

**同一份 APK 在另外两台设备上工作正常**，所以这大概率是那台机器的环境差异，
而不是本项目的缺陷。在拿到上面那份输出之前，不要改代码。
