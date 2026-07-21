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

当认证恢复打开单路由或全局熔断器时，受保护的上游路由会在本地返回 `503`、`Retry-After`、错误码 `copilot_upstream_circuit_open` 和 `X-Copilot-Proxy-Recovery-State`。全局熔断器打开期间，`/readyz` 也会带 `Retry-After` 返回 `503`。客户端和网关应遵守该等待时间，不要自行启动重启或重试循环。

## 安全与请求控制

| 设置 | 用途 |
| --- | --- |
| `COPILOT_PROXY_ALLOWED_HOSTS` | 精确的非 loopback Host allowlist |
| `COPILOT_PROXY_CORS_ORIGINS` | 额外允许的精确浏览器 origin |
| `COPILOT_PROXY_MAX_JSON_BODY_BYTES` | 正整数 JSON body 限制；默认 32 MiB |
| `COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1` | 启用翻译路径的文档 URL 抓取；仍会阻止私网、loopback、metadata、保留地址及不安全重定向 |
| `COPILOT_PROXY_EXPOSE_TOKEN=1` | 在 loopback 与同源限制下启用 `/token`，直到移除该变量；原生服务环境可以让它跨重启持续生效 |

带 JSON body 的请求必须使用 `application/json` 或 `application/*+json`。

## CLI 参数真值入口

不要在文档中复制所有参数，请直接查看 CLI help：

```sh
copilot-proxy --help
copilot-proxy <command> --help
```

常用的非交互认证与超时控制包括：

```sh
copilot-proxy auth --github-token <token>
copilot-proxy start --headers-timeout-ms <ms> --body-timeout-ms <ms> --connect-timeout-ms <ms>
```

`--github-token` 会保存 token 后立即退出，避免长时间运行的 launcher 在进程参数中保留它。不要把真实 token 写入共享 shell history 或日志；分享 CLI 输出前，还要脱敏本地路径、用户名、内部 endpoint 和带认证信息的代理 URL。

运行预设、诊断、代理环境和服务生命周期见[运维](operations.zh-CN.md)。
