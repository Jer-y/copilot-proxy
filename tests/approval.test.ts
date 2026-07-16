import process from 'node:process'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

import { awaitApproval, setApprovalRequestModel, withApprovalRequestContext } from '~/lib/approval'

const originalPrompt = consola.prompt
const originalStdinIsTTY = process.stdin.isTTY
const originalStdoutIsTTY = process.stdout.isTTY

afterEach(() => {
  consola.prompt = originalPrompt
  setIsTTY(process.stdin, originalStdinIsTTY)
  setIsTTY(process.stdout, originalStdoutIsTTY)
})

describe('awaitApproval', () => {
  test('rejects without prompting when no TTY is available', async () => {
    const prompt = mock(async () => true)
    consola.prompt = prompt as unknown as typeof consola.prompt
    setIsTTY(process.stdin, false)
    setIsTTY(process.stdout, false)

    await expect(awaitApproval()).rejects.toMatchObject({
      response: expect.objectContaining({ status: 503 }),
    })
    expect(prompt).toHaveBeenCalledTimes(0)
  })

  test('rejects after prompt timeout', async () => {
    consola.prompt = mock(async () => new Promise<boolean>(() => {})) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)

    await expect(awaitApproval({ timeoutMs: 5 })).rejects.toMatchObject({
      response: expect.objectContaining({ status: 503 }),
    })
  })

  test('aborts the prompt when approval times out', async () => {
    let signal: AbortSignal | undefined
    consola.prompt = mock(async (_message: string, options?: { signal?: AbortSignal }) => {
      signal = options?.signal
      return new Promise<boolean>(() => {})
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)

    await expect(awaitApproval({ timeoutMs: 5 })).rejects.toMatchObject({
      response: expect.objectContaining({ status: 503 }),
    })
    expect(signal?.aborted).toBe(true)
  })

  test('cancels an active prompt when the request signal aborts', async () => {
    let promptSignal: AbortSignal | undefined
    consola.prompt = mock(async (_message: string, options?: { signal?: AbortSignal }) => {
      promptSignal = options?.signal
      return await new Promise<boolean>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)
    const controller = new AbortController()
    const approval = awaitApproval({ signal: controller.signal, timeoutMs: 1_000 })

    await waitFor(() => promptSignal !== undefined)
    controller.abort('client disconnected')

    await expect(approval).rejects.toMatchObject({ name: 'AbortError' })
    expect(promptSignal?.aborted).toBe(true)
  })

  test('keeps an aborted active prompt serialized until its underlying prompt settles', async () => {
    const resolvers: Array<(value: boolean) => void> = []
    consola.prompt = mock(async () => {
      return await new Promise<boolean>((resolve) => {
        resolvers.push(resolve)
      })
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)
    const controller = new AbortController()
    const first = awaitApproval({ signal: controller.signal, timeoutMs: 1_000 })

    await waitFor(() => resolvers.length === 1)
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    const second = awaitApproval({ timeoutMs: 1_000 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(consola.prompt).toHaveBeenCalledTimes(1)

    resolvers[0](true)
    await waitFor(() => resolvers.length === 2)
    resolvers[1](true)
    await second
  })

  test('removes an aborted queued approval from the internal queue before it can prompt', async () => {
    const resolvers: Array<(value: boolean) => void> = []
    consola.prompt = mock(async () => {
      return await new Promise<boolean>((resolve) => {
        resolvers.push(resolve)
      })
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)
    const first = awaitApproval({ timeoutMs: 1_000 })
    const controller = new AbortController()
    let abortedReads = 0
    const trackedSignal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'aborted')
          abortedReads++
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as AbortSignal
    const queued = awaitApproval({ signal: trackedSignal, timeoutMs: 1_000 })

    await waitFor(() => resolvers.length === 1)
    controller.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(consola.prompt).toHaveBeenCalledTimes(1)
    const readsAfterRemoval = abortedReads

    resolvers[0](true)
    await first
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(consola.prompt).toHaveBeenCalledTimes(1)
    expect(abortedReads).toBe(readsAfterRemoval)
  })

  test('serializes concurrent approval prompts', async () => {
    const resolvers: Array<(value: boolean) => void> = []
    consola.prompt = mock(async () => {
      return await new Promise<boolean>((resolve) => {
        resolvers.push(resolve)
      })
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)

    const first = awaitApproval({ timeoutMs: 1000 })
    const second = awaitApproval({ timeoutMs: 1000 })

    await waitFor(() => resolvers.length === 1)
    expect(consola.prompt).toHaveBeenCalledTimes(1)

    resolvers[0](true)
    await first

    await waitFor(() => resolvers.length === 2)
    expect(consola.prompt).toHaveBeenCalledTimes(2)

    resolvers[1](true)
    await second
  })

  test('preserves the request context of each queued approval', async () => {
    const messages: string[] = []
    const resolvers: Array<(value: boolean) => void> = []
    consola.prompt = mock(async (message: string) => {
      messages.push(message)
      return await new Promise<boolean>((resolve) => {
        resolvers.push(resolve)
      })
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)

    const first = withApprovalRequestContext({ method: 'POST', path: '/first' }, () =>
      awaitApproval({ timeoutMs: 1_000 }))
    const second = withApprovalRequestContext({ method: 'WS response.create', path: '/second' }, () =>
      awaitApproval({ timeoutMs: 1_000 }))

    await waitFor(() => resolvers.length === 1)
    expect(messages[0]).toContain('POST /first')
    resolvers[0](true)
    await first

    await waitFor(() => resolvers.length === 2)
    expect(messages[1]).toContain('WS response.create /second')
    resolvers[1](true)
    await second
  })

  test('rejects requests beyond the bounded approval queue', async () => {
    const resolvers: Array<(value: boolean) => void> = []
    consola.prompt = mock(async () => await new Promise<boolean>((resolve) => {
      resolvers.push(resolve)
    })) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)

    const admitted = Array.from({ length: 4 }, () => awaitApproval({ timeoutMs: 5_000 }))
    await waitFor(() => resolvers.length === 1)

    try {
      const rejected = await awaitApproval({ timeoutMs: 5_000 }).catch((error: unknown) => error)
      expect(rejected).toMatchObject({
        response: expect.objectContaining({ status: 503 }),
      })
      const body = await (rejected as { json: () => Promise<unknown> }).json() as {
        error: { code: string, message: string }
      }
      expect(body.error).toMatchObject({
        code: 'manual_approval_unavailable',
        message: 'Manual approval queue is full',
      })
      expect(consola.prompt).toHaveBeenCalledTimes(1)
    }
    finally {
      for (const [index, approval] of admitted.entries()) {
        await waitFor(() => resolvers.length === index + 1)
        resolvers[index](true)
        await approval
      }
    }
    expect(consola.prompt).toHaveBeenCalledTimes(4)
  })

  test('shows bounded request context before approval', async () => {
    let message = ''
    consola.prompt = mock(async (promptMessage: string) => {
      message = promptMessage
      return true
    }) as unknown as typeof consola.prompt
    setIsTTY(process.stdin, true)
    setIsTTY(process.stdout, true)

    await withApprovalRequestContext({
      method: 'POST',
      path: '/v1/messages',
      clientAddress: '127.0.0.1',
      origin: 'http://localhost:3000',
      userAgent: 'test-client/1.0',
    }, async () => {
      setApprovalRequestModel('claude-test')
      await awaitApproval({ timeoutMs: 1000 })
    })

    expect(message).toContain('POST /v1/messages')
    expect(message).toContain('model=claude-test')
    expect(message).toContain('client=127.0.0.1')
    expect(message).toContain('origin=http://localhost:3000')
    expect(message).toContain('user-agent=test-client/1.0')
  })
})

function setIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined): void {
  Object.defineProperty(stream, 'isTTY', {
    configurable: true,
    value,
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
