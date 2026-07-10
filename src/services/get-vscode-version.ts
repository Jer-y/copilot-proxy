import { fetchWithTimeout } from '~/lib/upstream-fetch'

const FALLBACK = '1.104.3'
const RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable'

export async function getVSCodeVersion() {
  try {
    const response = await fetchWithTimeout(
      RELEASES_URL,
      {},
      {
        timeoutMs: 5_000,
        timeoutLabel: 'VSCode stable releases',
      },
    )

    const releases = await response.json() as unknown
    if (Array.isArray(releases) && typeof releases[0] === 'string') {
      return releases[0]
    }

    return FALLBACK
  }
  catch {
    return FALLBACK
  }
}
