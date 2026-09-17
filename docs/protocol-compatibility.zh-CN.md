[English](protocol-compatibility.md) | 简体中文

# 协议兼容性

copilot-proxy 将面向客户端的协议与 Copilot 上游协议视为两份独立契约。只支持原生协议路由：客户端请求与所选 Copilot 端点必须使用同一种 API。

## 路由模式

| 模式 | 含义 |
| --- | --- |
| `direct` | 客户端和 Copilot 使用同一协议类型；代理只做有界兼容性清理后转发 |
| `unsupported` | 不存在原生路由，因此在本地拒绝请求 |

Messages、Responses、Chat Completions 和 Embeddings 都只支持直连。请求不会通过其他协议或模型重试。Responses WebSocket 保持为独立的原生传输方式。

### 从跨协议路由迁移

**不兼容变更：**已移除 Messages 到 Responses、Responses 到 Messages 两条翻译路径。原先依赖这些路径的请求现在会返回符合客户端协议的 `400 invalid_request_error`，且不会访问 Copilot。请把客户端配置为所选模型支持的原生 API，或选择支持客户端 API 的模型。提供模型列表不会让仅支持一种协议的客户端自动具备其他协议能力。

路由按端点能力判断，不按模型品牌限制。一个模型如果声明多个原生 API，仍可通过这些 API 分别接入。

## 动态模型目录

每个账号在启动时拉取自己的 Copilot 模型目录并缓存在内存中。HTTP 路由、模型选择、setup 和能力展示使用该账号动态取得的模型 ID 与 `supported_endpoints`，不使用内置模型表，也不按模型家族前缀推断能力。已知客户端别名的格式归一化与模型是否可用是两回事。

首次拉取失败或目录为空时，该账号不可用。没有缓存目录的模型相关请求返回 `503 model_catalog_unavailable`；模型不在目录内或未声明对应 HTTP 端点时，在本地拒绝。缺少端点元数据表示代理无法提供该路由，不代表已经证明上游会拒绝所有请求。Embeddings 根据动态返回的 `capabilities.type=embeddings` 判断。

定期刷新会整体替换目录，包括移除已消失的模型。刷新失败保留最后一份有效快照并标记过期；刷新成功但目录为空则移除全部模型。普通请求不会重新拉取目录。

代理补充的默认输出额度只取动态目录，客户端显式额度保持不变。已有 GPT-5.4 Chat Completions token 字段归一化等小范围原生格式适配，不用于决定模型或端点是否可用。

## 成熟度标签

| 标签 | 产品含义 |
| --- | --- |
| `stable` | 当前模型目录为非预览模型提供直连 HTTP 路由 |
| `experimental` | 预览模型经目录明确声明的直连路由或原生 Responses WebSocket 路由可能快速变化 |
| `unsupported` | 不存在原生路由 |

这些标签只表示路由是否可用，不保证某模型支持所有字段、工具、停止条件或输出语义。

预览状态会把模型目录明确声明的直连 HTTP 路由从 `stable` 调整为 `experimental`；原生 Responses WebSocket 路由始终为 `experimental`。

## HTTP 与 SSE 上的 Responses

`POST /v1/responses` 独立于 WebSocket 提供，且必须使用原生 Responses 后端。只支持 Messages 的模型不能通过此端点调用。请求和事件保持 Responses 协议，只应用现有的 Copilot 兼容处理。

## WebSocket 上的 Responses

通过 Upgrade 请求访问 `GET /v1/responses` 时，会建立一对一的原生 Copilot WebSocket 桥接。当前模型条目必须明确声明 `ws:/responses`；普通 HTTP Responses 元数据、Chat Completions 和 Realtime 都不能证明该路由可用。

连接接受 `response.create` 文本事件，同一时间只处理一个响应，并按先进先出顺序处理排队回合。连接和输入内存均有上限。`stream` 是隐式行为：`true` 或 `null` 可作为传输兼容的空操作移除，`false` 或格式错误的值会被拒绝。后台模式和 `generate: false` 预热会被拒绝，因为转发它们无法保留客户端契约。

每条连接最长保持 60 分钟。单个文本帧上限为 16 MiB；每条连接最多排队 8 个回合或 32 MiB，所有连接中排队帧与建连阶段帧的总上限为 64 MiB。使用 `store: false` 时，重连后不能假定连接内的 `previous_response_id` 状态仍然存在；新会话链必须发送所需的完整上下文。

HTTP/SSE 与 WebSocket 是不同传输方式，但必须保持相同功能语义。代理内部绝不会把 WebSocket 失败静默转换为 HTTP 成功。

Codex 目前在模型提供商级别选择 Responses 传输，而不是按模型选择。因此，带 `client_version` 的模型选择目录只把当前实时目录中同时声明 `/responses` 与 `ws:/responses` 的模型暴露为可选项；不兼容的内置条目会被显式隐藏，防止 Codex 合并时重新放回选择器。生成的 profile 使用非秘密命令式认证，因为当前 Codex 版本只会通过该认证路径刷新自定义提供商目录；手写的 `env_key` 提供商会保留内置目录，不能依赖此过滤。传输方式单一的模型仍可通过 `copilot-proxy models --client codex` 查看，但不会作为可自由切换的选择项提供。这样可避免为一种传输配置的提供商把需要另一种传输的模型路由错误。

代理返回的 Codex 目录还会对已暴露模型设置 `use_responses_lite=false`。生成的提供商实际提供完整 Responses 契约；如果保留第一方内置的 Lite 元数据，即使实时 Copilot 模型支持，Codex 也会省略 `web_search` 等 hosted Responses 工具。

## Anthropic Messages

`POST /v1/messages` 必须使用原生 Messages 后端。只支持 Responses 的模型不能通过此端点调用。请求和事件保持 Messages 协议，只应用现有的 Copilot 兼容处理。

原生工具探针区分 `code_execution`、`web_search` 等服务端托管工具与 `bash`、文本编辑器、memory 等客户端执行工具：前者必须验证可观察的服务端结果，后者必须验证名称正确且输入可执行、符合请求操作的 `tool_use`。Anthropic 平台控制面 API 不属于逐模型能力矩阵。

Anthropic 专属行为以原生 Messages 为准。代理不会为了获得表面上的 `200` 响应而通过 Chat Completions 路由 Messages。

## 能力声明所需的证据

兼容性判断区分四类证据：

1. 用于判断路由可用性的当前 Copilot 模型目录元数据；
2. 用于客户端资格判断的本机客户端元数据，不能作为上游模型或端点回退；
3. 针对指定账号、模型、端点和请求结构，并验证可观察语义的 Copilot 实时探针；
4. 验证客户端行为的真实 Codex 或 Claude Code 冒烟测试。

模型目录元数据和 HTTP 成功本身不能证明语义支持。修改协议行为、路由、工具、结构化输出、传输或客户端集成后，应重新运行相关实时探针和真实客户端门禁。完整探针矩阵、环境要求、语义校验器与结果判读规则见[Copilot 能力验证](copilot-capability-validation.md)。

部署支持见[产品支持](product-support.zh-CN.md)，模型与运行状态检查见[运维](operations.zh-CN.md)。
