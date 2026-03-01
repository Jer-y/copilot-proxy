# Process Daemon Design

## Overview

为 copilot-proxy 添加跨平台（Linux / macOS / Windows）进程守护功能，包括后台运行、崩溃自动重启、开机自启注册。纯应用内实现，零额外依赖。

## CLI 命令

在现有子命令基础上扩展：

| 命令 | 说明 |
|------|------|
| `copilot-proxy start` | 前台运行（现有行为，不变） |
| `copilot-proxy start -d` | 后台运行，启动参数持久化 |
| `copilot-proxy stop` | 停止后台服务 |
| `copilot-proxy restart` | 用持久化参数重启后台服务 |
| `copilot-proxy status` | 查看服务状态（PID / uptime / 端口） |
| `copilot-proxy logs [-f]` | 查看日志，`-f` 实时跟踪 |
| `copilot-proxy enable` | 注册开机自启 |
| `copilot-proxy disable` | 移除开机自启 |

### 参数传递

`start -d` 接受与 `start` 相同的所有参数（`--port`、`--github-token`、`--account-type` 等），这些参数会：
1. 透传给实际服务子进程
2. 持久化到 `daemon.json`，供 `restart` 和 `enable` 使用

`--claude-code` 在 daemon 模式下禁用（需要交互式选择模型）。

## 数据存储

复用现有的 `~/.local/share/copilot-proxy/` 目录（`PATHS.APP_DIR`）：

```
~/.local/share/copilot-proxy/
├── github_token        # 已有
├── daemon.pid          # 后台进程 PID
├── daemon.log          # 日志输出（stdout + stderr）
└── daemon.json         # 持久化启动参数
```

### daemon.json 格式

```json
{
  "port": 4399,
  "verbose": false,
  "accountType": "individual",
  "manual": false,
  "rateLimit": null,
  "rateLimitWait": false,
  "githubToken": "ghu_xxxx",
  "showToken": false,
  "proxyEnv": false
}
```

## 后台运行架构

### 进程模型

```
[copilot-proxy start -d]  (主进程，立即退出)
       │
       └── spawn(detached, stdio -> daemon.log)
              │
              [supervisor 循环]
                    │
                    └── 实际服务进程 (runServer)
```

具体实现：

1. **主进程**（`start -d`）：
   - 验证没有已运行的 daemon（检查 PID 文件 + 进程存活）
   - 将启动参数序列化到 `daemon.json`
   - `child_process.spawn` 启动 supervisor 进程，设置 `detached: true`，stdout/stderr 重定向到 `daemon.log`
   - 写入 `daemon.pid`
   - `unref()` 后退出

2. **Supervisor 进程**（`copilot-proxy start --_supervisor`）：
   - 这是一个内部隐藏标志，用户不直接使用
   - 读取 `daemon.json`，调用 `runServer()`
   - 捕获未处理异常和 unhandled rejection，记录日志后自动重启
   - 重启带指数退避：1s → 2s → 4s → ... → 最大 60s
   - 连续成功运行超过 60s 后重置退避计数器
   - 监听 SIGTERM / SIGINT，优雅关闭后删除 PID 文件

### 优雅关闭

在 supervisor 进程中添加信号处理：

```
SIGTERM / SIGINT
  → 停止接受新连接
  → 等待进行中的请求完成（最长 10s）
  → 清理 PID 文件
  → 退出
```

## Token 刷新容错

当前 `setupCopilotToken` 中 token 刷新失败会 `throw`，导致进程崩溃。改为：

- 刷新失败时 `consola.error` 记录错误，保留旧 token 继续使用
- 下一个刷新周期再重试
- 移除 `throw error`

这个改动不论是否做 daemon 都应该做，属于应用层容错。

## 开机自启

### Linux (systemd user service)

`enable` 命令生成并安装：

```ini
# ~/.config/systemd/user/copilot-proxy.service
[Unit]
Description=Copilot API Proxy
After=network-online.target

[Service]
ExecStart=/path/to/copilot-proxy start --_supervisor
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

然后执行：
```bash
systemctl --user daemon-reload
systemctl --user enable copilot-proxy
systemctl --user start copilot-proxy
loginctl enable-linger $USER  # 确保用户不登录时服务也运行
```

`disable` 命令执行反向操作。

注意：当通过 systemd 管理时，systemd 自身提供了 `Restart=on-failure`，所以 supervisor 的重启逻辑会与 systemd 协同工作而非冲突。supervisor 处理应用级异常重启，systemd 处理进程级崩溃重启。

### macOS (launchd)

`enable` 命令生成并安装：

```xml
<!-- ~/Library/LaunchAgents/com.copilot-proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.copilot-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/copilot-proxy</string>
        <string>start</string>
        <string>--_supervisor</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>~/.local/share/copilot-proxy/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>~/.local/share/copilot-proxy/daemon.log</string>
</dict>
</plist>
```

然后 `launchctl load`。`disable` 执行 `launchctl unload` + 删除 plist。

### Windows (Task Scheduler)

`enable` 命令通过 `schtasks` 创建登录触发的任务：

```powershell
schtasks /create /tn "CopilotProxy" /tr "copilot-proxy start --_supervisor" /sc onlogon /rl limited
```

`disable` 命令执行 `schtasks /delete /tn "CopilotProxy" /f`。

### 平台检测

通过 `process.platform` 判断：
- `linux` → systemd
- `darwin` → launchd
- `win32` → schtasks

对于 Linux，额外检测 systemd 是否可用（`which systemctl`），不可用时提示用户手动配置。

## 各命令实现细节

### `stop`

1. 读取 `daemon.pid`
2. 检查进程是否存活（`process.kill(pid, 0)`）
3. 发送 `SIGTERM`
4. 等待进程退出（轮询，最长 10s）
5. 超时则 `SIGKILL`
6. 清理 PID 文件

Windows 上使用 `taskkill /PID <pid>` 替代信号。

### `status`

1. 读取 `daemon.pid`，检查进程是否存活
2. 如果存活：显示 PID、端口（从 `daemon.json` 读取）、启动时间（PID 文件的 mtime）
3. 如果未运行：提示 "Service is not running"

### `logs`

1. 无 `-f`：读取 `daemon.log` 最后 50 行输出
2. 有 `-f`：使用 `fs.watch` 或 `tail -f` 跟踪日志（Windows 上用 `fs.watch`）

### `restart`

1. 执行 `stop` 逻辑
2. 读取 `daemon.json`
3. 以持久化参数执行 `start -d` 逻辑

## 文件结构

新增文件：

```
src/
├── daemon/
│   ├── start.ts        # daemon start 逻辑（fork + detach）
│   ├── stop.ts         # stop 逻辑
│   ├── status.ts       # status 逻辑
│   ├── logs.ts         # logs 逻辑
│   ├── restart.ts      # restart 逻辑
│   ├── enable.ts       # 开机自启注册
│   ├── disable.ts      # 移除开机自启
│   └── supervisor.ts   # supervisor 包装层（崩溃重启 + 信号处理）
├── lib/
│   └── paths.ts        # 扩展：添加 DAEMON_PID, DAEMON_LOG, DAEMON_JSON 路径
```

修改文件：

```
src/main.ts             # 注册新子命令
src/start.ts            # 添加 -d / --daemon 参数，添加 --_supervisor 内部标志
src/lib/token.ts        # token 刷新失败容错（移除 throw）
```

## 不在范围内

- 日志轮转（日志文件过大时用户自行处理或后续迭代）
- 多实例管理（只支持单个 daemon 实例）
- Web 管理界面
- 配置文件热重载
