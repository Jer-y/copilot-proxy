[English](deployment.md) | 简体中文

# 部署

copilot-proxy 使用一个 GitHub Copilot 身份，且没有下游用户认证。更改监听地址前，请先从[产品支持矩阵](product-support.zh-CN.md#部署支持矩阵)选择合适的拓扑。

## 本机回环地址

默认支持一名受信任用户通过回环地址使用：

```sh
copilot-proxy start --preset personal
```

该命令绑定 `127.0.0.1`，并在整个身份范围内应用有界并发。凭据和应用数据目录应仅对当前操作系统用户可见。为客户端生成的占位 API Key 只用于通过客户端格式校验，不构成安全边界。

如果同一个私有监听器需要跨终端和登录会话运行，请通过原生服务使用 `service` 预设，详见[运维](operations.zh-CN.md#原生服务管理)。

## 本地 Docker

只把容器端口发布到主机回环地址，并将认证状态持久化到镜像之外：

```sh
docker build -t copilot-proxy .
docker volume create copilot-proxy-data
docker run \
  -p 127.0.0.1:4399:4399 \
  -v copilot-proxy-data:/home/bun/.local/share/copilot-proxy \
  copilot-proxy start --preset personal --host 0.0.0.0
```

进程在容器内绑定所有接口，供 Docker 转发流量；主机端只发布到回环地址。不要把主机映射改为 `0.0.0.0:4399` 后直接共享。

## 认证私有网关

有条件支持的共享拓扑为：

```text
客户端 -> 认证网关 -> 私有 copilot-proxy -> GitHub Copilot
```

网关必须负责用户、API Key、授权、每用户配额、模型权限、审计、计费和下游限流。copilot-proxy 仍是使用单一身份的私有上游。

一个具体的网关选择是 [New API](https://github.com/QuantumNous/new-api)。可将 copilot-proxy 配置为它的私有 OpenAI 兼容上游（例如 `http://copilot-proxy:4399/v1`），并只向客户端暴露 New API。这只是拓扑示例，并非对兼容性或安全性的全面保证；下列要求仍需全部满足。

将网关私有链路实际使用的非回环 Host 值设置为逗号分隔的允许列表，再启动私有后端：

```sh
export COPILOT_PROXY_ALLOWED_HOSTS=proxy.internal
copilot-proxy start --preset gateway-upstream
```

整个允许列表必须有效并至少包含一个非回环主机名或 IP 地址，否则该预设会直接失败。scheme、端口、路径、wildcard、空条目和仅含 loopback 的列表都无效。主机名经过规范化后匹配；网关必须在 HTTP `Host` header 中实际发送列表内的值。使用多个内部名称时，应逐一列出。

部署还必须：

- 通过网络限制确保只有网关能访问 copilot-proxy；
- 在网关认证并授权每个外部客户端；
- 在可信边界终止 TLS，并按环境要求保护私有链路；
- 在网关执行每用户限流，在 copilot-proxy 执行身份级最终限流；
- 避免重试风暴：不要盲目重试上游 `403` 或 `429`，并遵守代理在本地熔断打开时返回的 `503`、`Retry-After` 与 `X-Copilot-Proxy-Recovery-State`；
- 保留客户端所需的协议与模型目录查询行为；
- 阻止不受信任方访问诊断和令牌相关入口；
- 负责日志、审计留存、事件响应、更新、备份和可用性目标。

任何一项缺失，都会使部署变成不受支持的直接共享，而非受支持的私有网关。

同一熔断状态也会反映在 `/readyz`：全局恢复熔断器打开时，就绪检查会带 `Retry-After` 返回 `503`。网关应传递或遵守该退避时间，不要循环重启代理，或反复切换身份和端点。

## 监听器与浏览器安全

- 保持 `COPILOT_PROXY_EXPOSE_TOKEN` 未设置。`/token` 默认禁用，也不是认证入口。如果该变量进入原生服务环境，它会跨重启持续生效，直到删除持久化设置。
- 仅在确有需要时，将准确的非本地浏览器来源加入 `COPILOT_PROXY_CORS_ORIGINS`。
- 将准确的非回环请求主机名加入 `COPILOT_PROXY_ALLOWED_HOSTS`；它不能代替认证。
- 不要把 `--show-token` 输出持久化到共享日志。
- 后台服务不要使用交互式 `--manual` 审批。
- 将 `/diagnostics` 和托管状态面板视为可见性工具，而非访问控制入口。

运行预设和服务生命周期见[运维](operations.zh-CN.md)。网关不会改变协议行为，详见[协议兼容性](protocol-compatibility.zh-CN.md)。暴露任何监听器前，请阅读[安全策略（英文）](../SECURITY.md)。
