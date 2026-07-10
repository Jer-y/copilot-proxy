import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

const PAGE_PATH = new URL('../pages/index.html', import.meta.url)

describe('hosted usage viewer security', () => {
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

  test('validates quota data and endpoint protocols before rendering or fetching', async () => {
    const html = await readFile(PAGE_PATH, 'utf8')

    expect(html).toContain('function parseUsageData(value)')
    expect(html).toContain('Number.isFinite(value)')
    expect(html).toContain('typeof details.unlimited !== "boolean"')
    expect(html).toContain('state.data = parseUsageData(jsonData)')
    expect(html).toContain('function parseEndpointUrl(value)')
    expect(html).toContain('endpoint.protocol !== "http:"')
    expect(html).toContain('endpoint.username || endpoint.password')
    expect(html).toContain('escapeHtml(JSON.stringify(value))')
  })
})
