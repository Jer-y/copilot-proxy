import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const REPOSITORY_ROOT = path.resolve(import.meta.dir, '../..')
const TSDOWN_ENTRYPOINT = createRequire(import.meta.url).resolve('tsdown/run')

export interface PackagedCliFixture {
  cleanup: () => void
  entrypoint: string
  outputDirectory: string
  packageRoot: string
}

/**
 * Build the real packaged CLI without touching the repository's shared dist/.
 *
 * Bun may execute test files in parallel, and CI can run multiple test commands
 * against one checkout. tsdown cleans its output directory before writing, so
 * every test process must own both the package root and dist directory it uses.
 */
export function createPackagedCliFixture(): PackagedCliFixture {
  // Keep the fixture below the checkout's node_modules so Node can resolve the
  // package's intentionally externalized runtime dependencies. A random leaf
  // still gives every Bun test process an independent package and dist root.
  const fixtureParent = path.join(REPOSITORY_ROOT, 'node_modules', '.cache')
  fs.mkdirSync(fixtureParent, { recursive: true })
  const packageRoot = fs.mkdtempSync(path.join(fixtureParent, 'copilot-proxy-packaged-cli-'))
  const outputDirectory = path.join(packageRoot, 'dist')
  const entrypoint = path.join(outputDirectory, 'main.js')

  try {
    // Runtime version discovery resolves ../package.json from dist/main.js.
    fs.copyFileSync(
      path.join(REPOSITORY_ROOT, 'package.json'),
      path.join(packageRoot, 'package.json'),
    )

    const buildResult = spawnSync(
      process.execPath,
      [TSDOWN_ENTRYPOINT, '--out-dir', outputDirectory],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        env: process.env,
        timeout: 60_000,
      },
    )

    if (buildResult.error)
      throw buildResult.error
    if (buildResult.status !== 0) {
      throw new Error([
        `Packaged CLI fixture build exited with status ${buildResult.status}.`,
        buildResult.stdout,
        buildResult.stderr,
      ].filter(Boolean).join('\n'))
    }
    if (!fs.existsSync(entrypoint))
      throw new Error(`Packaged CLI fixture did not create ${entrypoint}.`)

    return {
      cleanup: () => fs.rmSync(packageRoot, { force: true, recursive: true }),
      entrypoint,
      outputDirectory,
      packageRoot,
    }
  }
  catch (error) {
    fs.rmSync(packageRoot, { force: true, recursive: true })
    throw error
  }
}
