import { describe, expect, mock, test } from 'bun:test'

import { closeServerGracefully } from '~/start'

describe('closeServerGracefully', () => {
  test('drains active requests before closing', async () => {
    const close = mock(async () => {})

    await expect(closeServerGracefully({ close }, 20)).resolves.toBe('graceful')
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(false)
  })

  test('forces active connections closed only after the deadline', async () => {
    const close = mock((force?: boolean) => force ? Promise.resolve() : new Promise<void>(() => {}))

    await expect(closeServerGracefully({ close }, 10)).resolves.toBe('forced')
    expect(close).toHaveBeenCalledTimes(2)
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
  })

  test('forces close when graceful close rejects', async () => {
    const close = mock((force?: boolean) => force ? Promise.resolve() : Promise.reject(new Error('close failed')))

    await expect(closeServerGracefully({ close }, 20)).resolves.toBe('forced')
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
  })

  test('forces close when graceful close throws synchronously', async () => {
    const close = mock((force?: boolean) => {
      if (!force)
        throw new Error('synchronous close failure')
      return Promise.resolve()
    })

    await expect(closeServerGracefully({ close }, 20)).resolves.toBe('forced')
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
  })
})
