import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'bun:test'
import { buildLegacySupervisorArgs, filterEnvForDaemon } from '~/daemon/start'

const testWindows = process.platform === 'win32' ? test : test.skip

describe('filterEnvForDaemon', () => {
  test('keeps essential env vars', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      COPILOT_PROXY_DATA_DIR: '/custom/copilot-proxy',
      SECRET_KEY: 'should-be-dropped',
    }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.PATH).toBe('/usr/bin')
    expect(filtered.HOME).toBe('/home/user')
    expect(filtered.LANG).toBe('en_US.UTF-8')
    expect(filtered.COPILOT_PROXY_DATA_DIR).toBe('/custom/copilot-proxy')
  })

  test('drops proxy-related env vars by default', () => {
    const env = {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      http_proxy: 'http://proxy:8080',
      https_proxy: 'http://proxy:8080',
      no_proxy: 'localhost',
    }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.HTTP_PROXY).toBeUndefined()
    expect(filtered.https_proxy).toBeUndefined()
    expect(filtered.NO_PROXY).toBeUndefined()
  })

  test('keeps proxy-related env vars only when proxy-env is enabled', () => {
    const env = {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://proxy:8080',
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      ALL_PROXY: 'socks5://proxy:1080',
      https_proxy: 'http://proxy:8080',
    }
    const filtered = filterEnvForDaemon(env, { proxyEnv: true })
    expect(filtered.HTTP_PROXY).toBe('http://proxy:8080')
    expect(filtered.https_proxy).toBe('http://proxy:8080')
    expect(filtered.NO_PROXY).toBe('localhost')
    expect(filtered.ALL_PROXY).toBe('socks5://proxy:1080')
  })

  test('keeps proxy security env vars', () => {
    const env = {
      PATH: '/usr/bin',
      COPILOT_PROXY_CORS_ORIGINS: 'https://internal.example.com',
      COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
      COPILOT_PROXY_EXPOSE_TOKEN: '1',
      COPILOT_PROXY_MAX_JSON_BODY_BYTES: '1048576',
      COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH: '1',
    }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.COPILOT_PROXY_CORS_ORIGINS).toBe('https://internal.example.com')
    expect(filtered.COPILOT_PROXY_ALLOWED_HOSTS).toBe('proxy.internal')
    expect(filtered.COPILOT_PROXY_EXPOSE_TOKEN).toBe('1')
    expect(filtered.COPILOT_PROXY_MAX_JSON_BODY_BYTES).toBe('1048576')
    expect(filtered.COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH).toBe('1')
  })

  test('keeps TLS certificate env vars for corporate CA setups', () => {
    const env = {
      PATH: '/usr/bin',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/custom-ca.pem',
      SSL_CERT_FILE: '/etc/ssl/custom-ca-bundle.pem',
      SSL_CERT_DIR: '/etc/ssl/custom-certs',
    }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/custom-ca.pem')
    expect(filtered.SSL_CERT_FILE).toBe('/etc/ssl/custom-ca-bundle.pem')
    expect(filtered.SSL_CERT_DIR).toBe('/etc/ssl/custom-certs')
  })

  test('drops unknown env vars', () => {
    const env = {
      PATH: '/usr/bin',
      AWS_SECRET_ACCESS_KEY: 'secret',
      DATABASE_URL: 'postgres://...',
      RANDOM_VAR: 'value',
    }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(filtered.DATABASE_URL).toBeUndefined()
    expect(filtered.RANDOM_VAR).toBeUndefined()
  })

  test('drops GitHub and provider credentials before the supervisor spawn boundary', () => {
    const filtered = filterEnvForDaemon({
      PATH: '/usr/bin',
      GH_TOKEN: 'gho_supervisor_secret',
      GITHUB_TOKEN: 'ghp_supervisor_secret',
      COPILOT_TOKEN: 'copilot_supervisor_secret',
      OPENAI_API_KEY: 'sk-supervisor-secret',
      ANTHROPIC_API_KEY: 'anthropic-supervisor-secret',
      AZURE_OPENAI_API_KEY: 'azure-supervisor-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-supervisor-secret',
    })

    expect(filtered.PATH).toBe('/usr/bin')
    expect(filtered.GH_TOKEN).toBeUndefined()
    expect(filtered.GITHUB_TOKEN).toBeUndefined()
    expect(filtered.COPILOT_TOKEN).toBeUndefined()
    expect(filtered.OPENAI_API_KEY).toBeUndefined()
    expect(filtered.ANTHROPIC_API_KEY).toBeUndefined()
    expect(filtered.AZURE_OPENAI_API_KEY).toBeUndefined()
    expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  testWindows('normalizes Windows-style bootstrap key casing and preserves empty values', () => {
    const filtered = filterEnvForDaemon({
      Path: '',
      appData: 'C:\\Users\\alice\\AppData\\Roaming',
      LocalAppData: 'C:\\Users\\alice\\AppData\\Local',
      ProgramData: 'C:\\ProgramData',
      userProfile: 'C:\\Users\\alice',
      homeDrive: 'C:',
      homePath: '\\Users\\alice',
      systemroot: 'C:\\Windows',
      WinDir: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PathExt: '.COM;.EXE;.BAT;.CMD',
    })

    expect(filtered.PATH).toBe('')
    expect(filtered.APPDATA).toBe('C:\\Users\\alice\\AppData\\Roaming')
    expect(filtered.LOCALAPPDATA).toBe('C:\\Users\\alice\\AppData\\Local')
    expect(filtered.PROGRAMDATA).toBe('C:\\ProgramData')
    expect(filtered.USERPROFILE).toBe('C:\\Users\\alice')
    expect(filtered.HOMEDRIVE).toBe('C:')
    expect(filtered.HOMEPATH).toBe('\\Users\\alice')
    expect(filtered.SystemRoot).toBe('C:\\Windows')
    expect(filtered.WINDIR).toBe('C:\\Windows')
    expect(filtered.COMSPEC).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(filtered.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD')
    expect(Object.keys(filtered).filter(key => key.toUpperCase() === 'PATH')).toEqual(['PATH'])
  })

  testWindows('passes a Windows-style Path to a real supervisor-shaped child without ambient credentials', () => {
    const expectedPath = process.env.PATH
    expect(expectedPath).toBeTruthy()

    const sourceEnvironment: Record<string, string | undefined> = {
      ...process.env,
      Path: expectedPath,
      GH_TOKEN: 'gho_child_secret',
      GITHUB_TOKEN: 'ghp_child_secret',
      COPILOT_TOKEN: 'copilot_child_secret',
      OPENAI_API_KEY: 'sk-child-secret',
      ANTHROPIC_API_KEY: 'anthropic-child-secret',
    }
    delete sourceEnvironment.PATH
    const childEnvironment = filterEnvForDaemon(sourceEnvironment)
    const result = spawnSync(
      process.execPath,
      ['-e', `process.stdout.write(JSON.stringify({
        path: process.env.PATH ?? null,
        ghToken: process.env.GH_TOKEN ?? null,
        githubToken: process.env.GITHUB_TOKEN ?? null,
        copilotToken: process.env.COPILOT_TOKEN ?? null,
        openaiApiKey: process.env.OPENAI_API_KEY ?? null,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
      }))`],
      {
        encoding: 'utf8',
        env: childEnvironment,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      path: expectedPath,
      ghToken: null,
      githubToken: null,
      copilotToken: null,
      openaiApiKey: null,
      anthropicApiKey: null,
    })
  })

  test('handles missing vars gracefully', () => {
    const env = { PATH: '/usr/bin' }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.PATH).toBe('/usr/bin')
    expect(filtered.HOME).toBeUndefined()
  })
})

describe('buildLegacySupervisorArgs', () => {
  test('pins the resolved data directory before the supervisor imports PATHS', () => {
    expect(buildLegacySupervisorArgs('/stable/main.js', '/custom/copilot-proxy')).toEqual([
      '/stable/main.js',
      'start',
      '--_supervisor',
      '--_log-file',
      '--_data-dir',
      '/custom/copilot-proxy',
    ])
  })

  test('preserves proxy mode in the Bun supervisor startup environment', () => {
    expect(buildLegacySupervisorArgs('/stable/main.js', '/custom/copilot-proxy', true)).toEqual([
      '/stable/main.js',
      'start',
      '--_supervisor',
      '--_log-file',
      '--_data-dir',
      '/custom/copilot-proxy',
      '--proxy-env',
    ])
  })
})
