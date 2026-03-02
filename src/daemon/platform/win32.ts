import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import consola from 'consola'

const TASK_NAME = 'CopilotProxy'

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  // Use XML task definition for reliable argument handling
  const xmlArgs = args.join(' ')
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Actions>
    <Exec>
      <Command>${escapeXmlAttr(execPath)}</Command>
      <Arguments>${escapeXmlAttr(xmlArgs)}</Arguments>
    </Exec>
  </Actions>
</Task>`

  const tmpDir = os.tmpdir()
  const xmlPath = path.join(tmpDir, 'copilot-proxy-task.xml')

  try {
    fs.writeFileSync(xmlPath, taskXml, { encoding: 'utf16le' })

    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/xml',
      xmlPath,
      '/f',
    ], { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to create scheduled task:', error instanceof Error ? error.message : error)
    return false
  }
  finally {
    try {
      fs.unlinkSync(xmlPath)
    }
    catch {}
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
