[English](getting-started.md) | 简体中文

# 入门指南

本指南用于验证代理路由、生成客户端配置并启动服务。copilot-proxy 面向一名受信任用户；使用非回环部署前，请先阅读[产品支持](product-support.zh-CN.md)。

## 环境要求

- 有效的 GitHub Copilot 个人版、商业版或企业版订阅。
- 使用已发布 CLI 时需要 Node.js 22.19.0 或更高版本；使用源码和 `bunx --bun` 时需要 Git 与 Bun 1.3.6 或更高版本。
- `setup codex` 以及应用并测试其生成的 profile 需要 `PATH` 中安装 Codex 0.134.0 或更高版本；Claude Code 或 OpenAI SDK 应用只在应用并测试对应的生成配置时需要。
- 一个空闲的本地 TCP 端口，默认端口为 `4399`。

## 1. 选择安装路径

以下两条路径都可以从空目录开始。使用 registry 发布版时，可以全局安装 CLI，也可以通过 one-shot runner 直接运行：

```sh
# 全局安装
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy --help
copilot-proxy start

# 或者不安装，直接运行已发布 CLI
npx --yes @jer-y/copilot-proxy@latest --help
npx --yes @jer-y/copilot-proxy@latest start
```

registry 的 `latest` 标签会选中一个具体的已发布 package，而不是当前源码 checkout。`setup`、`models` 和 `doctor` 应以该 package 的 `--help` 为准；只能通过 package 运行其已列出的命令。

本文后续的引导式设置使用当前源码 checkout。请从空目录运行：

```sh
git clone https://github.com/Jer-y/copilot-proxy.git
cd copilot-proxy
bun install --frozen-lockfile
```

下文有意使用 `bun run ./src/main.ts`，确保命令来自这个 checkout。registry 发布版的 `--help` 列出同名命令后，也可以改用 `copilot-proxy` 或同一个 one-shot package runner，但前后应保持一致。

## 2. 使用 setup 验证代理路由

为实际要使用的客户端运行 setup：

```sh
# 任选一个
bun run ./src/main.ts setup claude
bun run ./src/main.ts setup codex
bun run ./src/main.ts setup openai-sdk
```

`setup` 会在需要时完成认证、读取当前 Copilot 模型目录、选择**直连**路由，并通过一次性回环监听器进行探测。`supported_endpoints` 列表存在且非空时，以该实时 metadata 为权威依据，必须包含匹配的 HTTP endpoint；`supported_endpoints` 缺失或为空时，setup 才可回退到 copilot-proxy 的内置路由策略，把它作为资格输入。Responses WebSocket 从不使用这项回退，当前模型条目必须明确声明 `ws:/responses`。Codex 还会把具备 HTTP Responses 资格的模型与已安装 bundled catalog 中相同 slug 的可用条目取交集。

只有取得可观察的完整响应后才会生成配置。Codex 与 Claude 使用真实流式请求和终态标记，OpenAI SDK setup 验证所选直连 JSON 路由；如果选择了与主模型不同的 Claude small model，也会单独探测。探测截止时间、输出预算和关闭宽限用于限制一次性服务：触发这些边界只表示验证未完成，不代表上游不支持该能力。如果只有 Codex WebSocket 探测失败，setup 会报告结果，并保留已独立验证、写入 `supports_websockets = false` 的 HTTP/SSE profile。

`setup codex` 还要求本机 Codex 不低于 0.134.0，且所选模型具备可用的 bundled metadata。生成的 profile 使用专用子 `CODEX_HOME` 和命令式非秘密占位认证，让 Codex 刷新代理过滤后的模型目录。它会排除日常 home 的基础配置，但系统配置和受信任项目配置仍可覆盖生成的 provider；处理方法见下方故障排除。

这些证据彼此独立：已安装客户端 metadata 与路由策略只决定资格，setup 路由探测会另行验证可观察的代理路由语义；两者都不能证明最终 profile 已保存并由真实客户端执行。setup 不会写入客户端配置文件，也不会启动最终 profile。每个实际使用的 Codex 版本都要单独保存输出、运行完整的生成命令并完成真实交互。确认代理日志包含 `Codex model catalog response: client_version=<installed-version> status=200`，且 HTTP/SSE 已完成 `POST /v1/responses`，或 WebSocket 已转发并完成 `response.create`；同时确认 Codex 既没有报告 `auth cannot be combined with env_key`，也没有 metadata fallback。通用请求日志会有意省略 query 值。Claude setup 探测不会调用本机 `claude` 命令。

| 客户端 | 生成结果 |
| --- | --- |
| Claude Code | 使用 CLI `--settings` overlay 的启动命令，不修改或选中用户 `settings.json` 中冲突的环境值 |
| Codex | 生成需要手动保存为 `copilot-proxy-home/copilot-proxy.config.toml` 的 TOML 内容，该路径位于解析后的日常 Codex home 下（设置了 `CODEX_HOME` 时使用该目录，否则使用平台的 `.codex` 目录）；其中包含用于刷新目录的非秘密命令式认证，并提供把 `CODEX_HOME` 限定到 `copilot-proxy-home` 后选择 `--profile copilot-proxy` 的启动命令 |
| OpenAI SDK | 生成 `OPENAI_BASE_URL`、本地占位 API Key、所选模型和已验证的直连 API 类型 |

常用 setup 选项：

```sh
bun run ./src/main.ts setup codex --model <model-id>
bun run ./src/main.ts setup claude --small-model <model-id>
bun run ./src/main.ts setup openai-sdk --port 4400
bun run ./src/main.ts setup codex --account-type business
bun run ./src/main.ts setup codex --json --model <model-id>
bun run ./src/main.ts setup codex --copy
bun run ./src/main.ts setup openai-sdk --shell powershell
```

setup 支持 `personal`、`service` 和 `custom` 预设，但无下游认证的一次性监听器必须使用可直接绑定的回环 `--host`：`localhost`、`127/8` IPv4 地址或 `::1`。wildcard、`.localhost` 子域、带 scope 的 IPv6 地址及其他非回环 host 会在认证前被拒绝。`gateway-upstream` 预设用于已单独加固的部署，因此不能在 setup 中使用。检测到的客户端文件会原样保留；只有显式传入 `--copy` 才复制到剪贴板，且不能与机器可读的 `--json` 同时使用。

交互式 Codex setup 提供“HTTP Responses 直连候选”与“本机可用 bundled metadata”的交集。显式 `--model` 也必须通过相同检查；在 `--json` 或其他非交互运行中必须显式传入模型。

setup 会尽可能穿过一次性的 npm `.cmd` 启动器，识别实际调用它的 PowerShell。若 wrapper 或自动化层隐藏了目标 shell，请显式使用 `--shell bash|zsh|fish|powershell|pwsh|cmd|sh`。

## 3. 启动长期运行的代理

使用 setup 输出的准确启动命令。默认本地源码命令的简写为：

```sh
bun run ./src/main.ts start --preset personal
```

保持此前台进程运行，在另一个终端应用生成的配置并启动客户端。

如需由操作系统管理进程，请参阅[原生服务管理](operations.zh-CN.md#原生服务管理)。

## 4. 检查模型并诊断服务

`models` 会读取当前 Copilot 模型目录，并显示各客户端适用的路由：

```sh
bun run ./src/main.ts models --client all
bun run ./src/main.ts models --client claude
bun run ./src/main.ts models --client codex --json
bun run ./src/main.ts models --client openai-sdk
```

模型目录元数据可用于路由决策，但不能证明所有请求语义均受支持。两者区别见[协议兼容性](protocol-compatibility.zh-CN.md)。

长期代理启动后，通过基础地址进行诊断：

```sh
bun run ./src/main.ts doctor \
  --endpoint http://127.0.0.1:4399 \
  --client codex
```

自动化场景可使用 `--json`。必要检查失败时，doctor 会以非零状态退出。运维细节和状态面板见[运维](operations.zh-CN.md)。

## 故障排除

- **没有兼容模型：** 使用相同账号类型运行 `models --client <client> --json`。setup 只接受当前可用的直连路由。
- **端口已被占用：** 停止现有监听器，或为 setup 和 start 指定另一个 `--port`。
- **setup 拒绝非回环 host：** 一次性代理没有下游客户端认证，因此 setup 有意不开放 LAN/容器监听。请先在回环地址完成验证，再单独配置长期部署。
- **已有客户端配置或 Codex 模型目录错误：** setup 不会覆盖客户端文件。Codex 输出只能保存到 `copilot-proxy-home` 内生成的路径，保持该 home 中不存在 `config.toml`，不要追加到主配置。如果日志中没有对应已安装版本的成功 `Codex model catalog response`，或 Codex 报告 metadata fallback，请从系统配置和受信任项目配置中移除冲突的 `model_catalog_json` 或 `[model_providers.copilot-proxy]` 定义。Claude 使用运行时 settings overlay，不修改 `settings.json`。
- **doctor 无法访问服务：** 确认输出的长期启动命令仍在运行，并确保 `--endpoint` 指向基础地址而非 `/diagnostics`。
- **必须使用公司代理：** 添加 `--proxy-env`，并阅读[代理环境](operations.zh-CN.md#代理环境)。

非回环监听器、容器和网关部署见[部署](deployment.zh-CN.md)。
