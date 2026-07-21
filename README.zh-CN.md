[English](README.md) | 简体中文

# Copilot API Proxy

一个本地、单用户适配器：把一个 GitHub Copilot 身份转换成兼容 OpenAI 和 Anthropic 的 API，供 Claude Code、Codex、SDK 与自定义工具使用。

> [!IMPORTANT]
> copilot-proxy 面向一个通过本机回环地址访问的可信用户。Business 与 Enterprise 账号模式只选择对应的 Copilot 上游路由，不会提供下游认证、租户隔离、审计、计费或企业治理。使用网关或非回环监听地址前，请先阅读[产品支持](docs/product-support.zh-CN.md)。

> [!WARNING]
> 这是一个通过逆向工程实现的代理，不受 GitHub 官方支持，并可能因 Copilot 变化而失效。过度自动化或批量使用可能触发 GitHub 的滥用控制。请阅读 [GitHub 可接受使用政策](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)与 [GitHub Copilot 条款](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)，并负责任地使用。

## 快速开始

要求：拥有 Individual、Business 或 Enterprise Copilot 订阅的 GitHub 账号；使用 registry 发布版需要 Node.js >= 22.19.0，使用当前源码 checkout 需要 Git 与 Bun >= 1.3.6。运行 `setup codex` 还需要在 `PATH` 中安装 Codex >= 0.134.0。

从空目录开始，在发布版 package 与当前源码 checkout 之间二选一。全局安装 registry 发布版，或不安装直接运行一次：

```sh
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy --help
copilot-proxy start

# 一次性运行的替代方式
npx --yes @jer-y/copilot-proxy@latest --help
npx --yes @jer-y/copilot-proxy@latest start
```

registry 的 `latest` 发布版可能落后于当前 checkout，尚未提供 `setup`、`models` 或 `doctor`。请先查看所选版本的 `--help`，不要假定这些命令已经发布。要使用下文的引导式流程，请从空目录运行：

```sh
git clone https://github.com/Jer-y/copilot-proxy.git
cd copilot-proxy
bun install --frozen-lockfile
```

1. 根据使用的客户端运行设置命令，三选一：

   ```sh
   bun run ./src/main.ts setup claude
   bun run ./src/main.ts setup codex
   bun run ./src/main.ts setup openai-sdk
   ```

   setup 会完成认证、选择并探测直连路由，然后输出配置而不写入客户端配置文件。它可能更新 copilot-proxy 自身的认证数据，但不会保存或启动生成的客户端 profile。HTTP 资格以非空的实时 `supported_endpoints` 列表为权威依据，否则可使用代理内置策略回退；WebSocket 始终要求实时明确的 `ws:/responses`。这些资格输入不是实时路由或语义证明，探测结果才是。Codex 还有本机版本和模型 metadata 检查，详见[入门指南](docs/getting-started.zh-CN.md)。

2. 在另一个终端使用 setup 输出的完整命令启动代理。默认源码设置可简写为：

   ```sh
   bun run ./src/main.ts start --preset personal
   ```

3. 应用生成的配置。需要查看当前模型目录或诊断运行中的服务时，可以运行：

   ```sh
   bun run ./src/main.ts models --client codex
   bun run ./src/main.ts doctor --client codex
   ```

可按需把 `codex` 换成 `claude` 或 `openai-sdk`。配置安全、非交互使用与故障排查见[入门指南](docs/getting-started.zh-CN.md)。

代理启动后会输出指向当前监听地址的[托管诊断面板](https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics)链接。该面板是远程 GitHub Pages 站点：打开链接时，URL query 中编码后的本地 endpoint 会先发送给该站点，随后浏览器才读取 `/diagnostics`。如果 endpoint 地址也必须只保留在本机，请改用 `doctor` 或 `curl`。完整信任边界见[运维](docs/operations.zh-CN.md#诊断与状态面板)。

## 能力摘要

| 领域 | 摘要 |
| --- | --- |
| OpenAI 兼容 API | Chat Completions、HTTP/SSE Responses、Models 与 Embeddings |
| Anthropic 兼容 API | Messages 与 token count；按模型选择直连路由 |
| Responses WebSocket | 仅由实时明确的 `ws:/responses` metadata 放行的原生传输 |
| 路由 | 优先直连；只有能够保留请求意图时才进行有限翻译 |
| 运维 | 客户端设置、模型查看、健康诊断、服务管理与诊断面板 |

能力可用性取决于当前 Copilot 账号、模型、端点与传输。契约和限制见[协议兼容性](docs/protocol-compatibility.zh-CN.md)，验证范围、执行方式与结果判读见[能力验证](docs/copilot-capability-validation.md)。

## 产品边界

| 拓扑 | 支持状态 |
| --- | --- |
| 一个可信用户通过本机回环地址访问 | 支持 |
| 位于认证网关之后的私有后端 | 有条件支持；缺失的安全与治理能力必须由网关提供 |
| 团队直接共享 | 不支持 |
| 公共多租户服务 | 不支持 |

代理有意在单个进程中维护一个 Copilot 身份及其运行状态，不是多租户网关。完整理由见[产品支持](docs/product-support.zh-CN.md)。

## 文档

请从[文档索引](docs/README.zh-CN.md)按任务继续阅读。安全边界与私密漏洞报告方式见[安全策略（英文）](SECURITY.md)。

## 开发

源码开发要求 Bun >= 1.3.6。

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun run typecheck
bun run lint
bun test
bun run test:coverage
bun run knip
bun run audit
```

修改受上游能力约束的行为时，请执行[能力验证](docs/copilot-capability-validation.md)中对应的定向测试与真实验证。

## 致谢

最初基于 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)，此后代码库已进行全面重构。
