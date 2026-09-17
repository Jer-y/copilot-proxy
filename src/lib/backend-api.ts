export type BackendApiType = 'chat-completions' | 'responses' | 'anthropic-messages'

export function endpointToBackendApi(endpoint: string): BackendApiType | undefined {
  const normalized = endpoint.trim().toLowerCase()
  // A WebSocket capability is not an HTTP endpoint.
  if (/^wss?:/.test(normalized))
    return undefined

  switch (normalized.replace(/^\/v1\//, '/').replace(/^v1\//, '').replace(/^\/+/, '').replace(/\/+$/, '')) {
    case 'chat/completions':
      return 'chat-completions'
    case 'responses':
      return 'responses'
    case 'messages':
      return 'anthropic-messages'
    default:
      return undefined
  }
}

export function formatBackendApi(api: BackendApiType): string {
  switch (api) {
    case 'anthropic-messages':
      return '/v1/messages'
    case 'chat-completions':
      return '/chat/completions'
    case 'responses':
      return '/responses'
  }
}
