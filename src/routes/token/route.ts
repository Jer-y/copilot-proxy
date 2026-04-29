import consola from 'consola'
import { Hono } from 'hono'

import { isTokenRequestAllowed } from '~/lib/security'
import { state } from '~/lib/state'

export const tokenRoute = new Hono()

tokenRoute.get('/', (c) => {
  try {
    c.header('Cache-Control', 'no-store')

    if (!isTokenRequestAllowed(c.req.raw)) {
      return c.json({ error: 'Forbidden', token: null }, 403)
    }

    return c.json({
      token: state.copilotToken,
    })
  }
  catch (error) {
    consola.error('Error fetching token:', error)
    return c.json({ error: 'Failed to fetch token', token: null }, 500)
  }
})
