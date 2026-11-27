# 对话跑在 taugraph 上

> 2026-11-26 定稿。实现以代码和测试为准。涉及两个仓库：taugraph 发 0.4.1，moqi 发 0.8.0。

## 1. 起因

- moqi 只在托管事务（`src/core/watch.ts`）里用 taugraph。对话循环是 `src/core/agent.ts` 里手写的，每轮对话只在事件日志里留下用户和 moqi 的两句话，没有 trace，没法回放。
- moqi 有自己的模型契约 `ChatModel` 和一份自己的 OpenAI 适配器，和 taugraph 的 `LLMModel`、`taugraph/openai` 重复。图片能力检测靠匹配错误文字判断 400。
- 目标是"moqi 的真实 trace 能当回归测试用"。这一轮先让每轮对话和每次托管事务都留下 trace；用 trace 做回归回放是下一轮。

和用户确认过的选择：

- 这一轮只做"对话跑在 taugraph 上"，回归回放下一轮再做。
- moqi 全部改用 taugraph 的 `LLMModel`，删掉自己的 `ChatModel` 和适配器。
- 每个 moqi 工具包成 taugraph 工具，`run` 里调 `moqi.callTool`，确认仍是进程内等待。
- 工具轮数用完时，最后一次模型调用不带工具，由 taugraph/agent 的新选项 `lastRound: "answer"` 实现。
- trace 存在家目录的 `runs/` 下，记下 runId，保留 30 天。

## 2. 模型层（moqi）

### 2.1 契约

- 删除 `src/core/model.ts` 里的 `ChatModel`、`ChatRequest`、`ChatReply`、`ChatMessage`、`ToolCall`、`ToolSpec`、`ImagePart` 和现在的适配器实现。改用 `taugraph/nodes` 的 `LLMModel`、`LLMRequest`、`ChatMessage`。
- `MoqiOptions.model` 的类型改为 `LLMModel`。
- 不变的：`media.load(id)` 仍返回 `{ type, data }`（`type` 是 MIME 类型），到模型边界再转换；`toolSpec` 不变，在对话循环里转成 taugraph 的工具格式。

### 2.2 `openAICompatible`

- 名字和选项不变：`baseURL`、`model`、`apiKey`、`fetch`、`noThink`、`effort`。配置文件和控制台的设置表单不用改。
- 返回 `LLMModel`，内部用 `taugraph/openai` 的 `openAICompatible`，外面套一层薄包装：
  - `noThink`：请求是 `reasoning: "off"` 时，在最后一条用户消息的文字末尾加 ` /no_think`。内容是片段数组时，加在最后一个文字片段上；没有文字片段就补一个。
  - `effort`：通过 `reasoningParams` 实现。`"off"` 时配了 `effort` 发 `{ reasoning_effort: effort }`，没配发 `{}`；其他档位发 `{ reasoning_effort: level }`。不能用 taugraph 的默认（`"off"` 发 `reasoning_effort: "none"`），有的接口不认这个值。
  - 去掉回答文字里的 `<think>…</think>`（现有的 `stripThinking`，继续导出）。
- 模型 id 仍是 `openai-compatible:<model>`。

### 2.3 图片

- 对话历史里的图片写成 `{ type: "image", url: "media:<id>" }`，trace 只记引用。
- `Moqi` 在构造时给传入的模型套一层：调用前用 `taugraph/nodes` 的 `resolveImages` 把 `media:` 引用经 `media.load` 读成 `{ type: "image", data, mimeType }`。读不到时报错 `Image media:<id> is gone`，不在这里补文字。
- 建历史时仍先检查图片在不在，不在的写成"[图片]"，规则和现在一样（最近 12 条消息，最近 3 条带图的保留图片）。

### 2.4 调用点

- 对话、事实抽取、心思、自学（3 处）、控制台的模型测试、图片能力检测：`model.chat({...})` 改为 `model.complete({...}, { signal })`，`json: true` 改为 `responseFormat: "json"`，`maxTokens`、`temperature`、`reasoning: "off"` 不变。
- 图片能力检测（`canSeeImages`）判断"接口拒绝了请求"：错误本身或 `cause` 链上的数字 `status` 是 400、413、415 或 422。不限于 `HTTPError`。

## 3. 对话循环（moqi）

### 3.1 入口

- `chatTurn(moqi, text, signal?, how?)` 和 `Moqi.chat` 的签名、返回值不变。控制台、命令行、MCP、A2A 四个入口不改。

### 3.2 一轮对话就是一次 agent 运行

每轮新建一个 agent：

```ts
createAgent({
  model, // 2.3 里套好图片读取的模型
  tools, // 见 3.3
  system: systemPrompt(moqi),
  maxRounds: 7, // 6 轮工具调用加 1 次作答
  lastRound: "answer", // 第 7 次调用不带工具
  temperature: 0.3,
});
```

- 输入：`{ messages: [...历史, 这次的用户消息] }`。
- 运行：`agent.run(input, { signal, onEvent })`，`onEvent` 见 4.1。
- 结果：`answer = state.final`，为空时用"（我这次没想好怎么回答，换个说法再试试？）"。之后照旧记 assistant 消息事件（带工具带回的图片）、在后台触发事实抽取。
- 不重试：对话的模型调用不配 `retry`，和现在一样。

### 3.3 工具

- 每个 `moqi.visibleTools()` 里的工具包成一个 taugraph 工具：`name`、`description` 照抄，`inputSchema` 取 `toolSpec(t).parameters`，`effect` 取 `t.effect`，不给 `input`（校验仍在 `callTool` 里）。
- `run(args)`：调用 `moqi.callTool(name, args, { byUser: true, tainted, sites, images: shown })`，返回它的文字结果；调用之后，`t.local` 不为 true 时把 `tainted` 置为 true。
- `tainted`、`sites`、`shown` 是这一轮的闭包变量，初始值和现在一样（`fromAgent` 或提示词里有外来记忆时 `tainted` 从 true 开始）。
- 工具不设 `timeoutMs`：确认在 `callTool` 里进程内等待，用户想多久都行。
- 写工具跑在 `act_write` 步骤里，回放不会重复执行。

### 3.4 出错

- 节点失败时 taugraph 抛 `NODE_FAILED`，`chatTurn` 把它的 `cause` 原样重新抛出，调用方看到的错误和现在一样。中止时抛 taugraph 的 `ABORTED`。写计划时逐个核对调用方如何处理错误。

### 3.5 和现在的差别

- 模型给的参数不是合法 JSON、或者调用了不存在的工具时，提示由 taugraph/agent 给出，是英文（`Invalid arguments: ...`、`No tool named "x"`）。其余提示仍是 `callTool` 的中文。
- 一次回复最多执行 32 个工具调用，超出的会告诉模型没执行。
- assistant 消息事件新增 `run` 字段（这轮对话的 runId）。

## 4. trace 存储和托管事务（moqi）

### 4.1 内核

- `MoqiOptions` 新增 `onTrace?: (event: TraceEvent) => void`。每轮对话和每次托管事务运行都把它（包一层之后）作为 `onEvent` 传给 taugraph；不传就不存。
- 包的那一层吞掉 sink 抛出的错误：存 trace 失败不让对话或托管事务失败。moqi 的唯一事实来源是事件日志，trace 只用于排查和回归。写失败的 run 文件停在中途，在 `list()` 里显示为 `interrupted`。
- `watch.ran` 事件新增 `run` 字段。

### 4.2 node 层（家进程）

- `fileStore(join(家目录, "runs"), { durability: "none" })`，一个 run 一个文件，传给 `onTrace`。不做 fsync，理由同上。第一次写失败时往 stderr 打一行，之后不再重复。
- 清理：家进程启动时一次，之后每天一次。`store.list()` 里 `updatedAt` 在 30 天前、状态是 `completed`、`failed` 或 `interrupted` 的 run，调 `store.remove(runId)` 删掉；`running` 和 `paused` 不动。
- trace 比事件日志更敏感：它还记下工具返回的内容（文件、剪贴板、网页）和带记忆的系统提示词。`runs/` 目录建成只有用户自己能读（0700），新建的家目录也是。

### 4.3 托管事务

- `watch.ts` 运行时传入 `onEvent`，`WatchOutcome` 带回 `runId`。
- `check` 仍是 `retry: { maxAttempts: 2 }`，升到 taugraph 0.4 后重试前等 250 到 500 毫秒。`alert` 是写操作步骤，没有重试。

## 5. taugraph 0.4.1

只加功能，现有行为不变。

### 5.1 `lastRound`

- `AgentConfig.lastRound?: "tools" | "answer"`，默认 `"tools"`（现在的行为）。其他值让 `createAgent` 抛 `TypeError`：`createAgent: lastRound must be "tools" or "answer", got <x>`。
- `"answer"`：第 `maxRounds` 次模型调用（调用前 `rounds === maxRounds - 1`）的请求不带 `tools` 和 `toolChoice`。这次回复里如果仍有工具调用，忽略它们：assistant 消息不带 `toolCalls`，`pending` 为空，`final` 是回复文字（可能为空），`stop` 是 `"done"`。
- 这次调用和平常一样是一个 `think` 步骤，有 `llm_call` 事件。

### 5.2 `FileStore.remove`

- `remove(runId: string): boolean`：删除这个 run 的文件，删了返回 true，本来就没有返回 false。runId 不合法时和其他方法一样抛 `Invalid runId "<…>"`。
- 这个 run 正被一个活着的进程写（锁文件有效），或正被这个 store 自己写时，抛错，文字沿用 `Run "<runId>" is being written by process <pid>`。

### 5.3 测试和文档

- `lastRound`：最后一次请求没有 `tools` 和 `toolChoice`；最后一次返回的工具调用被忽略；`"tools"` 时行为不变；非法值报错。
- `remove`：删掉已结束的 run，之后 `load` 返回 undefined、`list` 不再列出；删除不存在的 run 返回 false；拒绝删除别的进程正在写的 run 和自己正在写的 run。
- README（中英文）的 agent 一节和存文件一节补说明；CHANGELOG 加 0.4.1 一节。

## 6. 测试（moqi）

- 现有测试全部照旧通过（包括 safety、sites、console、interop），只把 `test/helpers.ts` 的假模型换成 `complete(request)`，`call(name, args)` 返回解析好的参数对象；检查请求内容的测试改用 `inputSchema` 和新的图片片段。
- 模型包装：`noThink`、`effort`、去 `<think>`；`reasoning: "off"` 且没配 `effort` 时请求里没有 `reasoning_effort`；`media:` 引用按需读出；图片能力检测按 `status` 判断。
- 对话：trace 里有 `llm_call` 和 `tool_call`；写工具在 `act_write` 步骤；assistant 消息带 `run`；第 7 次调用不带工具；出错时抛出原始错误。
- 存储：`onTrace` 抛错时对话照常完成；`watch.ran` 带 `run`；`runs/` 下生成文件；清理只删 30 天前已结束的 run。
- 完成标准：两个仓库的 `pnpm check` 通过；moqi 的命令行和控制台用本地模型（或假模型）跑通一轮带工具的对话，`runs/` 下有对应的 trace。

## 7. 文档（moqi）

- README（中英文）：架构图和说明写明对话循环是 taugraph agent、trace 存在 `runs/`；模型契约一节改为 `LLMModel`。
- `docs/design.md` 第 3 节同步更新。
- CHANGELOG 0.8.0：删除的导出和 `MoqiOptions.model` 换类型标 **Breaking**。

## 8. 发布

1. taugraph 在 `feat/agent-last-round` 上做，审查、合并，发 0.4.1。
2. moqi 在 `feat/taugraph-agent` 上做，开发期间用本地打的 taugraph 包，taugraph 发布后依赖改为 `^0.4.1`，发 0.8.0。
3. taugraph-mcp 和 taugraph-pi 不受影响，这次不发。

## 9. 不做

- 用 trace 做回归回放（下一轮）。
- 把确认改成 taugraph 的暂停和恢复，或在 trace 里单独记录确认的回答。
- agent 自定义状态、进程内人工等待。
- 事实抽取、心思、自学这些旁路调用不进 trace。
- 接入 Hindsight 之类的外部记忆。
