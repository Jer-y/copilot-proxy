[English](README.md) | 简体中文

# Copilot API Proxy

本地协议反向代理服务，面向单一可信操作者，将一个或多个由所有者配置的 GitHub Copilot 身份接入兼容 OpenAI 和 Anthropic 的 API。

> [!WARNING]
> 本项目通过逆向工程实现，非官方支持；Copilot 变化可能导致失效，过度自动化可能触发滥用控制。请阅读 [GitHub 可接受使用政策](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)和 [Copilot 条款](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)。
>
> 默认仅供可信用户通过回环地址使用，不提供下游用户认证；远程访问须经过[认证私有网关](docs/deployment.zh-CN.md#认证私有网关)。

## 快速开始

需要 Copilot 订阅及 Node.js >= 22.19.0。使用 `setup codex` 时，`PATH` 中还须安装 Codex >= 0.134.0。

```sh
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy setup claude
```

按需把 `claude` 换为 `codex` 或 `openai-sdk`。setup 可能更新 copilot-proxy 自身的认证数据，但只打印配置，不写入客户端配置文件，也不启动客户端。

1. 在另一个终端执行 setup 输出的完整代理启动命令。
2. 自行应用输出的客户端配置，再运行客户端。
3. 使用 `copilot-proxy doctor` 检查运行中的服务。

本文对应所在修订版；发布包请使用随包文档，各 CLI 命令保持同一版本。npx、源码安装及故障排查见[入门指南](docs/getting-started.zh-CN.md)；已有安装请先查看[升级清单](docs/operations.zh-CN.md#v0100-之后的升级变更)。

## 能力

- OpenAI 兼容的 Chat Completions、HTTP/SSE Responses、Models 和 Embeddings。
- Anthropic 兼容的 Messages 和 token counting。
- 所选模型明确声明支持时可用的原生 Responses WebSocket。
- 确定性多账号路由、客户端设置、诊断和原生服务管理。

只支持同协议原生转发，不做跨协议翻译（如 Messages ↔ Responses 互转），也不做账号负载均衡或自动故障转移。端点与模型可用性取决于账号订阅、端点及传输方式，详见[协议兼容性](docs/protocol-compatibility.zh-CN.md)。

## 文档

通过[任务索引](docs/README.zh-CN.md)查找账号、部署、升级、API 和 Dashboard 文档。受支持的拓扑见[产品支持](docs/product-support.zh-CN.md)；暴露监听器或分享诊断前，请阅读[安全策略](SECURITY.md)。

## 开发

源码开发需要 Git 与 Bun >= 1.3.6。按[源码安装](docs/getting-started.zh-CN.md#源码安装)准备环境后运行 `bun run dev`。构建与测试命令集中维护在[本地验证](docs/copilot-capability-validation.md#local-validation)。

## 致谢

最初基于 [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api)，此后代码库已进行全面重构。
