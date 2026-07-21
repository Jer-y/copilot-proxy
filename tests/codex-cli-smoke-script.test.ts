import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'bun:test'

const CODEX_SMOKE_SCRIPT = new URL('../scripts/run-codex-cli-smoke.sh', import.meta.url)
const CODEX_SMOKE_LOG_EVIDENCE = new URL('../scripts/codex-smoke-log-evidence.sh', import.meta.url)
const CODEX_SMOKE_WORKTREE_GUARD = new URL('../scripts/codex-smoke-worktree-guard.sh', import.meta.url)
const WORKTREE_SNAPSHOT = new URL('../scripts/capture-worktree-snapshot.ts', import.meta.url)
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

function validateCatalogLog(log: string, expectedClientVersion = '0.144.6') {
  return spawnSync('bash', [
    '-c',
    'source "$1"; require_codex_catalog_success /dev/stdin "$2" HTTP',
    'bash',
    fileURLToPath(CODEX_SMOKE_LOG_EVIDENCE),
    expectedClientVersion,
  ], {
    encoding: 'utf8',
    input: log,
  })
}

describe('real Codex CLI smoke script', () => {
  test('uses the preflighted Bun runtime for provider authentication', async () => {
    const script = await readFile(CODEX_SMOKE_SCRIPT, 'utf8')

    expect(script).toContain('for command_name in bun cmp codex cp curl git jq lsof rg "$CODEX_TIMEOUT_BIN"')
    expect(script).toContain('auth={command=\\"bun\\",args=[\\"-e\\",\\"process.stdout.write(\'dummy\')\\"]}')
    expect(script).not.toContain('auth={command=\\"node\\"')
  })

  test('runs content-sensitive worktree verification from EXIT cleanup', async () => {
    const script = await readFile(CODEX_SMOKE_SCRIPT, 'utf8')

    expect(script).toContain('trap cleanup_codex_smoke EXIT')
    expect(script).toContain('trap \'exit 130\' INT')
    expect(script).toContain('trap \'exit 143\' TERM')
    expect(script).toContain('capture_codex_smoke_worktree_state')
    expect(script).toContain('verify_codex_smoke_worktree_unchanged')
    expect(script).toContain('"$CODEX_SMOKE_ROOT/worktree.before"')
    expect(script).toContain('"$CODEX_SMOKE_ROOT/worktree.after"')
    expect(script).toContain('rm -rf "$CODEX_SMOKE_ROOT"')
  })

  test('passes cleanup verification when tracked and untracked contents are unchanged', () => {
    const repository = createRepository()
    writeFileSync(path.join(repository, 'tracked.txt'), 'dirty but stable\n')
    writeFileSync(path.join(repository, 'untracked.txt'), 'untracked but stable\n')
    const fixture = captureGuardBaseline(repository)

    const result = verifyGuardBaseline(repository, fixture)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(readFileSync(fixture.statusAfter)).toEqual(readFileSync(fixture.statusBefore))
    expect(readFileSync(fixture.snapshotAfter)).toEqual(readFileSync(fixture.snapshotBefore))
  })

  test('fails cleanup verification when an already-modified tracked file changes content', () => {
    const repository = createRepository()
    const trackedPath = path.join(repository, 'tracked.txt')
    writeFileSync(trackedPath, 'dirty before\n')
    const fixture = captureGuardBaseline(repository)
    const statusBefore = git(repository, ['status', '--porcelain=v1'])

    writeFileSync(trackedPath, 'dirty after\n')
    const result = verifyGuardBaseline(repository, fixture)

    expect(git(repository, ['status', '--porcelain=v1'])).toBe(statusBefore)
    expect(readFileSync(fixture.statusAfter)).toEqual(readFileSync(fixture.statusBefore))
    expect(readFileSync(fixture.snapshotAfter)).not.toEqual(readFileSync(fixture.snapshotBefore))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('The Codex smoke changed the repository worktree')
    expect(result.stderr).toContain('tracked content or metadata')
  })

  test('fails cleanup verification when an existing untracked file changes content', () => {
    const repository = createRepository()
    const untrackedPath = path.join(repository, 'untracked.txt')
    writeFileSync(untrackedPath, 'untracked before\n')
    const fixture = captureGuardBaseline(repository)
    const statusBefore = git(repository, ['status', '--porcelain=v1'])

    writeFileSync(untrackedPath, 'untracked after\n')
    const result = verifyGuardBaseline(repository, fixture)

    expect(git(repository, ['status', '--porcelain=v1'])).toBe(statusBefore)
    expect(readFileSync(fixture.statusAfter)).toEqual(readFileSync(fixture.statusBefore))
    expect(readFileSync(fixture.snapshotAfter)).not.toEqual(readFileSync(fixture.snapshotBefore))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('The Codex smoke changed the repository worktree')
    expect(result.stderr).toContain('non-ignored untracked content or metadata')
  })

  test('requires a paired function or custom tool request loop', async () => {
    const script = await readFile(CODEX_SMOKE_SCRIPT, 'utf8')

    expect(script).toContain('sum_request_summary_field \'functionCalls\'')
    expect(script).toContain('sum_request_summary_field \'functionCallOutputs\'')
    expect(script).toContain('sum_request_summary_field \'customToolCalls\'')
    expect(script).toContain('sum_request_summary_field \'customToolCallOutputs\'')
    expect(script).toContain(
      '[[ "$CODEX_HTTP_FUNCTION_CALLS" -gt 0 && "$CODEX_HTTP_FUNCTION_CALL_OUTPUTS" -gt 0 ]]',
    )
    expect(script).toContain(
      '[[ "$CODEX_HTTP_CUSTOM_TOOL_CALLS" -gt 0 && "$CODEX_HTTP_CUSTOM_TOOL_CALL_OUTPUTS" -gt 0 ]]',
    )
  })

  test('requires a completed 200 catalog response for the Codex client version', () => {
    const result = validateCatalogLog([
      '<-- GET /v1/models',
      'ℹ Codex model catalog response: client_version=0.144.6 status=200',
      '--> GET /v1/models 200 12ms',
    ].join('\n'))

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('1\n')
    expect(result.stderr).toBe('')
  })

  test('rejects a completed 500 catalog response even when the Codex turn can continue', () => {
    const result = validateCatalogLog([
      '<-- GET /v1/models',
      'Codex model catalog response: client_version=0.144.6 status=500',
      '--> GET /v1/models 500 8ms',
      '--> POST /v1/responses 200 2.1s',
    ].join('\n'))

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('expected_200=0 non_2xx=1 completed=1')
  })

  test('rejects any non-2xx catalog response in a segment that also has a 200', () => {
    const result = validateCatalogLog([
      'Codex model catalog response: client_version=0.144.6 status=200',
      'Codex model catalog response: client_version=0.144.6 status=503',
    ].join('\n'))

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('expected_200=1 non_2xx=1 completed=2')
  })

  test('rejects prefixed or path-injected catalog markers as evidence', () => {
    for (const line of [
      'attacker: Codex model catalog response: client_version=0.144.6 status=200',
      '--> GET /Codex model catalog response: client_version=0.144.6 status=200',
    ]) {
      const result = validateCatalogLog(line)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('expected_200=0 non_2xx=0 completed=0')
    }
  })

  test('rejects model metadata fallback diagnostics for both real transports', async () => {
    const script = await readFile(CODEX_SMOKE_SCRIPT, 'utf8')

    expect(script.match(/fallback metadata\|fallback model metadata\|used_fallback_model_metadata/g)).toHaveLength(2)
    expect(script).toContain('"$CODEX_SMOKE_ROOT/http-diagnostics.log"')
    expect(script).toContain('"$CODEX_SMOKE_ROOT/ws-diagnostics.log"')
    expect(script).toContain('"$CODEX_SMOKE_ROOT/http-events.jsonl"')
    expect(script).toContain('"$CODEX_SMOKE_ROOT/ws-events.jsonl"')
  })

  test('has valid Bash syntax', () => {
    const syntaxCheck = spawnSync('bash', ['-n', fileURLToPath(CODEX_SMOKE_SCRIPT)], {
      encoding: 'utf8',
    })

    expect(syntaxCheck.status).toBe(0)
    expect(syntaxCheck.stderr).toBe('')

    const evidenceSyntaxCheck = spawnSync('bash', ['-n', fileURLToPath(CODEX_SMOKE_LOG_EVIDENCE)], {
      encoding: 'utf8',
    })

    expect(evidenceSyntaxCheck.status).toBe(0)
    expect(evidenceSyntaxCheck.stderr).toBe('')

    const guardSyntaxCheck = spawnSync('bash', ['-n', fileURLToPath(CODEX_SMOKE_WORKTREE_GUARD)], {
      encoding: 'utf8',
    })

    expect(guardSyntaxCheck.status).toBe(0)
    expect(guardSyntaxCheck.stderr).toBe('')
  })
})

interface GuardFixture {
  snapshotAfter: string
  snapshotBefore: string
  stateDirectory: string
  statusAfter: string
  statusBefore: string
}

function createRepository(): string {
  const repository = makeTemporaryDirectory('codex-smoke-guard-repository-')
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.email', 'codex-smoke@example.invalid'])
  git(repository, ['config', 'user.name', 'Codex Smoke Test'])
  writeFileSync(path.join(repository, 'tracked.txt'), 'committed\n')
  git(repository, ['add', 'tracked.txt'])
  git(repository, ['commit', '--quiet', '--no-gpg-sign', '-m', 'fixture'])
  return repository
}

function captureGuardBaseline(repository: string): GuardFixture {
  const stateDirectory = makeTemporaryDirectory('codex-smoke-guard-state-')
  const fixture = {
    snapshotAfter: path.join(stateDirectory, 'worktree.after'),
    snapshotBefore: path.join(stateDirectory, 'worktree.before'),
    stateDirectory,
    statusAfter: path.join(stateDirectory, 'git-status.after'),
    statusBefore: path.join(stateDirectory, 'git-status.before'),
  }
  const result = spawnSync('bash', [
    '-c',
    'source "$1"; capture_codex_smoke_worktree_state "$2" "$3" "$4" "$5"',
    'bash',
    fileURLToPath(CODEX_SMOKE_WORKTREE_GUARD),
    repository,
    fileURLToPath(WORKTREE_SNAPSHOT),
    fixture.statusBefore,
    fixture.snapshotBefore,
  ], { encoding: 'utf8' })

  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return fixture
}

function verifyGuardBaseline(repository: string, fixture: GuardFixture) {
  return spawnSync('bash', [
    '-c',
    'source "$1"; verify_codex_smoke_worktree_unchanged "$2" "$3" "$4" "$5" "$6" "$7"',
    'bash',
    fileURLToPath(CODEX_SMOKE_WORKTREE_GUARD),
    repository,
    fileURLToPath(WORKTREE_SNAPSHOT),
    fixture.statusBefore,
    fixture.snapshotBefore,
    fixture.statusAfter,
    fixture.snapshotAfter,
  ], { encoding: 'utf8' })
}

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
