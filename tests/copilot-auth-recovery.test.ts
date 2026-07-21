import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import {
  acquireCopilotRequestPermit,
  fetchAuthenticatedCopilot,
  getCopilotRecoveryStatus,
  resetCopilotRecoveryStateForTests,
} from '~/services/copilot/authenticated-fetch'

function opaqueForbidden(): Response {
  return new Response('Forbidden\n', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Copilot-Service-Request-Id': crypto.randomUUID(),
      'X-GitHub-Request-Id': crypto.randomUUID(),
    },
  })
}

function completed(body = 'ok'): Response {
  return new Response(body, { status: 200 })
}

describe('authenticated Copilot recovery', () => {
  let originalToken: string | undefined
  let originalLimiter: typeof state.concurrencyLimiter

  beforeEach(() => {
    originalToken = state.copilotToken
    originalLimiter = state.concurrencyLimiter
    state.copilotToken = 'old-token'
    state.concurrencyLimiter = undefined
    resetCopilotRecoveryStateForTests()
  })

  afterEach(() => {
    state.copilotToken = originalToken
    state.concurrencyLimiter = originalLimiter
    resetCopilotRecoveryStateForTests()
  })

  test('refreshes after a 401 and rebuilds the request once', async () => {
    const authorizations: string[] = []
    const refreshToken = mock(async () => {
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-test',
      request: async (attempt) => {
        authorizations.push(`Bearer ${state.copilotToken}`)
        return attempt === 0
          ? new Response('Unauthorized', { status: 401 })
          : completed()
      },
    }, { refreshToken })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(authorizations).toEqual(['Bearer old-token', 'Bearer new-token'])
    expect(getCopilotRecoveryStatus().metrics.replaySuccesses).toBe(1)
  })

  test('only treats eligible authentication failures as recoverable', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const cases = [
      new Response(JSON.stringify({ error: { code: 'model_not_allowed', message: 'no' } }), { status: 403 }),
      new Response('Forbidden\n', { status: 403 }),
      new Response('Forbidden\n', {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Request-Id': 'wrong-mime-request-id',
        },
      }),
      new Response('Forbidden\n', {
        status: 403,
        headers: {
          'Content-Type': 'text/html',
          'X-GitHub-Request-Id': 'html-request-id',
        },
      }),
      new Response('Forbidden\n', {
        status: 403,
        headers: {
          'Retry-After': '60',
          'X-Copilot-Service-Request-Id': 'request-id',
        },
      }),
      new Response('rate limited', { status: 429 }),
      new Response('upstream failed', { status: 500 }),
    ]

    for (const [index, upstreamResponse] of cases.entries()) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: `/responses/${index}`,
        request: async () => upstreamResponse,
      }, { refreshToken })
      expect(response.status).toBe(upstreamResponse.status)
    }

    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses/transport-error',
      request: async () => {
        throw new Error('connection reset')
      },
    }, { refreshToken })).rejects.toThrow('connection reset')

    expect(refreshToken).toHaveBeenCalledTimes(0)
  })

  test('refreshes explicit token-error 403s regardless of Retry-After', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const codes = ['expired_token', 'invalid_token', 'token_expired'] as const

    for (const code of codes) {
      for (const hasRetryAfter of [false, true]) {
        const headers = hasRetryAfter ? { 'Retry-After': '60' } : undefined
        const request = mock(async (attempt: 0 | 1) => attempt === 0
          ? Response.json({ error: { code, message: 'expired' } }, { status: 403, headers })
          : completed('recovered'))

        const response = await fetchAuthenticatedCopilot({
          endpoint: `/responses/${code}/${hasRetryAfter ? 'retry-after' : 'no-retry-after'}`,
          model: 'gpt-expired-token',
          request,
        }, { refreshToken })

        expect(await response.text()).toBe('recovered')
        expect(request).toHaveBeenCalledTimes(2)
      }
    }

    expect(refreshToken).toHaveBeenCalledTimes(codes.length * 2)
  })

  test('uses Retry-After to exclude only opaque Forbidden 403s from recovery', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))

    for (const hasRetryAfter of [false, true]) {
      const request = mock(async (attempt: 0 | 1) => {
        if (attempt === 1)
          return completed('recovered')
        const response = opaqueForbidden()
        if (hasRetryAfter)
          response.headers.set('Retry-After', '60')
        return response
      })

      const response = await fetchAuthenticatedCopilot({
        endpoint: `/responses/opaque-forbidden/${hasRetryAfter ? 'retry-after' : 'no-retry-after'}`,
        model: 'gpt-opaque-forbidden',
        request,
      }, { refreshToken })

      expect(response.status).toBe(hasRetryAfter ? 403 : 200)
      expect(request).toHaveBeenCalledTimes(hasRetryAfter ? 1 : 2)
    }

    expect(refreshToken).toHaveBeenCalledTimes(1)
  })

  test('coalesces concurrent same-scope failures into one refresh and one canary', async () => {
    const refreshToken = mock(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    let firstAttempts = 0
    let replays = 0

    const responses = await Promise.all(Array.from({ length: 32 }, () =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-test',
        request: async (attempt) => {
          if (attempt === 0) {
            firstAttempts++
            return opaqueForbidden()
          }
          replays++
          return completed()
        },
      }, { refreshToken })))

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(firstAttempts).toBe(32)
    expect(replays).toBe(32)
    expect(responses.every(response => response.status === 200)).toBe(true)
  })

  test('lets an aborted recovery leader release its lease without cancelling the shared refresh', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    })
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    let leaderResponseDiscarded = false
    const leaderRequest = mock(async (attempt: 0 | 1) => {
      if (attempt !== 0)
        throw new Error('cancelled recovery leader must not replay')
      return new Response(new ReadableStream({
        cancel() {
          leaderResponseDiscarded = true
        },
      }), { status: 401 })
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-leader',
      request: leaderRequest,
      signal: leaderController.signal,
    }, { refreshToken })
    await refreshStarted
    leaderController.abort(new Error('setup deadline expired'))

    await expect(leader).rejects.toThrow('setup deadline expired')
    expect(leaderResponseDiscarded).toBe(true)
    expect(state.concurrencyLimiter.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 1,
      totalReleased: 1,
    })

    const followerRequest = mock(async (attempt: 0 | 1) => attempt === 0
      ? new Response('Unauthorized', { status: 401 })
      : completed('follower recovered'))
    const follower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-leader',
      request: followerRequest,
    }, { refreshToken })

    finishRefresh()
    const followerResponse = await follower
    expect(await followerResponse.text()).toBe('follower recovered')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(leaderRequest).toHaveBeenCalledTimes(1)
    expect(followerRequest).toHaveBeenCalledTimes(2)
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: {
        reactiveRefreshAttempts: 1,
        reactiveRefreshSuccesses: 1,
        replayAttempts: 1,
        replaySuccesses: 1,
      },
      scopes: { open: 0 },
    })
    expect(state.concurrencyLimiter.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 2,
      totalReleased: 2,
    })
  })

  test('does not let an unrelated in-flight request pin a failed aborted recovery past refresh cooldown', async () => {
    const leaderController = new AbortController()
    let now = 1_000
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const initialRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      return { outcome: 'failed' as const, generation: 1 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-failed-refresh',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { now: () => now, refreshToken: initialRefresh })
    await refreshStarted
    leaderController.abort(new Error('caller left during failed refresh'))
    await expect(leader).rejects.toThrow('caller left during failed refresh')

    let releaseKeeper!: (response: Response) => void
    let markKeeperStarted!: () => void
    const keeperGate = new Promise<Response>((resolve) => {
      releaseKeeper = resolve
    })
    const keeperStarted = new Promise<void>((resolve) => {
      markKeeperStarted = resolve
    })
    const keeper = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-failed-refresh',
      request: async () => {
        markKeeperStarted()
        return keeperGate
      },
    }, { now: () => now })
    await keeperStarted

    finishRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    now += 60_001

    const nextRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const nextRequest = mock(async (attempt: 0 | 1) => attempt === 0
      ? new Response('Unauthorized', { status: 401 })
      : completed('fresh recovery'))
    const nextResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-failed-refresh',
      request: nextRequest,
    }, { now: () => now, refreshToken: nextRefresh })

    releaseKeeper(completed('keeper complete'))
    expect(await (await keeper).text()).toBe('keeper complete')
    expect(await nextResponse.text()).toBe('fresh recovery')
    expect(nextRefresh).toHaveBeenCalledTimes(1)
    expect(nextRequest).toHaveBeenCalledTimes(2)
  })

  test('keeps a successful aborted recovery available to a request still waiting for its first response', async () => {
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    let markRefreshFinished!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve
    })
    const initialRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      markRefreshFinished()
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-late-follower',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { refreshToken: initialRefresh })
    await refreshStarted
    leaderController.abort(new Error('caller left during successful refresh'))
    await expect(leader).rejects.toThrow('caller left during successful refresh')

    let releaseFirstResponse!: (response: Response) => void
    let markFollowerStarted!: () => void
    const firstResponseGate = new Promise<Response>((resolve) => {
      releaseFirstResponse = resolve
    })
    const followerStarted = new Promise<void>((resolve) => {
      markFollowerStarted = resolve
    })
    const unexpectedRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 3 }))
    const followerRequest = mock(async (attempt: 0 | 1) => {
      if (attempt === 0) {
        markFollowerStarted()
        return firstResponseGate
      }
      return completed('late follower recovered')
    })
    const follower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-late-follower',
      request: followerRequest,
    }, { refreshToken: unexpectedRefresh })
    await followerStarted

    finishRefresh()
    await refreshFinished
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseFirstResponse(new Response('Unauthorized', { status: 401 }))

    expect(await (await follower).text()).toBe('late follower recovered')
    expect(initialRefresh).toHaveBeenCalledTimes(1)
    expect(unexpectedRefresh).toHaveBeenCalledTimes(0)
    expect(followerRequest).toHaveBeenCalledTimes(2)
  })

  test('does not let a request started after successful recovery settlement join the old follower cohort', async () => {
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    let markRefreshFinished!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve
    })
    const initialRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      markRefreshFinished()
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-new-request',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { refreshToken: initialRefresh })
    await refreshStarted
    leaderController.abort(new Error('caller left before successful refresh settled'))
    await expect(leader).rejects.toThrow('caller left before successful refresh settled')

    let releaseKeeper!: (response: Response) => void
    let markKeeperStarted!: () => void
    const keeperGate = new Promise<Response>((resolve) => {
      releaseKeeper = resolve
    })
    const keeperStarted = new Promise<void>((resolve) => {
      markKeeperStarted = resolve
    })
    const keeper = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-new-request',
      request: async () => {
        markKeeperStarted()
        return keeperGate
      },
    }, { refreshToken: initialRefresh })
    await keeperStarted

    finishRefresh()
    await refreshFinished
    await new Promise(resolve => setTimeout(resolve, 0))

    let freshTokenAvailable = false
    const laterRefresh = mock(async () => {
      freshTokenAvailable = true
      return { outcome: 'refreshed' as const, generation: 3 }
    })
    const laterRequest = mock(async () => freshTokenAvailable
      ? completed('new request recovered')
      : new Response('Unauthorized', { status: 401 }))
    const laterResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-new-request',
      request: laterRequest,
    }, { refreshToken: laterRefresh })

    releaseKeeper(completed('keeper complete'))
    expect(await (await keeper).text()).toBe('keeper complete')
    expect(await laterResponse.text()).toBe('new request recovered')
    expect(laterRefresh).toHaveBeenCalledTimes(1)
    expect(laterRequest).toHaveBeenCalledTimes(2)
  })

  test('does not let an older successful cohort close a circuit opened by a newer recovery', async () => {
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    let markRefreshFinished!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve
    })
    const initialRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      markRefreshFinished()
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-stale-cohort',
      request: async () => opaqueForbidden(),
      signal: leaderController.signal,
    }, { refreshToken: initialRefresh })
    await refreshStarted
    leaderController.abort(new Error('old cohort leader left'))
    await expect(leader).rejects.toThrow('old cohort leader left')

    let releaseFollowerFirst!: (response: Response) => void
    let releaseKeeper!: (response: Response) => void
    let initialRequestsStarted = 0
    let markInitialRequestsStarted!: () => void
    const initialRequestsReady = new Promise<void>((resolve) => {
      markInitialRequestsStarted = resolve
    })
    const followerFirstGate = new Promise<Response>((resolve) => {
      releaseFollowerFirst = resolve
    })
    const keeperGate = new Promise<Response>((resolve) => {
      releaseKeeper = resolve
    })
    const markInitialRequestStarted = () => {
      initialRequestsStarted++
      if (initialRequestsStarted === 2)
        markInitialRequestsStarted()
    }
    const follower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-stale-cohort',
      request: async (attempt) => {
        if (attempt === 0) {
          markInitialRequestStarted()
          return followerFirstGate
        }
        return completed('old cohort follower recovered')
      },
    }, { refreshToken: initialRefresh })
    const keeper = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-stale-cohort',
      request: async () => {
        markInitialRequestStarted()
        return keeperGate
      },
    }, { refreshToken: initialRefresh })
    await initialRequestsReady

    finishRefresh()
    await refreshFinished
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseFollowerFirst(opaqueForbidden())
    expect(await (await follower).text()).toBe('old cohort follower recovered')

    const newerRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 3 }))
    const newerResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-stale-cohort',
      request: async () => opaqueForbidden(),
    }, { refreshToken: newerRefresh })
    expect(newerResponse.status).toBe(403)
    expect(newerRefresh).toHaveBeenCalledTimes(0)
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)

    releaseKeeper(completed('keeper complete'))
    expect(await (await keeper).text()).toBe('keeper complete')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)
  })

  test('allows a fresh recovery after a persistent-transport permit settles', async () => {
    const permit = await acquireCopilotRequestPermit({
      endpoint: '/responses',
      model: 'gpt-aborted-permit-cleanup',
    })
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    let markRefreshFinished!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve
    })
    const initialRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      markRefreshFinished()
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-permit-cleanup',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { refreshToken: initialRefresh })
    await refreshStarted
    leaderController.abort(new Error('caller left during refresh'))
    await expect(leader).rejects.toThrow('caller left during refresh')
    finishRefresh()
    await refreshFinished
    await new Promise(resolve => setTimeout(resolve, 0))

    permit.cancel()

    const nextRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 3 }))
    const nextResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-permit-cleanup',
      request: async attempt => attempt === 0
        ? new Response('Unauthorized', { status: 401 })
        : completed('fresh recovery'),
    }, { refreshToken: nextRefresh })

    expect(await nextResponse.text()).toBe('fresh recovery')
    expect(nextRefresh).toHaveBeenCalledTimes(1)
  })

  test('does not let a persistent-transport permit pin a settled aborted recovery', async () => {
    const permit = await acquireCopilotRequestPermit({
      endpoint: '/responses',
      model: 'gpt-aborted-permit-not-a-follower',
    })
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    let markRefreshFinished!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve
    })
    const initialRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token-1'
      markRefreshFinished()
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-permit-not-a-follower',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { refreshToken: initialRefresh })
    await refreshStarted
    leaderController.abort(new Error('caller left during refresh'))
    await expect(leader).rejects.toThrow('caller left during refresh')
    finishRefresh()
    await refreshFinished
    await new Promise(resolve => setTimeout(resolve, 0))

    const authorizations: string[] = []
    const nextRefresh = mock(async () => {
      state.copilotToken = 'new-token-2'
      return { outcome: 'refreshed' as const, generation: 3 }
    })
    const nextResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-permit-not-a-follower',
      request: async () => {
        authorizations.push(`Bearer ${state.copilotToken}`)
        return state.copilotToken === 'new-token-2'
          ? completed('fresh recovery')
          : new Response('Unauthorized', { status: 401 })
      },
    }, { refreshToken: nextRefresh })

    expect(await nextResponse.text()).toBe('fresh recovery')
    expect(nextRefresh).toHaveBeenCalledTimes(1)
    expect(authorizations).toEqual(['Bearer new-token-1', 'Bearer new-token-2'])
    expect(getCopilotRecoveryStatus().scopes.open).toBe(0)
    permit.cancel()
  })

  test('closes opaque circuit evidence after every joined follower replay succeeds for an aborted leader', async () => {
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-opaque-followers',
      request: async (attempt) => {
        if (attempt !== 0)
          throw new Error('cancelled recovery leader must not replay')
        return new Response('Unauthorized', { status: 401 })
      },
      signal: leaderController.signal,
    }, { refreshToken })
    await refreshStarted
    leaderController.abort(new Error('setup deadline expired'))
    await expect(leader).rejects.toThrow('setup deadline expired')

    let followerFirstAttempts = 0
    let markFollowersWaiting!: () => void
    const followersWaiting = new Promise<void>((resolve) => {
      markFollowersWaiting = resolve
    })
    const followers = Array.from({ length: 3 }, (_, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-opaque-followers',
      request: async (attempt) => {
        if (attempt === 0) {
          followerFirstAttempts++
          if (followerFirstAttempts === 3)
            markFollowersWaiting()
          return opaqueForbidden()
        }
        return completed(`follower ${index} recovered`)
      },
    }, { refreshToken }))
    await followersWaiting
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)

    finishRefresh()
    const followerResponses = await Promise.all(followers)
    expect(await Promise.all(followerResponses.map(response => response.text()))).toEqual([
      'follower 0 recovered',
      'follower 1 recovered',
      'follower 2 recovered',
    ])
    expect(getCopilotRecoveryStatus()).toMatchObject({
      metrics: {
        replayAttempts: 3,
        replayFailures: 0,
        replaySuccesses: 3,
      },
      scopes: { open: 0 },
    })

    const nextRequest = mock(async () => completed('circuit closed'))
    const nextResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-opaque-followers',
      request: nextRequest,
    }, { refreshToken })
    expect(await nextResponse.text()).toBe('circuit closed')
    expect(nextRequest).toHaveBeenCalledTimes(1)
  })

  test('does not count a cancelled recovery follower as a replay failure', async () => {
    const leaderController = new AbortController()
    const cancelledFollowerController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-cancelled-opaque-follower',
      request: async (attempt) => {
        if (attempt !== 0)
          throw new Error('cancelled recovery leader must not replay')
        return new Response('Unauthorized', { status: 401 })
      },
      signal: leaderController.signal,
    }, { refreshToken })
    await refreshStarted
    leaderController.abort(new Error('recovery leader left during refresh'))
    await expect(leader).rejects.toThrow('recovery leader left during refresh')

    let followerFirstAttempts = 0
    let markFollowersWaiting!: () => void
    const followersWaiting = new Promise<void>((resolve) => {
      markFollowersWaiting = resolve
    })
    const followers = Array.from({ length: 3 }, (_, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-cancelled-opaque-follower',
      request: async (attempt) => {
        if (attempt === 0) {
          followerFirstAttempts++
          if (followerFirstAttempts === 3)
            markFollowersWaiting()
          return opaqueForbidden()
        }
        if (index === 0)
          throw new Error('cancelled recovery follower must not replay')
        return completed(`follower ${index} recovered`)
      },
      ...(index === 0 ? { signal: cancelledFollowerController.signal } : {}),
    }, { refreshToken }))
    await followersWaiting
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus().metrics.recoverableAuthFailures === 4)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus()).toMatchObject({
      metrics: { recoverableAuthFailures: 4 },
      scopes: { open: 1 },
    })

    cancelledFollowerController.abort(new Error('follower left while waiting for shared recovery'))
    await expect(followers[0]).rejects.toThrow('follower left while waiting for shared recovery')
    finishRefresh()

    const followerResponses = await Promise.all(followers.slice(1))
    expect(await Promise.all(followerResponses.map(response => response.text()))).toEqual([
      'follower 1 recovered',
      'follower 2 recovered',
    ])
    expect(getCopilotRecoveryStatus()).toMatchObject({
      metrics: {
        replayAttempts: 2,
        replayFailures: 0,
        replaySuccesses: 2,
      },
      scopes: { open: 0 },
    })

    const nextRequest = mock(async () => completed('circuit closed after cancellation'))
    const nextResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-cancelled-opaque-follower',
      request: nextRequest,
    }, { refreshToken })
    expect(await nextResponse.text()).toBe('circuit closed after cancellation')
    expect(nextRequest).toHaveBeenCalledTimes(1)
  })

  test('clears sub-threshold opaque evidence after every joined follower replay succeeds', async () => {
    const now = 1_000
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-sub-threshold-evidence',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { now: () => now, refreshToken })
    await refreshStarted
    leaderController.abort(new Error('setup deadline expired'))
    await expect(leader).rejects.toThrow('setup deadline expired')

    let followerFirstAttempts = 0
    let markFollowersWaiting!: () => void
    const followersWaiting = new Promise<void>((resolve) => {
      markFollowersWaiting = resolve
    })
    const followers = Array.from({ length: 2 }, (_, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-sub-threshold-evidence',
      request: async (attempt) => {
        if (attempt === 0) {
          followerFirstAttempts++
          if (followerFirstAttempts === 2)
            markFollowersWaiting()
          return opaqueForbidden()
        }
        return completed(`follower ${index} recovered`)
      },
    }, { now: () => now, refreshToken }))
    await followersWaiting
    await new Promise(resolve => setTimeout(resolve, 0))
    finishRefresh()
    const followerResponses = await Promise.all(followers)
    expect(followerResponses.every(response => response.status === 200)).toBe(true)

    const laterRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 3 }))
    const laterRequest = mock(async (attempt: 0 | 1) => attempt === 0
      ? opaqueForbidden()
      : completed('later recovery succeeded'))
    const laterResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-sub-threshold-evidence',
      request: laterRequest,
    }, { now: () => now, refreshToken: laterRefresh })

    expect(await laterResponse.text()).toBe('later recovery succeeded')
    expect(laterRefresh).toHaveBeenCalledTimes(1)
    expect(laterRequest).toHaveBeenCalledTimes(2)
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(0)
  })

  test('keeps stale scope cleanup alive across an unrelated global circuit close', async () => {
    const now = 1_000
    const leaderController = new AbortController()
    let markRefreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const scopeRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-scope-cleanup-after-global-close',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { now: () => now, refreshToken: scopeRefresh })
    await refreshStarted
    leaderController.abort(new Error('setup leader cancelled'))
    await expect(leader).rejects.toThrow('setup leader cancelled')

    let markFollowerInitialStarted!: () => void
    let markFollowerReplayStarted!: () => void
    let releaseFollowerInitial!: () => void
    let releaseFollowerReplay!: () => void
    const followerInitialStarted = new Promise<void>((resolve) => {
      markFollowerInitialStarted = resolve
    })
    const followerReplayStarted = new Promise<void>((resolve) => {
      markFollowerReplayStarted = resolve
    })
    const followerInitialGate = new Promise<void>((resolve) => {
      releaseFollowerInitial = resolve
    })
    const followerReplayGate = new Promise<void>((resolve) => {
      releaseFollowerReplay = resolve
    })
    const follower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-scope-cleanup-after-global-close',
      request: async (attempt) => {
        if (attempt === 0) {
          markFollowerInitialStarted()
          await followerInitialGate
          return opaqueForbidden()
        }
        markFollowerReplayStarted()
        await followerReplayGate
        return completed('delayed follower recovered')
      },
    }, { now: () => now, refreshToken: scopeRefresh })
    await followerInitialStarted
    releaseRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseFollowerInitial()
    await followerReplayStarted

    const globalRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 3 }))
    const globalResponses = await Promise.all(
      ['gpt-unrelated-global-a', 'gpt-unrelated-global-b'].flatMap(model =>
        Array.from({ length: 3 }, () => fetchAuthenticatedCopilot({
          endpoint: '/responses',
          model,
          request: async attempt => attempt === 0
            ? opaqueForbidden()
            : completed(`${model} recovered`),
        }, { now: () => now, refreshToken: globalRefresh }))),
    )
    expect(globalResponses.every(response => response.status === 200)).toBe(true)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { scopeCircuitOpens: 2 },
      scopes: { open: 0 },
    })

    releaseFollowerReplay()
    expect(await (await follower).text()).toBe('delayed follower recovered')
    await new Promise(resolve => setTimeout(resolve, 0))

    const failedRefresh = mock(async () => ({ outcome: 'failed' as const, generation: 4 }))
    const currentFailures = await Promise.all(Array.from({ length: 2 }, () =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-scope-cleanup-after-global-close',
        request: async () => opaqueForbidden(),
      }, { now: () => now, refreshToken: failedRefresh })))
    expect(currentFailures.every(response => response.status === 403)).toBe(true)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      metrics: { scopeCircuitOpens: 2 },
      scopes: { open: 0 },
    })
  })

  test('closes the global circuit after every affected scope has successful follower replays', async () => {
    let now = 1_000
    let finishRefresh!: () => void
    let markRefreshesStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshesStarted = new Promise<void>((resolve) => {
      markRefreshesStarted = resolve
    })
    let refreshAttempts = 0
    const refreshToken = mock(async () => {
      refreshAttempts++
      if (refreshAttempts === 2)
        markRefreshesStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const models = ['gpt-aborted-global-a', 'gpt-aborted-global-b']
    const controllers = models.map(() => new AbortController())
    const leaders = models.map((model, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: controllers[index]!.signal,
    }, { now: () => now, refreshToken }))
    const leaderErrors = leaders.map(leader => leader.then(
      () => { throw new Error('cancelled recovery leader unexpectedly completed') },
      error => error instanceof Error ? error : new Error(String(error)),
    ))
    await refreshesStarted
    controllers.forEach((controller, index) => controller.abort(new Error(`leader ${index} expired`)))
    const errors = await Promise.all(leaderErrors)
    expect(errors.map(error => error.message)).toEqual(['leader 0 expired', 'leader 1 expired'])

    let followerFirstAttempts = 0
    let markFollowersWaiting!: () => void
    const followersWaiting = new Promise<void>((resolve) => {
      markFollowersWaiting = resolve
    })
    const followers = models.flatMap(model => Array.from({ length: 3 }, (_, index) =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            followerFirstAttempts++
            if (followerFirstAttempts === 6)
              markFollowersWaiting()
            return opaqueForbidden()
          }
          return completed(`${model} follower ${index} recovered`)
        },
      }, { now: () => now, refreshToken })))
    await followersWaiting
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { open: 2 },
    })

    now += 60_001
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'half_open' },
      scopes: { halfOpen: 2 },
    })
    finishRefresh()
    const followerResponses = await Promise.all(followers)
    expect(followerResponses.every(response => response.status === 200)).toBe(true)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { replayFailures: 0, replaySuccesses: 6 },
      scopes: { halfOpen: 0, open: 0 },
    })

    const healthyRequest = mock(async () => completed('healthy scope reached upstream'))
    const healthyResponse = await fetchAuthenticatedCopilot({
      endpoint: '/v1/messages',
      model: 'claude-healthy-after-global-recovery',
      request: healthyRequest,
    }, { now: () => now, refreshToken })
    expect(await healthyResponse.text()).toBe('healthy scope reached upstream')
    expect(healthyRequest).toHaveBeenCalledTimes(1)
  })

  test('closes a global circuit opened by pending followers after their aborted leaders already refreshed', async () => {
    const now = 1_000
    let refreshesStarted = 0
    let markBothRefreshesStarted!: () => void
    let releaseRefreshes!: () => void
    const bothRefreshesStarted = new Promise<void>((resolve) => {
      markBothRefreshesStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefreshes = resolve
    })
    const refreshToken = mock(async () => {
      refreshesStarted++
      if (refreshesStarted === 2)
        markBothRefreshesStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const models = ['gpt-late-global-a', 'gpt-late-global-b']
    const controllers = models.map(() => new AbortController())
    const leaders = models.map((model, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: controllers[index]!.signal,
    }, { now: () => now, refreshToken }))
    await bothRefreshesStarted
    controllers.forEach(controller => controller.abort(new Error('setup leader cancelled')))
    await Promise.allSettled(leaders)

    let followerInitialAttempts = 0
    let markAllFollowersStarted!: () => void
    let releaseFollowerInitialAttempts!: () => void
    const allFollowersStarted = new Promise<void>((resolve) => {
      markAllFollowersStarted = resolve
    })
    const followerInitialGate = new Promise<void>((resolve) => {
      releaseFollowerInitialAttempts = resolve
    })
    const followers = models.flatMap(model =>
      Array.from({ length: 3 }, (_, index) => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            followerInitialAttempts++
            if (followerInitialAttempts === 6)
              markAllFollowersStarted()
            await followerInitialGate
            return opaqueForbidden()
          }
          return completed(`${model} follower ${index} recovered`)
        },
      }, { now: () => now, refreshToken })))

    await allFollowersStarted
    releaseRefreshes()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now).globalCircuit.phase).toBe('closed')

    releaseFollowerInitialAttempts()
    const followerResponses = await Promise.all(followers)
    expect(followerResponses.every(response => response.status === 200)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { replaySuccesses: 6 },
      scopes: { open: 0 },
    })
  })

  test('closes the global circuit after concurrent normal recoveries succeed in every affected scope', async () => {
    const models = ['gpt-global-recovery-a', 'gpt-global-recovery-b']
    let firstAttempts = 0
    let markAllFirstAttemptsComplete!: () => void
    let releaseRefresh!: () => void
    const allFirstAttemptsComplete = new Promise<void>((resolve) => {
      markAllFirstAttemptsComplete = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshToken = mock(async () => {
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const pendingResponses = Promise.all(models.flatMap(model =>
      Array.from({ length: 3 }, () => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            firstAttempts++
            if (firstAttempts === 6)
              markAllFirstAttemptsComplete()
            return opaqueForbidden()
          }
          return completed(`${model} recovered`)
        },
      }, { refreshToken }))))

    await allFirstAttemptsComplete
    let beforeReplay = getCopilotRecoveryStatus()
    for (let attempt = 0; attempt < 100 && beforeReplay.globalCircuit.phase !== 'open'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      beforeReplay = getCopilotRecoveryStatus()
    }
    releaseRefresh()
    const responses = await pendingResponses

    expect(beforeReplay).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { open: 2 },
    })
    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(refreshToken).toHaveBeenCalledTimes(2)
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { replayFailures: 0, replaySuccesses: 6 },
      scopes: { open: 0 },
    })

    const healthyRequest = mock(async () => completed('global circuit recovered'))
    const healthyResponse = await fetchAuthenticatedCopilot({
      endpoint: '/v1/messages',
      model: 'claude-after-global-recovery',
      request: healthyRequest,
    }, { refreshToken })
    expect(await healthyResponse.text()).toBe('global circuit recovered')
    expect(healthyRequest).toHaveBeenCalledTimes(1)
  })

  test('clears a single-scope circuit after delayed initial requests replay through a normal recovery', async () => {
    const now = 1_000
    let markRefreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const model = 'gpt-single-scope-delayed'
    const owner = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async attempt => attempt === 0
        ? new Response('Unauthorized', { status: 401 })
        : completed('owner recovered'),
    }, { now: () => now, refreshToken })
    await refreshStarted

    let followerInitialAttempts = 0
    let markAllFollowersStarted!: () => void
    let releaseFollowerInitialAttempts!: () => void
    const allFollowersStarted = new Promise<void>((resolve) => {
      markAllFollowersStarted = resolve
    })
    const followerInitialGate = new Promise<void>((resolve) => {
      releaseFollowerInitialAttempts = resolve
    })
    let followerReplaysStarted = 0
    let markAllFollowerReplaysStarted!: () => void
    let releaseFollowerReplays!: () => void
    const allFollowerReplaysStarted = new Promise<void>((resolve) => {
      markAllFollowerReplaysStarted = resolve
    })
    const followerReplayGate = new Promise<void>((resolve) => {
      releaseFollowerReplays = resolve
    })
    const followerRequestCalls = [0, 0, 0]
    const followers = followerRequestCalls.map((_, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async (attempt) => {
        followerRequestCalls[index]++
        if (attempt === 0) {
          followerInitialAttempts++
          if (followerInitialAttempts === followerRequestCalls.length)
            markAllFollowersStarted()
          await followerInitialGate
          return opaqueForbidden()
        }
        followerReplaysStarted++
        if (followerReplaysStarted === followerRequestCalls.length)
          markAllFollowerReplaysStarted()
        await followerReplayGate
        return completed(`follower ${index} recovered`)
      },
    }, { now: () => now, refreshToken }))

    await allFollowersStarted
    releaseRefresh()
    const ownerResponse = await owner
    expect(await ownerResponse.text()).toBe('owner recovered')
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { replaySuccesses: 1 },
      scopes: { open: 0 },
    })

    releaseFollowerInitialAttempts()
    await allFollowerReplaysStarted
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { globalCircuitOpens: 0, scopeCircuitOpens: 1 },
      scopes: { open: 1 },
    })

    releaseFollowerReplays()
    const followerResponses = await Promise.all(followers)
    expect(followerResponses.every(response => response.status === 200)).toBe(true)
    expect(followerRequestCalls).toEqual([2, 2, 2])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { replayFailures: 0, replaySuccesses: 4 },
      scopes: { open: 0 },
    })

    const healthyRequest = mock(async () => completed('scope remains available'))
    const healthyResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: healthyRequest,
    }, { now: () => now, refreshToken })
    expect(await healthyResponse.text()).toBe('scope remains available')
    expect(healthyRequest).toHaveBeenCalledTimes(1)
  })

  test('replays delayed initial requests through a successful normal recovery cohort', async () => {
    const now = 1_000
    let refreshesStarted = 0
    let markBothRefreshesStarted!: () => void
    let releaseRefreshes!: () => void
    const bothRefreshesStarted = new Promise<void>((resolve) => {
      markBothRefreshesStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefreshes = resolve
    })
    const refreshToken = mock(async () => {
      refreshesStarted++
      if (refreshesStarted === 2)
        markBothRefreshesStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const models = ['gpt-normal-delayed-a', 'gpt-normal-delayed-b']
    const owners = models.map(model => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async attempt => attempt === 0
        ? opaqueForbidden()
        : completed(`${model} owner recovered`),
    }, { now: () => now, refreshToken }))
    await bothRefreshesStarted

    let fastInitialAttempts = 0
    let slowInitialAttempts = 0
    let markAllInitialAttemptsStarted!: () => void
    let releaseSlowInitialAttempts!: () => void
    const allInitialAttemptsStarted = new Promise<void>((resolve) => {
      markAllInitialAttemptsStarted = resolve
    })
    const slowInitialGate = new Promise<void>((resolve) => {
      releaseSlowInitialAttempts = resolve
    })
    const markInitialAttempt = (slow: boolean) => {
      if (slow)
        slowInitialAttempts++
      else
        fastInitialAttempts++
      if (fastInitialAttempts === 4 && slowInitialAttempts === 6)
        markAllInitialAttemptsStarted()
    }
    const fastFollowers = models.flatMap(model =>
      Array.from({ length: 2 }, (_, index) => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            markInitialAttempt(false)
            return opaqueForbidden()
          }
          return completed(`${model} fast follower ${index} recovered`)
        },
      }, { now: () => now, refreshToken })))
    const slowRequestCalls = Array.from({ length: 6 }).fill(0) as number[]
    const slowFollowers = models.flatMap((model, modelIndex) =>
      Array.from({ length: 3 }, (_, followerIndex) => {
        const requestIndex = modelIndex * 3 + followerIndex
        return fetchAuthenticatedCopilot({
          endpoint: '/responses',
          model,
          request: async (attempt) => {
            slowRequestCalls[requestIndex]++
            if (attempt === 0) {
              markInitialAttempt(true)
              await slowInitialGate
              return opaqueForbidden()
            }
            return completed(`${model} delayed follower ${followerIndex} recovered`)
          },
        }, { now: () => now, refreshToken })
      }))

    await allInitialAttemptsStarted
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus(now).metrics.recoverableAuthFailures === 6)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      metrics: { recoverableAuthFailures: 6 },
      scopes: { open: 2 },
    })

    releaseRefreshes()
    const fastResponses = await Promise.all([...owners, ...fastFollowers])
    expect(fastResponses.every(response => response.status === 200)).toBe(true)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { open: 0 },
    })

    releaseSlowInitialAttempts()
    const slowResponses = await Promise.all(slowFollowers)
    expect(slowResponses.every(response => response.status === 200)).toBe(true)
    expect(slowRequestCalls).toEqual([2, 2, 2, 2, 2, 2])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { replaySuccesses: 12 },
      scopes: { open: 0 },
    })
  })

  test('does not let an older recovery follower close a global circuit reopened by a newer probe failure', async () => {
    let now = 1_000
    let refreshesStarted = 0
    let markBothRefreshesStarted!: () => void
    let releaseRefreshes!: () => void
    const bothRefreshesStarted = new Promise<void>((resolve) => {
      markBothRefreshesStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefreshes = resolve
    })
    const refreshToken = mock(async () => {
      refreshesStarted++
      if (refreshesStarted === 2)
        markBothRefreshesStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const models = ['gpt-old-global-follower-a', 'gpt-old-global-follower-b']
    const owners = models.map(model => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async attempt => attempt === 0
        ? opaqueForbidden()
        : completed(`${model} owner recovered`),
    }, { now: () => now, refreshToken }))
    await bothRefreshesStarted

    let followerFirstAttempts = 0
    let markAllFollowersWaiting!: () => void
    let markSlowReplayStarted!: () => void
    let releaseSlowReplay!: () => void
    const allFollowersWaiting = new Promise<void>((resolve) => {
      markAllFollowersWaiting = resolve
    })
    const slowReplayStarted = new Promise<void>((resolve) => {
      markSlowReplayStarted = resolve
    })
    const slowReplayGate = new Promise<void>((resolve) => {
      releaseSlowReplay = resolve
    })
    const followers = models.flatMap((model, modelIndex) =>
      Array.from({ length: 2 }, (_, followerIndex) => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            followerFirstAttempts++
            if (followerFirstAttempts === 4)
              markAllFollowersWaiting()
            return opaqueForbidden()
          }
          if (modelIndex === 0 && followerIndex === 0) {
            markSlowReplayStarted()
            await slowReplayGate
          }
          return completed(`${model} follower ${followerIndex} recovered`)
        },
      }, { now: () => now, refreshToken })))

    await allFollowersWaiting
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus(now).metrics.recoverableAuthFailures === 6)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      metrics: { recoverableAuthFailures: 6 },
      scopes: { open: 2 },
    })

    releaseRefreshes()
    const ownerResponses = await Promise.all(owners)
    expect(ownerResponses.every(response => response.status === 200)).toBe(true)
    await slowReplayStarted
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus(now).scopes.open === 0)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { open: 0 },
    })

    now += 60_001
    const failedProbe = mock(async () => {
      throw new Error('newer global probe transport failed')
    })
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/v1/messages',
      model: 'claude-newer-global-probe',
      request: failedProbe,
    }, { now: () => now, refreshToken })).rejects.toThrow('newer global probe transport failed')
    expect(getCopilotRecoveryStatus(now).globalCircuit).toMatchObject({
      phase: 'open',
      retryAfterSeconds: 120,
    })

    releaseSlowReplay()
    const followerResponses = await Promise.all(followers)
    expect(followerResponses.every(response => response.status === 200)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now).globalCircuit).toMatchObject({
      phase: 'open',
      retryAfterSeconds: 120,
    })
  })

  test('does not let an unrelated closed-global recovery follower block a later global recovery', async () => {
    let markEarlyRefreshStarted!: () => void
    let releaseEarlyRefresh!: () => void
    const earlyRefreshStarted = new Promise<void>((resolve) => {
      markEarlyRefreshStarted = resolve
    })
    const earlyRefreshGate = new Promise<void>((resolve) => {
      releaseEarlyRefresh = resolve
    })
    const earlyRefresh = mock(async () => {
      markEarlyRefreshStarted()
      await earlyRefreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const earlyOwner = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-unrelated-slow-follower',
      request: async attempt => attempt === 0
        ? new Response('Unauthorized', { status: 401 })
        : completed('early owner recovered'),
    }, { refreshToken: earlyRefresh })
    await earlyRefreshStarted

    let markSlowReplayStarted!: () => void
    let releaseSlowReplay!: () => void
    const slowReplayStarted = new Promise<void>((resolve) => {
      markSlowReplayStarted = resolve
    })
    const slowReplayGate = new Promise<void>((resolve) => {
      releaseSlowReplay = resolve
    })
    const slowFollower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-unrelated-slow-follower',
      request: async (attempt) => {
        if (attempt === 0)
          return new Response('Unauthorized', { status: 401 })
        markSlowReplayStarted()
        await slowReplayGate
        return completed('slow follower recovered')
      },
    }, { refreshToken: earlyRefresh })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus().metrics.recoverableAuthFailures === 2)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { recoverableAuthFailures: 2 },
    })
    releaseEarlyRefresh()
    expect(await (await earlyOwner).text()).toBe('early owner recovered')
    await slowReplayStarted

    const models = ['gpt-later-global-a', 'gpt-later-global-b']
    let firstAttempts = 0
    let markAllFirstAttemptsComplete!: () => void
    let releaseLaterRefresh!: () => void
    const allFirstAttemptsComplete = new Promise<void>((resolve) => {
      markAllFirstAttemptsComplete = resolve
    })
    const laterRefreshGate = new Promise<void>((resolve) => {
      releaseLaterRefresh = resolve
    })
    const laterRefresh = mock(async () => {
      await laterRefreshGate
      return { outcome: 'refreshed' as const, generation: 3 }
    })
    const pendingResponses = Promise.all(models.flatMap(model =>
      Array.from({ length: 3 }, () => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            firstAttempts++
            if (firstAttempts === 6)
              markAllFirstAttemptsComplete()
            return opaqueForbidden()
          }
          return completed(`${model} recovered`)
        },
      }, { refreshToken: laterRefresh }))))

    await allFirstAttemptsComplete
    let beforeReplay = getCopilotRecoveryStatus()
    for (let attempt = 0; attempt < 100 && beforeReplay.globalCircuit.phase !== 'open'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      beforeReplay = getCopilotRecoveryStatus()
    }
    releaseLaterRefresh()
    const responses = await pendingResponses
    const recoveredStatus = getCopilotRecoveryStatus()
    releaseSlowReplay()
    const slowFollowerResponse = await slowFollower

    expect(beforeReplay.globalCircuit.phase).toBe('open')
    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(recoveredStatus).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { open: 0 },
    })
    expect(await slowFollowerResponse.text()).toBe('slow follower recovered')
  })

  test('does not attach an unrelated cancelled-leader recovery cohort to the current global epoch', async () => {
    const unrelatedController = new AbortController()
    let markUnrelatedRefreshStarted!: () => void
    let releaseUnrelatedRefresh!: () => void
    const unrelatedRefreshStarted = new Promise<void>((resolve) => {
      markUnrelatedRefreshStarted = resolve
    })
    const unrelatedRefreshGate = new Promise<void>((resolve) => {
      releaseUnrelatedRefresh = resolve
    })
    const unrelatedRefresh = mock(async () => {
      markUnrelatedRefreshStarted()
      await unrelatedRefreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const unrelatedOwner = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-unrelated-cancelled-leader',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: unrelatedController.signal,
    }, { refreshToken: unrelatedRefresh })
    await unrelatedRefreshStarted
    unrelatedController.abort(new Error('unrelated recovery leader cancelled'))
    await expect(unrelatedOwner).rejects.toThrow('unrelated recovery leader cancelled')

    let markUnrelatedFollowerWaiting!: () => void
    let markUnrelatedReplayStarted!: () => void
    let releaseUnrelatedReplay!: () => void
    const unrelatedFollowerWaiting = new Promise<void>((resolve) => {
      markUnrelatedFollowerWaiting = resolve
    })
    const unrelatedReplayStarted = new Promise<void>((resolve) => {
      markUnrelatedReplayStarted = resolve
    })
    const unrelatedReplayGate = new Promise<void>((resolve) => {
      releaseUnrelatedReplay = resolve
    })
    const unrelatedFollower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-unrelated-cancelled-leader',
      request: async (attempt) => {
        if (attempt === 0) {
          markUnrelatedFollowerWaiting()
          return new Response('Unauthorized', { status: 401 })
        }
        markUnrelatedReplayStarted()
        await unrelatedReplayGate
        return completed('unrelated follower recovered')
      },
    }, { refreshToken: unrelatedRefresh })
    await unrelatedFollowerWaiting
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus().metrics.recoverableAuthFailures === 2)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: { recoverableAuthFailures: 2 },
      scopes: { open: 0 },
    })

    let affectedInitialAttempts = 0
    let markAllAffectedInitialAttemptsStarted!: () => void
    let releaseAffectedRefreshes!: () => void
    const allAffectedInitialAttemptsStarted = new Promise<void>((resolve) => {
      markAllAffectedInitialAttemptsStarted = resolve
    })
    const affectedRefreshGate = new Promise<void>((resolve) => {
      releaseAffectedRefreshes = resolve
    })
    const affectedRefresh = mock(async () => {
      await affectedRefreshGate
      return { outcome: 'refreshed' as const, generation: 3 }
    })
    const affectedModels = ['gpt-current-affected-a', 'gpt-current-affected-b']
    const affectedRequests = affectedModels.flatMap(model =>
      Array.from({ length: 3 }, (_, index) => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            affectedInitialAttempts++
            if (affectedInitialAttempts === 6)
              markAllAffectedInitialAttemptsStarted()
            return opaqueForbidden()
          }
          return completed(`${model} follower ${index} recovered`)
        },
      }, { refreshToken: affectedRefresh })))

    await allAffectedInitialAttemptsStarted
    for (let attempt = 0; attempt < 100; attempt++) {
      if (getCopilotRecoveryStatus().globalCircuit.phase === 'open')
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { open: 2 },
    })

    releaseUnrelatedRefresh()
    await unrelatedReplayStarted
    releaseAffectedRefreshes()
    const affectedResponses = await Promise.all(affectedRequests)
    expect(affectedResponses.every(response => response.status === 200)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    const statusWhileUnrelatedReplayPending = getCopilotRecoveryStatus()

    releaseUnrelatedReplay()
    expect(await (await unrelatedFollower).text()).toBe('unrelated follower recovered')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(statusWhileUnrelatedReplayPending).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { open: 0 },
    })
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { open: 0 },
    })
  })

  test('keeps the global circuit open when one normal recovery follower replay fails', async () => {
    const models = ['gpt-global-follower-failure-a', 'gpt-global-follower-failure-b']
    let now = 1_000
    let refreshesStarted = 0
    let markBothRefreshesStarted!: () => void
    let releaseRefresh!: () => void
    const bothRefreshesStarted = new Promise<void>((resolve) => {
      markBothRefreshesStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshToken = mock(async () => {
      refreshesStarted++
      if (refreshesStarted === 2)
        markBothRefreshesStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const owners = models.map(model => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async attempt => attempt === 0
        ? opaqueForbidden()
        : completed(`${model} owner recovered`),
    }, { now: () => now, refreshToken }))
    await bothRefreshesStarted

    let followerFirstAttempts = 0
    let markAllFollowersWaiting!: () => void
    const allFollowersWaiting = new Promise<void>((resolve) => {
      markAllFollowersWaiting = resolve
    })
    const followers = models.flatMap((model, modelIndex) =>
      Array.from({ length: 2 }, (_, followerIndex) => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async (attempt) => {
          if (attempt === 0) {
            followerFirstAttempts++
            if (followerFirstAttempts === 4)
              markAllFollowersWaiting()
            return opaqueForbidden()
          }
          if (modelIndex === 0 && followerIndex === 0)
            return opaqueForbidden()
          return completed(`${model} follower ${followerIndex} recovered`)
        },
      }, { now: () => now, refreshToken })))

    await allFollowersWaiting
    let beforeReplay = getCopilotRecoveryStatus(now)
    for (let attempt = 0; attempt < 100 && beforeReplay.globalCircuit.phase !== 'open'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      beforeReplay = getCopilotRecoveryStatus(now)
    }
    releaseRefresh()
    const responses = await Promise.all([...owners, ...followers])

    expect(beforeReplay.globalCircuit.phase).toBe('open')
    expect(responses.filter(response => response.status === 403)).toHaveLength(1)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      metrics: { replayFailures: 1, replaySuccesses: 5 },
      scopes: { open: 1 },
    })

    const blockedRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/v1/messages',
      model: 'claude-after-partial-global-recovery',
      request: blockedRequest,
    }, { now: () => now, refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(blockedRequest).not.toHaveBeenCalled()

    now += 60_001
    const halfOpenProbe = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: models[0],
      request: async () => completed('half-open recovery succeeded'),
    }, { now: () => now, refreshToken })
    expect(await halfOpenProbe.text()).toBe('half-open recovery succeeded')
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { halfOpen: 0, open: 0 },
    })
  })

  test('keeps the global circuit half-open until every affected scope succeeds', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const models = ['gpt-half-open-scope-a', 'gpt-half-open-scope-b']

    for (const model of models) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { now: () => now, refreshToken })
      expect(response.status).toBe(403)
      await response.text()
    }

    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { open: 2 },
    })

    now += 60_001
    const firstProbe = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: models[0],
      request: async () => completed('first scope recovered'),
    }, { now: () => now, refreshToken })
    expect(await firstProbe.text()).toBe('first scope recovered')
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'half_open' },
      scopes: { halfOpen: 1, open: 0 },
    })

    const secondProbe = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: models[1],
      request: async () => completed('second scope recovered'),
    }, { now: () => now, refreshToken })
    expect(await secondProbe.text()).toBe('second scope recovered')
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { halfOpen: 0, open: 0 },
    })
  })

  test('closes the current global epoch without waiting for an older unused scope', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const openScope = async (model: string) => {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { now: () => now, refreshToken })
      expect(response.status).toBe(403)
      await response.text()
    }

    await openScope('gpt-old-unused-scope-c')
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { open: 1 },
    })

    now += 10_001
    await openScope('gpt-current-global-scope-a')
    await openScope('gpt-current-global-scope-b')
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      metrics: { globalCircuitOpens: 1, scopeCircuitOpens: 3 },
      scopes: { open: 3 },
    })

    now += 60_001
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'half_open' },
      scopes: { halfOpen: 3, open: 0 },
    })

    for (const model of ['gpt-current-global-scope-a', 'gpt-current-global-scope-b']) {
      const probe = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => completed(`${model} recovered`),
      }, { now: () => now, refreshToken })
      expect(await probe.text()).toBe(`${model} recovered`)
    }

    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'closed' },
      scopes: { halfOpen: 1, open: 0 },
    })

    const healthyRequest = mock(async () => completed('healthy request reached upstream'))
    const healthyResults = await Promise.allSettled(
      ['claude-healthy-concurrent-a', 'claude-healthy-concurrent-b'].map(model =>
        fetchAuthenticatedCopilot({
          endpoint: '/v1/messages',
          model,
          request: healthyRequest,
        }, { now: () => now, refreshToken })),
    )

    expect(healthyResults.every(result => result.status === 'fulfilled')).toBe(true)
    expect(healthyRequest).toHaveBeenCalledTimes(2)
    for (const result of healthyResults) {
      if (result.status === 'fulfilled')
        expect(await result.value.text()).toBe('healthy request reached upstream')
    }
  })

  test('keeps follower replay failure dominant when a later joined replay succeeds', async () => {
    const leaderController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-follower-failure',
      request: async () => opaqueForbidden(),
      signal: leaderController.signal,
    }, { refreshToken })
    await refreshStarted
    leaderController.abort(new Error('setup deadline expired'))
    await expect(leader).rejects.toThrow('setup deadline expired')

    let followerFirstAttempts = 0
    let markFollowersWaiting!: () => void
    const followersWaiting = new Promise<void>((resolve) => {
      markFollowersWaiting = resolve
    })
    let allowLateSuccess!: () => void
    const lateSuccessGate = new Promise<void>((resolve) => {
      allowLateSuccess = resolve
    })
    const failedFollower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-follower-failure',
      request: async (attempt) => {
        if (attempt === 0) {
          followerFirstAttempts++
          if (followerFirstAttempts === 2)
            markFollowersWaiting()
        }
        return opaqueForbidden()
      },
    }, { refreshToken })
    const successfulFollower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-follower-failure',
      request: async (attempt) => {
        if (attempt === 0) {
          followerFirstAttempts++
          if (followerFirstAttempts === 2)
            markFollowersWaiting()
          return opaqueForbidden()
        }
        await lateSuccessGate
        return completed('late follower recovered')
      },
    }, { refreshToken })
    await followersWaiting
    await new Promise(resolve => setTimeout(resolve, 0))
    finishRefresh()

    expect((await failedFollower).status).toBe(403)
    allowLateSuccess()
    expect(await (await successfulFollower).text()).toBe('late follower recovered')
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)

    const blockedRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-follower-failure',
      request: blockedRequest,
    }, { refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(blockedRequest).not.toHaveBeenCalled()
  })

  test('lets an aborted recovery follower release only its own lease while the leader completes', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 2,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    })
    const followerController = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const leaderRequest = mock(async (attempt: 0 | 1) => attempt === 0
      ? new Response('Unauthorized', { status: 401 })
      : completed('leader recovered'))
    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-follower',
      request: leaderRequest,
    }, { refreshToken })
    await refreshStarted

    let markFollowerWaiting!: () => void
    let followerResponseDiscarded = false
    const followerWaiting = new Promise<void>((resolve) => {
      markFollowerWaiting = resolve
    })
    const followerRequest = mock(async (attempt: 0 | 1) => {
      if (attempt !== 0)
        throw new Error('cancelled recovery follower must not replay')
      markFollowerWaiting()
      return new Response(new ReadableStream({
        cancel() {
          followerResponseDiscarded = true
        },
      }), { status: 401 })
    })
    const follower = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-follower',
      request: followerRequest,
      signal: followerController.signal,
    }, { refreshToken })
    await followerWaiting
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.concurrencyLimiter.snapshot().active).toBe(2)

    followerController.abort(new Error('follower setup deadline expired'))
    await expect(follower).rejects.toThrow('follower setup deadline expired')
    expect(followerResponseDiscarded).toBe(true)
    expect(state.concurrencyLimiter.snapshot()).toMatchObject({
      active: 1,
      totalAcquired: 2,
      totalReleased: 1,
    })

    finishRefresh()
    const leaderResponse = await leader
    expect(await leaderResponse.text()).toBe('leader recovered')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(leaderRequest).toHaveBeenCalledTimes(2)
    expect(followerRequest).toHaveBeenCalledTimes(1)
    expect(getCopilotRecoveryStatus()).toMatchObject({
      globalCircuit: { phase: 'closed' },
      metrics: {
        reactiveRefreshAttempts: 1,
        reactiveRefreshSuccesses: 1,
        replayAttempts: 1,
        replaySuccesses: 1,
      },
      scopes: { open: 0 },
    })
    expect(state.concurrencyLimiter.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 2,
      totalReleased: 2,
    })
  })

  test('does not close a half-open circuit when its cancelled probe only refreshes the token', async () => {
    let now = 1_000
    const openCircuitRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const rejected = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-half-open',
      request: async () => opaqueForbidden(),
    }, { now: () => now, refreshToken: openCircuitRefresh })
    expect(rejected.status).toBe(403)
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(1)

    now += 60_001
    const controller = new AbortController()
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    let markRefreshFinished!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve
    })
    const halfOpenRefresh = mock(async () => {
      markRefreshStarted()
      await refreshGate
      markRefreshFinished()
      return { outcome: 'refreshed' as const, generation: 3 }
    })
    const cancelledProbe = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-half-open',
      request: async (attempt) => {
        if (attempt !== 0)
          throw new Error('cancelled half-open probe must not replay')
        return new Response('Unauthorized', { status: 401 })
      },
      signal: controller.signal,
    }, { now: () => now, refreshToken: halfOpenRefresh })
    await refreshStarted
    controller.abort(new Error('half-open setup probe expired'))
    await expect(cancelledProbe).rejects.toThrow('half-open setup probe expired')

    finishRefresh()
    await refreshFinished
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now).scopes.halfOpen).toBe(1)

    const successfulProbe = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-half-open',
      request: async () => completed('half-open recovered'),
    }, { now: () => now, refreshToken: halfOpenRefresh })
    expect(await successfulProbe.text()).toBe('half-open recovered')
    expect(getCopilotRecoveryStatus(now).scopes.halfOpen).toBe(0)
  })

  test('does not let older aborted-recovery followers close a scope reopened by a newer probe failure', async () => {
    let now = 1_000
    const leaderController = new AbortController()
    let markRefreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshToken = mock(async () => {
      markRefreshStarted()
      await refreshGate
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    const leader = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-stale-scope-followers',
      request: async () => new Response('Unauthorized', { status: 401 }),
      signal: leaderController.signal,
    }, { now: () => now, refreshToken })
    await refreshStarted
    leaderController.abort(new Error('setup leader cancelled'))
    await expect(leader).rejects.toThrow('setup leader cancelled')

    let initialAttempts = 0
    let replayAttempts = 0
    let markAllInitialAttemptsStarted!: () => void
    let markAllReplaysStarted!: () => void
    let releaseInitialAttempts!: () => void
    let releaseReplays!: () => void
    const allInitialAttemptsStarted = new Promise<void>((resolve) => {
      markAllInitialAttemptsStarted = resolve
    })
    const allReplaysStarted = new Promise<void>((resolve) => {
      markAllReplaysStarted = resolve
    })
    const initialAttemptGate = new Promise<void>((resolve) => {
      releaseInitialAttempts = resolve
    })
    const replayGate = new Promise<void>((resolve) => {
      releaseReplays = resolve
    })
    const followers = Array.from({ length: 3 }, (_, index) => fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-stale-scope-followers',
      request: async (attempt) => {
        if (attempt === 0) {
          initialAttempts++
          if (initialAttempts === 3)
            markAllInitialAttemptsStarted()
          await initialAttemptGate
          return opaqueForbidden()
        }
        replayAttempts++
        if (replayAttempts === 3)
          markAllReplaysStarted()
        await replayGate
        return completed(`follower ${index} recovered`)
      },
    }, { now: () => now, refreshToken }))

    await allInitialAttemptsStarted
    releaseRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    releaseInitialAttempts()
    await allReplaysStarted
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(1)

    now += 60_001
    const failedProbe = mock(async () => {
      throw new Error('newer scope probe transport failed')
    })
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-stale-scope-followers',
      request: failedProbe,
    }, { now: () => now, refreshToken })).rejects.toThrow('newer scope probe transport failed')
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(1)

    releaseReplays()
    const followerResponses = await Promise.all(followers)
    expect(followerResponses.every(response => response.status === 200)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(1)

    const bypassRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-stale-scope-followers',
      request: bypassRequest,
    }, { now: () => now, refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(bypassRequest).not.toHaveBeenCalled()
  })

  test('retains opaque failure evidence when cancelled leaders refresh without a canary', async () => {
    const now = 1_000
    let refreshAttempts = 0

    const abortOpaqueRecovery = async (index: number) => {
      const controller = new AbortController()
      let finishRefresh!: () => void
      let markRefreshStarted!: () => void
      const refreshGate = new Promise<void>((resolve) => {
        finishRefresh = resolve
      })
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve
      })
      const refreshToken = mock(async () => {
        refreshAttempts++
        markRefreshStarted()
        await refreshGate
        return { outcome: 'refreshed' as const, generation: index + 1 }
      })
      const pending = fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-aborted-opaque-evidence',
        request: async (attempt) => {
          if (attempt !== 0)
            throw new Error('cancelled opaque leader must not replay')
          return opaqueForbidden()
        },
        signal: controller.signal,
      }, { now: () => now, refreshToken })

      await refreshStarted
      controller.abort(new Error(`opaque setup probe ${index} expired`))
      await expect(pending).rejects.toThrow(`opaque setup probe ${index} expired`)
      finishRefresh()
      await refreshGate
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    await abortOpaqueRecovery(1)
    await abortOpaqueRecovery(2)
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(0)

    const unexpectedRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 4 }))
    const thresholdResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-aborted-opaque-evidence',
      request: async () => opaqueForbidden(),
    }, { now: () => now, refreshToken: unexpectedRefresh })

    expect(thresholdResponse.status).toBe(403)
    expect(unexpectedRefresh).not.toHaveBeenCalled()
    expect(refreshAttempts).toBe(2)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      metrics: { scopeCircuitOpens: 1 },
      scopes: { open: 1 },
    })
  })

  test('does not evict a closed scope while one of its requests is still in flight', async () => {
    let resolveFirstResponse!: (response: Response) => void
    let markFirstStarted!: () => void
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const firstRequest = mock(async (attempt: 0 | 1) => {
      if (attempt === 0) {
        markFirstStarted()
        return await firstResponse
      }
      return opaqueForbidden()
    })

    const pending = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-in-flight-oldest',
      request: firstRequest,
    }, { refreshToken })
    await firstStarted

    for (let index = 0; index < 127; index++) {
      await fetchAuthenticatedCopilot({
        endpoint: `/responses/fill-${index}`,
        request: async () => completed(),
      })
    }
    await fetchAuthenticatedCopilot({
      endpoint: '/responses/overflow',
      request: async () => completed(),
    })

    resolveFirstResponse(opaqueForbidden())
    expect((await pending).status).toBe(403)
    expect(firstRequest).toHaveBeenCalledTimes(2)
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)

    const bypassRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-in-flight-oldest',
      request: bypassRequest,
    }, { refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(bypassRequest).toHaveBeenCalledTimes(0)
  })

  test('does not open the global circuit when healthy in-flight scopes saturate the registry', async () => {
    let releaseRequests!: () => void
    let markAllStarted!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseRequests = resolve
    })
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve
    })
    let started = 0
    const pending = Array.from({ length: 128 }, (_, index) =>
      fetchAuthenticatedCopilot({
        endpoint: `/responses/healthy-in-flight-${index}`,
        request: async () => {
          started++
          if (started === 128)
            markAllStarted()
          await releaseGate
          return completed()
        },
      }))

    await allStarted
    try {
      const overflowRequest = mock(async () => completed('healthy overflow'))
      const overflowResponse = await fetchAuthenticatedCopilot({
        endpoint: '/responses/healthy-in-flight-overflow',
        request: overflowRequest,
      })

      expect(await overflowResponse.text()).toBe('healthy overflow')
      expect(overflowRequest).toHaveBeenCalledTimes(1)
      expect(getCopilotRecoveryStatus().globalCircuit.phase).toBe('closed')
      expect(getCopilotRecoveryStatus().metrics.globalCircuitOpens).toBe(0)
    }
    finally {
      releaseRequests()
      await Promise.all(pending)
    }
  })

  test('keeps a failing overflow scope isolated when healthy in-flight scopes saturate the registry', async () => {
    let releaseRequests!: () => void
    let markAllStarted!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseRequests = resolve
    })
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve
    })
    let started = 0
    const pending = Array.from({ length: 128 }, (_, index) =>
      fetchAuthenticatedCopilot({
        endpoint: `/responses/isolated-in-flight-${index}`,
        request: async () => {
          started++
          if (started === 128)
            markAllStarted()
          await releaseGate
          return completed()
        },
      }))

    await allStarted
    try {
      const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
      const overflowRequest = mock(async () => opaqueForbidden())
      const overflowResponse = await fetchAuthenticatedCopilot({
        endpoint: '/responses/failing-in-flight-overflow',
        request: overflowRequest,
      }, { refreshToken })

      expect(overflowResponse.status).toBe(403)
      expect(overflowRequest).toHaveBeenCalledTimes(2)

      const originalScopeRequest = mock(async () => completed('original scope remains healthy'))
      const originalScopeResponse = await fetchAuthenticatedCopilot({
        endpoint: '/responses/isolated-in-flight-0',
        request: originalScopeRequest,
      })

      expect(await originalScopeResponse.text()).toBe('original scope remains healthy')
      expect(originalScopeRequest).toHaveBeenCalledTimes(1)
      expect(getCopilotRecoveryStatus().globalCircuit.phase).toBe('closed')
    }
    finally {
      releaseRequests()
      await Promise.all(pending)
    }
  })

  test('restores the scope registry bound after a high-cardinality failure burst settles', async () => {
    let now = 1_000
    let initialAttempts = 0
    let markAllInitialAttemptsStarted!: () => void
    let releaseInitialAttempts!: () => void
    const allInitialAttemptsStarted = new Promise<void>((resolve) => {
      markAllInitialAttemptsStarted = resolve
    })
    const initialAttemptGate = new Promise<void>((resolve) => {
      releaseInitialAttempts = resolve
    })
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const requests = Array.from({ length: 129 }, (_, scopeIndex) =>
      Array.from({ length: 3 }, () => fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: `gpt-registry-burst-${scopeIndex}`,
        request: async (attempt) => {
          if (attempt === 0) {
            initialAttempts++
            if (initialAttempts === 129 * 3)
              markAllInitialAttemptsStarted()
            await initialAttemptGate
          }
          return opaqueForbidden()
        },
      }, { now: () => now, refreshToken })))
      .flat()

    await allInitialAttemptsStarted
    releaseInitialAttempts()
    const responses = await Promise.all(requests)
    expect(responses.every(response => response.status === 403)).toBe(true)
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open' },
      scopes: { tracked: 128, open: 128 },
    })

    now += 60_001
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'half_open' },
      scopes: { tracked: 128, halfOpen: 128 },
    })
  })

  test('suppresses staggered followers after a failed fresh-token canary opens the scope', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    let replays = 0

    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-persistent',
        request: async (attempt) => {
          if (attempt === 0 && index > 0)
            await new Promise(resolve => setTimeout(resolve, 20))
          if (attempt === 1)
            replays++
          return opaqueForbidden()
        },
      }, { refreshToken })))

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(replays).toBe(1)
    expect(responses.every(response => response.status === 403)).toBe(true)
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)
  })

  test('opens a scoped circuit when a fresh-token canary is still rejected', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const request = mock(async () => opaqueForbidden())

    const rejected = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-blocked',
      request,
    }, { now: () => now, refreshToken })
    expect(rejected.status).toBe(403)
    expect(request).toHaveBeenCalledTimes(2)

    let circuitError: HTTPError | undefined
    try {
      await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-blocked',
        request,
      }, { now: () => now, refreshToken })
    }
    catch (error) {
      circuitError = error as HTTPError
    }
    expect(circuitError).toBeInstanceOf(HTTPError)
    expect(circuitError?.response.status).toBe(503)
    expect(circuitError?.response.headers.get('retry-after')).toBe('60')
    expect(request).toHaveBeenCalledTimes(2)

    now += 60_001
    const halfOpen = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-blocked',
      request: async () => completed('recovered'),
    }, { now: () => now, refreshToken })
    expect(await halfOpen.text()).toBe('recovered')
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(0)
  })

  test('suppresses repeated token exchanges for other scopes after refresh itself fails', async () => {
    const refreshToken = mock(async () => ({ outcome: 'failed' as const, generation: 1 }))

    for (const model of ['gpt-refresh-failure-a', 'gpt-refresh-failure-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { refreshToken })
      expect(response.status).toBe(403)
    }

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(getCopilotRecoveryStatus().metrics.reactiveRefreshSuppressions).toBe(1)
    expect(typeof getCopilotRecoveryStatus().reactiveRefreshSuppressedUntil).toBe('number')
  })

  test('aggregates scopes opened by repeated opaque failures while refresh is suppressed', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'failed' as const, generation: 1 }))
    const request = mock(async () => opaqueForbidden())

    for (const model of ['gpt-threshold-a', 'gpt-threshold-b']) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetchAuthenticatedCopilot({
          endpoint: '/responses',
          model,
          request,
        }, { now: () => now++, refreshToken })
        expect(response.status).toBe(403)
      }
    }

    const status = getCopilotRecoveryStatus(now)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(6)
    expect(status.scopes.open).toBe(2)
    expect(status.globalCircuit.phase).toBe('open')
    expect(status.metrics.globalCircuitOpens).toBe(1)
  })

  test('opens the global circuit after persistent failures in two scopes', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    for (const model of ['gpt-a', 'gpt-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { refreshToken })
      expect(response.status).toBe(403)
    }

    expect(getCopilotRecoveryStatus().globalCircuit.phase).toBe('open')
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/v1/messages',
      model: 'claude-c',
      request: async () => completed(),
    }, { refreshToken })).rejects.toBeInstanceOf(HTTPError)
  })

  test('doubles a half-open scope cooldown when token refresh fails after opaque evidence opened it', async () => {
    let now = 1_000
    const model = 'gpt-half-open-refresh-failure'
    const refreshToken = mock(async () => ({ outcome: 'failed' as const, generation: 1 }))

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { now: () => now, refreshToken })
      expect(response.status).toBe(403)
      await response.text()
    }
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      metrics: { scopeCircuitOpens: 1 },
      scopes: { open: 1 },
    })

    now += 60_001
    const failedProbe = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async () => new Response('Unauthorized', { status: 401 }),
    }, { now: () => now, refreshToken })
    expect(failedProbe.status).toBe(401)
    await failedProbe.text()

    const blockedRequest = mock(async () => completed('must not reach upstream'))
    let circuitError: HTTPError | undefined
    try {
      await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: blockedRequest,
      }, { now: () => now, refreshToken })
    }
    catch (error) {
      if (error instanceof HTTPError)
        circuitError = error
    }
    expect(circuitError).toBeInstanceOf(HTTPError)
    expect(circuitError?.response.headers.get('retry-after')).toBe('120')
    expect(blockedRequest).not.toHaveBeenCalled()
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      metrics: {
        reactiveRefreshAttempts: 2,
        reactiveRefreshFailures: 2,
        scopeCircuitOpens: 1,
      },
      scopes: { open: 1 },
    })

    now += 119_999
    const beforeBoundaryError = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: blockedRequest,
    }, { now: () => now, refreshToken }).then(
      () => undefined,
      error => error,
    )
    expect(beforeBoundaryError).toBeInstanceOf(HTTPError)
    if (beforeBoundaryError instanceof HTTPError)
      expect(beforeBoundaryError.response.headers.get('retry-after')).toBe('1')
    expect(blockedRequest).not.toHaveBeenCalled()

    now += 1
    const recovered = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model,
      request: async () => completed('scope recovered at the 120 second boundary'),
    }, { now: () => now, refreshToken })
    expect(await recovered.text()).toBe('scope recovered at the 120 second boundary')
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(0)
  })

  test('doubles a global half-open cooldown when delayed failures reopen it before its probe settles', async () => {
    let now = 1_000
    const delayedModels = ['gpt-delayed-global-a', 'gpt-delayed-global-b']
    const unexpectedDelayedRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))

    let delayedRequestsStarted = 0
    let markDelayedRequestsStarted!: () => void
    let releaseDelayedRequests!: () => void
    const allDelayedRequestsStarted = new Promise<void>((resolve) => {
      markDelayedRequestsStarted = resolve
    })
    const delayedRequestGate = new Promise<void>((resolve) => {
      releaseDelayedRequests = resolve
    })
    const delayedRequests = delayedModels.flatMap(model => Array.from({ length: 3 }, () =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => {
          delayedRequestsStarted++
          if (delayedRequestsStarted === delayedModels.length * 3)
            markDelayedRequestsStarted()
          await delayedRequestGate
          return opaqueForbidden()
        },
      }, { now: () => now, refreshToken: unexpectedDelayedRefresh })))
    await allDelayedRequestsStarted

    const successfulRefresh = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    for (const model of ['gpt-initial-global-a', 'gpt-initial-global-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => new Response('Unauthorized', { status: 401 }),
      }, { now: () => now, refreshToken: successfulRefresh })
      expect(response.status).toBe(401)
      await response.text()
    }
    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open', retryAfterSeconds: 60 },
      metrics: { globalCircuitOpens: 1 },
    })

    now += 60_001
    let markProbeRefreshStarted!: () => void
    let finishProbeRefresh!: () => void
    const probeRefreshStarted = new Promise<void>((resolve) => {
      markProbeRefreshStarted = resolve
    })
    const probeRefreshGate = new Promise<void>((resolve) => {
      finishProbeRefresh = resolve
    })
    const failedProbeRefresh = mock(async () => {
      markProbeRefreshStarted()
      await probeRefreshGate
      return { outcome: 'failed' as const, generation: 2 }
    })
    const globalProbe = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-global-probe-refresh-failure',
      request: async () => new Response('Unauthorized', { status: 401 }),
    }, { now: () => now, refreshToken: failedProbeRefresh })
    await probeRefreshStarted

    releaseDelayedRequests()
    const delayedResponses = await Promise.all(delayedRequests)
    expect(delayedResponses.every(response => response.status === 403)).toBe(true)
    await Promise.all(delayedResponses.map(response => response.text()))
    expect(unexpectedDelayedRefresh).not.toHaveBeenCalled()

    finishProbeRefresh()
    const failedProbe = await globalProbe
    expect(failedProbe.status).toBe(401)
    await failedProbe.text()

    expect(getCopilotRecoveryStatus(now)).toMatchObject({
      globalCircuit: { phase: 'open', retryAfterSeconds: 120 },
      metrics: { globalCircuitOpens: 1 },
    })

    const blockedRequest = mock(async () => completed('must not reach upstream'))
    now += 119_999
    const beforeBoundaryError = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-blocked-before-global-boundary',
      request: blockedRequest,
    }, { now: () => now, refreshToken: successfulRefresh }).then(
      () => undefined,
      error => error,
    )
    expect(beforeBoundaryError).toBeInstanceOf(HTTPError)
    if (beforeBoundaryError instanceof HTTPError)
      expect(beforeBoundaryError.response.headers.get('retry-after')).toBe('1')
    expect(blockedRequest).not.toHaveBeenCalled()

    now += 1
    for (const model of delayedModels) {
      const recovered = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => completed(`${model} recovered`),
      }, { now: () => now, refreshToken: successfulRefresh })
      expect(await recovered.text()).toBe(`${model} recovered`)
    }
    expect(getCopilotRecoveryStatus(now).globalCircuit.phase).toBe('closed')
  })

  test('doubles a half-open scope cooldown when its authentication replay is still rejected', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const request = mock(async () => new Response('Unauthorized', { status: 401 }))

    const firstRejected = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-half-open-auth-rejection',
      request,
    }, { now: () => now, refreshToken })
    expect(firstRejected.status).toBe(401)

    now += 60_001
    const secondRejected = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-half-open-auth-rejection',
      request,
    }, { now: () => now, refreshToken })
    expect(secondRejected.status).toBe(401)
    expect(request).toHaveBeenCalledTimes(4)

    let circuitError: HTTPError | undefined
    try {
      await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-half-open-auth-rejection',
        request,
      }, { now: () => now, refreshToken })
    }
    catch (error) {
      if (error instanceof HTTPError)
        circuitError = error
    }
    expect(circuitError).toBeInstanceOf(HTTPError)
    expect(circuitError?.response.headers.get('retry-after')).toBe('120')
    expect(request).toHaveBeenCalledTimes(4)
  })

  test('reopens scoped and global cooldowns when a half-open transport probe throws', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    for (const model of ['gpt-transport-a', 'gpt-transport-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { now: () => now, refreshToken })
      expect(response.status).toBe(403)
    }
    expect(getCopilotRecoveryStatus(now).globalCircuit.phase).toBe('open')

    now += 60_001
    const transportProbe = mock(async () => {
      throw new Error('connection reset during half-open probe')
    })
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-transport-a',
      request: transportProbe,
    }, { now: () => now, refreshToken })).rejects.toThrow('connection reset during half-open probe')

    const status = getCopilotRecoveryStatus(now)
    expect(transportProbe).toHaveBeenCalledTimes(1)
    expect(status.globalCircuit.phase).toBe('open')
    expect(status.globalCircuit.retryAfterSeconds).toBe(120)
    expect(status.scopes.open).toBe(1)

    const blockedRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-transport-a',
      request: blockedRequest,
    }, { now: () => now, refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(blockedRequest).toHaveBeenCalledTimes(0)
  })

  test('holds the concurrency lease until the response body completes', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })

    const first = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      request: async () => completed('first'),
    })

    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses/second',
      request: async () => completed('second'),
    })).rejects.toMatchObject({ response: { status: 429 } })

    expect(await first.text()).toBe('first')
    const third = await fetchAuthenticatedCopilot({
      endpoint: '/responses/third',
      request: async () => completed('third'),
    })
    expect(await third.text()).toBe('third')
    expect(state.concurrencyLimiter.snapshot().active).toBe(0)
  })

  test('releases the concurrency lease when the response body is cancelled', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
    let upstreamCancelled = false
    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      request: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
        },
        cancel() {
          upstreamCancelled = true
        },
      })),
    })

    expect(state.concurrencyLimiter.snapshot().active).toBe(1)
    await response.body?.cancel('client disconnected')
    expect(upstreamCancelled).toBe(true)
    expect(state.concurrencyLimiter.snapshot().active).toBe(0)
  })

  test('settles persistent-transport permits exactly once for every outcome', async () => {
    for (const [outcome, settle] of [
      ['success', (permit: Awaited<ReturnType<typeof acquireCopilotRequestPermit>>) => permit.succeed()],
      ['failure', (permit: Awaited<ReturnType<typeof acquireCopilotRequestPermit>>) => permit.fail()],
      ['cancel', (permit: Awaited<ReturnType<typeof acquireCopilotRequestPermit>>) => permit.cancel()],
    ] as const) {
      state.concurrencyLimiter = new AsyncConcurrencyLimiter({
        maxConcurrency: 1,
        maxQueue: 0,
        queueTimeoutMs: 0,
      })
      const permit = await acquireCopilotRequestPermit({
        endpoint: 'ws:/responses',
        model: `gpt-permit-${outcome}`,
      })

      expect(state.concurrencyLimiter.snapshot().active).toBe(1)
      settle(permit)
      permit.succeed()
      permit.fail()
      permit.cancel()

      expect(state.concurrencyLimiter.snapshot()).toMatchObject({
        active: 0,
        totalAcquired: 1,
        totalReleased: 1,
      })
    }
  })

  test('rejects an already-cancelled authenticated fetch before touching upstream', async () => {
    const controller = new AbortController()
    controller.abort(new Error('request cancelled before admission'))
    const request = mock(async () => completed('must not reach upstream'))

    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-cancelled-before-admission',
      request,
      signal: controller.signal,
    })).rejects.toThrow('request cancelled before admission')
    expect(request).not.toHaveBeenCalled()
  })

  test('rechecks cancellation after a concurrency slot is handed off', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    })
    const activeResponse = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-active-before-handoff',
      request: async () => new Response(new ReadableStream()),
    })
    const controller = new AbortController()
    const queuedRequest = mock(async () => completed('must not reach upstream'))
    const queued = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-cancelled-after-handoff',
      request: queuedRequest,
      signal: controller.signal,
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (state.concurrencyLimiter.snapshot().queued === 1)
        break
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(state.concurrencyLimiter.snapshot().queued).toBe(1)

    const cancellation = activeResponse.body!.cancel()
    controller.abort(new Error('request cancelled after slot handoff'))
    await cancellation
    await expect(queued).rejects.toThrow('request cancelled after slot handoff')
    expect(queuedRequest).not.toHaveBeenCalled()
    expect(state.concurrencyLimiter.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  test('rejects an already-cancelled persistent-transport permit without a limiter', async () => {
    state.concurrencyLimiter = undefined
    const controller = new AbortController()
    controller.abort('client disconnected')

    await expect(acquireCopilotRequestPermit({
      endpoint: 'ws:/responses',
      model: 'gpt-cancelled-before-admission',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })

    const followup = await acquireCopilotRequestPermit({
      endpoint: 'ws:/responses',
      model: 'gpt-cancelled-before-admission',
    })
    followup.cancel()
  })

  test('preserves limiter abort accounting for a cancelled persistent-transport permit', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 1_000,
    })
    const controller = new AbortController()
    controller.abort('client disconnected')

    await expect(acquireCopilotRequestPermit({
      endpoint: 'ws:/responses',
      model: 'gpt-cancelled-limiter-admission',
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: 'concurrency_acquire_aborted',
      name: 'AbortError',
    })
    expect(state.concurrencyLimiter.snapshot()).toMatchObject({
      abortedAcquisitions: 1,
      active: 0,
    })
  })

  test('rejects a full persistent-transport queue before recording an upstream attempt', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
    const activePermit = await acquireCopilotRequestPermit({
      endpoint: 'ws:/responses',
      model: 'gpt-active',
    })

    try {
      await expect(acquireCopilotRequestPermit({
        endpoint: 'ws:/responses',
        model: 'gpt-overflow',
      })).rejects.toMatchObject({ response: { status: 429 } })

      expect(getCopilotRecoveryStatus().metrics).toMatchObject({
        concurrencyQueueFullRejections: 1,
        upstreamAttempts: 0,
      })
      expect(state.concurrencyLimiter.snapshot()).toMatchObject({
        active: 1,
        queued: 0,
      })
    }
    finally {
      activePermit.cancel()
    }
  })

  test('times out a queued persistent-transport permit without recording an upstream attempt', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 5,
    })
    const activePermit = await acquireCopilotRequestPermit({
      endpoint: 'ws:/responses',
      model: 'gpt-active-timeout',
    })

    try {
      await expect(acquireCopilotRequestPermit({
        endpoint: 'ws:/responses',
        model: 'gpt-queued-timeout',
      })).rejects.toMatchObject({ response: { status: 503 } })

      expect(getCopilotRecoveryStatus().metrics).toMatchObject({
        concurrencyQueueTimeoutRejections: 1,
        upstreamAttempts: 0,
      })
      expect(state.concurrencyLimiter.snapshot()).toMatchObject({
        active: 1,
        queued: 0,
      })
    }
    finally {
      activePermit.cancel()
    }
  })

  test('never refreshes after a successful streaming response has begun', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      request: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event-one'))
          controller.error(new Error('stream failed'))
        },
      }), { status: 200 }),
    }, { refreshToken })

    await expect(response.text()).rejects.toThrow('stream failed')
    expect(refreshToken).toHaveBeenCalledTimes(0)
  })
})
