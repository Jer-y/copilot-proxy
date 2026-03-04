import { describe, expect, test } from 'bun:test'
import { filterEnvForDaemon } from '~/daemon/start'

describe('filterEnvForDaemon', () => {
  test('keeps essential env vars', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      SECRET_KEY: 'should-be-dropped',
    }
    const filtered = filterEnvForDaemon(env)
    expect(filtered.PATH).toBe('/usr/bin')
    expect(filtered.HOME).toBe('/home/user')
    expect(filtered.LANG).toBe('en_US.UTF-8')
  })

  test('keeps proxy-related env vars', () => {
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
    expect(filtered.HTTP_PROXY).toBe('http://proxy:8080')
    expect(filtered.https_proxy).toBe('http://proxy:8080')
    expect(filtered.NO_PROXY).toBe('localhost')
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
