import type { Stats } from 'node:fs'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export function captureWorktreeSnapshot(cwd = process.cwd()): string {
  const root = path.resolve(cwd)
  const digest = createHash('sha256')
  const status = runGit(root, ['status', '--porcelain=v1', '-z'])
  const trackedDiff = runGit(root, [
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-renames',
    '--no-textconv',
    'HEAD',
    '--',
  ])
  const trackedIndex = runGit(root, ['ls-files', '--stage', '-z'])
  const trackedPaths = splitNullTerminated(runGit(root, [
    'ls-files',
    '--cached',
    '-z',
  ])).sort(Buffer.compare)
  const untrackedPaths = splitNullTerminated(runGit(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])).sort(Buffer.compare)

  updateFramed(digest, Buffer.from('status'))
  updateFramed(digest, status)
  updateFramed(digest, Buffer.from('tracked-diff'))
  updateFramed(digest, trackedDiff)
  updateFramed(digest, Buffer.from('tracked-index'))
  updateFramed(digest, trackedIndex)
  updateFramed(digest, Buffer.from('tracked-worktree'))
  for (const relativePath of trackedPaths)
    updatePathSnapshot(digest, root, relativePath, 'tracked')
  updateFramed(digest, Buffer.from('untracked'))

  for (const relativePath of untrackedPaths)
    updatePathSnapshot(digest, root, relativePath, 'untracked')

  return digest.digest('hex')
}

function updatePathSnapshot(
  digest: ReturnType<typeof createHash>,
  root: string,
  relativePath: Buffer,
  scope: 'tracked' | 'untracked',
): void {
  const absolutePath = Buffer.concat([
    Buffer.from(`${root}${path.sep}`),
    relativePath,
  ])
  updateFramed(digest, relativePath)

  const stat = lstatSync(absolutePath, { throwIfNoEntry: false })
  if (!stat) {
    updateFramed(digest, Buffer.from('missing'))
    return
  }

  updateFramed(digest, Buffer.from((stat.mode & 0o7777).toString(8)))
  const type = fileType(stat)
  updateFramed(digest, Buffer.from(type))

  if (scope === 'untracked' && type === 'directory') {
    throw new Error(
      'Cannot safely snapshot an untracked directory-valued Git entry; remove or explicitly track the nested repository before running the gate',
    )
  }

  if (type === 'symlink') {
    updateFramed(digest, readlinkSync(absolutePath, { encoding: 'buffer' }))
  }
  else if (type === 'file') {
    updateFramed(digest, Buffer.from(hashFile(absolutePath)))
  }
  else {
    updateFramed(digest, Buffer.from(`${stat.size}`))
  }
}

function fileType(stat: Stats): string {
  if (stat.isFile())
    return 'file'
  if (stat.isSymbolicLink())
    return 'symlink'
  if (stat.isDirectory())
    return 'directory'
  if (stat.isFIFO())
    return 'fifo'
  if (stat.isSocket())
    return 'socket'
  if (stat.isCharacterDevice())
    return 'character-device'
  if (stat.isBlockDevice())
    return 'block-device'
  return 'unknown'
}

function runGit(cwd: string, args: string[]): Buffer {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = Buffer.from(result.stderr).toString('utf8').trim()
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`)
  }
  return Buffer.from(result.stdout)
}

function splitNullTerminated(value: Buffer): Buffer[] {
  const entries: Buffer[] = []
  let start = 0

  for (let index = 0; index < value.length; index++) {
    if (value[index] !== 0)
      continue
    if (index > start)
      entries.push(value.subarray(start, index))
    start = index + 1
  }

  if (start !== value.length)
    throw new Error('git ls-files returned a non-NUL-terminated path')
  return entries
}

function updateFramed(digest: ReturnType<typeof createHash>, value: Buffer): void {
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(value.length))
  digest.update(length)
  digest.update(value)
}

function hashFile(filePath: Buffer): string {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const descriptor = openSync(filePath, 'r')
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead === 0)
        break
      digest.update(buffer.subarray(0, bytesRead))
    }
  }
  finally {
    closeSync(descriptor)
  }
  return digest.digest('hex')
}

if (import.meta.main) {
  try {
    process.stdout.write(`${captureWorktreeSnapshot()}\n`)
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Failed to capture worktree snapshot'}\n`)
    process.exitCode = 1
  }
}
