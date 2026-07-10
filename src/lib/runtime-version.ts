export const MINIMUM_NODE_VERSION = '22.19.0'

export function isSupportedNodeVersion(version: string): boolean {
  const current = parseVersion(version)
  const minimum = parseVersion(MINIMUM_NODE_VERSION)

  for (let index = 0; index < minimum.length; index++) {
    if (current[index] > minimum[index])
      return true
    if (current[index] < minimum[index])
      return false
  }

  return true
}

function parseVersion(version: string): [number, number, number] {
  const normalized = version.trim().replace(/^v/, '').split('-', 1)[0]
  const parts = normalized.split('.').slice(0, 3).map(part => Number.parseInt(part, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}
