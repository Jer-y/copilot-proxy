import { execFileSync } from 'node:child_process'
import consola from 'consola'

const TASK_NAME = 'CopilotProxy'

export async function installAutoStart(execPath: string, args: string[]): Promise<void> {
  const command = `"${execPath}" ${args.join(' ')}`

  try {
    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/tr',
      command,
      '/sc',
      'onlogon',
      '/rl',
      'limited',
      '/f',
    ], { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to create scheduled task:', error)
    return
  }

  consola.success('Auto-start enabled via Task Scheduler')
}

export async function uninstallAutoStart(): Promise<void> {
  try {
    execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'pipe' })
  }
  catch {}

  consola.success('Auto-start disabled')
}
