# 控制（CONTROL）

代号：CONTROL

> **读我**：本文件列 App 对在线 pi 会话的现行控制行为，以及桥接在受监视会话里提供的工具；桥接协议和实现见 [architecture.md](../architecture.md)。

## 连接与准入

- CONTROL-1：App 运行时才在数据目录写 `bridge.json`（protocol 2、随机端口、随机口令、发现到的工地路径、pid），工地集合变了才重写（没有工地时写空数组），WebSocket 只绑 `127.0.0.1` 的 `/bridge`；App 退出时删除自己的文件，不删口令不同的文件。口令每次启动重新生成，只用来做挑战应答，任何一帧里都不出现。
- CONTROL-2：握手是双向挑战应答：`hello`（随机数）→ `challenge`（随机数 + 工地的证明）→ `auth`（桥接的证明 + 会话信息）→ `welcome`；证明是 HMAC-SHA256，输入串带方向标签，随机数每次连接重生成。任一侧证明不对、帧不合法、版本不是 2 或握手超时都立即断开，不降级；没通过握手就不发会话信息、不发事件、不收指令。通过后维持心跳，支持多个会话同时在线；同一会话重连时关掉旧连接。三级会话可以连接上报状态，但只读。桥接拨号前还要求 `bridge.json` 里的 pid 是活进程。
- CONTROL-3：桥接在线的 pi 一级 / 二级会话不再只读：小人卡和灯显示在线，并带暂停 / 挂起状态；离线、三级及以下、Claude Code、DSH 仍只读。准入只看 `auth` 帧里的层级（握手验过之后才有的会话信息），不看日志推断的层级。

## 指令

- CONTROL-4：在线一级 / 二级会话可以暂停、继续、立即中断和给建议；建议分“插话 / 做完再说”。每条指令有 ack，5 秒没有回执或连接断开时显示错误，不自动重试；中断需要二次确认。
- CONTROL-7：控制只对 App 已知的在线会话开放；主进程校验 IPC 来源和会话 key。暂停、继续、中断、建议的正文和回执写入 App 数据目录的 `commands.jsonl`，正文和错误先脱敏。渲染层拿不到口令和端口。

## 决策

- CONTROL-5：在线一级 / 二级会话的 `ask_designer` 进入 App 决策卡，显示问题、背景、选项和自定义输入；App 的回答 / 取消只表示本地受理并写帧，最终以桥接的 `ask_resolved` 为准（终端可能先答）。同一 askId 不重复弹卡；卡片可按普通卡 3 秒或手动关闭，提问仍保留，可从工人卡重开；`ask_resolved` 或会话离线才结束请求并移除入口。三级会话的 `ask` 立即取消（这种自动取消不算设计师跳过：模型当成这一边没有答案，终端仍可回答）。点卡片上的"取消这个提问"是**明确跳过**，不是离线：桥接立即收尾，模型拿到"设计师跳过了这个问题，请按最佳判断继续"的说明，终端那边的对话框同时关掉，App 当场显示已取消，`ask_resolved` 的 `by` 是 `cancelled`。
  - 例：agent 问一个方案取舍，设计师在 App 点取消 → 终端对话框关闭，agent 按自己的判断继续并在回复里说明假设；App 的卡片显示已取消。
  - 证明：`tests/bridge/ask.test.ts` 中的 "设计师在 App 里跳过 …"；`tests/bridge/link.test.ts` 中的 "答案：… cancelled 是明确跳过 …"；`tests/main/bridge-service.test.ts` 中的 "取消和终端先答 …"
- CONTROL-6：App 关闭、崩溃或断线时，在线会话回到只读，桥接断开后不再接受控制，重连后重新握手；未完成指令失败；App 侧未答决策关闭，桥接按 60 秒宽限和终端状态收尾，暂停中的工具调用也会在断线 60 秒后放行。App 不会为了让提问有答案而阻塞 agent。

## 订阅时机

- CONTROL-11：不属于被监视仓库的会话里，桥接不为控制模块订阅任何 pi 事件（`tool_call`、`agent_start`、`agent_settled`），工具调用不经过桥接；属于的会话里这些订阅照旧。
  - 例：在未被监视的目录里跑一个会话、调一次工具，桥接注册的事件处理函数只有 `session_start` 和 `session_shutdown`。
  - 证明：`tests/bridge/bridge.e2e.test.ts` 中的 "不属于被监视仓库 …控制模块的处理函数一个都不挂"；`tests/bridge/control.test.ts` 中的 "没激活时一个处理函数都不挂"

## 依赖

- CONTROL-10：桥接产物没有对宿主模块（typebox、pi SDK 等）的运行时引用；`ask_designer`、`site_todo` 的参数都是普通 JSON Schema，由 pi 在调用工具前校验。桥接支持的最低 pi 版本是 1.5：从这一版起，普通 JSON Schema 也做宽松转换（`options: "A"` → `["A"]`、`allowOther: "0"` → `false`），和原来用 TypeBox 时一致。
  - 例：产物里搜不到 `from "typebox"` 或 `from "@earendil-works/…"`；缺 `question` 的调用被 pi 挡在工具外，不会发出提问；把 `options` 写成字符串照样能问出去，工地上收到的是数组；`site_todo` 的 `status` 不在三选一时同样被挡在工具外。
  - 证明：`tests/bridge/bundle.e2e.test.ts` 中的产物检查；`tests/bridge/bridge.e2e.test.ts` 中的 "ask_designer 的参数是普通 JSON Schema" 与 "模型把 options 写成字符串也能用"

## 工具

- CONTROL-12：被监视仓库里的一级 pi 会话激活桥接时，注册模型工具 `site_todo`，并把用法写进系统提示：计划或进度变化时调用它，传完整待办列表。参数 `todos` 是 0–50 条，每条 `text` 为 1–500 字、`status` 为 `pending` / `in_progress` / `completed`；调用按给定顺序整体替换这个会话的待办，空列表清空。工具结果把同一列表写进 `details.todos`（App 从会话日志读，见 SITE-7），给模型的文字说明条数和完成数（空列表说明已清空）。未被监视的会话、`AGENT_SITE_BRIDGE=off`、二级及以下没有这个工具；参数不合法时 pi 在工具外挡下，桥接不执行、不写结果。
  - 例：在被监视仓库的一级会话里让 pi 列三条待办并调用 `site_todo`，会话日志的 toolResult 里 `details.todos` 是三条，模型收到"记录 3 条待办，完成 0 条"；同一个仓库的二级会话和仓库外的会话的工具列表里没有 `site_todo`。
  - 证明：`tests/bridge/todo.test.ts` 中的 "site_todo …"；`tests/bridge/bridge.e2e.test.ts` 中的 "被监视仓库的会话：激活时注册 ask_designer 和 site_todo …" 与 "CONTROL-12：二级会话没有 site_todo …"；`tests/core/unify-pi.test.ts` 中的 "site_todo …"

## 连接

- CONTROL-9：工地不回应时，桥接断开连接不超过 1 秒（先 `close()`，到点硬关），不拖住 pi 进程退出；正常关闭不受影响。
  - 例：工地停止读写之后断开会话，进程里不再留下那条 TCP 连接，`-p` 模式的 pi 照常退出。
  - 证明：`tests/bridge/link.test.ts` 中的 "工地卡住时 stop …"；`tests/bridge/bundle.e2e.test.ts` 中的产物静态检查

## 开关

- CONTROL-8：桥接扩展在 `AGENT_SITE_BRIDGE=off`（忽略大小写和首尾空白）时整层不装：不读 `bridge.json`、不装控制、不订阅会话事件、不注册 `ask_designer` 或 `site_todo`、不给子进程导出层级变量；只认 `off`，其它写法都当没设。子进程从环境里继承这个开关。
  - 例：在被监视的仓库里带这个开关启动 pi，工地一条帧都收不到（桥接不上线、不能控制、没有 `ask_designer`），模型的工具集里没有 `ask_designer`，也没有 `site_todo`；App 仍可能按会话日志画出这个会话的只读小人，那不是桥接。
  - 证明：`tests/bridge/bridge.e2e.test.ts` 中的 "CONTROL-8 …"；`tests/bridge/off.test.ts` 中的取值判断

## 清理

- App 退出时关闭本地服务并删除自己的 `bridge.json`；指令台账只追加、不改写；App 不写 `~/.pi`、`~/.claude`、`~/.dsh`，只按会话日志的路径规则读取。

## 验证

- 桥接握手（含伪造证明、旧协议、没验过就发 welcome、未认证就发指令）、坏口令、多会话、心跳、重连和退出清理用真实 WebSocket 客户端测；控制帧 / ack / 超时 / 断连用临时 `bridge.json` 和假桥接客户端测。
- 决策保留、回答 / 取消、终端先答、ask_resolved、三级取消和断线清卡用服务单测覆盖。
- 小人卡的控制区、建议草稿隔离、决策卡、演示模式和自动关卡用真实 App + 假桥接客户端人工验收；不读真实会话日志。
