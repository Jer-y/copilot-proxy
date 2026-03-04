import type { State } from './state'

import consola from 'consola'

import { HTTPError } from './error'
import { sleep } from './utils'

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined)
    return

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const elapsedSeconds = (now - state.lastRequestTimestamp) / 1000

  if (elapsedSeconds > state.rateLimitSeconds) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeSeconds = Math.ceil(state.rateLimitSeconds - elapsedSeconds)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      'Rate limit exceeded',
      Response.json({ message: 'Rate limit exceeded' }, { status: 429 }),
    )
  }

  // Update timestamp immediately to prevent concurrent requests from
  // bypassing the rate limit during the sleep (Bun is single-threaded
  // but yields at await boundaries)
  state.lastRequestTimestamp = now

  const waitTimeMs = waitTimeSeconds * 1000
  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)

  consola.info('Rate limit wait completed, proceeding with request')
}
