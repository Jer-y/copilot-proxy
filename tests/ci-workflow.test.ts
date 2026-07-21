import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

const ROOT = new URL('../', import.meta.url)

interface WorkflowStep {
  env?: Record<string, string>
  if?: string
  id?: string
  name?: string
  run?: string
  shell?: string
  uses?: string
}

interface WorkflowJob {
  'environment'?: {
    url?: string
  }
  'if'?: string
  'runs-on'?: string
  'steps'?: WorkflowStep[]
  'strategy'?: {
    matrix?: {
      include?: Array<{ os?: string }>
    }
  }
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>
}

describe('CI workflow platform coverage', () => {
  test('runs local and real-UNC launcher coverage on the Windows Bun runner', async () => {
    const [source, uncGateSource] = await Promise.all([
      readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8'),
      readFile(new URL('scripts/run-windows-unc-launcher-test.ps1', ROOT), 'utf8'),
    ])
    const workflow = Bun.YAML.parse(source) as Workflow
    const job = workflow.jobs?.['native-service-adapters']

    expect(job?.['runs-on']).toMatch(/^\$\{\{ matrix\.os \}\}$/)
    const windowsMatrixEntries = job?.strategy?.matrix?.include?.filter(
      entry => entry.os === 'windows-latest',
    ) ?? []
    expect(windowsMatrixEntries).toHaveLength(1)

    const windowsSteps = job?.steps?.filter(
      step => step.if === 'runner.os == \'Windows\'',
    ) ?? []
    expect(windowsSteps).toEqual([
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

    expect(uncGateSource).toContain('New-SmbShare')
    expect(uncGateSource).toContain('Remove-SmbShare')
    expect(uncGateSource).toContain('COPILOT_PROXY_TEST_REQUIRE_WINDOWS_UNC')
    expect(uncGateSource).toContain('Windows UNC launcher test did not write its non-skip evidence marker.')
    expect(uncGateSource).toContain('windows_unc_launcher_test=passed')
  })

  test('fails the Pages job when the public dashboard is stale or missing safety capabilities', async () => {
    const [source, html] = await Promise.all([
      readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8'),
      readFile(new URL('pages/index.html', ROOT), 'utf8'),
    ])
    const workflow = Bun.YAML.parse(source) as Workflow
    const job = workflow.jobs?.['deploy-pages']
    const steps = job?.steps ?? []
    const dollar = '$'
    const deploymentPageUrl = `${dollar}{{ steps.deployment.outputs.page_url }}`

    expect(job?.if).toBe('github.ref == \'refs/heads/main\' && (github.event_name == \'push\' || github.event_name == \'workflow_dispatch\')')
    expect(job?.environment?.url).toBe(deploymentPageUrl)

    const deployIndex = steps.findIndex(step => step.id === 'deployment')
    expect(deployIndex).toBeGreaterThanOrEqual(0)
    expect(steps[deployIndex]?.uses).toContain('actions/deploy-pages@')

    const currentMainGuard = steps.find(step => step.name === 'Verify deployment still targets main HEAD')
    expect(currentMainGuard?.env?.GH_TOKEN).toBe(`${dollar}{{ github.token }}`)
    expect(currentMainGuard?.shell).toBe('bash')
    expect(steps.indexOf(currentMainGuard!)).toBe(deployIndex - 1)
    expect(currentMainGuard?.run).toContain(`current_main_sha="${dollar}(gh api "repos/${dollar}{GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')"`)
    expect(currentMainGuard?.run).toContain(`if [[ "${dollar}GITHUB_SHA" != "${dollar}current_main_sha" ]]; then`)
    expect(currentMainGuard?.run).toContain('::error::Refusing to deploy')

    const stampStep = steps.find(step => step.name === 'Stamp Pages artifact revision')
    expect(stampStep?.run).toBe('printf \'%s\\n\' "$GITHUB_SHA" > pages/deployment-revision.txt')
    expect(steps.indexOf(stampStep!)).toBeLessThan(deployIndex)

    const verification = steps[deployIndex + 1]
    expect(verification?.name).toBe('Verify public Diagnostics dashboard')
    expect(verification?.env?.DASHBOARD_URL).toBe(deploymentPageUrl)
    expect(verification?.env?.GH_TOKEN).toBe(`${dollar}{{ github.token }}`)
    expect(verification?.shell).toBe('bash')

    const run = verification?.run ?? ''
    const requiredPublicFeatures = [
      '<meta name="copilot-proxy-dashboard-version" content="diagnostics-v1" />',
      'content="diagnostics exact-endpoints redirect-error credentials-omit"',
      '<title>Copilot Proxy Diagnostics</title>',
      '["/diagnostics", "/diagnostics/", "/usage", "/usage/"]',
      'credentials: "omit"',
      'redirect: "error"',
    ]
    for (const feature of requiredPublicFeatures) {
      expect(html).toContain(feature)
      expect(run).toContain(`grep -Fq '${feature}'`)
    }

    expect(run).toContain(`public_url="${dollar}{DASHBOARD_URL%/}/?deployment=${dollar}{GITHUB_SHA}-${dollar}{GITHUB_RUN_ATTEMPT}"`)
    expect(run).toContain(`revision_url="${dollar}{DASHBOARD_URL%/}/deployment-revision.txt?deployment=${dollar}{GITHUB_SHA}-${dollar}{GITHUB_RUN_ATTEMPT}"`)
    expect(run).toContain(`"${dollar}{public_url}-${dollar}{attempt}"`)
    expect(run).toContain(`"${dollar}{revision_url}-${dollar}{attempt}"`)
    expect(run).toContain(`grep -Fxq "${dollar}GITHUB_SHA" "${dollar}revision_file"`)
    expect(run).toContain(`latest_main_sha="${dollar}(gh api "repos/${dollar}{GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha')"`)
    expect(run).toContain(`if [[ "${dollar}GITHUB_SHA" != "${dollar}latest_main_sha" ]]; then`)
    expect(run).toContain('::error::The public dashboard revision')
    expect(run).toContain('--header \'Cache-Control: no-cache\'')
    expect(run).toContain('for attempt in {1..12}')
    expect(run).toContain('if (( attempt < 12 )); then')
    expect(run).toContain('::error::The deployed public dashboard does not contain the required Diagnostics version and security capabilities.')
    expect(run.trimEnd()).toEndWith('exit 1')
  })
})
