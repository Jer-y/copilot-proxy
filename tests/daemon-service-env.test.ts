import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  assertProxyEndpointAvailable,
  buildNativeServiceBootstrapEnvironment,
  loadNativeServiceEnvironment,
  removeNativeServiceEnvironment,
  saveNativeServiceEnvironment,
} from '~/daemon/service-env'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { force: true, recursive: true })
})

describe('native service environment', () => {
  test('persists only supported security settings with owner-only permissions', () => {
    const filePath = makeFilePath()
    saveNativeServiceEnvironment({
      proxyEnv: false,
      filePath,
      sourceEnv: {
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
        COPILOT_PROXY_EXPOSE_TOKEN: '1',
        NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
        HTTP_PROXY: 'http://secret@proxy:8080',
        UNRELATED_SECRET: 'do-not-save',
      },
    })

    const raw = fs.readFileSync(filePath, 'utf8')
    expect(raw).toContain('COPILOT_PROXY_ALLOWED_HOSTS')
    expect(raw).toContain('COPILOT_PROXY_EXPOSE_TOKEN')
    expect(raw).toContain('NODE_EXTRA_CA_CERTS')
    expect(raw).not.toContain('HTTP_PROXY')
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

  test('removes persisted service settings on disable', () => {
    const filePath = makeFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{}')

    removeNativeServiceEnvironment(filePath)

    expect(fs.existsSync(filePath)).toBe(false)
  })

  test('clears ambient startup TLS settings before applying the persisted snapshot', () => {
    const environment = buildNativeServiceBootstrapEnvironment(
      {
        HTTPS_PROXY: 'http://ambient-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/ambient/ca.pem',
        SSL_CERT_FILE: '/ambient/cert.pem',
        SSL_CERT_DIR: '/ambient/certs',
      },
      {
        HTTPS_PROXY: 'http://saved-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/saved/ca.pem',
      },
      { proxyEnv: true },
    )

    expect(environment.HTTPS_PROXY).toBe('http://saved-proxy:8080')
    expect(environment.NODE_EXTRA_CA_CERTS).toBe('/saved/ca.pem')
    expect(environment.SSL_CERT_FILE).toBeUndefined()
    expect(environment.SSL_CERT_DIR).toBeUndefined()
  })

  test('does not replay stale proxy keys when the service definition disables proxy mode', () => {
    const environment = buildNativeServiceBootstrapEnvironment(
      { HTTPS_PROXY: 'http://ambient-proxy:8080' },
      {
        HTTPS_PROXY: 'http://stale-saved-proxy:8080',
        NODE_EXTRA_CA_CERTS: '/saved/ca.pem',
      },
      { proxyEnv: false },
    )

    expect(environment.HTTPS_PROXY).toBeUndefined()
    expect(environment.NODE_EXTRA_CA_CERTS).toBe('/saved/ca.pem')
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
