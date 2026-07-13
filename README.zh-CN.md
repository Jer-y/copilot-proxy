[English](README.md) | 简体中文

# Copilot API 代理

> [!WARNING]
> 这是一个通过逆向工程实现的 GitHub Copilot API 代理。它不受 GitHub 官方支持，可能随时失效。使用风险自负。

> [!WARNING]
> **GitHub 安全提示：**
> 对 Copilot 的过度自动化或脚本化使用（包括快速或批量请求）可能触发 GitHub 的滥用检测系统。
> 你可能会收到 GitHub Security 的警告，进一步的异常活动可能导致 Copilot 权限被临时暂停。
>
> GitHub 禁止过度的自动化批量活动或任何对其基础设施造成不当负担的行为。
>
> 请阅读：
>
> - [GitHub 可接受使用政策](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot 条款](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> 请负责任地使用本代理以避免账号受限。

---

**注意：** 如果你在使用 [opencode](https://github.com/sst/opencode)，则不需要本项目。Opencode 已原生支持 GitHub Copilot Provider。

> [!NOTE]
> GitHub 现在已经在部分产品中提供了官方的一方 Anthropic / Claude 支持，包括由 Copilot 驱动的 Anthropic Claude coding agent，以及 Copilot CLI 的 Anthropic BYOK 支持。
>
> - [Anthropic Claude - GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/anthropic-claude)
> - [在 GitHub Copilot CLI 中使用自带 LLM 模型 - GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
>
> 如果你的目标是给 Claude Code、Codex、SDK 或自定义工具提供一个由 GitHub Copilot 订阅驱动的本地 OpenAI / Anthropic 兼容 HTTP 代理，本项目仍然有意义。

---

## 项目概览

这是一个面向 GitHub Copilot API 的逆向代理，把你的 Copilot 订阅暴露为 OpenAI / Anthropic 兼容 HTTP 端点。你可以用任何支持 OpenAI Chat Completions / Responses 或 Anthropic Messages 的外部工具来调用 GitHub Copilot，包括 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 与 OpenAI Codex。

## 功能特性

- **OpenAI & Anthropic 兼容**：提供 OpenAI 兼容端点（`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`）与 Anthropic 兼容端点（`/v1/messages`），并在上游支持时优先走 Claude 原生 `/v1/messages`。
- **Responses API 支持**：支持 OpenAI Responses API（`/v1/responses`），适用于 Copilot 暴露 Responses 后端的模型；请求形状能够忠实翻译为 Anthropic Messages 时，Claude 请求也可通过 `/v1/responses` 调用。
- **Codex 可用（Responses 后端模型）**：当所选 Copilot 模型暴露 Responses 后端时，将 OpenAI Codex CLI/SDK 的 base URL 指向本代理即可使用。Codex 到 Claude 的翻译受下述限制。
- **模型感知路由与翻译**：请求协议受模型支持时直通；否则仅 `/v1/messages` 与 `/responses` 之间可互译。代理不会与 `/chat/completions` 做互译。同时自动应用 Claude 提示缓存（`copilot_cache_control`），保留 `adaptive thinking` / `output_config.effort` 兼容，并在 Copilot 上游需要不同模型名时归一化 provider-specific 模型 ID。
- **Claude Code 集成**：通过 `--claude-code` 一键生成配置命令，直接用 Copilot 作为 Claude Code 后端。
- **适合接入网关**：可以把 [New API](https://github.com/QuantumNous/new-api) 放在本代理前面，实现一处部署、处处访问，由 New API 统一管理用户、API Key、额度、日志、限流与计费。
- **用量面板**：Web 仪表盘查看 Copilot API 使用量与配额。
- **速率限制**：通过 `--rate-limit` 与 `--wait` 控制请求节流，避免频繁请求报错。
- **上游稳健性控制**：内置更长的 Copilot 上游 timeout，可按需覆盖 headers/body/connect timeout，并在等待首个 Anthropic 流事件时发送 SSE keepalive `ping`。
- **手动审核**：通过 `--manual` 在交互式前台 TTY 中逐个确认；无法显示或超时的提示会 fail-closed。
- **Token 可视化**：`--show-token` 显示 GitHub/Copilot token 便于调试。
- **灵活认证**：支持交互式登录或直接传入 GitHub token，适用于 CI/CD。
- **多账号类型**：支持个人、企业、组织三种 Copilot 账户类型。
- **原生后台服务**：通过 `enable`/`disable` 注册为系统自启动服务，支持 Linux（systemd）、macOS（launchd）和 Windows（任务计划程序）。安装了原生服务时，`stop`、`restart`、`status`、`logs` 会优先使用系统服务管理器。
- **兼容守护模式**：`start -d` 仍可作为应用自管后台模式使用，适合不想安装原生服务的兼容场景。

在 Linux 上，`enable` 会安装 user systemd 服务，并要求开启 systemd user lingering，这样服务才能在系统启动后、用户尚未登录时自动拉起。如果无法自动开启 lingering，请先执行 `sudo loginctl enable-linger "$USER"`，然后重试 `enable`。

## 前置要求

- 从源码运行或使用 `bunx --bun` 时要求 Bun >= 1.3.6
- 全局安装 CLI，以及使用 npm、npx、pnpm、Yarn 或 Volta 时要求 Node.js >= 22.19.0
- 拥有 Copilot 订阅的 GitHub 账号（个人 / 企业 / 组织）

## 安装

### 全局安装 CLI

选择你的包管理器：

```sh
# npm
npm i -g @jer-y/copilot-proxy

# pnpm
pnpm add -g @jer-y/copilot-proxy

# yarn (classic)
yarn global add @jer-y/copilot-proxy

# volta (可选)
volta install @jer-y/copilot-proxy
```

然后运行：

```sh
copilot-proxy start
```

### 免安装运行（一次性）

```sh
# npx
npx @jer-y/copilot-proxy@latest start

# pnpm dlx
pnpm dlx @jer-y/copilot-proxy@latest start

# yarn dlx
yarn dlx @jer-y/copilot-proxy@latest start

# Bun（强制使用 Bun 运行 package bin）
bunx --bun @jer-y/copilot-proxy@latest start
```

### 从源码安装（开发）

本地安装依赖：

```sh
bun install --frozen-lockfile
```

## 使用 Docker

构建镜像：

```sh
docker build -t copilot-proxy .
```

运行容器：

```sh
# 使用 Docker 命名卷，避免凭据进入源码和构建上下文
docker volume create copilot-proxy-data

# 使用命名卷保持认证信息，确保容器重启后依旧有效
docker run -p 127.0.0.1:4399:4399 -v copilot-proxy-data:/home/bun/.local/share/copilot-proxy copilot-proxy start --host 0.0.0.0
```

> **提示：**
> GitHub token 与相关数据保存在 Docker 管理的 `copilot-proxy-data` 命名卷中。不要把 token 数据放进仓库或 Docker 构建上下文。

### Docker 环境变量

可以通过环境变量直接传入 GitHub token：

```sh
# 在仓库外创建权限为 0600 的 env 文件并写入 GH_TOKEN，然后运行：
docker run -p 127.0.0.1:4399:4399 --env-file "$HOME/.config/copilot-proxy/container.env" copilot-proxy start --host 0.0.0.0

# 运行时追加参数
docker run -p 127.0.0.1:4399:4399 --env-file "$HOME/.config/copilot-proxy/container.env" copilot-proxy start --host 0.0.0.0 --port 4399
```

### Docker Compose 示例

```yaml
version: '3.8'
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

Docker 镜像包含：

- 多阶段构建，体积更小
- 非 root 用户，安全性更好
- 健康检查，便于容器监控
- 同时固定基础镜像版本与 digest，保证可复现

## 配合 New API 使用

[New API](https://github.com/QuantumNous/new-api) 是一个自托管的 AI 网关和资产管理系统。它可以统一接入多个上游服务，对外提供 OpenAI / Claude / Gemini 兼容入口，并集中处理用户侧 API Key、Token 额度、模型权限、使用日志、限流、计费和负载均衡。

它和 copilot-proxy 的职责可以清晰拆分：

- **copilot-proxy** 作为私有上游，专注连接 GitHub Copilot，负责 GitHub 登录、Copilot token 刷新、模型路由以及 OpenAI / Anthropic 兼容。
- **New API** 作为公开或团队内部入口，负责用户认证、API Key、额度、计费、审计日志和客户端分发。

推荐拓扑是把 copilot-proxy 放在私有网络，只把 New API 暴露给用户：

```text
客户端 / SDK / Claude Code / Codex
        |
        | New API Key、额度、日志、计费
        v
New API 网关
        |
        | 私有上游渠道
        v
copilot-proxy
        |
        | GitHub Copilot 认证
        v
GitHub Copilot 上游
```

推荐配置步骤：

1. 先部署并完成 copilot-proxy 认证。让它只对 New API 所在主机或容器网络可达，例如 `http://copilot-proxy:4399`。
2. 按 New API 自身的 Docker / Compose 文档部署 New API。
3. 在 New API 中创建 OpenAI 兼容或自定义上游渠道，指向 copilot-proxy 的 OpenAI 兼容 base URL，例如 `http://copilot-proxy:4399/v1`。
4. 如果 New API 的渠道表单要求填写上游 Key，可以填占位值。copilot-proxy 自己负责登录 GitHub Copilot，不需要 New API 转发真实的上游 provider key。
5. 对用户只分发 New API 的 API Key 和 New API 的 base URL。客户端不需要直接访问 copilot-proxy、`/token` 或持久化的 GitHub token。

当 New API 通过 `copilot-proxy` 服务名访问容器时，请在 copilot-proxy 上设置 `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy`。只添加客户端实际使用的精确内网主机名。

对于 Claude 兼容客户端，如果你的 New API 部署暴露了 Claude 兼容入口，可以直接使用该入口；也可以根据 New API 渠道配置，让 New API 转换或路由到 copilot-proxy 的 OpenAI 兼容渠道。对于 Codex CLI，如果希望保留 Codex 专用模型目录和上下文窗口信息，请确认你的 New API 部署会原样透传 `/v1/models?client_version=...` 这类 query string；copilot-proxy 已经直接支持这个目录路径。

这样可以实现实际意义上的“一处部署，处处访问”：copilot-proxy 把 Copilot 兼容逻辑集中在一个私有上游，New API 负责所有下游客户端共享的访问控制和 API Key 层。

## 使用 npx（或 pnpm/Bun/Yarn）

使用 npx 直接运行：

```sh
npx @jer-y/copilot-proxy@latest start
```

带参数示例：

```sh
npx @jer-y/copilot-proxy@latest start --port 8080
```

仅进行认证：

```sh
npx @jer-y/copilot-proxy@latest auth
```

> 提示：如果你使用 pnpm/Bun/Yarn，可替换为 `pnpm dlx`、`bunx --bun` 或 `yarn dlx`。发布包的全局 bin 使用 Node.js shebang，因此只有 Bun 的机器应使用 `bunx --bun`，不要使用 `bun add -g`。

## 命令结构

Copilot API 使用子命令结构，主要命令如下：

- `start`：以前台方式启动 Copilot API 服务（必要时会自动认证）。`-d` 仅用于兼容的应用自管后台守护进程。
- `stop`：停止已安装的原生服务；如果没有原生服务，则回退到旧守护进程。
- `restart`：重启已安装的原生服务；如果没有原生服务，则使用已保存配置回退重启旧守护进程。
- `status`：查看原生服务状态；如果没有原生服务，则回退查看旧守护进程状态（PID、端口、启动时间）。
- `logs`：查看原生服务日志；如果当前平台不支持或没有原生服务，则回退查看旧守护进程日志。使用 `-f` 实时跟踪。
- `enable`：注册为原生系统自启动服务（systemd / launchd / 任务计划程序），服务中运行前台 `start`。Linux 需要 systemd user lingering 才能在未登录时启动。
- `disable`：移除自启动服务注册。
- `auth`：仅进行 GitHub 认证，不启动服务。非交互环境可用 `--github-token` 一次性安全写入现有 token；该命令会主动退出，随后需不带敏感参数再次启动。
- `check-usage`：直接查看 Copilot 使用量/配额（无需启动服务）。
- `debug`：输出诊断信息，包括版本、运行环境、路径与认证状态。

## 命令行参数

### start 参数

| 参数           | 说明                                                                    | 默认值      | 简写 |
| -------------- | ----------------------------------------------------------------------- | ----------- | ---- |
| --port         | 监听端口                                                                | 4399        | -p   |
| --host         | 绑定的 Host/IP。仅在确实要暴露端口时使用 `0.0.0.0`                      | 127.0.0.1   | -H   |
| --verbose      | 开启详细诊断；日志应按敏感信息处理                                        | false       | -v   |
| --account-type | 账户类型（individual, business, enterprise）                            | individual  | -a   |
| --manual       | 在交互式前台 TTY 中审批每个请求                                          | false       | 无   |
| --rate-limit   | 两次请求之间的最小间隔（秒）                                            | 无          | -r   |
| --wait         | 触发限流时等待，而非直接报错                                            | false       | -w   |
| --headers-timeout-ms | upstream 响应头超时（毫秒，`0` 表示禁用）                         | 自动*       | 无   |
| --body-timeout-ms | upstream 响应体超时（毫秒，`0` 表示禁用）                           | 自动*       | 无   |
| --connect-timeout-ms | upstream 建连超时（毫秒，`0` 表示禁用）                           | 自动*       | 无   |
| --github-token | 将 GitHub token 写入仅属主可读的 token 文件后退出；随后不带此参数重新运行 `start` | 无          | -g   |
| --claude-code  | 生成 Claude Code 配置命令                                               | false       | -c   |
| --show-token   | 在获取/刷新时显示 GitHub/Copilot token                                 | false       | 无   |
| --proxy-env    | 从环境变量初始化代理（HTTP_PROXY/HTTPS_PROXY 等）                      | false       | 无   |
| --daemon       | 作为兼容的应用自管后台守护进程运行                                      | false       | -d   |

`自动*` 表示在 Node.js 运行时，如果没有显式覆盖，发往 `githubcopilot.com` 的请求会默认使用 `900000ms` 响应头 timeout、`900000ms` 响应体 timeout 和 `30000ms` 建连 timeout。其他域名仍沿用 Node/undici 默认值，除非你显式传参覆盖。

### 本地安全默认值

代理默认监听 `127.0.0.1`，定位是个人本地使用。除非你完全信任所有能访问该端口的客户端，否则不要把它绑定到 LAN 或公网接口。如果需要 Docker 端口映射，请在容器内使用 `--host 0.0.0.0`，并把宿主机端口绑定到 loopback，例如 `-p 127.0.0.1:4399:4399`。

CORS 默认只允许本地浏览器来源，例如 `http://localhost:*`、`http://127.0.0.1:*` 和 `http://[::1]:*`。托管的用量面板来源只允许访问 `/usage`。如需添加其他精确浏览器来源，可设置逗号分隔的 `COPILOT_PROXY_CORS_ORIGINS`，例如 `COPILOT_PROXY_CORS_ORIGINS=https://internal.example.com`。

来源不在允许列表内的浏览器请求会在执行路由前被拒绝。为防止 DNS rebinding，Host 还会单独限制为 loopback 名称；如确实需要其他服务名，请用不带端口的精确名称配置 `COPILOT_PROXY_ALLOWED_HOSTS`，例如 `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy,proxy.internal`。JSON 请求体必须使用 `Content-Type: application/json`（也接受 `application/*+json`）。

入站 JSON 请求体默认限制为 32 MiB。如需覆盖，可将 `COPILOT_PROXY_MAX_JSON_BODY_BYTES` 设置为正数字节数。

Legacy daemon 与原生系统服务会把受支持的 `COPILOT_PROXY_*`、代理、`NO_PROXY` 和 TLS CA 环境保存到仅 owner 可读的运行时文件。`--proxy-env` 在没有实际代理端点时会 fail closed。Bun 服务会先用该环境完成 bootstrap，再启动真正的运行进程，避免 Bun 的启动时代理快照绕过恢复后的代理，或继续使用未经允许的 ambient proxy。

当所选模型走 Copilot `/v1/messages` 后端时，Anthropic document URL source 会原样 native 转发。需要本地翻译的 document URL 抓取默认关闭；只有在你明确信任客户端和 URL 时，才设置 `COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1`。即使开启，代理仍会在抓取前和 redirect 后拒绝 localhost、私网、云元数据以及保留 DNS/IP 目标。

`GET /token` 默认关闭，因为 loopback 不是用户级安全边界。仅在短时本机诊断时设置 `COPILOT_PROXY_EXPOSE_TOKEN=1`；启用后仍要求 loopback 远端地址、loopback Host 与浏览器同源访问，用完应立即关闭。

`--manual` 采用 fail-closed：没有交互式 TTY 或审批超时时，请求返回 `503`。它只适合前台 `start`，不适用于 `enable`、`start -d`、无 TTY 容器或其他无人值守服务。所有诊断日志都应按敏感信息处理；`--show-token` 会主动打印 bearer token，绝不能与持久化或共享日志一起使用。

当 `/v1/responses` 请求必须翻译到 Claude 原生 `/v1/messages` 后端时，请求必须显式设置 `store: false`；代理无法模拟 Responses API 默认的服务端持久化，也无法让翻译生成的 response ID 可被再次查询。会话开头的 system/developer input 会保留为 Anthropic 顶层 system prompt；会话中途的 system/developer input 只在 Anthropic 支持的位置原样保留，无法忠实表达的顺序会被明确拒绝，而不会重排。

> **Codex 到 Claude 的限制：** 使用 Codex CLI 0.144.1 实测时，默认配置会携带 Anthropic Messages 无法忠实表达的 hosted/custom Responses 工具。代理会有意在本地返回 HTTP `400`，而不是丢弃工具或制造误导性的成功。受限实机测试仅在使用下列覆盖项后通过文本与 `exec_command` 工具闭环；这只证明该受限配置，不代表默认 Codex 到 Claude 兼容：
>
> ```sh
> -c 'web_search="disabled"' \
> -c 'features.multi_agent=false' \
> -c 'features.remote_plugin=false'
> ```

### auth 参数

| 参数         | 说明                | 默认值 | 简写 |
| ------------ | ------------------- | ------ | ---- |
| --verbose    | 开启敏感诊断日志    | false  | -v   |
| --show-token | 显示 GitHub token   | false  | 无   |
| --github-token | 安全写入 GitHub token 后退出 | 无 | -g |
| --proxy-env | 认证请求使用 HTTP(S)_PROXY/NO_PROXY | false | 无 |

### debug 参数

| 参数   | 说明                 | 默认值 | 简写 |
| ------ | -------------------- | ------ | ---- |
| --json | 以 JSON 输出调试信息 | false  | 无   |

### logs 参数

| 参数     | 说明           | 默认值 | 简写 |
| -------- | -------------- | ------ | ---- |
| --follow | 实时跟踪日志   | false  | -f   |
| --lines  | 显示行数       | 50     | -n   |

## API 端点

OpenAI 兼容的 Chat Completions、Models、Embeddings 与 Responses 路由同时接受表中 `/v1/...` 路径和对应的无前缀路径。Anthropic Messages 只在 `/v1/messages` 下提供；`/usage` 与 `/token` 是无前缀辅助路由。

### OpenAI 兼容端点

| 端点                       | 方法 | 说明                                             |
| -------------------------- | ---- | ------------------------------------------------ |
| `POST /v1/chat/completions` | POST | 基于对话创建模型响应                              |
| `GET /v1/models`           | GET  | 获取可用模型列表                                  |
| `POST /v1/embeddings`      | POST | 创建文本 Embedding 向量                          |

### OpenAI Responses API 端点

支持 OpenAI Responses API（`/v1/responses`）。由 Copilot Responses surface 支持的模型会直接转发到上游；Claude 模型通过翻译为 Anthropic Messages 提供服务。

| 端点               | 方法 | 说明                                                   |
| ------------------ | ---- | ------------------------------------------------------ |
| `POST /v1/responses` | POST | 创建 Responses API 响应（支持流式）                     |

### Anthropic 兼容端点

这些端点与 Anthropic Messages API 兼容。Claude 模型走 Copilot 原生 `/v1/messages` 直通；其他由 Responses 后端支持的模型通过将 Anthropic Messages 翻译到 Responses API 提供服务。

| 端点                            | 方法 | 说明                                         |
| ------------------------------- | ---- | -------------------------------------------- |
| `POST /v1/messages`             | POST | 为对话创建模型响应                            |
| `POST /v1/messages/count_tokens` | POST | 计算消息 token 数量                            |

### 用量监控端点

| 端点     | 方法 | 说明                                           |
| -------- | ---- | ---------------------------------------------- |
| `GET /usage` | GET  | 获取 Copilot 使用量与配额信息                 |
| `GET /token` | GET  | 本机诊断用 Copilot token；仅在 `COPILOT_PROXY_EXPOSE_TOKEN=1` 时启用，并限制为 loopback 与同源读取 |

## 使用示例

使用 npx（可替换为 `pnpm dlx`、`bunx --bun` 或 `yarn dlx`）：

```sh
# 基础启动
npx @jer-y/copilot-proxy@latest start

# 自定义端口 + 详细日志
npx @jer-y/copilot-proxy@latest start --port 8080 --verbose

# 商业账号
npx @jer-y/copilot-proxy@latest start --account-type business

# 企业账号
npx @jer-y/copilot-proxy@latest start --account-type enterprise

# 手动审批
npx @jer-y/copilot-proxy@latest start --manual

# 设置请求间隔
npx @jer-y/copilot-proxy@latest start --rate-limit 30

# 触发限流时等待
npx @jer-y/copilot-proxy@latest start --rate-limit 30 --wait

# 一次性写入 GitHub token，然后不带敏感参数启动
npx @jer-y/copilot-proxy@latest start --github-token ghp_YOUR_TOKEN_HERE
npx @jer-y/copilot-proxy@latest start

# 仅认证
npx @jer-y/copilot-proxy@latest auth

# 不启动设备登录流程，直接安全写入现有 token
npx @jer-y/copilot-proxy@latest auth --github-token ghp_YOUR_TOKEN_HERE

# 认证 + 详细日志
npx @jer-y/copilot-proxy@latest auth --verbose

# 查看使用量
npx @jer-y/copilot-proxy@latest check-usage

# 输出调试信息
npx @jer-y/copilot-proxy@latest debug

# JSON 输出调试信息
npx @jer-y/copilot-proxy@latest debug --json

# 从环境变量初始化代理
npx @jer-y/copilot-proxy@latest start --proxy-env

# 针对较慢模型启动拉长 upstream timeout
npx @jer-y/copilot-proxy@latest start --headers-timeout-ms 600000 --body-timeout-ms 600000

# 原生服务必须使用稳定的全局安装，不能指向 npx/dlx 缓存
npm i -g @jer-y/copilot-proxy

# 安装非交互式原生服务前先完成认证
copilot-proxy auth

# 仅 Linux：如果 enable 无法自动开启未登录启动能力，先手动开启 lingering
sudo loginctl enable-linger "$USER"

# 注册并启动原生开机自启服务（systemd / launchd / 任务计划程序）
copilot-proxy enable

# 查看服务状态
copilot-proxy status

# 查看服务日志（最后 50 行）
copilot-proxy logs

# 实时跟踪服务日志
copilot-proxy logs -f

# 重启服务
copilot-proxy restart

# 停止服务
copilot-proxy stop

# 移除开机自启
copilot-proxy disable

# 兼容的应用自管守护模式仍可使用
copilot-proxy start -d
```

`enable` 会拒绝 `_npx`、`pnpm dlx`、`yarn dlx` 和 `bunx` 缓存路径，因为缓存一旦清理，长期服务就会失效。原生自启动必须使用全局安装或稳定的源码 checkout。

## 使用用量面板

启动服务后，终端会输出用量面板的 URL。该面板用于查看 Copilot API 的配额与统计信息。

1. 使用 npx 启动服务：
   ```sh
   npx @jer-y/copilot-proxy@latest start
   ```
2. 终端输出的 URL 类似：
   `https://jer-y.github.io/copilot-proxy?endpoint=http://localhost:4399/usage`
   - 如果你使用 Windows 的 `start.bat`，该页面会自动打开。

面板功能包括：

- **API Endpoint URL**：可在 URL 中传入 endpoint 参数来指定数据源。
- **Fetch Data**：点击按钮刷新数据。
- **Usage Quotas**：以进度条方式展示配额使用情况。
- **Detailed Information**：查看完整 JSON 响应。
- **URL 参数配置**：可将 endpoint 直接写入 URL 便于收藏与分享：
  `https://jer-y.github.io/copilot-proxy?endpoint=http://your-api-server/usage`

## 使用 Claude Code

本代理可用于 [Claude Code](https://docs.anthropic.com/en/claude-code)。

有两种方式：

### 交互式配置（`--claude-code`）

```sh
npx @jer-y/copilot-proxy@latest start --claude-code
```

会提示选择主要模型与“快速模型”，随后把 Claude Code 所需的环境变量命令复制到剪贴板，粘贴执行即可。

### 手动配置 `settings.json`

在项目根目录创建 `.claude/settings.json`：

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

上游模型会变化。保存配置前先查询 `GET /v1/models`，选择当前声明支持 Anthropic Messages 的模型；不要给 Claude Code 配置仅支持 Chat Completions 的模型。

更多选项见：[Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

IDE 集成说明：[Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## 从源码运行

### 开发模式

```sh
bun run dev
```

### 生产模式

```sh
bun run start
```

### GitHub Copilot 能力验证

如果你准备修改 Anthropic / Claude 兼容层，建议先验证 GitHub Copilot 上游端点是否真的接受这些映射字段，再决定是否默认开启。

仓库里已经带了一组可选的 live probe：

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=claude-model-under-test \
COPILOT_LIVE_RESPONSES_MODEL=responses-model-under-test \
bun run test:live:copilot
```

探针矩阵、环境变量说明和结果判读见 [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md)。

## 使用建议

- 为避免触发 GitHub Copilot 的速率限制，可使用：
  - `--manual`：在交互式前台 TTY 中逐个审批；无法显示提示或超时时会拒绝请求
  - `--rate-limit <seconds>`：限制请求最小间隔
  - `--wait`：配合 `--rate-limit` 使用，触发限流时等待而不是报错
- 如果你是商业版/企业版 Copilot 账号，可使用 `--account-type`：
  - `--account-type business`
  - `--account-type enterprise`
  详见：[官方文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)

## 致谢

本项目 fork 自 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)，仓库主要用于个人使用。
