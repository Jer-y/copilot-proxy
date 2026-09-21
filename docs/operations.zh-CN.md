[English](operations.md) | 简体中文

# 运维

下文使用已安装的 `copilot-proxy`；源码运行时换为 `bun run ./src/main.ts`。安装与版本选择见[入门指南](getting-started.zh-CN.md#1-选择安装路径)，网络暴露要求见[部署](deployment.zh-CN.md)。

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

不带 preset 的 `start` 默认使用 `custom`，保留引入 preset 之前版本的无限制行为。setup 会为新的本地配置输出显式带 `--preset personal` 的命令。旧版原生服务和已经包含并发参数的命令也继续按 `custom` 解释；只有显式 `--preset` 才会采用预设值。全局限流租约会一直持有到上游响应正文或流结束或被取消。账号另有 `maxConcurrency` 时，先获取账号租约再获取全局租约，避免一个繁忙账号在等待自身槽位时占住全局容量。

`gateway-upstream` 是部署约定，不代表可以公开暴露服务。该预设还要求设置 `COPILOT_PROXY_ALLOWED_HOSTS`，详见[认证私有网关](deployment.zh-CN.md#认证私有网关)。

## 多个 Copilot 账号

多账号模式面向一个可信操作者管理名下的多个 GitHub Copilot 身份。它提供确定性路由，不提供多租户、负载均衡、配额池化或自动故障转移。

从尚未支持多账号 runtime lock 的构建升级后，首次执行会修改配置的 `accounts` 命令前，必须停止或重启所有由旧构建启动的前台 proxy。已安装的原生服务会被检测并按事务重启，但旧前台进程无法发布 `runtime.lock`；继续运行会让它仍使用旧的单账号内存状态。

```sh
# Device flow
copilot-proxy accounts add personal --account-type individual
copilot-proxy accounts add work --account-type enterprise

# 安全地从 stdin 提供已有 token，避免进入 argv
printf '%s\n' "$TOKEN" | copilot-proxy accounts auth work --token-stdin --yes

copilot-proxy accounts default personal --yes
copilot-proxy accounts route set 'claude-*' work --yes
copilot-proxy accounts route set 'gpt-5*' personal --yes
copilot-proxy accounts list
copilot-proxy accounts route list

# 可选的账号级并发与启动/readiness 必需路由
copilot-proxy accounts concurrency set work 2 --yes
copilot-proxy accounts required-route set responses-http gpt-5.4 --yes
copilot-proxy accounts required-route list
```

`accounts.json` 与 `tokens/<account-id>` 保存在原有的仅所有者可访问数据目录中。账号 ID 必须为小写，最长 32 个字符，只能包含字母、数字、`_` 与 `-`；最多配置八个账号。`--token-stdin` 最多读取 8 KiB，只移除一个结尾换行，并拒绝空值或含空白的输入。存在 `accounts.json` 时，早期 `--github-token` bootstrap 会明确拒绝；请改用 `accounts auth <id>`。

`accounts concurrency set <id> <max>` 保存一个正整数账号级 `maxConcurrency`；`accounts concurrency clear <id>` 会移除这个更窄的限制。未设置时，该账号没有独立限制器，但仍受已配置的全局限制器约束。账号级限制器使用默认的有界队列：最多等待 50 个请求，最长等待 30 秒。

`accounts required-route set <surface> <model>` 把所选模型路由设为启动与 readiness 必需项；它不会增加 fallback 或账号切换。支持的 surface 为 `responses-http`、`responses-websocket`、`anthropic-messages`、`chat-completions` 和 `embeddings`，账号仍由该模型的正常静态路由决定；set 操作会在提交前验证最终必需路由的能力。使用完全相同的 pair 执行 `accounts required-route remove <surface> <model>`，并通过 `accounts required-route list [--json]` 查看已配置门槛。

请求选择顺序为：

1. 已经 pin 的 Responses WebSocket 账号。
2. `x-copilot-account: <id>`。
3. `<account-id>/<model-id>` 模型前缀。
4. `accounts.json` 中第一条命中的 glob 规则。
5. `defaultAccount`。

显式 selector 冲突时返回 `409`。静态绑定账号不可用时返回 `503`，不会扫描其他账号。Responses WebSocket 默认在首个 `response.create` 选择账号；Upgrade 已提供 `x-copilot-account` 时会预先 pin，随后整个连接不换账号。

`GET /readyz?account=<id>` 只检查指定账号。普通 `/readyz` 会返回安全的逐账号 availability、身份校验状态、token/recovery 状态以及全局/账号级并发；默认不会通过 HTTP 返回 GitHub login 或数值 user ID。只有显式设置 `COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY=1`（或前台 `start --expose-account-identity`）才暴露身份。`COPILOT_PROXY_EXPOSE_ACCOUNT_MODELS=1` 或 `start --expose-account-models` 只为非 Codex 模型列表增加 `<account>/<model>` 别名。

账号、路由、并发和必需路由写操作使用仅所有者可访问的排他锁和原子文件。原生服务运行时，CLI 会重启服务、探测受影响账号与整体 readiness，并在失败时恢复磁盘状态。相同 data-dir 中若运行的是前台 proxy，必须先停止。原生服务使用自定义 data-dir 时，`accounts` 与 `auth --account` 默认操作已安装服务的目录；如需管理独立实例，请显式设置 `COPILOT_PROXY_DATA_DIR`。第二个 proxy 不能复用同一 data-dir。

## 模型检查

```sh
copilot-proxy models --client all
copilot-proxy models --account work --client codex --json
copilot-proxy check-usage --account work
```

存在 `accounts.json` 时，两条命令默认使用 `defaultAccount`；`--account <id>` 选择其他账号。它们按记录的数值 GitHub identity 验证持久 token，不回退到旧版 `github_token` 或 Device Flow。没有该文件时，`models --account-type` 与单账号认证含义不变。

`models` 展示所选账号的实时目录，包括只能显式选择账号访问的模型，不局限于无前缀路由绑定。用 `--client claude|codex|openai-sdk` 筛选；输出包含直连/不支持路由、成熟度、限制及功能标志。JSON 还包含账号 ID/类型、路由 source/reason code，以及随 npm 和 Docker 分发的文档路径。models 和 diagnostics 均省略 `model_picker_enabled=false`。

setup 共享原生路由基线，但 `setup codex` 还检查本机内置 `base_instructions` 和 `context_window` metadata，因此 `models --client codex` 可能列出 setup 无法配置的模型。HTTP `/v1/models` 另按账号路由绑定和 [Codex 传输筛选](protocol-compatibility.zh-CN.md#websocket-上的-responses)生成目录，不是静态模型表。目录资格不证明功能语义。

## Doctor

```sh
copilot-proxy doctor --endpoint http://127.0.0.1:4399 --client all
```

- 传入服务基础 URL，而不是 `/diagnostics` 路径。doctor 检查就绪状态、令牌生命周期、恢复、并发、客户端模型可用性和用量。
- 按需使用 `--client claude|codex|openai-sdk` 及 `--json`。默认超时 10 秒，`--timeout-ms <ms>` 接受正数且有界的覆盖值。
- 必要检查失败时非零退出。缺少 `/diagnostics`（`404`）时退出码为 `1`，不回退到其他端点；请检查基础 URL、反代或升级服务端。JSON 的 `mode: "full"` 表示报告格式，不表示成功。

## 诊断与状态面板

| 入口 | 用途 |
| --- | --- |
| `GET /livez` | 仅检查进程存活 |
| `GET /readyz` | 被动检查认证、模型、恢复和并发的就绪状态 |
| `GET /diagnostics` | 汇总运行状态、模型路由和用量快照 |

```sh
curl http://127.0.0.1:4399/diagnostics
```

`/diagnostics` 不返回凭据或提示词，也不刷新 token 或探测模型，但用量缓存未命中时可能请求上游配额。严格被动检查用 `/readyz`。这些端点及 `/v1/models`、`/usage` 均保持独立。

目录刷新失败时保留最后有效快照：`/readyz` 仍就绪并带 `model_catalog_stale` 和生命周期时间；diagnostics、doctor 与面板显示警告/降级视图，直到刷新成功。面板使用目录新鲜度，而非诊断文档时间。缺少目录是硬性就绪失败。

可打开[托管诊断面板](https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics)，或使用 `start` 输出的当前监听器链接。Windows 启动器只在自身实例就绪后打开它。`/diagnostics` 本身是 JSON API，不是 HTML 面板。

托管页面会把 endpoint URL 发给 GitHub Pages，并通过浏览器读取诊断。URL 中不得放入秘密；不能接受该披露时，用本地 `doctor`/`curl` 或自托管副本。详见[诊断隐私](../SECURITY.md#diagnostics-privacy)。

- 面板应匹配代理版本。它只发送 GET，没有管理或认证能力，但可能触发上述用量缓存填充。
- endpoint 必须精确使用 `/diagnostics`（可带结尾斜杠），不得包含凭据、query 或 fragment。请求省略浏览器凭据并拒绝重定向。旧链接见[升级清单](#v0100-之后的升级变更)。
- Chrome 142+ 可能要求 [Local Network Access](https://developer.chrome.com/blog/local-network-access)。明确提示被阻止时，在面板来源设置中允许该权限。只有匹配的 Permissions API `denied` 状态才显示专门指导；不支持/未决定的权限或普通失败使用通用连通性提示。可用本地 doctor 或 curl 独立验证。

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

`enable` 会在 systemd、launchd 或 Task Scheduler 中安装以前台 `start` 方式运行的服务。新安装默认使用 `service` 预设，可直接配置服务，例如：

```sh
copilot-proxy enable --account-type business --port 4400 --proxy-env
```

只有在同时配置 [API 与配置参考](api-reference.zh-CN.md)所述 `COPILOT_PROXY_ALLOWED_HOSTS` 部署边界时才使用 `--host`。`enable` 也接受 `enable --help` 所列、适合无交互服务的限速、等待策略、详细日志、并发和上游超时选项；对应 clear 选项可移除已持久化的限速、超时、并发或代理选择。再次运行 `enable` 时会保留已安装设置，除非显式传入对应选项。对于安装状态尚未保存并发参数的旧版服务，会继续保留无限制行为，不会静默迁移到某个预设。可通过 `enable --preset personal|service|gateway-upstream|custom` 持久化其他选择。

其余生命周期操作使用 `restart`、`stop` 和 `disable`。

## v0.10.0 之后的升级变更

以下对比 v0.10.0 与当前源码修订版，不表示新版本已经发布。升级前以目标包的随包文档为准；现有账号文件和凭据不会重置。

| 变更 | 操作 |
| --- | --- |
| 移除 Messages ↔ Responses 翻译 | 选择支持客户端原生 API 的模型；不兼容组合在本地失败，见[协议迁移](protocol-compatibility.zh-CN.md#从跨协议路由迁移)。 |
| 移除静态模型/能力回退 | 用 `copilot-proxy models --client all --json` 检查（显式账号加 `--account <id>`），解决认证或目录失败，见[动态目录](protocol-compatibility.zh-CN.md#动态模型目录)。 |
| 拒绝 `--manual` 与已保存的 `manual: true` | 只有接受无人值守转发后，才移除参数或设为 `manual: false`；不再提供逐请求审批。 |
| 移除 `start --claude-code` / `start -c` | 运行 `copilot-proxy setup claude` 并按输出操作，需要时才加 `--copy`，见[setup](getting-started.zh-CN.md#2-使用-setup-验证代理路由)。 |
| Doctor 要求 `/diagnostics` | 检查基础 URL、反代或升级服务端；不再进行旧式多端点回退，见 [Doctor](#doctor)。 |
| 退役明文诊断：`/token`、`--show-token`、`COPILOT_PROXY_EXPOSE_TOKEN`、`showToken` | 移除退役参数/设置，改用 `doctor` 或 `/diagnostics`，不再输出 token；见 [API 参考](api-reference.zh-CN.md#路由)及下方旧设置处理规则。 |
| 托管 Dashboard 拒绝 `/usage` 链接 | 把 endpoint 路径改为 `/diagnostics`；服务端 `/usage` API 保留，见[面板](#诊断与状态面板)。 |
| 移除本地 token usage 估算 | 上游 usage 缺失时按不可用处理，见[用量](protocol-compatibility.zh-CN.md#用量)。 |
| 移除通用 Anthropic `document.source` 适配 | 本地文本用 text 或 `tool_result`；PDF 和 token counting 按[文档边界](api-reference.zh-CN.md#claude-code-文档边界)处理。 |

退役的 `--manual`、`--show-token` 和 `start --claude-code`/`-c` 参数在认证或持久化 token 前报错。旧设置：`manual: false` 仍可读取，`manual: true` 报错；历史 `showToken` 布尔值会被丢弃，开启值会警告；退役环境选项被忽略，开启时警告。读取不改写文件，退役字段在下次正常保存时省略。

检查启动参数、服务设置与客户端配置后，运行 `copilot-proxy models --client <client> --json`、`copilot-proxy doctor --endpoint <base-url> --client <client>`，并完成真实客户端回合。替换实际客户端和基础 URL；源码运行使用 `bun run ./src/main.ts`。目录和健康检查不能代替真实请求或工具循环。更早的服务还需执行 [pre-v0.10.0 迁移](#从-v0100-之前的安装升级)。

## 从 v0.10.0 之前的安装升级

如果旧版本仍使用应用自行管理的 daemon，或原生服务安装状态尚未保存完整配置，请先升级到最后一个支持迁移的版本并刷新原生服务状态：

```sh
npm i -g @jer-y/copilot-proxy@0.9.3
copilot-proxy enable
copilot-proxy status
npm i -g @jer-y/copilot-proxy@0.10.0
copilot-proxy restart
copilot-proxy status
```

`v0.10.0` 不再运行 `start -d`，也不再使用 daemon PID 文件。上面的 v0.9.3 `enable` 步骤会在旧运行时被移除前写入完整的原生服务控制状态。如果已经先安装了 v0.10.0，只有当控制状态缺少配置时，`enable` 和 `restart` 才会把通过校验的 `daemon.json` 作为迁移回退读取；请运行 `enable` 将迁移后的配置持久化。之后只使用 `enable`、`status`、`logs`、`restart`、`stop` 和 `disable`。

## 代理环境

环境中的代理变量默认不生效，每条命令通过 `--proxy-env` 显式启用：

```sh
copilot-proxy start --proxy-env
copilot-proxy enable --proxy-env
copilot-proxy accounts add work --account-type enterprise --proxy-env
copilot-proxy accounts auth work --proxy-env
copilot-proxy models --client all --proxy-env
copilot-proxy doctor --endpoint https://proxy.internal --proxy-env
```

启用后使用 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，无法建立可用代理路由时直接失败。账号 add/auth 独立执行身份、token 和目录检查，原生服务保存的代理选项不会自动应用到这些 CLI 命令。

服务配置把代理/TLS 设置保存在仅所有者可访问的文件中。该文件和带认证信息的代理 URL 都是凭据；只使用可信基础设施，分享输出前遵循[安全策略](../SECURITY.md)。

完整参数见 `copilot-proxy <command> --help`；路由与环境字段见 [API 参考](api-reference.zh-CN.md)。
