[English](protocol-compatibility.md) | 简体中文

# 协议兼容性

copilot-proxy 将面向客户端的协议与 Copilot 上游协议视为两份独立契约。只有当前模型具备直连后端，或请求可以在不制造误导性成功的前提下完成翻译时，才会启用对应路由。

## 路由模式

| 模式 | 含义 |
| --- | --- |
| `direct` | 客户端和 Copilot 使用同一协议类型；代理只做有界兼容性清理后转发 |
| `translated` | 代理在 OpenAI Responses 与 Anthropic Messages 之间转换，并逐请求检查语义保真度 |
| `unsupported` | 不存在语义保真的路由，因此在本地拒绝请求 |

Chat Completions 只支持直连，绝不作为 Responses 或 Messages 的回退。Embeddings 也是直连路由。Responses WebSocket 是传输层专用路径，不参与翻译。

## 成熟度标签

| 标签 | 产品含义 |
| --- | --- |
| `stable` | 当前模型目录为非预览模型提供直连 HTTP 路由 |
| `conditional` | 有界翻译（包括预览模型的翻译）或内置路由回退需要按请求和模型验证 |
| `experimental` | 预览模型经目录明确声明的直连路由或原生 Responses WebSocket 路由可能快速变化 |
| `unsupported` | 不存在直连或语义保真的翻译路由 |

这些标签只表示路由是否可用，不保证某模型支持所有字段、工具、停止条件或输出语义。

预览状态会把模型目录明确声明的直连 HTTP 路由从 `stable` 调整为 `experimental`，但不会把有界翻译从 `conditional` 改为其他标签；原生 Responses WebSocket 路由始终为 `experimental`。

## HTTP 与 SSE 上的 Responses

`POST /v1/responses` 独立于 WebSocket 提供。模型存在直连 Responses 端点时使用该端点；Messages 后端模型可使用有界的 Responses 到 Messages 翻译路径。

翻译后的 Responses 请求是无状态的，必须显式设置 `store: false`。`previous_response_id`、已存储 prompt 或 conversation object 等服务端 Responses 状态无法模拟。初始 instructions 可以转换为 Anthropic system prompt；如果无法保留原位置，则不会调整 instructions 的顺序。

翻译路径会拒绝无法忠实映射到 Messages 的托管 Responses 工具、文件输入、后台执行及其他字段。只有可保留可观察语义时，才会映射函数工具和受支持的结构化输出形式。

## WebSocket 上的 Responses

通过 Upgrade 请求访问 `GET /v1/responses` 时，会建立一对一的原生 Copilot WebSocket 桥接。当前模型条目必须明确声明 `ws:/responses`；普通 HTTP Responses 元数据、静态模型默认值、Claude 翻译、Chat Completions 和 Realtime 都不能证明该路由可用。

连接接受 `response.create` 文本事件，同一时间只处理一个响应，并按先进先出顺序处理排队回合。连接和输入内存均有上限。`stream` 是隐式行为：`true` 或 `null` 可作为传输兼容的空操作移除，`false` 或格式错误的值会被拒绝。后台模式和 `generate: false` 预热会被拒绝，因为转发它们无法保留客户端契约。

每条连接最长保持 60 分钟。单个文本帧上限为 16 MiB；每条连接最多排队 8 个回合或 32 MiB，所有连接中排队帧与建连阶段帧的总上限为 64 MiB。使用 `store: false` 时，重连后不能假定连接内的 `previous_response_id` 状态仍然存在；新会话链必须发送所需的完整上下文。

HTTP/SSE 与 WebSocket 是不同传输方式，但必须保持相同功能语义。代理内部绝不会把 WebSocket 失败静默转换为 HTTP 成功。

Codex 目前在模型提供商级别选择 Responses 传输，而不是按模型选择。因此，带 `client_version` 的模型选择目录只把当前实时目录中同时声明 `/responses` 与 `ws:/responses` 的模型暴露为可选项；不兼容的内置条目会被显式隐藏，防止 Codex 合并时重新放回选择器。生成的 profile 使用非秘密命令式认证，因为当前 Codex 版本只会通过该认证路径刷新自定义提供商目录；手写的 `env_key` 提供商会保留内置目录，不能依赖此过滤。传输方式单一的模型仍可通过 `copilot-proxy models --client codex` 查看，但不会作为可自由切换的选择项提供。这样可避免为一种传输配置的提供商把需要另一种传输的模型路由错误。

## Anthropic Messages

所选模型声明 Messages 端点时，`POST /v1/messages` 使用原生 Messages。否则，Responses 后端模型可使用有界的 Messages 到 Responses 翻译路径。

翻译路径会拒绝 Responses 无法表示的 Anthropic 服务端工具和会话状态控制，也会拒绝语义会丢失的请求控制，例如不受支持的停止、采样、推理、任务预算、工具选择或 MCP 设置。只有所选后端能够保留契约时，才会翻译自定义函数工具和输出格式。

Anthropic 专属行为以原生 Messages 为准。代理不会为了获得表面上的 `200` 响应而通过 Chat Completions 路由 Messages。

## 能力声明所需的证据

兼容性判断区分四类证据：

1. 用于判断路由可用性的当前 Copilot 模型目录元数据；
2. 代理内置的分类策略；
3. 针对指定账号、模型、端点和请求结构，并验证可观察语义的 Copilot 实时探针；
4. 验证客户端行为的真实 Codex 或 Claude Code 冒烟测试。

模型目录元数据和 HTTP 成功本身不能证明语义支持。修改协议行为、路由、工具、结构化输出、传输或客户端集成后，应重新运行相关实时探针和真实客户端门禁。完整探针矩阵、环境要求、语义校验器与结果判读规则见[Copilot 能力验证](copilot-capability-validation.md)。

部署支持见[产品支持](product-support.zh-CN.md)，模型与运行状态检查见[运维](operations.zh-CN.md)。
