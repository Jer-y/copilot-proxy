[CmdletBinding()]
param(
    [string]$UncRoot = $env:COPILOT_PROXY_WINDOWS_UNC_ROOT
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'The Windows UNC launcher gate must run on Windows.'
}

$sourceRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
}
else {
    [System.IO.Path]::GetTempPath()
}
$runId = [Guid]::NewGuid().ToString('N')
$stageRoot = Join-Path $temporaryRoot "copilot-proxy-unc-stage-$runId"
$markerPath = Join-Path $temporaryRoot "copilot-proxy-unc-marker-$runId.json"
$shareName = "copilot-proxy-unc-$runId"
$createdShare = $false
$previousRequireMarker = $env:COPILOT_PROXY_TEST_REQUIRE_WINDOWS_UNC
$previousMarkerPath = $env:COPILOT_PROXY_TEST_WINDOWS_UNC_MARKER

function Assert-RealUncPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not $Path.StartsWith('\\')) {
        throw "Expected a real UNC path, received: $Path"
    }
}

try {
    if ($UncRoot) {
        Assert-RealUncPath -Path $UncRoot
        $testRoot = $UncRoot.TrimEnd('\')
    }
    else {
        New-Item -ItemType Directory -Path (Join-Path $stageRoot 'tests') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $stageRoot 'scripts') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'start.bat') -Destination (Join-Path $stageRoot 'start.bat')
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\start-windows.ps1') -Destination (Join-Path $stageRoot 'scripts\start-windows.ps1')
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'tests\start-bat.test.ts') -Destination (Join-Path $stageRoot 'tests\start-bat.test.ts')

        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        New-SmbShare `
            -Name $shareName `
            -Path $stageRoot `
            -FullAccess $identity `
            -CachingMode None `
            -FolderEnumerationMode AccessBased `
            -Temporary | Out-Null
        $createdShare = $true
        $testRoot = "\\$env:COMPUTERNAME\$shareName"
    }

    Assert-RealUncPath -Path $testRoot
    $testFile = "$testRoot\tests\start-bat.test.ts"
    if (-not (Test-Path -LiteralPath $testFile)) {
        throw "UNC launcher test file is not accessible: $testFile"
    }

    $env:COPILOT_PROXY_TEST_REQUIRE_WINDOWS_UNC = '1'
    $env:COPILOT_PROXY_TEST_WINDOWS_UNC_MARKER = $markerPath
    $bun = (Get-Command bun.exe -ErrorAction Stop).Source
    & $bun test $testFile
    if ($LASTEXITCODE -ne 0) {
        throw "Windows UNC launcher tests failed with exit code $LASTEXITCODE."
    }

    if (-not (Test-Path -LiteralPath $markerPath)) {
        throw 'Windows UNC launcher test did not write its non-skip evidence marker.'
    }
    $evidence = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($evidence.status -ne 'passed' -or $evidence.platform -ne 'win32') {
        throw 'Windows UNC launcher evidence marker did not report a passing Windows run.'
    }
    $moduleDirectory = [string]$evidence.testModuleDirectory
    Assert-RealUncPath -Path $moduleDirectory

    Write-Output "windows_unc_launcher_test=passed module_directory=$moduleDirectory"
}
finally {
    $env:COPILOT_PROXY_TEST_REQUIRE_WINDOWS_UNC = $previousRequireMarker
    $env:COPILOT_PROXY_TEST_WINDOWS_UNC_MARKER = $previousMarkerPath
    if ($createdShare) {
        Remove-SmbShare -Name $shareName -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stageRoot -Force -Recurse -ErrorAction SilentlyContinue
}
