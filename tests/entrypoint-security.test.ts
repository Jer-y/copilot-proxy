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
})
