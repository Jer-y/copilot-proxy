import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  assertProxyEndpointAvailable,
  buildNativeServiceBootstrapEnvironment,
  loadNativeServiceEnvironment,
  NATIVE_SERVICE_ENV_SCHEMA_VERSION,
  readNativeServiceEnvironment,
  removeNativeServiceEnvironment,
  saveNativeServiceEnvironment,
} from '~/daemon/service-env'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { force: true, recursive: true })
})

describe('native service environment', () => {
  test('persists the explicit service-runtime schema with owner-only permissions and no tokens', () => {
    const filePath = makeFilePath()
    saveNativeServiceEnvironment({
      proxyEnv: false,
      filePath,
      sourceEnv: {
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
        COPILOT_PROXY_CORS_ORIGINS: 'https://viewer.internal',
        COPILOT_PROXY_EXPOSE_TOKEN: '1',
        COPILOT_PROXY_MAX_JSON_BODY_BYTES: '1048576',
        COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH: '1',
        NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
        HTTP_PROXY: 'http://secret@proxy:8080',
        GH_TOKEN: 'gho_must_not_be_persisted',
        GITHUB_TOKEN: 'ghp_must_not_be_persisted',
        COPILOT_TOKEN: 'copilot_must_not_be_persisted',
        OPENAI_API_KEY: 'sk-must-not-be-persisted',
        ANTHROPIC_API_KEY: 'anthropic-must-not-be-persisted',
        UNRELATED_SECRET: 'do-not-save',
      },
    })

    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(NATIVE_SERVICE_ENV_SCHEMA_VERSION)
    expect(raw).toContain('COPILOT_PROXY_ALLOWED_HOSTS')
    expect(raw).toContain('COPILOT_PROXY_CORS_ORIGINS')
    expect(raw).toContain('COPILOT_PROXY_EXPOSE_TOKEN')
    expect(raw).toContain('COPILOT_PROXY_MAX_JSON_BODY_BYTES')
    expect(raw).toContain('COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH')
    expect(raw).toContain('NODE_EXTRA_CA_CERTS')
    expect(raw).not.toContain('HTTP_PROXY')
    expect(raw).not.toContain('GH_TOKEN')
    expect(raw).not.toContain('GITHUB_TOKEN')
    expect(raw).not.toContain('COPILOT_TOKEN')
    expect(raw).not.toContain('OPENAI_API_KEY')
    expect(raw).not.toContain('ANTHROPIC_API_KEY')
    expect(raw).not.toContain('UNRELATED_SECRET')
    if (process.platform !== 'win32')
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
  })

  test('round-trips proxy settings without putting them in service argv', () => {
    const filePath = makeFilePath()
    saveNativeServiceEnvironment({
      proxyEnv: true,
      filePath,
      sourceEnv: {
        HTTPS_PROXY: 'http://user:password@proxy.internal:8080',
        NO_PROXY: 'localhost',
        COPILOT_PROXY_CORS_ORIGINS: 'https://viewer.internal',
      },
    })

    const targetEnv: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://stale-proxy:8080',
      COPILOT_PROXY_EXPOSE_TOKEN: '1',
    }
    loadNativeServiceEnvironment({ proxyEnv: true, filePath, targetEnv })

    expect(targetEnv.HTTPS_PROXY).toBe('http://user:password@proxy.internal:8080')
    expect(targetEnv.NO_PROXY).toBe('localhost')
    expect(targetEnv.COPILOT_PROXY_CORS_ORIGINS).toBe('https://viewer.internal')
    expect(targetEnv.HTTP_PROXY).toBeUndefined()
    expect(targetEnv.COPILOT_PROXY_EXPOSE_TOKEN).toBeUndefined()
  })

  test('fails closed when proxy mode has no endpoint', () => {
    expect(() => assertProxyEndpointAvailable({ NO_PROXY: 'localhost' })).toThrow('Refusing to fall back to a direct connection')

    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ NO_PROXY: 'localhost' }))
    expect(() => loadNativeServiceEnvironment({ proxyEnv: true, filePath, targetEnv: {} })).toThrow('Refusing to fall back to a direct connection')
  })

  test('fails closed for HTTP-only proxies and external NO_PROXY bypasses', () => {
    expect(() => assertProxyEndpointAvailable({
      HTTP_PROXY: 'http://http-only.invalid:8080',
    })).toThrow('HTTPS_PROXY or ALL_PROXY')

    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: 'api.github.com',
    })).toThrow('Refusing to fall back to a direct connection')

    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: 'localhost,127.0.0.1',
    })).not.toThrow()

    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: '.corp.local,10.0.0.8',
    })).not.toThrow()
  })

  test('validates only the network targets required by each command', () => {
    const env = {
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: 'localhost',
    }
    expect(() => assertProxyEndpointAvailable(env, ['https://github.com'])).not.toThrow()
  })

  test('rejects malformed environment files', () => {
    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ HTTPS_PROXY: 42 }))

    expect(() => loadNativeServiceEnvironment({ proxyEnv: true, filePath, targetEnv: {} })).toThrow('environment file is invalid')
  })

  test('loads legacy flat snapshots while ignoring unknown credentials', () => {
    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({
      COPILOT_PROXY_ALLOWED_HOSTS: 'legacy.internal',
      NODE_EXTRA_CA_CERTS: '/legacy/ca.pem',
      GITHUB_TOKEN: 'legacy-secret-must-not-be-replayed',
    }))

    const targetEnv: NodeJS.ProcessEnv = {
      COPILOT_PROXY_ALLOWED_HOSTS: 'ambient.internal',
      GITHUB_TOKEN: 'ambient-token',
    }
    const saved = loadNativeServiceEnvironment({ proxyEnv: false, filePath, targetEnv })

    expect(saved).toEqual({
      COPILOT_PROXY_ALLOWED_HOSTS: 'legacy.internal',
      NODE_EXTRA_CA_CERTS: '/legacy/ca.pem',
    })
    expect(targetEnv.COPILOT_PROXY_ALLOWED_HOSTS).toBe('legacy.internal')
    expect(targetEnv.GITHUB_TOKEN).toBe('ambient-token')
  })

  test('rejects unsupported entries in a versioned snapshot', () => {
    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({
      version: NATIVE_SERVICE_ENV_SCHEMA_VERSION,
      environment: {
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
        GITHUB_TOKEN: 'must-not-be-accepted',
      },
    }))

    expect(() => readNativeServiceEnvironment(filePath)).toThrow('unsupported entries: GITHUB_TOKEN')
  })

  test('removes persisted service settings on disable', () => {
    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{}')

    removeNativeServiceEnvironment(filePath)

    expect(fs.existsSync(filePath)).toBe(false)
  })

  test('builds the bootstrap child from explicit runtime state instead of ambient security or credentials', () => {
    const environment = buildNativeServiceBootstrapEnvironment(
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://ambient-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/ambient/ca.pem',
        SSL_CERT_FILE: '/ambient/cert.pem',
        SSL_CERT_DIR: '/ambient/certs',
        COPILOT_PROXY_ALLOWED_HOSTS: 'stale.internal',
        COPILOT_PROXY_CORS_ORIGINS: 'https://stale.internal',
        COPILOT_PROXY_EXPOSE_TOKEN: '1',
        GH_TOKEN: 'gho_ambient',
        GITHUB_TOKEN: 'ghp_ambient',
        COPILOT_TOKEN: 'copilot_ambient',
        OPENAI_API_KEY: 'sk-ambient',
        UNRELATED_SECRET: 'ambient-secret',
      },
      {
        HTTPS_PROXY: 'http://saved-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/saved/ca.pem',
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
        COPILOT_PROXY_CORS_ORIGINS: 'https://viewer.internal',
        COPILOT_PROXY_MAX_JSON_BODY_BYTES: '1048576',
      },
      { proxyEnv: true },
    )

    expect(environment.PATH).toBe('/usr/bin')
    expect(environment.HTTPS_PROXY).toBe('http://saved-proxy:8080')
    expect(environment.NODE_EXTRA_CA_CERTS).toBe('/saved/ca.pem')
    expect(environment.COPILOT_PROXY_ALLOWED_HOSTS).toBe('proxy.internal')
    expect(environment.COPILOT_PROXY_CORS_ORIGINS).toBe('https://viewer.internal')
    expect(environment.COPILOT_PROXY_MAX_JSON_BODY_BYTES).toBe('1048576')
    expect(environment.COPILOT_PROXY_EXPOSE_TOKEN).toBeUndefined()
    expect(environment.SSL_CERT_FILE).toBeUndefined()
    expect(environment.SSL_CERT_DIR).toBeUndefined()
    expect(environment.GH_TOKEN).toBeUndefined()
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.COPILOT_TOKEN).toBeUndefined()
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.UNRELATED_SECRET).toBeUndefined()
  })

  test('does not replay stale proxy keys when the service definition disables proxy mode', () => {
    const environment = buildNativeServiceBootstrapEnvironment(
      { HTTPS_PROXY: 'http://ambient-proxy:8080' },
      {
        HTTPS_PROXY: 'http://stale-saved-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/saved/ca.pem',
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
      },
      { proxyEnv: false },
    )

    expect(environment.HTTPS_PROXY).toBeUndefined()
    expect(environment.NODE_EXTRA_CA_CERTS).toBe('/saved/ca.pem')
    expect(environment.COPILOT_PROXY_ALLOWED_HOSTS).toBe('proxy.internal')
  })

  test('does not restore legacy proxy entries when persisted config disables proxy mode', () => {
    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({
      HTTPS_PROXY: 'http://stale-saved-proxy:8080',
      COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
    }))
    const targetEnv: NodeJS.ProcessEnv = {
      HTTPS_PROXY: 'http://ambient-proxy:8080',
    }

    loadNativeServiceEnvironment({ proxyEnv: false, filePath, targetEnv })

    expect(targetEnv.HTTPS_PROXY).toBeUndefined()
    expect(targetEnv.COPILOT_PROXY_ALLOWED_HOSTS).toBe('proxy.internal')
  })

  test('rejects invalid proxy URLs before a Bun service can snapshot them', () => {
    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: 'not a valid proxy',
    })).toThrow('invalid proxy URL')
    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: 'socks5://proxy.internal:1080',
    })).toThrow('unsupported proxy protocol')
  })
})

function makeFilePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-service-env-test-'))
  tempDirs.push(dir)
  return path.join(dir, 'service-env.json')
}
