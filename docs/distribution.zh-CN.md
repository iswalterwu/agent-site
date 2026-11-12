# 安装 Agent Site

[English](distribution.md) · [项目介绍](../README.zh-CN.md)

> **读我**：用于安装、配置、卸载或回滚 Windows 桌面组件与可选 DSH 插件。分发行为见 DIST；pi 桥接安装见项目 README。

## 选哪些文件

从项目 GitHub Releases 页面下载同一版本的文件：

| 文件 | 用途 |
| --- | --- |
| `agent-site-<version>-win-x64.zip` | Windows 11 x64 桌面组件，包含 Electron 运行时 |
| `dsh-agent-site-<version>.tgz` | 可选的预构建 DSH 启动插件，不包含桌面运行时 |
| `SHA256SUMS` | 上述两个文件的 SHA-256 校验值 |

便携 App 不需要另装 Node.js、npm 或 Electron。Git 仓库和 worktree 识别使用 Git 2.31+。插件仅声明支持已验证的 DSH `0.2.1-rc.3`、`0.2.2-rc.1`。macOS、Linux、ARM64 和远程桌面启动不在本版支持范围内。

## 检查下载

只从项目 Release 页面下载。在 PowerShell 中执行：

```powershell
Get-FileHash .\agent-site-<version>-win-x64.zip -Algorithm SHA256
Get-FileHash .\dsh-agent-site-<version>.tgz -Algorithm SHA256
```

将两项结果与 `SHA256SUMS` 比对。校验值可以发现文件损坏或版本不一致，但不是发布者签名。本便携版**未签名**，Windows 可能显示未知发布者或 SmartScreen 提示。请核对来源与源码，不要为了运行程序而关闭系统保护。

## 打开桌面窗口

1. 把 **ZIP 完整解压**到一个可写的本机目录。
2. 保持 `AgentSite.exe`、`agent-site.json`、`resources/` 与运行时文件在一起。
3. 运行 `AgentSite.exe`；没有会话时显示空工地。

首次界面跟随系统语言；设置里选择简体中文或 English，保存后立即切换。App 不启动 agent，继续使用平常的终端即可。Claude Code、DSH 为只读监控；pi 控制需要单独安装桥接。

## 添加 DSH 入口

- **官方 DSH Desktop**：在客户端自己的「插件 → 添加插件」中安装本地 `.tgz` 并启用。不要认为命令行的 `web` profile 就是 Desktop 使用的 profile。
- **本机 `dsh web`**：把插件装到实际启动时使用的 profile：

```text
dsh plugin --profile <profile> add <插件.tgz的绝对路径>
```

进入 Agent Site 插件页，填入完整解压目录中的 `AgentSite.exe` 路径，点击**保存**，再点**打开工地**。安装插件本身不会下载或启动桌面组件。

窗口打开在**运行 DSH 的 Windows 电脑**上，不是远程浏览器所在的电脑。入口采用宿主已保存的配置和解析后的 `DSH_HOME`，不会通过插件转发会话正文，也不调用模型。

## 数据根与常见问题

- DSH 会话根：`--dsh-home` 优先于 `DSH_HOME`，再回落到 `~/.dsh`。合法但不存在的根保持为空，不被创建。pi、Claude 沿用各自正常读取根。
- 自定义根命令示例：`AgentSite.exe --dsh-home "<DSH目录的绝对路径>"`。
- 已有窗口使用其他根时，先退出它，再从目标 DSH 打开；App 不静默替换当前根。
- 组件不存在或不兼容：重新选择**完整解压目录**里的 `AgentSite.exe` 和配套 `agent-site.json`，不要选择 `electron.exe` 或单独移动可执行文件。
- 保存失败：草稿会保留。先解决宿主配置或写入问题，再重新保存；打开操作不使用未保存路径。
- 超时或断连：结果尚未确认，不会自动重试；先看桌面是否已打开，再决定是否重发。

App 设置和本地控制记录位于 `%APPDATA%\agent-site`，设置了 `AGENT_SITE_HOME` 则使用该目录。App 不迁移、删除或改写 Harness 会话。开机启动由 App 的自选开关管理，不由安装插件开启。

## 卸载或回滚

1. 用 DSH 插件管理器禁用或卸载；本机 web profile 也可使用 `dsh plugin --profile <profile> remove dsh-agent-site`。
2. 已打开的工地继续独立运行，需要时单独退出。
3. 移走便携目录前，在 Agent Site 设置中关闭**开机启动**并保存。
4. 回滚时，将兼容发行版解压到另一目录，再在插件中选择它的程序；不要混用不同版本文件。

移除插件或便携目录不会删除 App 数据或 Harness 会话。DSH 插件不安装、卸载 pi 桥接；桥接的安装和移除按项目 README 操作。

## 构建与分发

维护者使用 `npm run build:distribution` 生成的是**本地开发制品**，不等同于获准公开的发行包。`npm run check:distribution` 检查归档白名单、标识、许可证、图片、校验文件名和常见私人路径/凭证格式；它不替代独立的源码、隐私和图片核验。

单独取得公开代码同步授权后，在已审核公开 `origin/main` 提交的干净 checkout 中执行：

```text
npm ci
npm run prepare:release
```

准备命令重新构建并检查，只把当前 ZIP、TGZ 和 `SHA256SUMS` 收集到 `dist/release/<version>/`。私人开发库、脏源码、尚未同步到公开 `origin/main` 的提交会被拒绝；命令不拉取、推送、打标签、上传或提交 PR。失败后没有获准的新发行集合：修好提示的源码、构建或检查问题，再重新准备。

Release 上传和商店 PR 分别需要执行授权。只将收集的文件上传到 `v<version>` 标签下。收录源文件是 `packages/dsh-plugin/marketplace.yml`，向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交时命名为 `data/plugins/iswalterwu__agent-site--packages-dsh-plugin.yml`，不改生成的 README 或他人条目；其中 tarball 固定到匹配的 Release 版本。提交前复核目录现行规则、仓库年龄、`dsh-plugin` topic 和下载文件。另一个 1024 Store 需要 npm 的安装路径不在本版范围内。
