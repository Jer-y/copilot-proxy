const FALLBACK = '1.104.3'
const RELEASES_URL = 'https://update.code.visualstudio.com/api/releases/stable'

export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(
      RELEASES_URL,
      {
        signal: controller.signal,
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
  finally {
    clearTimeout(timeout)
  }
}
