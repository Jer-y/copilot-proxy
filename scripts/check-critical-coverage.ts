import fs from 'node:fs'
import process from 'node:process'

interface CoverageFloor {
  file: string
  functions: number
  lines: number
}

// Bun has no branch/per-file threshold setting. Keep the global statement,
// function and line gate in bunfig.toml, then protect security/routing/lifecycle
// files individually here so a well-covered helper cannot mask a critical
// module disappearing from coverage.
const FLOORS: CoverageFloor[] = [
  { file: 'src/start.ts', lines: 0.30, functions: 0.45 },
  // Native manager mutations need real OS runners; the low floor still makes
  // disappearance visible while pure builders and rollback helpers are tested.
  { file: 'src/daemon/enable.ts', lines: 0.20, functions: 0.20 },
  { file: 'src/daemon/log-file.ts', lines: 0.85, functions: 0.85 },
  { file: 'src/daemon/service-env.ts', lines: 0.95, functions: 0.95 },
  { file: 'src/daemon/service-install-state.ts', lines: 0.80, functions: 0.75 },
  { file: 'src/daemon/start.ts', lines: 0.30, functions: 0.25 },
  { file: 'src/daemon/supervisor.ts', lines: 0.55, functions: 0.60 },
  { file: 'src/lib/proxy.ts', lines: 0.18, functions: 0.25 },
  { file: 'src/lib/proxy-environment.ts', lines: 0.85, functions: 0.85 },
  { file: 'src/lib/routing-policy.ts', lines: 0.95, functions: 0.95 },
  { file: 'src/lib/security.ts', lines: 0.90, functions: 0.95 },
  { file: 'src/lib/translation/anthropic-to-responses.ts', lines: 0.80, functions: 0.85 },
  { file: 'src/lib/translation/responses-to-anthropic.ts', lines: 0.60, functions: 0.80 },
  { file: 'src/routes/messages/stream-finalizer.ts', lines: 0.65, functions: 0.80 },
  { file: 'src/services/copilot/create-anthropic-messages.ts', lines: 0.90, functions: 0.90 },
  { file: 'src/services/copilot/create-embeddings.ts', lines: 0.90, functions: 0.95 },
  { file: 'src/services/copilot/create-responses.ts', lines: 0.90, functions: 0.95 },
  { file: 'src/services/copilot/upstream-response.ts', lines: 0.95, functions: 0.70 },
]

const lcovPath = process.argv[2] ?? 'coverage/lcov.info'
const records = parseLcov(fs.readFileSync(lcovPath, 'utf8'))
const failures: string[] = []

for (const floor of FLOORS) {
  const coverage = records.get(floor.file)
  if (!coverage) {
    failures.push(`${floor.file}: missing from ${lcovPath}`)
    continue
  }

  const lineRatio = ratio(coverage.linesHit, coverage.linesFound)
  const functionRatio = ratio(coverage.functionsHit, coverage.functionsFound)
  if (lineRatio < floor.lines) {
    failures.push(`${floor.file}: line ${(lineRatio * 100).toFixed(2)}% < ${(floor.lines * 100).toFixed(2)}%`)
  }
  if (functionRatio < floor.functions) {
    failures.push(`${floor.file}: function ${(functionRatio * 100).toFixed(2)}% < ${(floor.functions * 100).toFixed(2)}%`)
  }
}

if (failures.length > 0) {
  process.stderr.write(`Critical per-file coverage gate failed:\n${failures.map(value => `- ${value}`).join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(`Critical per-file coverage gate passed (${FLOORS.length} files).\n`)

interface FileCoverage {
  functionsFound: number
  functionsHit: number
  linesFound: number
  linesHit: number
}

function parseLcov(content: string): Map<string, FileCoverage> {
  const parsed = new Map<string, FileCoverage>()
  for (const block of content.split('end_of_record')) {
    const file = block.match(/^SF:(.+)$/m)?.[1]
    if (!file)
      continue
    parsed.set(file.replaceAll('\\', '/'), {
      functionsFound: numberField(block, 'FNF'),
      functionsHit: numberField(block, 'FNH'),
      linesFound: numberField(block, 'LF'),
      linesHit: numberField(block, 'LH'),
    })
  }
  return parsed
}

function numberField(block: string, name: string): number {
  const value = block.match(new RegExp(`^${name}:(\\d+)$`, 'm'))?.[1]
  return value ? Number.parseInt(value, 10) : 0
}

function ratio(hit: number, found: number): number {
  return found === 0 ? 1 : hit / found
}
