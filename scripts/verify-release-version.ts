import process from 'node:process'

type StableVersion = readonly [bigint, bigint, bigint]

export function parseStableVersion(value: string): StableVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim())
  if (!match)
    throw new Error(`Release versions must use stable X.Y.Z syntax: ${value}`)
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]
}

export function isStrictlyNewerStableVersion(candidate: string, published: string): boolean {
  const next = parseStableVersion(candidate)
  const current = parseStableVersion(published)
  for (let index = 0; index < next.length; index++) {
    if (next[index] > current[index])
      return true
    if (next[index] < current[index])
      return false
  }
  return false
}

export function verifyReleaseVersion(candidate: string, published: string): void {
  if (!isStrictlyNewerStableVersion(candidate, published)) {
    throw new Error(
      `Release version ${candidate} must be strictly newer than npm latest ${published}`,
    )
  }
}

if (import.meta.main) {
  const [candidate, published] = process.argv.slice(2)
  if (!candidate || !published) {
    process.stderr.write('Usage: verify-release-version.ts <candidate X.Y.Z> <npm latest X.Y.Z>\n')
    process.exit(2)
  }

  try {
    verifyReleaseVersion(candidate, published)
    process.stdout.write(`Release version ${candidate} is newer than npm latest ${published}.\n`)
  }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
