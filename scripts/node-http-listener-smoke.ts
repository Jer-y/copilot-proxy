import type { ServerHandler } from 'srvx'

import assert from 'node:assert/strict'
import process from 'node:process'

import { serve } from 'srvx'
import { server } from '~/server'

const listener = serve({
  fetch: server.fetch as ServerHandler,
  gracefulShutdown: false,
  hostname: '127.0.0.1',
  port: 0,
  silent: true,
})

try {
  await listener.ready()
  assert.equal(listener.runtime, 'node')
  assert.ok(listener.url, 'srvx did not expose its bound Node.js listener URL')

  const response = await fetch(listener.url)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Server running')
  process.stdout.write(`Node.js HTTP listener smoke passed at ${listener.url}\n`)
}
finally {
  await listener.close(true)
}
