import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const ENTRYPOINT_PATH = new URL('../entrypoint.sh', import.meta.url)
const PORT_RESOLVER_PATH = new URL('../scripts/resolve-container-port.sh', import.meta.url)

describe('container entrypoint security', () => {
  test('does not copy GH_TOKEN into process arguments', async () => {
    const entrypoint = await readFile(ENTRYPOINT_PATH, 'utf8')

    expect(entrypoint).not.toContain('-g "$GH_TOKEN"')
    expect(entrypoint).not.toContain('--github-token')
    expect(entrypoint).toContain('token_dir=$' + '{COPILOT_PROXY_DATA_DIR:-"$data_home/copilot-proxy"}')
    expect(entrypoint).toContain('printf \'%s\' "$github_token" > "$token_dir/github_token"')
    expect(entrypoint).toContain('chmod 600 "$token_dir/github_token"')
    expect(entrypoint).toContain('unset github_token data_home token_dir health_port health_port_file health_port_tmp GH_TOKEN GITHUB_TOKEN')
    expect(entrypoint).toContain('exec bun run dist/main.js start "$@"')
    expect(entrypoint.indexOf('if [ "$' + '{1:-}" = "--healthcheck" ]')).toBeLessThan(entrypoint.indexOf('github_token=$' + '{GH_TOKEN'))
    expect(entrypoint).toContain('unset GH_TOKEN GITHUB_TOKEN')
  })

  test('dispatches advertised diagnostic commands instead of starting the server', async () => {
    const entrypoint = await readFile(ENTRYPOINT_PATH, 'utf8')
    const entrypointLines = entrypoint.split('\n')
    const directCommandBranchIndex = entrypointLines.findIndex(line =>
      line.includes('doctor') && line.trimEnd().endsWith(')'),
    )

    expect(directCommandBranchIndex).toBeGreaterThanOrEqual(0)
    const directCommands = entrypointLines[directCommandBranchIndex]
      ?.trim()
      .replace(/\)$/, '')
      .split('|') ?? []
    expect(directCommands).toContain('setup')
    expect(directCommands).toContain('models')
    expect(directCommands).toContain('doctor')
    expect(entrypointLines[directCommandBranchIndex + 1]?.trim()).toBe(
      'exec bun run dist/main.js "$@"',
    )

    const syntaxCheck = spawnSync('sh', ['-n', fileURLToPath(ENTRYPOINT_PATH)], {
      encoding: 'utf8',
    })
    expect(syntaxCheck.status).toBe(0)
    expect(syntaxCheck.stderr).toBe('')
  })

  test('resolves every supported long, short, equals, compact, and clustered port form', () => {
    const cases: Array<{ args: string[], expected: string }> = [
      { args: [], expected: '4399' },
      { args: ['start', '--port', '4400'], expected: '4400' },
      { args: ['start', '--port=4401'], expected: '4401' },
      { args: ['start', '-p', '4402'], expected: '4402' },
      { args: ['start', '-p=4403'], expected: '4403' },
      { args: ['start', '-p4404'], expected: '4404' },
      { args: ['start', '-vp4405'], expected: '4405' },
      { args: ['--port=4406'], expected: '4406' },
      { args: ['start', '--port=4407', '-p', '4408'], expected: '4408' },
      { args: ['start', '--', '--port=4409'], expected: '4399' },
    ]

    for (const item of cases) {
      const result = spawnSync('sh', [fileURLToPath(PORT_RESOLVER_PATH), ...item.args], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(item.expected)
    }
  })

  test('healthcheck mode never persists an inherited GitHub token', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-health-token-'))
    const dataDirectory = path.join(tempDirectory, 'data')
    const portFile = path.join(tempDirectory, 'port')
    fs.writeFileSync(portFile, 'invalid\n', { mode: 0o600 })

    try {
      const result = spawnSync('sh', [fileURLToPath(ENTRYPOINT_PATH), '--healthcheck'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          COPILOT_PROXY_DATA_DIR: dataDirectory,
          COPILOT_PROXY_HEALTH_PORT_FILE: portFile,
          GH_TOKEN: 'must-not-be-persisted',
        },
      })
      expect(result.status).toBe(1)
      expect(fs.existsSync(path.join(dataDirectory, 'github_token'))).toBe(false)
    }
    finally {
      fs.rmSync(tempDirectory, { force: true, recursive: true })
    }
  })

  test('healthcheck bypasses and removes every ambient proxy alias', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-health-proxy-'))
    const portFile = path.join(tempDirectory, 'port')
    const wgetArgsFile = path.join(tempDirectory, 'wget-args')
    const wgetPath = path.join(tempDirectory, 'wget')
    const proxyKeys = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'NO_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'no_proxy',
      'all_proxy',
    ]
    const unsetAssertions = proxyKeys
      .map(key => `[ -z "\${${key}+x}" ] || exit 91`)
      .join('\n')

    fs.writeFileSync(portFile, '4399\n', { mode: 0o600 })
    fs.writeFileSync(wgetPath, `#!/bin/sh
set -eu
${unsetAssertions}
[ -z "\${GH_TOKEN+x}" ] || exit 92
[ -z "\${GITHUB_TOKEN+x}" ] || exit 93
printf '%s\n' "$@" > "$COPILOT_PROXY_TEST_WGET_ARGS"
`, { mode: 0o700 })

    try {
      const proxyEnvironment = Object.fromEntries(
        proxyKeys.map(key => [key, 'http://ambient-proxy.invalid:8080']),
      )
      const result = spawnSync('sh', [fileURLToPath(ENTRYPOINT_PATH), '--healthcheck'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...proxyEnvironment,
          COPILOT_PROXY_HEALTH_PORT_FILE: portFile,
          COPILOT_PROXY_TEST_WGET_ARGS: wgetArgsFile,
          GH_TOKEN: 'must-be-removed',
          GITHUB_TOKEN: 'must-also-be-removed',
          PATH: `${tempDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(fs.readFileSync(wgetArgsFile, 'utf8').trim().split('\n')).toEqual([
        '-Y',
        'off',
        '--spider',
        '-q',
        'http://127.0.0.1:4399/',
      ])
    }
    finally {
      fs.rmSync(tempDirectory, { force: true, recursive: true })
    }
  })
})
