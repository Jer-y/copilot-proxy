[English](api-reference.md) | 简体中文

# API 与配置参考

OpenAI 兼容 base URL 使用 `http://127.0.0.1:4399/v1`，Anthropic base URL 使用 `http://127.0.0.1:4399`。

## 路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/chat/completions` | `POST` | OpenAI Chat Completions |
| `/v1/models` | `GET` | 精简 OpenAI 模型列表；带 `client_version` 时返回 Codex catalog 形状 |
| `/v1/embeddings` | `POST` | OpenAI embeddings |
| `/v1/responses` | `POST` | HTTP 或 SSE 上的 OpenAI Responses |
| `/v1/responses` | `GET` Upgrade | 仅适用于明确符合条件模型的原生 Responses WebSocket |
| `/v1/responses/input_tokens` | `POST` | 受上游能力约束的 Responses 辅助入口 |
| `/v1/responses/compact` | `POST` | 受上游能力约束的 Responses compaction |
| `/v1/responses/:id` | `GET`、`DELETE` | 受上游能力约束的已存储 response 操作 |
| `/v1/responses/:id/cancel` | `POST` | 受上游能力约束的取消操作 |
| `/v1/responses/:id/input_items` | `GET` | 受上游能力约束的 input items |
| `/v1/messages` | `POST` | Anthropic Messages |
| `/v1/messages/count_tokens` | `POST` | Anthropic token count |
| `/livez`、`/readyz` | `GET` | 存活与就绪状态 |
| `/diagnostics` | `GET` | 运行状态、模型路由与用量摘要 |
| `/usage` | `GET` | 最小 Copilot 配额摘要；不会暴露完整的上游用户 payload |
| `/token` | `GET` | 默认关闭的本地 token 诊断 |

OpenAI 路由也接受对应的不带 `/v1` 前缀路径。Anthropic Messages 仍只位于 `/v1/messages`。

可用性取决于模型和当前上游。对受上游能力约束的路由作支持结论前，请阅读[协议兼容性](protocol-compatibility.zh-CN.md)并运行相应的[能力验证](copilot-capability-validation.md)。

### Claude Code 文档边界

受支持的 Claude setup 只选择具有原生 `/v1/messages` 路由的模型。Claude Code 会把本地文本与 Markdown 文件转换为普通 `text` 或 `tool_result` block。只有客户端发送 base64 `application/pdf` document block 时才原样转发 PDF；Claude Code 也可能把 PDF 页面渲染为 base64 图片。代理不提供 Anthropic Files、Message Batches、Skills 或 Managed Agents 控制面。生成路径不实现通用 Anthropic document 适配：`document.source` 使用 `text`、`content`、`url`、`file` 或非 PDF base64 media type 时，会返回 Anthropic `400 invalid_request_error`。Anthropic 到 Responses 的生成翻译路由同样会拒绝 document block，不会在本地抓取、解析或展开文档。`/v1/messages/count_tokens` 按端点独立处理；由于 Copilot token counting 接受 generation 会拒绝的形状，该端点不会套用 generation 专用的 sanitizer 或 document gate。URL 或 `file_id` 成功返回 token 数只代表请求形状被接受，不代表 URL 已被抓取，也不代表文件存在或可读。

多账号模式下，生成路由接受 `x-copilot-account: <id>`。带模型的请求也可以使用 `<account-id>/<model-id>`。selector 冲突时返回 `409`；所选账号不可用时返回 `503`，不会自动切换。`/usage?account=<id>` 与 `/readyz?account=<id>` 可检查单个账号。

当认证恢复打开单路由或全局熔断器时，受保护的上游路由会在本地返回 `503`、`Retry-After`、错误码 `copilot_upstream_circuit_open` 和 `X-Copilot-Proxy-Recovery-State`。全局熔断器打开期间，`/readyz` 也会带 `Retry-After` 返回 `503`。客户端和网关应遵守该等待时间，不要自行启动重启或重试循环。

## 安全与请求控制

| 设置 | 用途 |
| --- | --- |
| `COPILOT_PROXY_ALLOWED_HOSTS` | 精确的非 loopback Host allowlist |
| `COPILOT_PROXY_CORS_ORIGINS` | 额外允许的精确浏览器 origin |
| `COPILOT_PROXY_MAX_JSON_BODY_BYTES` | 正整数 JSON body 限制；默认 32 MiB |
| `COPILOT_PROXY_EXPOSE_TOKEN=1` | 在 loopback 与同源限制下启用 `/token`，直到移除该变量；原生服务环境可以让它跨重启持续生效 |
| `COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY=1` | 在账号健康数据中加入 GitHub login 与数值 user ID；默认关闭 |
| `COPILOT_PROXY_EXPOSE_ACCOUNT_MODELS=1` | 为非 Codex `/models` 响应增加 `<account>/<model>` 别名 |

带 JSON body 的请求必须使用 `application/json` 或 `application/*+json`。

## CLI 参数真值入口

不要在文档中复制所有参数，请直接查看 CLI help：

```sh
copilot-proxy --help
copilot-proxy <command> --help
```

常用的非交互认证与超时控制包括：

```sh
printf '%s\n' "$TOKEN" | copilot-proxy accounts auth <id> --token-stdin --yes
copilot-proxy start --headers-timeout-ms <ms> --body-timeout-ms <ms> --connect-timeout-ms <ms>
```

`--github-token` 只保留为旧版单账号 bootstrap；存在 `accounts.json` 时会被拒绝。多账号应使用 `--token-stdin`，避免 token 进入 argv。不要把真实 token 写入共享 shell history 或日志；分享 CLI 输出前，还要脱敏本地路径、用户名、内部 endpoint 和带认证信息的代理 URL。

可通过 `accounts concurrency set|clear` 配置可选的账号级限制，通过 `accounts required-route set|remove|list` 配置启动/readiness 能力门槛。这些写操作与[运维](operations.zh-CN.md#多个-copilot-账号)说明的账号事务及回滚边界一致。

运行预设、诊断、代理环境和服务生命周期见[运维](operations.zh-CN.md)。
