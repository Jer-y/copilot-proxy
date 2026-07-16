[English](README.md) | 简体中文

# Copilot API 代理

把 GitHub Copilot 订阅转换为本地 OpenAI / Anthropic 兼容 API，供 Claude Code、Codex、SDK 与自定义工具使用。

> [!WARNING]
> 这是一个通过逆向工程实现的代理，不受 GitHub 官方支持，可能随时失效。过度自动化、快速或批量请求可能触发 GitHub 的滥用检测，并导致 Copilot 权限被临时暂停。请阅读 [GitHub 可接受使用政策](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)与 [GitHub Copilot 条款](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)，并负责任地使用本代理。

> [!NOTE]
> 如果你使用已原生支持 GitHub Copilot Provider 的 [opencode](https://github.com/sst/opencode)，则可能不需要本项目。GitHub 也已在部分产品中提供一方 Claude 能力，详见 [Anthropic Claude](https://docs.github.com/en/copilot/concepts/agents/anthropic-claude)与 [Copilot CLI BYOK 模型](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)。本项目适合确实需要本地 OpenAI / Anthropic 兼容 API（包括原生 Responses WebSocket 模式）并希望由 Copilot 提供后端的客户端。

[快速开始](#快速开始) · [能力](#能力一览) · [API](#api-端点) · [部署](#部署) · [CLI](#cli-与运维) · [客户端](#客户端集成) · [开发](#开发与-live-验证)

## 快速开始

你需要一个具有个人、商业或企业 Copilot 订阅的 GitHub 账号，以及以下任一运行时：

- 使用 npm、npx、pnpm、Yarn、Volta 或全局 CLI 安装时：Node.js >= 22.19.0
- 从源码开发或使用 `bunx --bun` 时：Bun >= 1.3.6

无需安装即可启动：

```sh
npx @jer-y/copilot-proxy@latest start
```

首次运行会在需要时发起 GitHub 认证，然后监听 `http://127.0.0.1:4399`。OpenAI 兼容客户端使用 `http://127.0.0.1:4399/v1` 作为 base URL；Anthropic 兼容客户端使用 `http://127.0.0.1:4399`。上游模型与所支持的 API 可能变化，选模型前请先查询 `GET /v1/models`。

<details>
<summary>其他安装方式</summary>

全局安装：

```sh
# npm
npm i -g @jer-y/copilot-proxy

# pnpm
pnpm add -g @jer-y/copilot-proxy

# Yarn Classic
yarn global add @jer-y/copilot-proxy

# Volta
volta install @jer-y/copilot-proxy

copilot-proxy start
```

其他免安装运行方式：

```sh
pnpm dlx @jer-y/copilot-proxy@latest start
yarn dlx @jer-y/copilot-proxy@latest start
bunx --bun @jer-y/copilot-proxy@latest start
```

`yarn dlx` 需要现代 Yarn。发布包的全局 bin 使用 Node.js shebang，因此只有 Bun 的机器应使用 `bunx --bun`，不要使用 `bun add -g`。

从源码运行：

```sh
bun install --frozen-lockfile
bun run dev       # watch 模式
bun run start     # 生产模式
```

</details>

## 能力一览

| 范围 | 行为 |
| --- | --- |
| OpenAI 兼容 HTTP | Chat Completions、Models、Embeddings 与 Responses 端点，包括 SSE 流式响应 |
| Anthropic 兼容 HTTP | Messages 与 token 计数；上游可用时，Claude 优先走 Copilot 原生 `/v1/messages` |
| Responses WebSocket | Bun 与 Node.js 上的一对一 Copilot 原生桥接；只有 live 模型元数据明确声明 `ws:/responses` 时才启用 |
| 路由与翻译 | 模型支持所请求 API 时直通；仅 Messages 与 Responses 可以互译，Chat Completions 绝不会作为翻译回退 |
| Claude 兼容 | `copilot_cache_control` 提示缓存、adaptive thinking / `output_config.effort`、provider-specific 模型归一化及 Claude Code 配置 |
| 稳健性控制 | 可选限速、身份级有界并发与队列、上游超时覆盖、Anthropic SSE keepalive ping，以及 fail-closed 手动审批 |
| 认证恢复 | 对符合条件的 `401` 或带关联 ID 的纯文本 `403 Forbidden`，执行一次 single-flight 短期 token 刷新与一次受控重放；持续拒绝会打开冷却熔断 |
| 运维 | 用量面板、个人/商业/企业路由、Linux/macOS/Windows 原生系统服务，以及兼容的 `start -d` 旧守护模式 |

支持范围以当前 Copilot 模型元数据为准。普通 Responses 支持不代表 Responses WebSocket 支持；解析器返回成功也不能单独证明功能语义受支持。

## API 端点

OpenAI 兼容路由同时接受表中的 `/v1/...` 路径和对应的无前缀路径。Anthropic Messages 只在 `/v1/messages` 下提供；辅助路由不带 `/v1` 前缀。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/v1/chat/completions` | `POST` | OpenAI 兼容聊天响应 |
| `/v1/models` | `GET` | 当前模型与模型级 API 元数据 |
| `/v1/embeddings` | `POST` | OpenAI 兼容 Embedding 向量 |
| `/v1/responses` | `POST` | [Responses API](https://platform.openai.com/docs/api-reference/responses) HTTP 端点，包括 SSE 流式响应 |
| `/v1/responses` | `GET` + Upgrade | 原生 Responses WebSocket；首轮必须选择明确支持它的模型 |
| `/v1/messages` | `POST` | Anthropic 兼容 Messages 响应 |
| `/v1/messages/count_tokens` | `POST` | Anthropic 兼容 token 计数 |
| `/usage` | `GET` | Copilot 使用量与配额 |
| `/token` | `GET` | 仅用于短时本机诊断；除非设置 `COPILOT_PROXY_EXPOSE_TOKEN=1`，否则关闭 |
| `/livez` | `GET` | 只检查进程存活，不代表上游可用 |
| `/readyz` | `GET` | 被动返回不含秘密的 token、恢复、模型缓存与并发就绪状态；全局恢复熔断未关闭时返回 `503` |

<details>
<summary>Responses WebSocket 契约与边界</summary>

所选模型暴露 Copilot Responses 后端时，HTTP Responses 请求会直接转发；Claude 模型只有在请求可以忠实翻译为 Anthropic Messages 时才可使用 HTTP 路由。WebSocket 轮次只允许原生直连：首个 `response.create` 必须选择明确声明 `ws:/responses` 的 live 模型，随后一条下游连接一对一映射到 Copilot `wss://.../responses`。Claude 翻译、Chat Completions 与 Realtime API 绝不会被描述为 WebSocket 支持。

该传输遵循[官方 Responses WebSocket 契约](https://developers.openai.com/api/docs/guides/websocket-mode)：每条连接只允许一个响应处于 in-flight，后续轮次按 FIFO 串行执行而不 multiplex，连接最长 60 分钟。Streaming 是隐式的；`stream: false` 与非法值会被拒绝，`stream: true` 或 `null` 会作为兼容 no-op 被剥离；`background` 不受支持。使用 `store: false` 时，重连会丢失连接本地的 `previous_response_id` 状态；除非明确存在持久化状态，否则新链必须重新发送所需上下文。

输入内存与上游并发分别设限：每个文本帧 16 MiB，每条连接最多排队 8 个轮次或 32 MiB，排队加 setup 阶段的请求帧还共享 64 MiB 全局预算。溢出会在本地返回 `429`，被拒绝的轮次不会转发到 Copilot。

OpenAI 把 `generate: false` 定义为不生成输出的预热；但在 2026-07-15 的 Copilot 实测中，不带 `input` 时返回 `bad_request`，带 `input` 时反而实际生成输出。在新探针证明语义一致前，代理会在打开上游前以 `400 unsupported_value` 和 `param: "generate"` 在本地拒绝它。

</details>

### Responses 到 Claude 与 Codex 到 Claude 的限制

<details>
<summary>展开兼容性说明</summary>

翻译到 Claude 原生 Messages 的 Responses 请求必须显式设置 `store: false`；代理无法模拟 Responses 默认的服务端持久化，也无法让翻译后的 response ID 可被再次查询。开头的 system/developer input 会成为 Anthropic 顶层 system prompt；会话中途的指令只在 Anthropic 支持的位置保留，需要语义重排的顺序会被拒绝。

使用 Codex CLI 0.144.1 实测时，默认配置包含 Anthropic Messages 无法忠实表达的 hosted/custom Responses 工具。代理会有意返回 HTTP `400`，不会静默丢弃工具。受限实机测试仅在使用下列覆盖项后通过文本与 `exec_command` 工具闭环，因此不代表默认 Codex 到 Claude 兼容：

```sh
-c 'web_search="disabled"' \
-c 'features.multi_agent=false' \
-c 'features.remote_plugin=false'
```

带日期的上游证据和客户端门禁要求见 [Copilot 能力验证](docs/copilot-capability-validation.md)。

</details>

## 部署

### Docker

使用命名卷构建并运行，让认证信息在容器重启后继续存在，又不进入源码或构建上下文：

```sh
docker build -t copilot-proxy .
docker volume create copilot-proxy-data
docker run \
  -p 127.0.0.1:4399:4399 \
  -v copilot-proxy-data:/home/bun/.local/share/copilot-proxy \
  copilot-proxy start --host 0.0.0.0
```

镜像使用多阶段构建、非 root 用户与健康检查，并同时固定基础镜像的版本和 digest。

<details>
<summary>环境文件与 Docker Compose 示例</summary>

把 `GH_TOKEN` 写入仓库外权限为 `0600` 的 env 文件，再在运行时传入：

```sh
docker run \
  -p 127.0.0.1:4399:4399 \
  --env-file "$HOME/.config/copilot-proxy/container.env" \
  copilot-proxy start --host 0.0.0.0
```

Compose 示例：

```yaml
services:
  copilot-proxy:
    build: .
    command: start --host 0.0.0.0
    ports:
      - '127.0.0.1:4399:4399'
    environment:
      GH_TOKEN: ${GH_TOKEN:?请在已忽略的 .env 文件中设置 GH_TOKEN}
      COPILOT_PROXY_ALLOWED_HOSTS: copilot-proxy
    volumes:
      - copilot-proxy-data:/home/bun/.local/share/copilot-proxy
    restart: unless-stopped
volumes:
  copilot-proxy-data:
```

</details>

### New API 网关

[New API](https://github.com/QuantumNous/new-api) 可统一提供用户、API Key、额度、模型权限、日志、限流、计费与负载均衡；copilot-proxy 则继续作为经过 Copilot 认证的私有上游：

```text
客户端 / SDK / Claude Code / Codex
        | New API Key、额度、日志、计费
        v
New API 网关                          公开或团队入口
        | 私有上游渠道
        v
copilot-proxy                         私有
        | GitHub Copilot 认证
        v
GitHub Copilot 上游
```

1. 在只允许 New API 访问的网络中部署并认证 copilot-proxy，例如 `http://copilot-proxy:4399`。
2. 在 New API 中创建 OpenAI 兼容或自定义渠道，base URL 指向 `http://copilot-proxy:4399/v1`。如果表单强制要求上游 Key，可填写占位值；copilot-proxy 会自行向 GitHub 认证。
3. 只向客户端分发 New API base URL 与 New API Key；客户端不需要直接访问 copilot-proxy、`/token` 或持久化 GitHub token。

运维边界：

- 关闭 New API 对上游 `403` 与 `429` 的重试。同一 Copilot 身份下的故障转移仍会命中同一风险桶，并可能放大限制。copilot-proxy 已负责一次受控 token 恢复；恢复熔断打开时会返回 `503`、`Retry-After` 与 `X-Copilot-Proxy-Recovery-State`。
- 除 New API 的用户级限流外，再设置 `--max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000` 之类的身份级最终边界。这些只是本地起点，不是 GitHub 公布的限制。
- 如果 New API 通过 `copilot-proxy` 服务名访问容器，请设置 `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy`；只加入实际使用的精确内网主机名。
- Claude 客户端可以使用 New API 的 Claude 兼容层或已配置的转换路由。若 Codex 需要目录元数据，请确认 New API 原样保留 `/v1/models?client_version=...` query string。

## CLI 与运维

以下命令假设已经全局安装。免安装运行时，请在命令前加 `npx @jer-y/copilot-proxy@latest`，或使用[快速开始](#快速开始)中的等价 runner。

| 命令 | 用途 |
| --- | --- |
| `start` | 前台启动并在需要时认证；`-d` 选择兼容的应用自管旧守护进程 |
| `auth` | 仅认证而不启动；`--github-token` 会安全保存现有 token 后退出 |
| `check-usage` | 无需运行服务即可查看 Copilot 使用量与配额 |
| `debug` | 查看版本、运行时、路径与认证状态；`--json` 输出 JSON |
| `enable` / `disable` | 安装或移除 systemd/launchd/任务计划程序原生自启动服务 |
| `status` | 查看原生服务状态；否则回退显示旧守护进程 PID、端口与启动时间 |
| `logs` | 查看原生服务或旧守护进程日志；`-f` 跟踪，`-n <行数>` 设置数量 |
| `restart` / `stop` | 控制已安装的原生服务，否则回退到旧守护进程 |

常用操作：

| 目标 | 命令 |
| --- | --- |
| 自定义监听与诊断 | `copilot-proxy start --port 8080 --verbose` |
| 商业或企业路由 | `copilot-proxy start --account-type business` / `enterprise` |
| 交互式请求审批 | `copilot-proxy start --manual` |
| 请求最小间隔 | `copilot-proxy start --rate-limit 30 --wait` |
| 限制共享并发 | `copilot-proxy start --max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000` |
| 保存现有 token | `copilot-proxy auth --github-token ghp_YOUR_TOKEN_HERE`，随后不带秘密重新运行 |
| 使用已配置的代理变量 | `copilot-proxy start --proxy-env` |
| 拉长慢启动超时 | `copilot-proxy start --headers-timeout-ms 600000 --body-timeout-ms 600000` |
| 查看用量或诊断 | `copilot-proxy check-usage` / `copilot-proxy debug --json` |

<details>
<summary>完整 <code>start</code> 参数表</summary>

| 参数 | 说明 | 默认值 | 简写 |
| --- | --- | --- | --- |
| `--port` | 监听端口 | `4399` | `-p` |
| `--host` | 绑定的 Host/IP；只有确实需要暴露端口时才使用 `0.0.0.0` | `127.0.0.1` | `-H` |
| `--verbose` | 详细诊断；日志应按敏感信息处理 | `false` | `-v` |
| `--account-type` | `individual`、`business` 或 `enterprise` | `individual` | `-a` |
| `--manual` | 在交互式前台 TTY 中审批每个请求 | `false` | 无 |
| `--rate-limit` | 两次请求之间的最小秒数 | 无 | `-r` |
| `--wait` | 触发限流时等待而不是报错 | `false` | `-w` |
| `--max-concurrency` | Copilot 上游最大并发；省略时不启用 | 无 | 无 |
| `--max-queue` | 等待并发槽位的请求数；`0` 表示不排队 | `50*` | 无 |
| `--queue-timeout-ms` | 队列最长等待；`0` 表示不等待 | `30000*` | 无 |
| `--headers-timeout-ms` | 上游响应头超时；`0` 表示禁用 | `自动*` | 无 |
| `--body-timeout-ms` | 上游响应体超时；`0` 表示禁用 | `自动*` | 无 |
| `--connect-timeout-ms` | 上游建连超时；`0` 表示禁用 | `自动*` | 无 |
| `--github-token` | 安全保存 GitHub token 后退出；随后不带此参数重新运行 | 无 | `-g` |
| `--claude-code` | 生成 Claude Code 启动命令 | `false` | `-c` |
| `--show-token` | 获取或刷新时打印 GitHub 与 Copilot token | `false` | 无 |
| `--proxy-env` | 从环境变量初始化代理处理 | `false` | 无 |
| `--daemon` | 使用兼容的应用自管旧后台守护进程 | `false` | `-d` |

队列的 `50*` 与 `30000*` 默认值只在 `--max-concurrency` 启用限制后生效。在 Node.js 中，`自动*` 对发往 `githubcopilot.com` 的请求使用内置的 `900000ms` 响应头超时、`900000ms` 响应体超时和 `30000ms` 建连超时；其他域名仍使用 Node/undici 默认值，除非显式覆盖。商业与企业账号路由背景见 GitHub 的[订阅网络路由文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)。

`auth` 还接受 `--verbose`、`--show-token`、`--github-token` 与 `--proxy-env`；`debug` 接受 `--json`；`logs` 接受 `--follow`/`-f` 与 `--lines`/`-n`。

</details>

### 原生后台服务

长期服务必须使用稳定的全局安装或源码 checkout：

```sh
npm i -g @jer-y/copilot-proxy
copilot-proxy auth

# 仅 Linux：如果 enable 无法自动配置未登录启动
sudo loginctl enable-linger "$USER"

copilot-proxy enable
copilot-proxy status
copilot-proxy logs -f
```

`enable` 会在 systemd、launchd 或任务计划程序中安装前台 `start`。它会拒绝 `_npx`、`pnpm dlx`、`yarn dlx` 与 `bunx` 缓存路径，避免清理缓存后服务失效。没有旧守护进程配置时，重复运行会保留已安装的原生配置；显式参数会覆盖已保存值。使用 `copilot-proxy enable --clear-concurrency-limit` 可移除持久化并发设置。`stop`、`restart`、`status` 与 `logs` 优先使用原生服务，否则回退到旧守护进程；`copilot-proxy start -d` 仍作为兼容路径保留。

<details>
<summary>本地安全默认值与敏感参数</summary>

- 代理默认监听 `127.0.0.1`，定位是个人本机使用。除非完全信任所有可访问客户端，否则不要暴露到 LAN 或公网。容器内可绑定 `0.0.0.0`，但宿主机只应发布到 loopback，例如 `-p 127.0.0.1:4399:4399`。
- CORS 默认允许 `http://localhost:*`、`http://127.0.0.1:*` 与 `http://[::1]:*` 等本地浏览器来源；托管面板只能访问 `/usage`。使用 `COPILOT_PROXY_CORS_ORIGINS=https://internal.example.com` 添加精确来源。
- Host 校验会单独防止 DNS rebinding。用 `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy,proxy.internal` 添加不带端口的精确名称。JSON 请求体必须使用 `application/json` 或 `application/*+json`。
- JSON 请求体默认限制为 32 MiB；可用正数 `COPILOT_PROXY_MAX_JSON_BODY_BYTES` 覆盖。
- 原生与旧守护服务会把受支持的 `COPILOT_PROXY_*`、代理、`NO_PROXY` 与 TLS CA 变量保存到仅 owner 可读的运行时文件。没有实际代理端点时 `--proxy-env` 会 fail closed；Bun 服务会在运行时启动前恢复该环境。
- 原生 `/v1/messages` 会直通 Anthropic document URL；翻译文档的本地 URL 抓取默认关闭。`COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1` 只应面向可信客户端与 URL；抓取前和重定向后仍会拦截 localhost、私网、云元数据及保留 DNS/IP 目标。
- `/token` 默认关闭，因为 loopback 不是用户级安全边界。短时诊断可设置 `COPILOT_PROXY_EXPOSE_TOKEN=1`，但仍要求 loopback 远端地址与 Host，以及浏览器同源访问；用完立即关闭。
- `--manual` 在没有交互式 TTY 或审批超时时以 `503` fail closed，不适用于服务和无人值守容器。诊断日志应按敏感信息处理；`--show-token` 会打印 bearer token，绝不能用于持久化或共享日志。

</details>

## 客户端集成

### Claude Code

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 交互式配置会选择主要模型和小型快速模型，然后复制包含所需环境变量的启动命令：

```sh
npx @jer-y/copilot-proxy@latest start --claude-code
```

<details>
<summary>手动 <code>.claude/settings.json</code> 示例</summary>

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4399",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-sonnet-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

上游模型可用性会变化。请查询 `GET /v1/models`，选择当前声明支持 Anthropic Messages 的模型；不要使用仅支持 Chat Completions 的模型。更多信息见 [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)与 [IDE 集成](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)。

</details>

### Codex

把自定义 Responses provider 指向 `http://127.0.0.1:4399/v1`，并选择当前暴露 Responses 后端的模型。原生 WebSocket 还要求模型目录声明 `ws:/responses`。Codex 到 Claude 的翻译范围更窄，详见[上面的限制](#responses-到-claude-与-codex-到-claude-的限制)。

### 用量面板

启动时，代理会输出类似以下地址：

```text
https://jer-y.github.io/copilot-proxy?endpoint=http://localhost:4399/usage
```

面板会自动获取使用量，展示配额进度和完整 JSON 响应；也可以修改 `endpoint` query 参数来连接其他兼容服务或保存书签。Windows 上的 `start.bat` 会自动打开面板。

## 开发与 live 验证

```sh
bun install --frozen-lockfile
bun run dev       # watch 模式
bun run start     # 生产模式
```

完整探针矩阵、环境变量、语义校验器与判读规则见 [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md)。上游门控决策必须绑定到带日期的 Copilot 实测证据，不能因为 OpenAI 或 Anthropic 官方支持某项能力就假设 Copilot 同样支持。

基础 opt-in 能力探针：

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=claude-model-under-test \
COPILOT_LIVE_RESPONSES_MODEL=responses-model-under-test \
bun run test:live:copilot
```

每次修改 Responses 行为都要运行成对的真实 Codex 门禁：

```sh
COPILOT_LIVE_CODEX_SMOKE=1 \
CODEX_SMOKE_MODEL=gpt-5.4 \
CODEX_SMOKE_ACCOUNT_TYPE=individual \
bun run test:live:codex
```

脚本会在 HTTP/SSE 与 WSS 两个半程调用机器上安装的真实 `codex` 命令，不会模拟客户端。WSS 成功要求本地与上游 `101` 握手、同一连接上至少两轮交替工具闭环，以及零次 HTTP Responses 回退。

验证文档中最新记录的证据日期为 2026-07-15：`gpt-5.4` 在 individual 与 enterprise 路由上的 parity 测试都以 `0` 退出，且为 `confirmed=7`、`inconclusive=0`、`failed=0`。Function tool control、`json_object`、`json_schema`、`web_search` 与 `web_search_preview` 在 SSE 和 WSS 上通过语义支持校验；MCP 与 `file_search` 证明的是明确拒绝一致性，不代表功能支持。

## 致谢

本项目最初基于 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)，此后代码库已进行全面重构。
