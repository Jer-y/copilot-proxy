import type { BackendApiType } from './model-config'

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
