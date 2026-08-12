import type { AccountContext } from '~/lib/account/types'

import { GITHUB_API_BASE_URL, standardHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { fetchGitHub } from '~/lib/upstream-fetch'

export async function getGitHubUser(ctx: AccountContext): Promise<GithubUserResponse> {
  const response = await fetchGitHub(`${GITHUB_API_BASE_URL}/user`, {
    headers: {
      authorization: `token ${ctx.githubToken}`,
      ...standardHeaders(),
    },
  })

  if (!response.ok)
    throw new HTTPError('Failed to get GitHub user', response)

  const value = await response.json() as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid GitHub user response')
  const user = value as Record<string, unknown>
  if (typeof user.login !== 'string' || !user.login.trim())
    throw new TypeError('Invalid GitHub user login')
  if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0)
    throw new TypeError('Invalid GitHub user id')
  return {
    login: user.login,
    id: user.id as number,
  }
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
  id: number
}
