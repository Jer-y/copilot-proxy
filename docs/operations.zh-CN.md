[English](operations.md) | 简体中文

# 运维

本文介绍运行参数选择、检查、诊断和服务生命周期。网络暴露与网关要求见[部署](deployment.zh-CN.md)。文中的 `setup`、`models` 和 `doctor` 示例适用于当前源码，以及自身 `--help` 已列出这些命令的发布版 package；较早的已发布版本可能尚未包含它们。使用源码时，请把命令开头的 `copilot-proxy` 替换为 `bun run ./src/main.ts`。

## 运行预设

| 预设 | 默认值 | 适用场景 |
| --- | --- | --- |
| `personal` | `127.0.0.1`；并发 2；队列 8；等待 30 秒 | 一名本地用户的推荐前台预设，也是 setup 默认值 |
| `service` | `127.0.0.1`；并发 4；队列 32；等待 30 秒 | 长期运行的本地私有服务 |
| `gateway-upstream` | `0.0.0.0`；并发 4；队列 50；等待 30 秒 | 只能通过认证网关访问的私有后端 |
| `custom` | `127.0.0.1`；默认不限制并发 | 由专家自行设置主机和限流参数 |

```sh
copilot-proxy start
copilot-proxy start --preset service
copilot-proxy start --preset custom --max-concurrency 3 --max-queue 10
```

不带 preset 的 `start` 默认使用 `custom`，保留引入 preset 之前版本的无限制行为。setup 会为新的本地配置输出显式带 `--preset personal` 的命令。旧版原生服务和已经包含并发参数的命令也继续按 `custom` 解释；只有显式 `--preset` 才会采用预设值。限流器在整个身份范围内生效，租约会一直持有到上游响应正文或流结束或被取消。

`gateway-upstream` 是部署约定，不代表可以公开暴露服务。该预设还要求设置 `COPILOT_PROXY_ALLOWED_HOSTS`，详见[认证私有网关](deployment.zh-CN.md#认证私有网关)。

## 模型检查

```sh
copilot-proxy models --client all
copilot-proxy models --client claude
copilot-proxy models --client codex --json
copilot-proxy models --client openai-sdk
```

该命令会认证并读取所选 `--account-type` 的当前模型目录。表格同时显示 `direct` 直连路由和有界的 `translated` 翻译路由，以及成熟度、限制和部分功能标志；JSON 输出增加精简的路由 source、target 与 reason code。setup 更严格，只会配置当前可用的**直连**路由。`models` 和 diagnostics 都会省略 `model_picker_enabled=false` 的条目。

`models` 与 setup 共享这个 picker-enabled 和实时路由可见性基线，但候选集不一定相同。`setup codex` 还要求本机 Codex 不低于 0.134.0，并将直连 Responses 候选与 bundled catalog 中具备可用 `base_instructions` 和 `context_window` metadata 的条目取交集。`models --client codex` 不检查本机 bundled catalog，因此可能展示当前机器上的 setup 无法配置的特定传输模型或 metadata 缺失模型。面向兼容性的 `/v1/models` 响应仍是独立的客户端契约。提供 `models` 的发布版会在 npm package 和 Docker 镜像中包含 `models --json` 返回的相对文档路径。

这些信息表示当前路由是否可用，并不代表所有语义均受支持。路由定义见[协议兼容性](protocol-compatibility.zh-CN.md)，实时验证方法见[Copilot 能力验证](copilot-capability-validation.md)。

## Doctor

```sh
copilot-proxy doctor \
  --endpoint http://127.0.0.1:4399 \
  --client all
```

doctor 会检查连通性、就绪状态、令牌生命周期、恢复状态、并发、模型可用性、客户端候选模型和用量接口。请传入服务基础地址，不要传入 `/diagnostics` 路径。可用 `--client claude`、`codex` 或 `openai-sdk` 缩小模型检查范围，也可用 `--json` 供自动化处理。每个诊断请求默认最多等待 10 秒；可通过 `--timeout-ms <ms>` 设置其他正数且有界的超时时间。

检查失败时命令以非零状态退出。如果旧版服务没有 `/diagnostics`，doctor 会把回退结果标记为旧版且不完整，而不会把它视为完整证据。

## 诊断与状态面板

| 入口 | 用途 |
| --- | --- |
| `GET /livez` | 仅检查进程存活 |
| `GET /readyz` | 被动检查认证、模型状态、恢复和并发状态 |
| `GET /diagnostics` | 汇总运行状态、精简模型路由和用量快照；可能填充用量缓存 |

```sh
curl http://127.0.0.1:4399/diagnostics
```

`/diagnostics` 不会刷新凭据或运行模型探针，但不保证对上游完全被动：usage cache miss 时可能请求当前配额并更新短期用量缓存。它不会返回 bearer token、提示词或下游用户密钥。需要严格被动的 readiness 时使用 `/readyz`。

如果定时模型目录刷新失败，代理会保留最后一次成功快照继续服务已有路由，而不会清空目录。此时 `/readyz` 仍保持运行就绪，但会增加 `model_catalog_stale` warning 和目录生命周期时间；`/diagnostics`、面板与 `doctor` 会把该 warning 显示为降级或提示状态，直到后续刷新成功。面板会把保留的模型矩阵明确标为陈旧，不会再把诊断文档生成时间当成目录刷新时间；完全没有目录仍是硬性 readiness 失败。

默认监听地址可以打开[托管诊断面板](https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics)。`start` 会根据当前监听地址输出对应的托管页面 URL，并将 `/diagnostics` endpoint 编码到 `endpoint` query 参数中；Windows 开发启动器只会在确认当次服务实例就绪后打开该 URL。原始 `/diagnostics` 路由是 JSON API，不是 HTML 面板。

托管面板是独立的远程 GitHub Pages origin，不属于本地代理的信任边界。打开该 URL 会把完整的 `endpoint` query 参数发送给 GitHub Pages，该 URL 还可能保留在浏览器历史或基础设施日志中；之后页面才让浏览器请求本地诊断 endpoint。如果 endpoint 主机名也不能泄露，请不要打开托管页面。URL 中绝不能放入凭据或其他秘密；请改用本地 `curl`、`doctor` 或自行托管的面板副本。

面板与代理版本匹配时，会提供完整的运行状态、模型路由和配额视图。单独部署的面板也兼容 `endpoint` 仍指向 `/usage` 的旧版 CLI 链接，但该兼容模式只显示最小配额摘要，并明确不声称已检查就绪状态、认证、恢复、并发或模型路由。其他面板 schema 仍要求代理版本匹配。面板只发送只读 GET 请求，不提供管理或认证能力；刷新面板仍可能触发上述用量缓存填充。

面板只接受路径精确为 `/diagnostics` 或旧版 `/usage` 的端点（可带一个结尾斜杠），且 URL 不得包含凭据、query 或 fragment。请求不会携带浏览器凭据，遇到重定向也会拒绝而非跟随。

Chrome 142 及更高版本可能通过 [Local Network Access](https://developer.chrome.com/blog/local-network-access) 权限控制托管 HTTPS 面板对 `localhost` 的请求。如果面板明确报告本地网络访问被阻止，请在浏览器的网站设置中允许面板来源访问本地网络，然后重试。只有浏览器通过 Permissions API 明确返回匹配权限的 `denied` 状态时，面板才会显示这项权限指导；不支持的权限名称、尚未决定的权限提示和普通连接失败仍保留通用的连通性提示。可使用 `curl` 或 `copilot-proxy doctor` 独立于浏览器权限验证代理。

## 原生服务管理

请从稳定的全局路径安装，或使用稳定的源码目录。临时包运行器缓存路径不适合开机服务。

```sh
npm i -g @jer-y/copilot-proxy
copilot-proxy auth

# 仅适用于 Linux，需要在未登录时启动服务的场景
sudo loginctl enable-linger "$USER"

copilot-proxy enable
copilot-proxy status
copilot-proxy logs -f
```

`enable` 会在 systemd、launchd 或 Task Scheduler 中安装以前台 `start` 方式运行的服务。新安装默认使用 `service` 预设，可直接配置服务而无需先创建旧 daemon，例如：

```sh
copilot-proxy enable --account-type business --port 4400 --proxy-env
```

只有在同时配置 [API 与配置参考](api-reference.zh-CN.md)所述 `COPILOT_PROXY_ALLOWED_HOSTS` 部署边界时才使用 `--host`。`enable` 也接受 `enable --help` 所列、适合无交互服务的限速、等待策略、详细日志、并发和上游超时选项；对应 clear 选项可移除已持久化的限速、超时、并发或代理选择。再次运行 `enable` 时会保留已安装设置，除非显式传入对应选项。对于安装状态尚未保存并发参数的旧版服务，会继续保留无限制行为，不会静默迁移到某个预设。可通过 `enable --preset personal|service|gateway-upstream|custom` 持久化其他选择。

其余生命周期操作使用 `restart`、`stop` 和 `disable`。

## 旧 daemon 迁移

应用自行管理的 `start -d` 已弃用，只用于迁移。请迁移到原生服务：

```sh
copilot-proxy stop
npm i -g @jer-y/copilot-proxy@latest
copilot-proxy enable
copilot-proxy status
```

迁移后使用 `status`、`logs`、`restart` 和 `stop`。不要再围绕 daemon PID 或日志文件构建自动化。

## 代理环境

环境中的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 默认不受信任。命令需要使用已配置的代理路由时，请添加 `--proxy-env`：

```sh
copilot-proxy start --proxy-env
copilot-proxy enable --proxy-env
copilot-proxy models --client all --proxy-env
copilot-proxy doctor --endpoint https://proxy.internal --proxy-env
```

`--proxy-env` 是显式出口策略；无法建立可用代理路由时会直接失败。代理 URL 可能内嵌用户名或密码。原生服务配置会把该选项及相关代理和 TLS 环境保存在仅所有者可访问的状态中，因此这些状态和复制出的代理 URL 都应按凭据处理。只对受信任的基础设施使用 `--proxy-env`。

分享 setup 输出、日志、`debug --json`、诊断快照或 shell 命令前，请删除 token、API Key、带认证信息的代理 URL、内部 endpoint、用户名和本地文件路径。本地输出只面向其所有者；日志边界的脱敏不代表每份诊断产物都可以公开。详见[安全策略（英文）](../SECURITY.md)。

完整且当前有效的命令与参数列表请查看 `copilot-proxy --help` 和 `copilot-proxy <command> --help`。路由与安全设置摘要见 [API 与配置参考](api-reference.zh-CN.md)。
