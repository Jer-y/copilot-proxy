import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, test } from 'bun:test'

import { captureWorktreeSnapshot } from '../scripts/capture-worktree-snapshot'

const temporaryRepositories: string[] = []
const testPosix = process.platform === 'win32' ? test.skip : test

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0))
    rmSync(repository, { force: true, recursive: true })
})

describe('captureWorktreeSnapshot', () => {
  test('is stable when tracked and untracked contents do not change', async () => {
    const repository = createRepository()
    writeFileSync(path.join(repository, 'untracked.txt'), 'same\n')

    expect(await captureWorktreeSnapshot(repository)).toBe(
      await captureWorktreeSnapshot(repository),
    )
  })

  test('detects content changes to an already-modified tracked file', async () => {
    const repository = createRepository()
    const trackedPath = path.join(repository, 'tracked.txt')
    writeFileSync(trackedPath, 'dirty before\n')
    const before = await captureWorktreeSnapshot(repository)

    writeFileSync(trackedPath, 'dirty after\n')

    expect(await captureWorktreeSnapshot(repository)).not.toBe(before)
    expect(git(repository, ['status', '--porcelain=v1'])).toBe(' M tracked.txt\n')
  })

  test('detects content changes to an existing untracked file', async () => {
    const repository = createRepository()
    const untrackedPath = path.join(repository, 'untracked.txt')
    writeFileSync(untrackedPath, 'untracked before\n')
    const before = await captureWorktreeSnapshot(repository)

    writeFileSync(untrackedPath, 'untracked after\n')

    expect(await captureWorktreeSnapshot(repository)).not.toBe(before)
    expect(git(repository, ['status', '--porcelain=v1'])).toBe('?? untracked.txt\n')
  })

  test('ignores files excluded by repository rules', async () => {
    const repository = createRepository()
    const ignoredPath = path.join(repository, 'ignored.log')
    writeFileSync(ignoredPath, 'ignored before\n')
    const before = await captureWorktreeSnapshot(repository)

    writeFileSync(ignoredPath, 'ignored after\n')

    expect(await captureWorktreeSnapshot(repository)).toBe(before)
  })

  test('detects tracked raw-byte changes hidden by Git EOL normalization', async () => {
    const repository = createRepository()
    const trackedPath = path.join(repository, 'tracked.txt')
    writeFileSync(path.join(repository, '.gitattributes'), '*.txt text eol=lf\n')
    git(repository, ['add', '.gitattributes'])
    git(repository, ['commit', '--quiet', '--no-gpg-sign', '-m', 'add attributes'])

    writeFileSync(trackedPath, 'line one\r\nline two\r\n')
    const statusBefore = git(repository, ['status', '--porcelain=v1'])
    const diffBefore = git(repository, ['diff', '--binary', 'HEAD', '--', 'tracked.txt'])
    const before = await captureWorktreeSnapshot(repository)

    writeFileSync(trackedPath, 'line one\r\nline two\n')

    expect(git(repository, ['status', '--porcelain=v1'])).toBe(statusBefore)
    expect(git(repository, ['diff', '--binary', 'HEAD', '--', 'tracked.txt'])).toBe(diffBefore)
    expect(await captureWorktreeSnapshot(repository)).not.toBe(before)
  })

  testPosix('detects non-executable permission changes to tracked files', async () => {
    const repository = createRepository()
    const trackedPath = path.join(repository, 'tracked.txt')
    chmodSync(trackedPath, 0o644)
    const before = await captureWorktreeSnapshot(repository)

    chmodSync(trackedPath, 0o600)

    expect(git(repository, ['diff', '--binary', 'HEAD', '--', 'tracked.txt'])).toBe('')
    expect(lstatSync(trackedPath).mode & 0o777).toBe(0o600)
    expect(await captureWorktreeSnapshot(repository)).not.toBe(before)
  })

  testPosix('detects changes to an untracked symbolic-link target', async () => {
    const repository = createRepository()
    const linkPath = path.join(repository, 'untracked-link')
    symlinkSync('first-target', linkPath)
    const before = await captureWorktreeSnapshot(repository)

    unlinkSync(linkPath)
    symlinkSync('second-target', linkPath)

    expect(await captureWorktreeSnapshot(repository)).not.toBe(before)
  })

  test('fails closed for an untracked nested repository', () => {
    const repository = createRepository()
    git(repository, ['init', '--quiet', 'nested'])
    writeFileSync(path.join(repository, 'nested', 'payload.txt'), 'nested content\n')

    expect(() => captureWorktreeSnapshot(repository)).toThrow(
      'Cannot safely snapshot an untracked directory-valued Git entry',
    )
  })
})

function createRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), 'copilot-proxy-worktree-snapshot-'))
  temporaryRepositories.push(repository)
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.email', 'snapshot@example.invalid'])
  git(repository, ['config', 'user.name', 'Snapshot Test'])
  writeFileSync(path.join(repository, '.gitignore'), 'ignored.log\n')
  writeFileSync(path.join(repository, 'tracked.txt'), 'committed\n')
  git(repository, ['add', '.gitignore', 'tracked.txt'])
  git(repository, ['commit', '--quiet', '--no-gpg-sign', '-m', 'test fixture'])
  return repository
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
