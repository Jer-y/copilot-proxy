import { access, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = path.join(
  root,
  'node_modules',
  '.cache',
  `copilot-proxy-node-http-smoke-${process.pid}`,
)
const outputFile = path.join(outputDirectory, 'node-http-listener-smoke.mjs')

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: process.env,
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0)
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
}

try {
  await mkdir(path.dirname(outputDirectory), { recursive: true })
  await run([
    process.execPath,
    'x',
    'tsdown',
    'scripts/node-http-listener-smoke.ts',
    '--no-config',
    '--tsconfig',
    'tsconfig.json',
    '--format',
    'esm',
    '--platform',
    'node',
    '--target',
    'es2022',
    '--out-dir',
    outputDirectory,
    '--clean',
  ])
  await access(outputFile)
  await run(['node', outputFile])
}
finally {
  await rm(outputDirectory, { force: true, recursive: true })
}
