import { describe, expect, test } from 'bun:test'
import { buildLegacySupervisorArgs, filterEnvForDaemon } from '~/daemon/start'

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
