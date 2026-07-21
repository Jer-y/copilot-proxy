import { readFile } from 'node:fs/promises'

import { expect, test } from 'bun:test'

const ROOT = new URL('../', import.meta.url)

interface WorkflowStep {
  if?: string
  name?: string
  run?: string
  shell?: string
}

interface WorkflowJob {
  'needs'?: string | string[]
  'runs-on'?: string
  'steps'?: WorkflowStep[]
  'strategy'?: {
    matrix?: {
      include?: Array<{
        adapter_test?: string
        os?: string
      }>
    }
  }
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>
}

function normalizeNeeds(needs: WorkflowJob['needs']): string[] {
  if (needs === undefined)
    return []

  if (typeof needs === 'string')
    return [needs]

  if (needs.every(need => typeof need === 'string'))
    return [...needs]

  throw new TypeError('Workflow job needs must be a string or an array of strings')
}

function collectTransitiveNeeds(
  jobs: Record<string, WorkflowJob>,
  jobId: string,
  visiting = new Set<string>(),
): Set<string> {
  if (visiting.has(jobId))
    throw new Error(`Workflow job dependency cycle detected at ${jobId}`)

  const job = jobs[jobId]
  if (!job)
    throw new Error(`Workflow job ${jobId} does not exist`)

  const nextVisiting = new Set(visiting).add(jobId)
  const transitiveNeeds = new Set<string>()
  for (const need of normalizeNeeds(job.needs)) {
    if (!jobs[need])
      throw new Error(`Workflow job ${jobId} needs missing job ${need}`)

    transitiveNeeds.add(need)
    for (const transitiveNeed of collectTransitiveNeeds(jobs, need, nextVisiting))
      transitiveNeeds.add(transitiveNeed)
  }

  return transitiveNeeds
}

test('gates every release publisher on the complete Windows launcher regression suite', async () => {
  const [source, ciSource] = await Promise.all([
    readFile(new URL('.github/workflows/release.yml', ROOT), 'utf8'),
    readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8'),
  ])
  const workflow = Bun.YAML.parse(source) as Workflow
  const ciWorkflow = Bun.YAML.parse(ciSource) as Workflow
  const jobs = workflow.jobs

  if (!jobs)
    throw new Error('Release workflow must define jobs')

  expect(Object.keys(jobs).sort()).toEqual([
    'docker-publish',
    'github-release',
    'native-service-adapters',
    'npm-publish',
    'validate',
  ])

  const nativeServiceAdapters = jobs['native-service-adapters']
  if (!nativeServiceAdapters)
    throw new Error('Release workflow must define native-service-adapters')

  expect(nativeServiceAdapters.needs).toBe('validate')
  expect(nativeServiceAdapters['runs-on']).toBe(`\${{ matrix.os }}`)
  expect(nativeServiceAdapters.strategy?.matrix?.include).toEqual([
    {
      adapter_test: 'tests/darwin-autostart.test.ts',
      os: 'macos-latest',
    },
    {
      adapter_test: 'tests/win32-autostart.test.ts',
      os: 'windows-latest',
    },
  ])

  const conditionalSteps = nativeServiceAdapters.steps?.filter(
    step => step.if !== undefined,
  ) ?? []
  expect(conditionalSteps).toEqual([
    {
      if: 'runner.os == \'Windows\'',
      name: 'Exercise the Windows development launcher on Windows',
      run: 'bun test tests/start-bat.test.ts tests/shell.test.ts tests/client-setup.test.ts',
    },
    {
      if: 'runner.os == \'Windows\'',
      name: 'Exercise the Windows launcher from a real UNC path',
      run: './scripts/run-windows-unc-launcher-test.ps1',
      shell: 'powershell',
    },
  ])
  const ciWindowsSteps = ciWorkflow.jobs?.['native-service-adapters']?.steps?.filter(
    step => step.if === 'runner.os == \'Windows\'',
  ) ?? []
  expect(ciWindowsSteps).toHaveLength(2)
  expect(conditionalSteps).toEqual(ciWindowsSteps)

  expect(jobs['npm-publish']?.needs).toEqual([
    'validate',
    'native-service-adapters',
  ])
  expect(jobs['docker-publish']?.needs).toEqual([
    'validate',
    'native-service-adapters',
  ])
  expect(jobs['github-release']?.needs).toEqual([
    'npm-publish',
    'docker-publish',
  ])

  const publishingJobIds = Object.keys(jobs)
    .filter(jobId => jobId !== 'validate' && jobId !== 'native-service-adapters')
    .sort()
  expect(publishingJobIds).toEqual([
    'docker-publish',
    'github-release',
    'npm-publish',
  ])
  expect(Object.fromEntries(
    publishingJobIds.map(jobId => [
      jobId,
      [...collectTransitiveNeeds(jobs, jobId)].sort(),
    ]),
  )).toEqual({
    'docker-publish': ['native-service-adapters', 'validate'],
    'github-release': [
      'docker-publish',
      'native-service-adapters',
      'npm-publish',
      'validate',
    ],
    'npm-publish': ['native-service-adapters', 'validate'],
  })
})
