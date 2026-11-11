# 架构

> **读我**：本文写 agent-site 的整体结构、各部分职责、跨进程契约和现行的关键决定。界面与楼体怎么画在 [design.md](design.md) 第 4 节；可验证的行为要求只在 [requirements/](requirements/) 里，本文引用编号、不重复写要求。

<a id="summary"></a>

## 框架摘要

工地 App 把终端里正在干活的 pi agent 画成一座工地：Electron 透明置顶小窗 + Canvas 楼体 + Vue 卡片，读真实会话快照。技术栈 TypeScript、Node ≥ 22.19、esbuild、vitest。

- 依赖方向：`src/app` → `src/main` → `src/core` → `src/protocol`；反向依赖一条都不许有，由 `tests/core/structure.test.ts` 守住。`core` 是纯函数，不碰 Electron 和文件系统。
- 两种数据入口：在线 pi 会话经桥接扩展 `site-bridge` 走 WebSocket（协议 v2，HMAC 四帧握手）上报摘要事件并接收控制；其余会话（Claude Code、DSH、没装桥接的 pi）由主进程只读跟随日志。
- 工地识别：主进程按会话 cwd 跑 git 认工地（`--git-common-dir` 归一 worktree），每个工地只读自己的 `specs/`；`settings.json` 里固定工地在发现结果之上叠加，`bridge.json` 只由 App 写。
- 待办楼段：没有意图卡的工地不再直接画矮楼；`src/core/site.ts` 取一级会话的待办（`SessionState.todos`，来自 pi 的 `todo` / `update_plan` / 桥接的 `site_todo`、Claude 的 `TodoWrite`、DSH 的 `todo_write`），一段一会话、一层一待办；矮楼只在既没有意图卡也没有待办会话时画（SITE-7）。
- 快照：`SiteEngine` 把会话、意图卡和 git 合成 `SiteSnapshot`（`at`、`sites`、`active`、`sources`、`diagnostics`），最多每 250 ms 一次经 IPC 推给渲染层；桥接在线态由 `bridge-overlay` 叠加，不写回引擎。
- 渲染：布局是纯函数（`src/app/layout.ts`），Canvas 画楼体和小人，Vue 画卡片、弹框和设置面板；preload 是唯一 IPC 面，`contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开。
- 反向控制：界面操作 → 指令服务（`commands.jsonl` 台账）→ 桥接 → pi，支持暂停 / 继续 / 中断 / 建议；决策提问走 ask 生命周期，桥接和终端先答的算数。
- 桥接硬约束：装在全局，处理函数绝不抛异常、未暂停时零等待、断线 60 秒全部放行；上报异步、批量、有上限，绝不阻塞 agent。
- 只读红线：引擎和桥接不写被监视仓库、`~/.pi`、`~/.claude`、`~/.dsh`；App 只写自己的数据目录 `%APPDATA%\agent-site\`。
- 外部数据只在入口层校验一次（`src/protocol/guards.ts`、`src/main/settings.ts`）；显示到界面或快照里的文字一律先过 `src/core/redact.ts`。

## 依赖方向

`src/app`（Electron 主进程与渲染层）→ `src/main`（引擎、读取器、桥接服务）→ `src/core`（纯函数：会话统一、归属、楼层、楼体、脱敏）→ `src/protocol`（协议与校验守卫）。反向依赖一条都不许有：`core` 不 import `main` / `app`，`protocol` 不 import 上面三层；测试 `tests/core/structure.test.ts` 守住这条。

## 组件

```
终端里的 pi 会话（协调者 / 子 agent）── 桥接扩展 site-bridge ──┐
                                                              ├─ ws://127.0.0.1（口令）──► 工地 App 主进程
Claude Code / DSH / 无桥接 pi 的日志（只读）── 读取器 ──────────┘                               │
specs 意图卡 + git（只读）──────────────────────────────────────────────────────────────────┘
主进程：会话库 → 按工作目录分工地 → 核心计算（纯函数）→ 工地快照（多工地 + 当前工地）──IPC──► 渲染层：Canvas 场景 + Vue 卡片 / 弹框
界面操作 → 指令服务（记台账）→ 桥接 → pi
```

## 桥接扩展 site-bridge

- **形态**：单个 JS 文件（构建产物，自带依赖），由用户放进 pi 个人扩展目录，或写进 pi 个人设置的 `extensions`。
  产物不 import 任何宿主模块：扩展装在全局，宿主哪天不再提供某个模块，所有 pi 会话都起不来（CONTROL-10）。所以 `ask_designer`、`site_todo` 的参数都是手写的 JSON Schema（pi 的工具参数校验本来就收普通 JSON Schema），pi SDK 只在类型位置出现。代价是最低版本抬到 pi 1.5：1.4 只对 TypeBox schema 做参数的宽松转换（`options: "A"` → `["A"]`），手写 schema 在它那里直接校验失败。
  WebSocket 客户端用 `ws` 打进产物，不用 Node 自带的那个：自带的那份没有硬关连接的办法，断不开不回应的对端（断了会怎样见 CONTROL-9）。`ws` 是 CommonJS，两个 ESM 产物（桥接和快照 CLI）都用 esbuild 的 banner 补上 `createRequire` 版的 `require`，否则它内部的 `require("events")` 这类调用在 ESM 里直接抛错。
- **激活**：
  0. 装扩展之前先看 `AGENT_SITE_BRIDGE`：等于 `off` 就返回一个什么都不做的扩展，控制、事件订阅、`ask_designer` 和 `site_todo` 都不装（见 requirements/control.md CONTROL-8）。产品运行时和测试用这个开关避开桥接。
  1. 会话启动时读取 `bridge.json`（默认 `%APPDATA%\agent-site\bridge.json`，可用环境变量 `AGENT_SITE_HOME` 改目录），取得端口、口令、协议版本和工地路径列表（App 发现到的工地，见「App 主进程」）。
  2. 判断会话工作目录是否落在其中一个工地里（规则同 [design.md](design.md) 4.4）。不属于 → 本会话内什么都不做，但仍按第 3 条继续重读：App 后来才发现这个工地时，不重启会话也能连上；反过来，已连上的会话在重读时发现被移出范围就断开，回到出范围轮询。
  3. 文件不存在、连不上或不在范围内 → 每 10 秒静默重试一次，不影响 agent。
     控制模块的处理函数（`tool_call`、`agent_start`、`agent_settled`）不在扩展安装时挂，而是等第 2 步判成"在范围内"才由 `Control.activate` 装、离开范围或会话结束时由 `Control.deactivate` 摘（订阅时机见 CONTROL-11）。
  4. 连上后按协议 v2 握手（见下节）；准入和断开规则见 [requirements/control.md](requirements/control.md) CONTROL-2。
  5. 被监视的一级会话激活时注册 `site_todo`（CONTROL-12）；二级及以下不注册，出范围或新会话开始时收起。
  6. 激活后给子进程设置环境变量 `AGENT_SITE_PARENT_SESSION`、`AGENT_SITE_LEVEL`。
- **上报**：订阅 pi 的事件（agent / turn / message / 工具执行 / 模型切换 / 压缩），转成摘要事件发给 App（格式见本文「桥接协议 v2」）。摘要会截断：文本字段 ≤ 200 字，命令 ≤ 120 字，只带路径、不带文件内容。
- **控制的实现**：
  - 暂停：`tool_call` 处理函数在暂停时等待一个 Promise，它在继续、建议、中断或断线放行时兑现；未暂停时立即返回。
  - 暂停中给建议：等待中收到建议 → 返回 `{ block: true, reason: "设计师暂停了这一步，并建议：…" }`。
  - 插话 / 做完再说：`pi.sendUserMessage(text, { deliverAs })`；空闲时不带 `deliverAs`。
  - 立即中断：`ctx.abort()`。
  - 待办：一级会话用 `pi.registerTool` 注册 `site_todo`，参数是完整待办列表（0–50 条，三种状态），调用整体替换；工具结果的 `details.todos` 进会话日志，App 从日志读，不走桥接协议（CONTROL-12）。
  - 决策：用 `pi.registerTool` 注册 `ask_designer`，并在 `before_agent_start` 的系统提示里加一句用法（需要用户拍板的事项，调用它并给出具体选项）。调用时：App 在线 → 发 `ask`、等 `answer`；终端会话同时用 `ctx.ui.select` / `ctx.ui.input` 在终端弹出，先答的算数，并用 `signal` 取消另一边；App 不在线 → 终端会话只在终端问，非交互会话立即返回"设计师离线，请在对话里提问"。
- **硬性要求**（桥接装在全局，所有 pi 会话都会加载）：
  1. 所有处理函数都在内部接住异常，绝不抛出（pi 在 `tool_call` 处理函数抛错时会拦下工具调用）。
  2. 未暂停时，`tool_call` 处理函数零等待返回。
  3. 与 App 断线 60 秒后自动放行所有暂停；未答的决策按"App 不在线"回退；放行和回退在重连后补报给 App。
  4. 上报是异步、批量、有上限的：App 处理不过来时丢弃最旧的摘要，绝不阻塞 agent。
  5. 不写任何文件；除了 127.0.0.1 上 App 的端口，不联网。
  6. 只接受发给本会话的指令，准入见 CONTROL-2。

## 桥接协议 v2

- 传输：`ws://127.0.0.1:<port>/bridge`，每帧一条 JSON。
- `bridge.json` 的字段：`{ "protocol": 2, "port": 51234, "token": "<64 位十六进制>", "repos": ["<工地路径>"], "pid": 4321 }`。谁写谁删、口令怎么生成和怎么用见 [requirements/control.md](requirements/control.md) CONTROL-1。
- 握手四帧，两端都要证明自己知道口令：
  1. 桥接 → App：`hello`，带一个 32 字节随机数（base64url），不带口令、不带会话信息。
  2. App → 桥接：`challenge`，带自己的随机数，和 `HMAC-SHA256(口令, "site:" + 桥接随机数 + "." + App 随机数)`。
  3. 桥接 → App：`auth`，带 `HMAC-SHA256(口令, "bridge:" + 桥接随机数 + "." + App 随机数)`，连同会话信息。
  4. App → 桥接：`welcome`。
- 证明的输入串是 `<方向>:<桥接随机数>.<App 随机数>`，方向是 `site` 或 `bridge`；随机数每次连接重新生成。方向标签让两个方向的证明不能互换，随机数让抓到的证明换一条连接就用不了。
- 版本是 2，不兼容 v1：装在 pi 里的旧桥接读到新文件会直接判为无效、根本不拨号，所以升级 App 时要重装桥接（见 [README](../README.md)）。准入、断开和未认证时的规则见 CONTROL-2。
- 心跳：双方每 10 秒发一次 `ping`；30 秒没收到对方任何消息视为断线。

桥接 → App：

| 消息 | 字段 |
|---|---|
| `hello` | protocol、nonce |
| `auth` | proof、session { id、file、cwd、model、provider、parentId?、level、startedAt、mode（tui / rpc / json / print） } |
| `event` | sessionId、seq、ts、kind、summary、detail?。kind 取值：user_prompt（source = user / bridge）、assistant_text、thinking、tool_start、tool_end（ok、durationMs、exitCode?）、model_change、compaction、turn_end、agent_idle、error（category） |
| `state` | sessionId、paused、holding?（tool、sinceMs）、idle |
| `ask` | sessionId、askId、question、options[]、allowOther、context? |
| `ask_resolved` | askId、by（site / terminal / offline / cancelled） |
| `ack` | cmdId、ok、error? |
| `bye` | sessionId、reason |

App → 桥接：

| 消息 | 字段 |
|---|---|
| `challenge` | nonce、proof |
| `welcome` | protocol |
| `pause` / `resume` / `abort` | cmdId |
| `suggest` | cmdId、text、mode（steer / followUp） |
| `answer` | askId，以及 value 或 `cancelled: true`；`auto: true` 表示 App 自己取消（问题没给人看过，比如三级会话），不是设计师跳过 |
| `ping` / `pong` | — |

`ask_designer` 工具：参数 `question`（必填）、`options`（0–6 个字符串）、`allowOther`（默认 true）、`context`（可选，≤ 200 字）。返回 `{ "answer": "<选项或输入>", "source": "site" | "terminal" }`；离线时返回 `{ "answer": null, "note": "设计师离线，请在对话里提问" }`。

`site_todo` 工具：参数 `todos`（0–50 条，每条 `text` 1–500 字、`status` 为 `pending` / `in_progress` / `completed`），按给定顺序整体替换；空数组清空。返回给模型的文字写条数和完成数（空列表说明已清空），`details.todos` 写进会话日志；App 按 SITE-7 读。

## App 主进程

- **桥接服务**：App 启动时在引擎前拉起，只绑 `127.0.0.1` 的随机端口，是 `bridge.json` 的唯一写入者：快照里的工地集合变了才重写（去重排序后比较，临时文件 + rename），同时复核在线连接，工作目录已不在新集合里的按 out of scope 断开。文件里有 protocol 2、随机 token、repos（= 工地路径，没有工地时为空数组）、pid；实现四帧握手、10 秒心跳、30 秒沉默断线、多会话、证明不对 / 坏协议断开和退出清理。在线态通过 `bridge-overlay` 叠加到快照，不写回 `SiteEngine`；`ask` 由服务保留，`answer` / 取消只写帧，`ask_resolved` 或连接断开才移除。单实例锁（重复启动时把已有窗口带到前面）。
- **读取器**（全部只读）：
  - pi 日志：没装桥接的 pi 会话，以及有桥接会话的历史补齐（App 启动时读会话文件）。
  - Claude Code 日志：读 type 为 user / assistant / system 的记录，内容块 text / thinking / tool_use / tool_result，字段 cwd、sessionId、gitBranch、isSidechain、timestamp。
  - DSH 日志：zstd 解压后按观察到的事件类型解析；认不出的跳过并计数。
  - specs/<feature>/spec.md 意图卡；git 只跑 `rev-parse`（`--git-common-dir`、`--show-toplevel`、`--abbrev-ref`）这类只读查询。
  - 文件发现：监听目录变化，加每 2 秒一次兜底检查；每个文件记住读到的位置，只读新增部分；半行先缓存到整行写完；文件变短就从头重读；启动时每个会话读开头约 64 KB（为了派工抬头）和结尾约 512 KB。
- **会话库**：每个会话保留最近 200 条事件和当前状态；同一会话内按文件顺序 / 桥接序号排序，不按时间戳。
- **核心计算**（`src/core/`，纯 TypeScript，不依赖 Electron 和文件系统）：事件统一、归属、动作与状态判定、楼层推断、楼体计算、脱敏；`site.ts` 负责一个工地的楼段、工人和等你清单，`snapshot.ts` 把多个工地合成一份快照（`at`、`sites`、`active`、`sources`、`diagnostics`），最多每 250 ms 一次。App 启动时用当前 settings 和 pi / Claude / DSH 三个会话根创建 `SiteEngine`，首轮 refresh 后建窗；之后的快照经 `onSnapshot` 推给渲染层。
- **缓存**：会话状态、工地 specs、cwd 的工地键和分支都缓存在引擎里，每轮扫完由 `prune` 清理（规则见 requirements/site.md SITE-6）。会话状态只在文件消失后清掉：重新发现一个还在的文件时只读头尾两段（见「文件发现」），把会话状态丢掉就再也补不回中段。
- **工地分组**：引擎在 `siteKeyOf` 里跑一次 git 认工地（`--git-common-dir` 归一 worktree，子模块和其它 git-dir 用 `--show-toplevel`），按 cwd 缓存，否定结果 5 分钟；会话按工地键分组，每个工地只读自己的 `specs/`，按每份 `spec.md` 的（mtime、大小）指纹失效缓存。`settings.repos` 里的固定工地按同样的键认，并沿用配置里的名字。分工地的行为要求见 [requirements/site.md](requirements/site.md)；当前工地在快照里是 `active`，主进程可以用内存里的 `pinnedSite` 覆盖它（不落盘）。
- **指令服务**：界面操作 → 桥接指令（暂停 / 继续 / 中断 / 建议）→ 等 ack；每条指令追加写入台账 `commands.jsonl`（时间、会话、类型、内容、回执），不自动重试。决策回答走同一服务的 ask 生命周期，不写入指令台账。
- **其他**：窗口（视觉无边框：Windows 上保留隐藏标题栏的窗口框架，透明、置顶、贴右边缘，用 `setIgnoreMouseEvents` 实现穿透）；任务栏入口；托盘；决策提问到达时弹系统通知（窗口没有焦点时，见 [requirements/window.md](requirements/window.md) WINDOW-22）。全局快捷键由主进程注册（`whenReady` 之后）并在退出时注销，键位和动作见 [requirements/window.md](requirements/window.md) WINDOW-23；动作直接复用控制通道（`runControl`）与「当前工地」的口径，不另开一套。
- **窗口与 DPI**：默认目标屏是光标所在显示器，用户可用托盘选屏；监听 `display-added` / `display-removed` / `display-metrics-changed`，按目标屏的 DIP 工作区重新计算窗口范围。`display.workArea`、`screen.getCursorScreenPoint()` 和 `BrowserWindow.getContentBounds()` 都是 DIP：窗口位置、尺寸和命中比较直接用，不再按 `scaleFactor` 除一次（除两次会让窗口落在屏幕中间）；窗口宽度 = 110 × 2/3 个 DIP，高度 = `min(工作区 DIP 高度, 720)`，垂直居中；`showInactive`、`focusable: true`、出现在任务栏，出现后 `setAlwaysOnTop` 和 `moveTop`。显示器或倍率变化时，主进程发新的 view，渲染层重排重画。

## 渲染层

- 主进程在 `src/app/main.ts`，preload 在 `src/app/preload.ts`，Vue 入口在 `src/app/renderer.ts`；楼体布局和绘制在 `src/app/layout.ts` / `draw.ts`，布局是纯函数。
- 场景用 Canvas 2D：原创像素画，基础小人 8×10 px，整数倍放大、最近邻；画布按设备像素建位图（逻辑宽 × 倍率 × `devicePixelRatio`），CSS 宽 = 逻辑宽 × 倍率，绘制倍率 = 倍率 × DPR；动画每秒 8–12 帧；只在快照变化、显示器 / 倍率变化或有动画时重画；收起或隐藏时停止。
- 卡片、弹框、提示用 Vue 3（DOM 文字，保证中文清晰）。
- 预加载脚本只暴露订阅快照、上报命中矩形、发送指令、在资源管理器中显示路径（只接受 App 已知的会话文件和 specs 目录）、读写设置。
- `contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开；CSP 只允许本地资源。
- 窗口的透明边缘和空白区用 `setIgnoreMouseEvents(true, { forward: true })`；渲染层上报楼体 / 气泡 / 灯 / 卡片 / 顶栏 / 齿轮 / 底栏的 CSS 命中矩形，主进程轮询光标并切换是否接收鼠标。光标和窗口内容边界都取 DIP，同一坐标系比较。

## 楼段造型与施工阶段

- 类型：`BuildingStyle = "tower" | "factory" | "storefront"`、`BuildStage = "empty" | "foundation" | "structure" | "done"` 在 `src/core/types.ts`；`Band` 和 `LayoutBand` 带 `style` / `stage`，`SiteView.office` 的每一项、`LayoutCrown`、`LayoutOffice` 也带。`draw.ts` 只读布局，不读配置。
- 配置：`settings.json` 的顶层 `style` 是默认造型，`features[].style` 覆盖；窗内设置面板只改顶层（`src/app/settings-form.ts`），`features[].style` 仍改文件。`src/main/settings.ts` 用 `oneOf` 校验：顶层无效整套回默认并写诊断，`features` 里任一 `style` 无效按现有 `features` 无效路径处理。旧文件没有 `style` 时按 `tower` 读，不迁移文件。
- 解析：`src/core/building.ts` 的 `resolveStyle` 取 feature 自己的造型，没写就跟顶层；顶层缺省是 `tower`（校验层给）。`stageOf` 只按切片 `done / total` 给四段，`total` 为 0 时给 `empty`；篷布段也是 `empty`，矮楼由调用方直接给 `done`，不在阶段函数里猜。office 的 style / stage 在 `src/core/site.ts` 里按同一套算，crown 的穹顶沿用 crown 楼段的取值。
- 绘制：`drawBandTrim` 按 `stage` 画楼段阶段件，`drawStyleFront` 按层号和店铺类型画窗型、门和装饰（塔楼错位窗格与空中花园、厂房院子和管道、临街店四种店铺），`drawCrown` / `drawOffice` 按各自的 `style` / `stage` 画；crown 楼段的楼层跟造型画颜色和窗型，但 `drawBandTrim` 跳过它的屋顶和阶段件。塔吊由 `drawBuilding` 选出自下而上最高的主体阶段楼段，全楼只画一台；crown 和 office 不立塔吊。造型件都在各自矩形内、不越界，段高不足 8 逻辑 px 时只画楼段本身。具体形状见 design 4.2。
- 主题：`src/app/theme.ts` 的 `Palette` 管外壳和材质，`STYLE` 放三种业态的颜色（塔楼青蓝、厂房锈红、临街店青与奶油）；围挡、卷帘门、雨棚、塔吊和钢筋的语义色也在 `Palette`，夜景和白昼共用。
- 依赖方向不变：`types → settings / building → site → layout → draw`；`core` 不引用 `app`。

## 配置与数据目录

App 数据目录 `%APPDATA%\agent-site\`：

| 文件 | 内容 |
|---|---|
| `settings.json` | 可选：额外固定的工地（路径、显示名，不填就全靠发现）、开机自启（见 WINDOW-24）、配色 `night` / `day`（见 WINDOW-26）、窗内设置面板写回同一个文件（见 WINDOW-27）、阈值（空闲 10 分钟、中途断掉 30 分钟、上工地时限 24 小时、断线放行 60 秒）、勿扰 / 演示模式与窗口模式（托盘里切，不落盘）、feature 配置（顺序、材质、placement，默认空）、楼段默认造型 `tower` / `factory` / `storefront`（WINDOW-30，`features[].style` 可覆盖，面板可改顶层）、按会话 ID 的归属钉住。默认值里没有任何项目名 |
| `bridge.json` | 运行时连接信息（见「桥接协议 v2」） |
| `commands.jsonl` | 指令台账 |
| `logs/` | App 自己的诊断日志（滚动） |

## 边界与契约

- `SiteSnapshot`：`{ at, sites: SiteView[], active: string | null, sources, diagnostics }`。`SiteView` = 一个工地的楼段、办公室、工人、等你清单和 `{ key, path, name, kind, mini }`；`sources` 和 `diagnostics` 描述会话来源，留在快照顶层。快照只走 App 内部 IPC 和 `npm run snapshot`，没有对外持久化格式。
- 工地键：`key` 是规范化后的路径（Windows 不分大小写、斜杠统一），用来判等、分组、比较 `bridge.json` 的 `repos`；`path` 是原样路径，用来显示和读 `specs/`。
- `bridge.json` 的唯一写入者是 `BridgeService`：快照里的工地集合变了才重写（去重排序后比较，临时文件 + rename），并复核在线连接。扩展只读它，出范围后按 `retryMs` 重读重判。
- 时间与节流：快照最多每 250 ms 推一次；会话日志每 2 秒兜底扫一遍，文件系统事件只是加速；`git` 只跑只读命令，单次 3 秒超时，超时按"不是仓库"处理。
- 只读红线：引擎和桥接不写被监视仓库、`~/.pi`、`~/.claude`、`~/.dsh`；App 只写自己的数据目录。

## 关键决定（只写现行，各附一句理由）

- 快照里带全部工地，渲染层只挑当前那个：切换工地只改一个字段，不用重走 IPC，托盘和菜单也能在同一份数据上算橙点和勾选。
- 当前工地默认跟"最近有事件"的工地：多工地时最想看的是刚动过的那个；钉住是例外，不是常态。
- 钉住状态放在 App 主进程内存里，不落盘：重启后回到"跟最近活动"最符合直觉，也省掉一份需要迁移的配置。
- 矮楼高度固定（各自算、不参与普通楼层平分）：没有意图卡的仓库不该和真楼体抢高度，否则冒出一个临时目录，整栋楼立刻变薄。
- 删掉 `extraPathRules`，worktree 靠 git common dir 归一：规则表是为了补"仓库外 worktree"的判定，按 cwd 认工地后，common dir 直接给出归属，规则表只会误导。
- 默认配置里 `repos`、`features` 都留空：代码或默认值里出现具体项目名，等于默认只服务一个项目；空配置照样能用是这个功能的验收口径。
- 桥接只读 `bridge.json`、按路径判范围：App 崩溃留下旧文件时，扩展最多连一次失败的端口，不会有写冲突或半写状态。
- 每个新 cwd 要跑一次 git：结果按 cwd 缓存，认可结果按 SITE-6 的闲置时间淘汰、否定结果 5 分钟重问；超时按非仓库处理，下一轮再问。
- 造型跟着 feature 走，顶层只给默认值：楼段本来就是按 feature 分的，未配置的段不用逐段重复写。
- 施工阶段按切片完成数算，不按步骤数或状态：卡片里的 `done / total` 是用户能自己核对的数字，阶段跟它不会和卡片对不上；步骤数在切片之间不可比，状态只有两档。
- 造型件画在楼段矩形内部，屋顶不做成楼顶穹顶：上下楼段紧贴、段间没有留白，越界的屋顶会压住上一段；每段内部做屋顶反而让“整段一套”读得出来。
- 穹顶和办公室也跟业态与阶段走，crown 楼段的楼层也跟造型走、但不画屋顶和阶段件：穹顶在楼顶上方、办公室在地面左侧，各占一块独立矩形，造型件落在自己的矩形里；crown 楼段若再叠一层屋顶，会在穹顶下面出现第二层顶。
