import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { NATIVE_SERVICE_INSTANCE_HEADER } from '~/daemon/native-service'
import { withApprovalRequestContext } from '~/lib/approval'
import { isRequestHostAllowed, isRequestOriginAllowed, resolveCorsOrigin } from '~/lib/security'
import { state } from '~/lib/state'

import { completionRoutes } from './routes/chat-completions/route'
import { embeddingRoutes } from './routes/embeddings/route'
import { healthRoutes } from './routes/health/route'
import { messageRoutes } from './routes/messages/route'
import { modelRoutes } from './routes/models/route'
import { responsesRoutes } from './routes/responses/route'
import { tokenRoute } from './routes/token/route'
import { usageRoute } from './routes/usage/route'

export const server = new Hono()

server.use(logger())
server.use(async (c, next) => {
  if (!isRequestHostAllowed(c.req.raw)) {
    return c.json({
      error: {
        message: 'Request Host is not allowed',
        type: 'invalid_request_error',
        code: 'host_not_allowed',
      },
    }, 403)
  }

  if (!isRequestOriginAllowed(c.req.raw, c.req.path)) {
    return c.json({
      error: {
        message: 'Request Origin is not allowed',
        type: 'invalid_request_error',
        code: 'origin_not_allowed',
      },
    }, 403)
  }

  const requestWithIp = c.req.raw as Request & { ip?: string }
  await withApprovalRequestContext({
    method: c.req.method,
    path: c.req.path,
    clientAddress: requestWithIp.ip,
    origin: c.req.header('origin'),
    userAgent: c.req.header('user-agent'),
  }, next)
})
server.use(cors({
  origin: (origin, c) => resolveCorsOrigin(origin, c.req.path),
  exposeHeaders: [
    'x-request-id',
    'x-github-request-id',
    'x-copilot-service-request-id',
    'x-copilot-proxy-recovery-state',
    'retry-after',
  ],
}))

server.get('/', (c) => {
  if (state.nativeServiceInstanceToken)
    c.header(NATIVE_SERVICE_INSTANCE_HEADER, state.nativeServiceInstanceToken)
  return c.text('Server running')
})
server.route('/', healthRoutes)

server.route('/chat/completions', completionRoutes)
server.route('/models', modelRoutes)
server.route('/embeddings', embeddingRoutes)
server.route('/responses', responsesRoutes)
server.route('/usage', usageRoute)
server.route('/token', tokenRoute)

// Compatibility with tools that expect v1/ prefix
server.route('/v1/chat/completions', completionRoutes)
server.route('/v1/models', modelRoutes)
server.route('/v1/embeddings', embeddingRoutes)
server.route('/v1/responses', responsesRoutes)

// Anthropic compatible endpoints
server.route('/v1/messages', messageRoutes)
