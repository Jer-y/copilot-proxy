import { GITHUB_API_BASE_URL, githubHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchGitHub } from '~/lib/upstream-fetch'

export async function getCopilotToken(signal?: AbortSignal): Promise<GetCopilotTokenResponse> {
  const response = await fetchGitHub(
    `${GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
      signal,
    },
  )

  if (!response.ok)
    throw new HTTPError('Failed to get Copilot token', response)

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
export interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
