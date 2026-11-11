# agent-site — agent 入口

> 先读本页，然后按"按任务读什么"只读当前任务需要的文件和小节。不要通读 docs/；除非用户要求，不要翻 Git 历史找规则。

## 1. 项目一句话

agent-site 把终端里正在干活的 pi agent 画成一座"工地"：用户在桌面小窗里看进度、暂停某个 agent、给它建议、回答它抛来的决策。

目前仓库里有：
- pi 一侧的桥接扩展 `site-bridge`；
- 只读的工地快照引擎：按会话的工作目录自动认出工地，每个工地读自己的 `specs/`；
- 桌面 App：Electron 透明置顶窗口 + 楼体 / 气泡 / 卡片 / 收起彩带 + 任务栏 / 托盘，读真实会话快照。

技术栈：TypeScript、Node ≥ 22.19、esbuild、vitest；App 用 Electron + Canvas 2D + Vue 3。

## 2. 按任务读什么

| 任务 | 读 |
|---|---|
| 判断需求属于哪个能力、框架接不接得住 | `devcircuit context --map`，再读 `docs/architecture.md` 开头的框架摘要 |
| 做或续做一个功能 | `devcircuit context --feature <feature>` 的输出 + dev-circuit-ultra 技能 |
| 查某个能力的现行要求 | `devcircuit context --capability <代号>`，要原文用 `--ids <编号>` |
| 界面、楼体、小人、卡片的设计 | `docs/design.md` 第 4 节；界面演示见 README |
| 整体结构、数据流、桥接与协议、主进程、渲染层、配置与数据目录 | `docs/architecture.md` |
| 出错处理、安全与隐私、性能、测试策略 | `docs/design.md` 第 6–9 节 |
| 安装或卸载桥接 | `README.md` |
| 找零散的待做事项和待决问题 | `specs/backlog.md` |
| 不知道该看哪份文档 | `devcircuit context --map`，或 `docs/README.md` |

## 3. 常用命令（提交前检查）

- 安装依赖：`npm install`
- 类型检查：`npm run typecheck`
- 测试：`npm test`
- 构建桥接：`npm run build:bridge`（产物在 `dist/bridge/site-bridge.js`）
- 打印工地快照：`npm run snapshot`。它只读本机的会话日志，输出脱敏后的 JSON。
- 启动工地 App：`npm run start:app`（读本机会话，显示工地小窗）。
- 文档防回流：`python scripts/doc_guard.py`
- 要求编号检查：`python scripts/spec_check.py`（加 `--report` 可查看未被测试引用的要求和演示要求清单）
- 误杀时用白名单：`--ignore <GLOB>`、`--ignore-rule <RULE>`，或在项目根写 `.dcuignore`；两个检查器直接运行、按输出修，规则名用 `--list-rules` 看，不要读源码
- 上下文：`devcircuit context`；账本：`devcircuit ledger add`（只写）、`devcircuit ledger check`（核对）；收尾：`devcircuit close <feature>`
- 新克隆后执行一次：`git config core.hooksPath .githooks`

提交前至少跑 typecheck、`npm test`、doc_guard 和 spec_check。

## 4. 代码地图

- `src/bridge/`：pi 扩展 `site-bridge`，负责事件上报、暂停与建议、提问转发、与 App 的连接。
- `src/protocol/`：桥接协议 v1。外部数据的通用校验守卫统一从 `src/protocol/guards.ts` 引入。
- `src/core/`：快照模型，包括工地（`site.ts`）、会话状态、动作、归属、楼体与楼层、脱敏和气泡文字；`snapshot.ts` 把各工地合成一份快照。各会话格式的转换器在 `src/core/unify/`，它们共用的小工具放在 `src/core/unify/common.ts`。
- `src/main/`：引擎主进程，负责发现并跟随会话日志、按会话的工作目录认出工地（`repo.ts`）、读各工地自己的 specs、加载设置，以及快照命令行；`bridge-service.ts` 是 App 侧本地桥接服务，`command-ledger.ts` 记录控制指令，JSONL 和 zstd 读取器在 `src/main/readers/`。
- `src/app/`：Electron 窗口、preload、Vue 渲染入口、Canvas 楼体布局与绘制、菜单与工地钉住（`menu.ts`、`sites.ts`）；`bridge-overlay.ts` 把在线桥接状态叠加到快照。窗口几何和布局是纯函数，测试在 `tests/app/`。
- `tests/`：按 bridge、core、main、protocol 分目录；`tests/fixtures/` 是测试夹具，`tests/harness/` 是测试工具。

## 5. 红线

- 测试不读真实的会话日志和真实仓库，不联网。
- 不读写 `~/.pi/agent/`；pi 安装包自带的文档和 dist 除外。
- 被监视的仓库只读，不做任何改动。
- pi 只加载复制到仓库外的桥接副本，不要让 pi 直接加载 `dist/` 里的构建产物：每次构建和测试都会改写它，扩展加载失败时 pi 会拒绝启动。
- 桥接由用户本人安装；不擅自改用户的全局 pi 配置。
- 显示到界面或快照里的文字，一律先经 `src/core/redact.ts` 脱敏。唯一例外是设置面板里编辑用户自己 `settings.json` 的输入框：那是文件原文，脱敏后就没法编辑。
- 环境：Windows 11；识别放在仓库外的 worktree 需要 git ≥ 2.31。
- 主干：`main`（`devcircuit` 默认拿它当对比的基线）。
- 分支：每个功能在 `feat/<feature>` 上做，bug 在 `fix/<名>` 上修；主干只放验收过的内容，功能分支做完合并后即删。

## 6. 工程准则

1. 不为猜测出来的竞态或安全边界增加复杂度。只有能说清"具体怎么出错、概率多大、要写多少代码"的才做，而且要先报给用户、得到同意；不悄悄扩大改动范围。
2. 外部数据只在入口层校验：用户输入、外部 API、网络响应在边界处校验一次，并转成确定的类型；往里只传确定类型的值，内部不重复做防御性检查。
3. 不提前抽只用一次的函数。只有会复用、封装了确实复杂的逻辑，或者代表一个能起清楚名字的概念时，才抽出来。
4. 主函数只写正常流程，校验和细节放到它下面的小函数里。
5. 自动生成的文件不手改；改源头，然后重新生成。
6. 测试要测真实实现：不把业务逻辑抄一份进测试，尽量少用 mock（优先用真实实现，或在系统边界注入）。
7. 按仓库现有的做法走，不引入仓库里没在用的工具或流程。

## 7. 开发流程与文档规则

- 功能开发按 dev-circuit-ultra 技能进行，规则以技能为准。设计是唯一现行源：设计变更原地覆盖或删除，不保留旧版本和被否方案；本项目不使用 OpenSpec，也不生成 superpowers 的设计或计划文件。
- 文档只写现在：不写决策编号、日期、批准记录、模型和通道、哈希，也不写旧版本、被替代内容或备选方案。为什么这么做、哪些方案没选，由 human 在项目外的私有账本记录。
- 可验证的行为要求只写在 `docs/requirements/` 下的能力规格里；其他文档引用编号，不重复写要求。
- 不新建 decisions、maintenance、history、handoff、ledger 一类的文件或目录，doc_guard 会拦截。
- 账本在项目外，只用 `devcircuit ledger add` 写、`devcircuit ledger check` 核对，不读；需要历史或被否方案时停下来问 human，由 human 用 dev-circuit-ledger 取最小 brief。
- 代码注释里形如 E17、P13 的标记，没有对应的文档，不需要去查；以代码、测试和 docs 为准。
- 审核模型：每个功能验收前派独立上下文的子 agent 审一次，审核模型用当前模型（需要换模型时在派发命令里指定）。
- 做功能时不改本节，也不改 dev-circuit-ultra。觉得流程不顺，在回复里告诉用户。
