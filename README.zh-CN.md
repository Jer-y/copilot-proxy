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

---

## 项目概览

这是一个面向 GitHub Copilot API 的逆向代理，将其暴露为 OpenAI/Anthropic 兼容服务。你可以用任何支持 OpenAI Chat Completions/Responses 或 Anthropic Messages 的工具来调用 GitHub Copilot，包括 [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) 与 OpenAI Codex。

## 功能特性

- **OpenAI & Anthropic 兼容**：提供 OpenAI 兼容端点（`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`）与 Anthropic 兼容端点（`/v1/messages`）。
- **Responses API 支持**：支持 OpenAI Responses API（`/v1/responses`），适用于 `gpt-5`、`gpt-5.1-codex`、`gpt-5.2-codex`、`o3-mini`、`o4-mini` 等思考型模型。
- **Codex 可用**：将 OpenAI Codex CLI/SDK 的 base URL 指向本代理即可使用。
- **模型感知翻译**：自动应用模型优化 —— Claude 的提示缓存（`copilot_cache_control`）、Anthropic `thinking.budget_tokens` → `reasoning_effort` 映射，以及模型名归一化（如 `claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`）。
- **Claude Code 集成**：通过 `--claude-code` 一键生成配置命令，直接用 Copilot 作为 Claude Code 后端。
- **用量面板**：Web 仪表盘查看 Copilot API 使用量与配额。
- **速率限制**：通过 `--rate-limit` 与 `--wait` 控制请求节流，避免频繁请求报错。
- **手动审核**：通过 `--manual` 对每个请求进行人工确认。
- **Token 可视化**：`--show-token` 显示 GitHub/Copilot token 便于调试。
- **灵活认证**：支持交互式登录或直接传入 GitHub token，适用于 CI/CD。
- **多账号类型**：支持个人、企业、组织三种 Copilot 账户类型。

## 前置要求

- Bun (>= 1.2.x)
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

# bun
bun add -g @jer-y/copilot-proxy

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

# bunx
bunx @jer-y/copilot-proxy@latest start
```

### 从源码安装（开发）

本地安装依赖：

```sh
bun install
```

## 使用 Docker

构建镜像：

```sh
docker build -t copilot-proxy .
```

运行容器：

```sh
# 在宿主机创建目录以持久化 GitHub token 等数据
mkdir -p ./copilot-data

# 使用挂载目录来保持认证信息，确保容器重启后依旧有效
docker run -p 4399:4399 -v $(pwd)/copilot-data:/root/.local/share/copilot-proxy copilot-proxy
```

> **提示：**
> GitHub token 与相关数据会保存在宿主机的 `copilot-data`，映射到容器内 `/root/.local/share/copilot-proxy`，便于持久化。

### Docker 环境变量

可以通过环境变量直接传入 GitHub token：

```sh
# 构建时注入 GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-proxy .

# 运行时传入 GitHub token
docker run -p 4399:4399 -e GH_TOKEN=your_github_token_here copilot-proxy

# 运行时追加参数
docker run -p 4399:4399 -e GH_TOKEN=your_token copilot-proxy start --verbose --port 4399
```

### Docker Compose 示例

```yaml
version: '3.8'
services:
  copilot-proxy:
    build: .
    ports:
      - '4399:4399'
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

Docker 镜像包含：

- 多阶段构建，体积更小
- 非 root 用户，安全性更好
- 健康检查，便于容器监控
- 固定基础镜像版本，保证可复现

## 使用 npx（或 pnpm/bunx）

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

> 提示：如果你使用 pnpm/bun/yarn，可替换为 `pnpm dlx`、`bunx` 或 `yarn dlx`。

## 命令结构

Copilot API 使用子命令结构，主要命令如下：

- `start`：启动 Copilot API 服务（必要时会自动认证）。
- `auth`：仅进行 GitHub 认证，不启动服务，常用于生成 `--github-token`（CI/CD 场景）。
- `check-usage`：直接查看 Copilot 使用量/配额（无需启动服务）。
- `debug`：输出诊断信息，包括版本、运行环境、路径与认证状态。

## 命令行参数

### start 参数

| 参数           | 说明                                                                    | 默认值      | 简写 |
| -------------- | ----------------------------------------------------------------------- | ----------- | ---- |
| --port         | 监听端口                                                                | 4399        | -p   |
| --verbose      | 开启详细日志                                                            | false       | -v   |
| --account-type | 账户类型（individual, business, enterprise）                            | individual  | -a   |
| --manual       | 手动审批每个请求                                                        | false       | 无   |
| --rate-limit   | 两次请求之间的最小间隔（秒）                                            | 无          | -r   |
| --wait         | 触发限流时等待，而非直接报错                                            | false       | -w   |
| --github-token | 直接传入 GitHub token（需通过 `auth` 命令生成）                         | 无          | -g   |
| --claude-code  | 生成 Claude Code 配置命令                                               | false       | -c   |
| --show-token   | 在获取/刷新时显示 GitHub/Copilot token                                 | false       | 无   |
| --proxy-env    | 从环境变量初始化代理（HTTP_PROXY/HTTPS_PROXY 等）                      | false       | 无   |

### auth 参数

| 参数         | 说明                | 默认值 | 简写 |
| ------------ | ------------------- | ------ | ---- |
| --verbose    | 开启详细日志        | false  | -v   |
| --show-token | 显示 GitHub token   | false  | 无   |

### debug 参数

| 参数   | 说明                 | 默认值 | 简写 |
| ------ | -------------------- | ------ | ---- |
| --json | 以 JSON 输出调试信息 | false  | 无   |

## API 端点

服务提供多组端点，以兼容 OpenAI / Anthropic API。所有端点均支持有无 `/v1/` 前缀。

### OpenAI 兼容端点

| 端点                       | 方法 | 说明                                             |
| -------------------------- | ---- | ------------------------------------------------ |
| `POST /v1/chat/completions` | POST | 基于对话创建模型响应                              |
| `GET /v1/models`           | GET  | 获取可用模型列表                                  |
| `POST /v1/embeddings`      | POST | 创建文本 Embedding 向量                          |

### OpenAI Responses API 端点

支持 OpenAI Responses API（`/v1/responses`），适用于 `gpt-5`、`gpt-5.1-codex`、`gpt-5.2-codex`、`o3-mini`、`o4-mini` 等思考型模型。请求会被直接转发到 Copilot `/responses`。

| 端点               | 方法 | 说明                                                   |
| ------------------ | ---- | ------------------------------------------------------ |
| `POST /v1/responses` | POST | 创建 Responses API 响应（支持流式）                     |

### Anthropic 兼容端点

这些端点与 Anthropic Messages API 兼容。收到 Anthropic 格式请求后会自动翻译为 OpenAI 格式转发给 Copilot，再将响应翻译回 Anthropic 格式。

| 端点                            | 方法 | 说明                                         |
| ------------------------------- | ---- | -------------------------------------------- |
| `POST /v1/messages`             | POST | 为对话创建模型响应                            |
| `POST /v1/messages/count_tokens` | POST | 计算消息 token 数量                            |

### 用量监控端点

| 端点     | 方法 | 说明                                           |
| -------- | ---- | ---------------------------------------------- |
| `GET /usage` | GET  | 获取 Copilot 使用量与配额信息                 |
| `GET /token` | GET  | 获取当前正在使用的 Copilot token              |

## 使用示例

使用 npx（可替换为 `pnpm dlx`、`bunx` 或 `yarn dlx`）：

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

# 直接传入 GitHub token
npx @jer-y/copilot-proxy@latest start --github-token ghp_YOUR_TOKEN_HERE

# 仅认证
npx @jer-y/copilot-proxy@latest auth

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
```

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
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
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

## 使用建议

- 为避免触发 GitHub Copilot 的速率限制，可使用：
  - `--manual`：每次请求手动确认
  - `--rate-limit <seconds>`：限制请求最小间隔
  - `--wait`：配合 `--rate-limit` 使用，触发限流时等待而不是报错
- 如果你是商业版/企业版 Copilot 账号，可使用 `--account-type`：
  - `--account-type business`
  - `--account-type enterprise`
  详见：[官方文档](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization)

## 致谢

本项目 fork 自 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)，仓库主要用于个人使用。
