import { execFileSync } from 'node:child_process'
import consola from 'consola'

const TASK_NAME = 'CopilotProxy'

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  // Quote all arguments for Windows safety
  const quotedArgs = args.map(a => `"${a}"`)
  const command = `"${execPath}" ${quotedArgs.join(' ')}`

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
    return false
  }

  consola.success('Auto-start enabled via Task Scheduler')
  return true
}

export async function uninstallAutoStart(): Promise<boolean> {
  try {
    execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'pipe' })
  }
  catch (error) {
    consola.warn('Failed to delete scheduled task:', error instanceof Error ? error.message : error)
  }

  consola.success('Auto-start disabled')
  return true
}
