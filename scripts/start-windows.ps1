[CmdletBinding()]
param(
    [switch]$AuthenticationPreflightCompleted
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$repositoryRootFromBatch = -not [string]::IsNullOrWhiteSpace(
    $env:COPILOT_PROXY_START_REPOSITORY_ROOT
)
$repositoryRoot = if (-not $repositoryRootFromBatch) {
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
} else {
    (Resolve-Path -LiteralPath $env:COPILOT_PROXY_START_REPOSITORY_ROOT).ProviderPath
}
Remove-Item Env:COPILOT_PROXY_START_REPOSITORY_ROOT -ErrorAction SilentlyContinue

$authExitCode = 0
if (-not $AuthenticationPreflightCompleted) {
    $authProcessStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $authProcessStartInfo.FileName = 'bun.exe'
    $authProcessStartInfo.Arguments = 'run ./src/main.ts auth --_if-needed'
    $authProcessStartInfo.WorkingDirectory = $repositoryRoot
    $authProcessStartInfo.UseShellExecute = $false
    $authProcess = [System.Diagnostics.Process]::Start($authProcessStartInfo)
    try {
        $authProcess.WaitForExit()
        $authExitCode = $authProcess.ExitCode
    } finally {
        $authProcess.Dispose()
    }

    [void]$authProcessStartInfo.EnvironmentVariables.Remove('GH_TOKEN')
    [void]$authProcessStartInfo.EnvironmentVariables.Remove('GITHUB_TOKEN')
    $authProcessStartInfo = $null
}

# Authentication must consume or persist any inherited token before the
# long-lived supervisor, watcher, server, or browser can inherit it.
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
if ($authExitCode -ne 0) {
    exit $authExitCode
}

$instanceToken = [Guid]::NewGuid().ToString('N')
$instanceHeaderName = 'x-copilot-proxy-instance-token'

$readyUrl = if ([string]::IsNullOrWhiteSpace($env:COPILOT_PROXY_START_READY_URL)) {
    'http://127.0.0.1:4399/'
} else {
    $env:COPILOT_PROXY_START_READY_URL
}
$diagnosticsEndpoint = if ([string]::IsNullOrWhiteSpace($env:COPILOT_PROXY_START_DIAGNOSTICS_URL)) {
    'http://localhost:4399/diagnostics'
} else {
    $env:COPILOT_PROXY_START_DIAGNOSTICS_URL
}
$dashboardUrl = 'https://jer-y.github.io/copilot-proxy?endpoint=' +
    [System.Uri]::EscapeDataString($diagnosticsEndpoint)

$timeoutSeconds = 90
$parsedTimeoutSeconds = 0
if ([int]::TryParse($env:COPILOT_PROXY_START_READY_TIMEOUT_SECONDS, [ref]$parsedTimeoutSeconds) -and
    $parsedTimeoutSeconds -ge 1 -and $parsedTimeoutSeconds -le 600) {
    $timeoutSeconds = $parsedTimeoutSeconds
}

$pollIntervalMilliseconds = 250
$parsedPollIntervalMilliseconds = 0
if ([int]::TryParse($env:COPILOT_PROXY_START_READY_POLL_MILLISECONDS, [ref]$parsedPollIntervalMilliseconds) -and
    $parsedPollIntervalMilliseconds -ge 25 -and $parsedPollIntervalMilliseconds -le 5000) {
    $pollIntervalMilliseconds = $parsedPollIntervalMilliseconds
}

$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(1)
$serverProcess = $null
$serverExitCode = 1

try {
    $processStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processStartInfo.FileName = 'bun.exe'
    $processStartInfo.Arguments = "run dev -- --_instance-token $instanceToken"
    $processStartInfo.WorkingDirectory = $repositoryRoot
    $processStartInfo.UseShellExecute = $false
    [void]$processStartInfo.EnvironmentVariables.Remove('GH_TOKEN')
    [void]$processStartInfo.EnvironmentVariables.Remove('GITHUB_TOKEN')
    $serverProcess = [System.Diagnostics.Process]::Start($processStartInfo)
    $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
    $isReady = $false

    while (-not $serverProcess.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        try {
            $response = $client.GetAsync($readyUrl).GetAwaiter().GetResult()
            try {
                $instanceHeaderValues = $null
                $instanceMatches = $response.Headers.TryGetValues(
                    $instanceHeaderName,
                    [ref]$instanceHeaderValues
                ) -and $instanceHeaderValues -contains $instanceToken
                if ($response.IsSuccessStatusCode -and $instanceMatches) {
                    $isReady = $true
                    break
                }
            } finally {
                $response.Dispose()
            }
        } catch {
            # The listener is still starting. Retry until it is ready, exits, or the deadline expires.
        }

        if (-not $serverProcess.HasExited) {
            Start-Sleep -Milliseconds $pollIntervalMilliseconds
        }
    }

    $startupTimedOut = -not $isReady -and -not $serverProcess.HasExited
    if ($startupTimedOut) {
        $serverExitCode = 1
        [Console]::Error.WriteLine(
            "The server did not become ready within $timeoutSeconds seconds. Stopping it."
        )
    }

    if ($isReady -and -not $serverProcess.HasExited) {
        try {
            if ([string]::IsNullOrWhiteSpace($env:COPILOT_PROXY_START_OPEN_LOG)) {
                if ([string]::IsNullOrWhiteSpace($env:COPILOT_PROXY_START_BROWSER_COMMAND)) {
                    Start-Process -FilePath $dashboardUrl
                } else {
                    $browserArguments = if ([string]::IsNullOrWhiteSpace(
                        $env:COPILOT_PROXY_START_BROWSER_ARGUMENT
                    )) {
                        @($dashboardUrl)
                    } else {
                        @($env:COPILOT_PROXY_START_BROWSER_ARGUMENT, $dashboardUrl)
                    }
                    Start-Process -FilePath $env:COPILOT_PROXY_START_BROWSER_COMMAND `
                        -ArgumentList $browserArguments
                }
            } else {
                [System.IO.File]::WriteAllText(
                    $env:COPILOT_PROXY_START_OPEN_LOG,
                    $dashboardUrl,
                    [System.Text.UTF8Encoding]::new($false)
                )
            }
        } catch {
            Write-Warning "The diagnostics dashboard could not be opened: $($_.Exception.Message)"
        }
    }

    if (-not $startupTimedOut) {
        $serverProcess.WaitForExit()
        $serverExitCode = $serverProcess.ExitCode
    }
} finally {
    $client.Dispose()

    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        try {
            & taskkill.exe /PID $serverProcess.Id /T /F 2>&1 | Out-Null
        } catch {
            # Preserve the launcher's original failure when the child exits
            # between the HasExited check and taskkill.
        }
        if (-not $serverProcess.HasExited) {
            $serverProcess.WaitForExit()
        }
    }
}

exit $serverExitCode
