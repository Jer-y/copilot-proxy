import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

const PAGE_PATH = new URL('../pages/index.html', import.meta.url)

describe('hosted diagnostics dashboard security', () => {
  test('publishes stable Diagnostics version and capability markers', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('<meta name="copilot-proxy-dashboard-version" content="diagnostics-v1" />')
    expect(html).toContain('name="copilot-proxy-dashboard-capabilities"')
    expect(html).toContain('content="diagnostics exact-endpoints redirect-error credentials-omit"')
  })

  test('uses a restrictive script policy without inline event handlers', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]

    expect(html).toContain('Content-Security-Policy')
    expect(script).toBeDefined()
    const scriptHash = createHash('sha256').update(script!).digest('base64')
    expect(html).toContain(`script-src 'sha256-${scriptHash}'`)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toContain('script-src \'unsafe-inline\'')
    expect(html).not.toContain('script-src \'nonce-')
  })

  test('has no runtime dependencies and renders untrusted diagnostics with DOM text APIs', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i)
    expect(html).not.toMatch(/\bexperimental\b/i)
    expect(html).toContain('function parseDiagnosticsData(value)')
    expect(html).toContain('requireRecord(data.readiness, "readiness")')
    expect(html).toContain('Number.isFinite(value)')
    expect(html).toContain('function parseEndpointUrl(value)')
    expect(html).toContain('endpoint.protocol !== "http:"')
    expect(html).toContain('endpoint.username || endpoint.password')
    expect(html).toContain('["/diagnostics", "/diagnostics/", "/usage", "/usage/"]')
    expect(html).toContain('rawEndpoint.includes("?") || rawEndpoint.includes("#")')
    expect(html).toContain('credentials: "omit"')
    expect(html).toContain('redirect: "error"')
    expect(html).toContain('element.textContent = String(value)')
    expect(html).toContain('elements.modelRows.replaceChildren()')
    expect(html).not.toContain('.innerHTML')
  })

  test('clears every previously rendered diagnostics section after a refresh failure', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')
    const renderFailure = html.match(/function renderFailure\(message\) \{([\s\S]*?)\n {6}\}/)?.[1]

    expect(renderFailure).toBeDefined()
    expect(renderFailure).toContain('renderRuntime({})')
    expect(renderFailure).toContain('renderModels()')
    expect(renderFailure).toContain('renderUsage({')
    expect(renderFailure).toContain('status: "unavailable"')
  })

  test('does not turn missing diagnostics fields into negative runtime assertions', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('token.tokenAvailable === false')
    expect(html).toContain('"Token state unknown"')
    expect(html).toContain('"refresh state unknown"')
    expect(html).toContain('if (concurrency.enabled === false)')
    expect(html).toContain('else if (concurrency.enabled === true)')
    expect(html).toContain('"Limit state unknown"')
    expect(html).toContain('"Concurrency diagnostics unavailable"')
    expect(html).toContain('return number === undefined ? "unknown"')
    expect(html).toContain('"Model catalog unavailable"')
  })

  test('describes the usage-cache side effect instead of calling diagnostics passive', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('A usage cache miss may refresh quota data.')
    expect(html).toContain('A usage cache miss may fetch current quota')
    expect(html).not.toContain('One passive view')
    expect(html).not.toContain('without changing runtime state')
  })

  test('bounds diagnostics requests and keeps retry available while loading', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('const DIAGNOSTICS_TIMEOUT_MS = 10_000')
    expect(html).toContain('activeDiagnosticsController?.abort()')
    expect(html).toContain('signal: controller.signal')
    expect(html).toContain('window.setTimeout(() => {')
    expect(html).toContain('Diagnostics request timed out after $' + '{DIAGNOSTICS_TIMEOUT_MS}ms')
    expect(html).toContain('elements.refreshButton.disabled = false')
    expect(html).toContain('elements.refreshButton.textContent = loading ? "Retry" : "Refresh"')
    expect(html).not.toContain('elements.refreshButton.disabled = loading')
  })

  test('only diagnoses local-network denial through a feature-detected permission state', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('function localNetworkPermissionFailure(endpoint)')
    expect(html).toContain('typeof navigator === "undefined"')
    expect(html).toContain('typeof permissions.query !== "function"')
    expect(html).toContain('["loopback-network", "local-network-access"]')
    expect(html).toContain('permission.state === "denied"')
    expect(html).toContain('!timedOut && !responseReceived')
    expect(html).toContain('function isLoopbackHostname(hostname)')
  })

  test('shows the filtered diagnostics profile count instead of the raw catalog count', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('renderRuntime(readiness, data.models.length)')
    expect(html).not.toContain('integerText(readiness.modelsAvailable)')
  })
})
