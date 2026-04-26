import { Hono } from 'hono'

import { forwardError } from '~/lib/error'

import { handleResponses, handleResponsesPassthrough } from './handler'

export const responsesRoutes = new Hono()

responsesRoutes.post('/', async (c) => {
  try {
    return await handleResponses(c)
  }
  catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.post('/input_tokens', async (c) => {
  try {
    return await handleResponsesPassthrough(c, '/responses/input_tokens', 'POST')
  }
  catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.post('/compact', async (c) => {
  try {
    return await handleResponsesPassthrough(c, '/responses/compact', 'POST')
  }
  catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.post('/:responseId/cancel', async (c) => {
  try {
    const responseId = encodeURIComponent(c.req.param('responseId'))
    return await handleResponsesPassthrough(c, `/responses/${responseId}/cancel`, 'POST')
  }
  catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.get('/:responseId/input_items', async (c) => {
  try {
    const responseId = encodeURIComponent(c.req.param('responseId'))
    return await handleResponsesPassthrough(c, `/responses/${responseId}/input_items`, 'GET')
  }
  catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.get('/:responseId', async (c) => {
  try {
    const responseId = encodeURIComponent(c.req.param('responseId'))
    return await handleResponsesPassthrough(c, `/responses/${responseId}`, 'GET')
  }
  catch (error) {
    return await forwardError(c, error)
  }
})

responsesRoutes.delete('/:responseId', async (c) => {
  try {
    const responseId = encodeURIComponent(c.req.param('responseId'))
    return await handleResponsesPassthrough(c, `/responses/${responseId}`, 'DELETE')
  }
  catch (error) {
    return await forwardError(c, error)
  }
})
