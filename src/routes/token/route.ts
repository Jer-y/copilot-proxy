import { Hono } from 'hono'

export const tokenRoute = new Hono()

tokenRoute.get('/', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: {
      code: 'token_diagnostic_removed',
      message: 'Plaintext token diagnostics have been removed. Use /diagnostics or copilot-proxy doctor for safe status information.',
    },
  }, 410)
})
