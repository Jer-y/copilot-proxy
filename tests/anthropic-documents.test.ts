import type { AnthropicMessagesPayload } from '~/routes/messages/anthropic-types'

import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'

import { expandDocumentBlocks } from '../src/lib/translation/anthropic-documents'

// Minimal valid PDF with text "Hello World"
const MINIMAL_PDF_BASE64 = 'JVBERi0xLjAKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9QYXJlbnQgMiAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDQgMCBSPj4+Pi9Db250ZW50cyA1IDAgUj4+ZW5kb2JqCjQgMCBvYmo8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PmVuZG9iago1IDAgb2JqCjw8L0xlbmd0aCA0ND4+CnN0cmVhbQpCVCAvRjEgMjQgVGYgMTAwIDcwMCBUZCAoSGVsbG8gV29ybGQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjY2IDAwMDAwIG4gCjAwMDAwMDAzNDAgMDAwMDAgbiAKdHJhaWxlcjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjQzNAolJUVPRg=='

function makePayload(messages: AnthropicMessagesPayload['messages']): AnthropicMessagesPayload {
  return {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages,
  }
}

describe('expandDocumentBlocks', () => {
  test('extracts text from PDF base64 document block', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: MINIMAL_PDF_BASE64,
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
    expect(content[0].text).toContain('Hello World')
  })

  test('decodes text/plain base64 document block', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('Hello from text document').toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe('Hello from text document')
  })

  test('handles text/plain with charset parameter', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain; charset=utf-8',
              data: Buffer.from('UTF-8 text').toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe('UTF-8 text')
  })

  test('respects non-UTF-8 charset for text documents', async () => {
    // Latin-1 encoded string: "café" → bytes [99, 97, 102, E9]
    const latin1Bytes = new Uint8Array([99, 97, 102, 0xE9])
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain; charset=iso-8859-1',
              data: Buffer.from(latin1Bytes).toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe('café')
  })

  test('decodes text/html document block', async () => {
    const html = '<html><body><h1>Hello</h1></body></html>'
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/html',
              data: Buffer.from(html).toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe(html)
  })

  test('decodes official data-based text-source document block', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'Hello from text source',
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe('Hello from text source')
  })

  test('accepts legacy text-based text-source document block for compatibility', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              text: 'Hello from legacy text source',
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe('Hello from legacy text source')
  })

  test('decodes native content-source document block', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'content',
              content: [
                { type: 'text', text: 'First paragraph.' },
                { type: 'text', text: 'Second paragraph.' },
              ],
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].type).toBe('text')
    expect(content[0].text).toBe('First paragraph.\n\nSecond paragraph.')
  })

  test('formats text with title and context', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            title: 'My Report',
            context: 'Summarize this',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('Report content here').toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].text).toBe('[Document: My Report]\nContext: Summarize this\n\nReport content here')
  })

  test('returns plain text without title or context', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('Just text').toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content[0].text).toBe('Just text')
  })

  test('preserves cache_control from document block', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('cached doc').toString('base64'),
            },
            cache_control: { type: 'ephemeral' as const },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, cache_control?: { type: string } }>
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('expands document blocks inside tool_result content', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_123',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'text/plain',
                  data: Buffer.from('tool result doc').toString('base64'),
                },
              },
            ],
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const toolResult = (payload.messages[0].content as Array<{ type: string, content: unknown }>)[0]
    const innerContent = toolResult.content as Array<{ type: string, text?: string }>
    expect(innerContent[0].type).toBe('text')
    expect(innerContent[0].text).toBe('tool result doc')
  })

  test('replaces document blocks in mixed content, preserves other blocks', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Before' },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('Document text').toString('base64'),
            },
          },
          { type: 'text', text: 'After' },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content).toHaveLength(3)
    expect(content[0]).toEqual({ type: 'text', text: 'Before' })
    expect(content[1].type).toBe('text')
    expect(content[1].text).toBe('Document text')
    expect(content[2]).toEqual({ type: 'text', text: 'After' })
  })

  test('throws on unsupported media_type', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/msword',
              data: Buffer.from('fake doc').toString('base64'),
            },
          },
        ],
      },
    ])

    await expect(expandDocumentBlocks(payload)).rejects.toThrow('Unsupported document media_type')
  })

  test('does nothing when payload has no document blocks', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi' },
        ],
      },
    ])

    const originalContent = JSON.stringify(payload)
    await expandDocumentBlocks(payload)
    expect(JSON.stringify(payload)).toBe(originalContent)
  })

  test('handles multiple document blocks in parallel', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('Doc 1').toString('base64'),
            },
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('Doc 2').toString('base64'),
            },
          },
        ],
      },
    ])

    await expandDocumentBlocks(payload)

    const content = payload.messages[0].content as Array<{ type: string, text?: string }>
    expect(content).toHaveLength(2)
    expect(content[0].text).toBe('Doc 1')
    expect(content[1].text).toBe('Doc 2')
  })

  test('throws descriptive error on corrupted PDF data', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: Buffer.from('not a real pdf').toString('base64'),
            },
          },
        ],
      },
    ])

    await expect(expandDocumentBlocks(payload)).rejects.toThrow('Failed to extract text from PDF document')
  })

  test('skips string content in user messages', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: 'Just a string message',
      },
    ])

    await expandDocumentBlocks(payload)
    expect(payload.messages[0].content).toBe('Just a string message')
  })

  test('rejects malformed base64 data', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: '!!!not-valid-base64!!!',
            },
          },
        ],
      },
    ])

    await expect(expandDocumentBlocks(payload)).rejects.toThrow('Invalid base64 data')
  })

  test('rejects truncated/unpadded base64 data', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: 'a', // single char — not a valid quartet
            },
          },
        ],
      },
    ])

    await expect(expandDocumentBlocks(payload)).rejects.toThrow('Invalid base64 data')
  })

  test('rejects base64 data containing asterisk character', async () => {
    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: 'SGV*sbG8=',
            },
          },
        ],
      },
    ])

    await expect(expandDocumentBlocks(payload)).rejects.toThrow('Invalid base64 data')
  })

  test('rejects base64 document exceeding 32MB', async () => {
    // Create a base64 string that decodes to > 32MB
    // 33MB of 'A' bytes → base64 is all 'QUFB...'
    const largeBase64 = Buffer.alloc(33 * 1024 * 1024, 65).toString('base64')

    const payload = makePayload([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: largeBase64,
            },
          },
        ],
      },
    ])

    await expect(expandDocumentBlocks(payload)).rejects.toThrow('exceeds maximum size of 32MB')
  })

  test('should reject file source type (Files API not supported)', async () => {
    const payload = {
      model: 'claude-sonnet-4',
      max_tokens: 100,
      messages: [{
        role: 'user' as const,
        content: [{
          type: 'document' as const,
          source: { type: 'file' as const, file_id: 'file-abc123' },
        }],
      }],
    }
    expect(expandDocumentBlocks(payload as any)).rejects.toThrow(/Files API/)
  })

  test('blocks URLs targeting localhost and private networks', async () => {
    const blockedUrls = [
      'http://localhost/doc.pdf',
      'http://localhost./doc.pdf', // trailing dot
      'http://127.0.0.1/doc.pdf',
      'http://127.0.0.2/doc.pdf',
      'http://127.255.255.255/doc.pdf',
      'http://[::1]/doc.pdf', // IPv6 loopback
      'http://[fd00::1]/doc.pdf', // IPv6 unique local (fd)
      'http://[fc00::1]/doc.pdf', // IPv6 unique local (fc)
      'http://[fe80::1]/doc.pdf', // IPv6 link-local
      'http://[::ffff:127.0.0.1]/doc.pdf', // IPv6-mapped IPv4 loopback
      'http://[::ffff:169.254.169.254]/doc.pdf', // IPv6-mapped metadata
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/internal.pdf',
      'http://192.168.1.1/secret.pdf',
      'http://172.16.0.1/private.pdf',
    ]

    for (const blockedUrl of blockedUrls) {
      const payload = makePayload([
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'url',
                url: blockedUrl,
              },
            },
          ],
        },
      ])

      await expect(expandDocumentBlocks(payload)).rejects.toThrow('blocked address')
    }
  })

  test('does not block public hostnames that resemble private IP prefixes', async () => {
    // Hostnames like 10.example.com are NOT IPv4 addresses — they must not be blocked.
    // We verify by checking the error is about fetch failure, not "blocked address".
    const legitimateUrls = [
      'http://10.example.com/doc.pdf',
      'http://172.16.docs.example.com/doc.pdf',
    ]

    for (const url of legitimateUrls) {
      const payload = makePayload([
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'url',
                url,
              },
            },
          ],
        },
      ])

      // Should NOT throw "blocked address" — will throw a fetch/network error instead
      try {
        await expandDocumentBlocks(payload)
        // If it doesn't throw at all, that's also fine (unlikely without a real server)
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).not.toContain('blocked address')
      }
    }
  })
})
