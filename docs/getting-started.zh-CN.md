[English](getting-started.md) | 简体中文

# 入门指南

选定一个版本，生成客户端配置，再验证真实客户端回合。非回环访问请先阅读[部署](deployment.zh-CN.md)。

## 环境要求

- 有效的 Individual、Business 或 Enterprise Copilot 订阅，以及空闲本地端口（默认 `4399`）。
- 发布包需要 Node.js >= 22.19.0；源码开发需要 Git 和 Bun >= 1.3.6。
- `setup codex` 要求 `PATH` 中安装 Codex >= 0.134.0。Claude Code 或 SDK 应用在应用并测试其配置时需要。

## 1. 选择安装路径

本文对应所在源码修订版。发布包请使用随包文档和 `--help`，各 CLI 命令保持同一版本。升级前查看[升级清单](operations.zh-CN.md#v0100-之后的升级变更)。

### 全局安装

```sh
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy --help
```

### 一次性运行

```sh
npx --yes @jer-y/copilot-proxy@latest --help
npx --yes @jer-y/copilot-proxy@latest setup claude
```

后续命令将 `copilot-proxy` 替换为 `npx --yes @jer-y/copilot-proxy@<version>`，使用上面选定的已发布版本。

### 源码安装

```sh
git clone https://github.com/Jer-y/copilot-proxy.git
cd copilot-proxy
bun install --frozen-lockfile
```

使用该 checkout 时，将下文的 `copilot-proxy` 替换为 `bun run ./src/main.ts`。不要混用源码 setup 和另一个已安装版本。

## 2. 使用 setup 验证代理路由

```sh
copilot-proxy setup claude
# 或：copilot-proxy setup codex / copilot-proxy setup openai-sdk
```

setup 可能更新代理认证数据，但只打印客户端配置，不保存客户端文件或启动客户端。它选择[目录允许的原生路由](protocol-compatibility.zh-CN.md#动态模型目录)，通过临时回环监听器探测。

- Claude 和 Codex 要求流式输出正常完成；OpenAI SDK setup 检查所选 JSON 路由。不同于主模型的 Claude `--small-model` 会单独探测。
- 超时或达到输出、退出等待限制表示验证未完成，不表示能力不受支持。只有 Codex WebSocket 探测失败时，保留独立验证通过的 HTTP/SSE profile，并设置 `supports_websockets = false`。
- `setup codex` 在认证前检查已安装版本和可用的内置模型 metadata。交互选择与显式 `--model` 使用相同门槛；非交互运行（包括 `--json`）须传入 `--model <model-id>`。
- setup 只接受 `personal`、`service`、`custom` 预设及 `localhost`、`127/8`、`::1`。通配地址、`.localhost` 子域、带 scope 的 IPv6 和非回环地址在认证前拒绝；setup 不提供 `gateway-upstream`。
- `--copy` 显式复制输出，不能与 `--json` 同用。启动器隐藏 shell 时可指定 `--shell bash|zsh|fish|powershell|pwsh|cmd|sh`；npm `.cmd` 启动器会尽可能追溯到 PowerShell。其他参数见 `copilot-proxy setup --help`。

### 应用生成的配置

| 客户端 | 操作 |
| --- | --- |
| Claude Code | 执行带 `--settings` 覆盖层的输出命令；不会修改已有 `settings.json`，也不使用其中冲突的环境值。 |
| Codex | 将输出的 TOML 保存到正常 Codex home（`CODEX_HOME`，否则为平台 `.codex` 目录）下的 `copilot-proxy-home/copilot-proxy.config.toml`，使用输出的 `--profile copilot-proxy` 启动命令。 |
| OpenAI SDK | 应用输出的 `OPENAI_BASE_URL`、占位本地 API key、模型和原生 API 类型；占位 key 不提供下游认证。 |

Claude 模型声明 1M 窗口时使用 `[1m]` 客户端选择器；代理探测和上游请求保留基础模型 ID。`CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 可关闭该客户端模式。

Codex 启动命令使用独立子目录 `CODEX_HOME` 和非秘密命令式认证。该子目录不要放置 `config.toml`，也不要把 profile 追加到正常配置中。系统和可信项目设置仍可能覆盖它，见[故障排除](#故障排除)。

## 3. 启动长期运行的代理

在另一个终端执行 setup 输出的完整命令。默认本地命令为：

```sh
copilot-proxy start --preset personal
```

保持代理运行，再应用配置并启动客户端。后台运行见[原生服务管理](operations.zh-CN.md#原生服务管理)；已退役的 start 参数见[升级清单](operations.zh-CN.md#v0100-之后的升级变更)。

### 验证客户端

setup 的路由探测不等于客户端冒烟：它不会运行生成的 Codex profile，也不会调用本地 Claude 程序。应用配置后须完成真实回合。

Codex 的代理日志应出现 `Codex model catalog response: client_version=<installed-version> status=200`，随后是完成的 `POST /v1/responses`，或已转发且完成的 `response.create`。不应出现 `auth cannot be combined with env_key` 或 metadata fallback。普通请求日志省略 query 值。维护者工具循环验证见[能力验证](copilot-capability-validation.md#real-codex-cli)。

## 4. 检查模型并诊断服务

```sh
copilot-proxy models --client all
copilot-proxy doctor --endpoint http://127.0.0.1:4399 --client all
```

用 `--client claude|codex|openai-sdk` 缩小查看范围，自动化使用 `--json`。doctor 需要运行中的服务，必要检查失败时以非零状态退出。账号选择和目录解释见[模型检查](operations.zh-CN.md#模型检查)。

## 故障排除

| 现象 | 操作 |
| --- | --- |
| 没有兼容模型 | 对同一账号运行 `copilot-proxy models --client <client> --json`，检查[原生路由资格](protocol-compatibility.zh-CN.md#动态模型目录)。 |
| 端口占用 | 为 setup 和 start 选择另一个 `--port`，或停止目标监听器。 |
| setup 拒绝非回环地址 | 先在回环地址验证，再按[部署](deployment.zh-CN.md)配置远程访问。 |
| Codex 目录不对或认证冲突 | 仅使用生成的子目录 profile，检查系统或项目中的 `model_catalog_json` 和 `[model_providers.copilot-proxy]` 覆盖项，移除你管理的配置中的冲突定义。 |
| doctor 无法连接 | 确认代理运行中，且 `--endpoint` 是基础 URL，而不是 `/diagnostics` 路径。 |
| 需要企业代理 | 添加 `--proxy-env`，按[代理环境](operations.zh-CN.md#代理环境)配置。 |
