import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const WINDOWS_ACL_TARGETS_ENV = 'COPILOT_PROXY_OWNER_ONLY_ACL_TARGETS'

export interface OwnerOnlyPathTarget {
  path: string
  directory?: boolean
}

const hardenedWindowsDirectories = new Map<string, string>()

const WINDOWS_OWNER_ONLY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $serializedTargets = [Environment]::GetEnvironmentVariable('${WINDOWS_ACL_TARGETS_ENV}', 'Process')
  if ([String]::IsNullOrWhiteSpace($serializedTargets)) {
    throw 'Owner-only ACL targets are unavailable.'
  }
  $payload = $serializedTargets | ConvertFrom-Json

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User) {
    throw 'Current Windows identity has no security identifier.'
  }

  $sid = $identity.User.Value
  foreach ($entry in @($payload.targets)) {
    $targetPath = [string]$entry.path
    $isDirectory = [bool]$entry.directory
    if ([String]::IsNullOrWhiteSpace($targetPath)) {
      throw 'An owner-only ACL target path is unavailable.'
    }

    $aceFlags = if ($isDirectory) { 'OICI' } else { '' }
    $acl = if ($isDirectory) {
      [System.Security.AccessControl.DirectorySecurity]::new()
    } else {
      [System.Security.AccessControl.FileSecurity]::new()
    }
    $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor
      [System.Security.AccessControl.AccessControlSections]::Access
    $acl.SetSecurityDescriptorSddlForm(
      "O:$($sid)D:P(A;$aceFlags;FA;;;$sid)",
      $sections
    )
    if ($isDirectory) {
      $target = [System.IO.DirectoryInfo]::new($targetPath)
      $target.SetAccessControl($acl)
    } else {
      $target = [System.IO.FileInfo]::new($targetPath)
      $target.SetAccessControl($acl)
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

const WINDOWS_OWNER_ONLY_ACL_COMMAND = Buffer
  .from(WINDOWS_OWNER_ONLY_ACL_SCRIPT, 'utf16le')
  .toString('base64')

export function hardenOwnerOnlyPath(
  targetPath: string,
  options: { directory?: boolean } = {},
): void {
  hardenOwnerOnlyPaths([{
    path: targetPath,
    ...(options.directory && { directory: true }),
  }])
}

export function hardenOwnerOnlyPaths(
  targets: readonly OwnerOnlyPathTarget[],
): void {
  const uniqueTargets = deduplicateTargets(targets)
  if (uniqueTargets.length === 0)
    return

  if (process.platform !== 'win32') {
    for (const target of uniqueTargets)
      fs.chmodSync(target.path, target.directory ? 0o700 : 0o600)
    return
  }

  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  const executable = systemRoot
    ? path.win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : 'powershell.exe'
  try {
    execFileSync(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      WINDOWS_OWNER_ONLY_ACL_COMMAND,
    ], {
      env: {
        ...process.env,
        [WINDOWS_ACL_TARGETS_ENV]: JSON.stringify({ targets: uniqueTargets }),
      },
      windowsHide: true,
    })
  }
  catch (error) {
    const detail = commandErrorDetail(error)
    throw new Error(
      `Cannot apply owner-only ACL to ${uniqueTargets.map(target => target.path).join(', ')}${detail ? `: ${detail}` : ''}`,
      { cause: error },
    )
  }

  for (const target of uniqueTargets) {
    if (target.directory)
      cacheHardenedWindowsDirectory(target.path)
  }
}

export function ensureOwnerOnlyDirectories(
  directoryPaths: readonly string[],
): void {
  const uniquePaths = [...new Set(directoryPaths.map(directoryPath => path.resolve(directoryPath)))]
  if (process.platform !== 'win32') {
    hardenOwnerOnlyPaths(uniquePaths.map(directoryPath => ({ path: directoryPath, directory: true })))
    return
  }

  const stalePaths = uniquePaths.filter((directoryPath) => {
    const identity = readDirectoryIdentity(directoryPath)
    return identity === undefined
      || hardenedWindowsDirectories.get(normalizeWindowsDirectoryKey(directoryPath)) !== identity
  })
  hardenOwnerOnlyPaths(stalePaths.map(directoryPath => ({ path: directoryPath, directory: true })))
}

function commandErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('stderr' in error))
    return undefined
  const stderr = (error as { stderr?: unknown }).stderr
  const detail = Buffer.isBuffer(stderr)
    ? stderr.toString('utf8')
    : typeof stderr === 'string'
      ? stderr
      : undefined
  return detail
    ?.replaceAll('\0', '')
    .trim()
    .replaceAll(/\s+/g, ' ')
    .slice(0, 500)
}

function deduplicateTargets(
  targets: readonly OwnerOnlyPathTarget[],
): OwnerOnlyPathTarget[] {
  const unique = new Map<string, OwnerOnlyPathTarget>()
  for (const target of targets) {
    if (!target.path.trim())
      throw new TypeError('Owner-only ACL target path must not be empty')
    const normalizedPath = path.resolve(target.path)
    const key = process.platform === 'win32'
      ? normalizedPath.toLowerCase()
      : normalizedPath
    const existing = unique.get(key)
    if (existing && Boolean(existing.directory) !== Boolean(target.directory))
      throw new TypeError(`Owner-only ACL target has conflicting file and directory types: ${target.path}`)
    unique.set(key, { path: normalizedPath, ...(target.directory && { directory: true }) })
  }
  return [...unique.values()]
}

function cacheHardenedWindowsDirectory(directoryPath: string): void {
  const identity = readDirectoryIdentity(directoryPath)
  if (identity !== undefined) {
    hardenedWindowsDirectories.set(
      normalizeWindowsDirectoryKey(directoryPath),
      identity,
    )
  }
}

function readDirectoryIdentity(directoryPath: string): string | undefined {
  try {
    const stats = fs.statSync(directoryPath, { bigint: true })
    if (!stats.isDirectory())
      return undefined
    return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`
  }
  catch {
    return undefined
  }
}

function normalizeWindowsDirectoryKey(directoryPath: string): string {
  return path.resolve(directoryPath).toLowerCase()
}
