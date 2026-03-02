import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import consola from 'consola'

const TASK_NAME = 'CopilotProxy'

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Quote a single argument for Windows CommandLineToArgvW parsing.
 * See: https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
 */
function winQuoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"\\]/.test(arg))
    return arg

  let result = '"'
  for (let i = 0; i < arg.length; i++) {
    let numBackslashes = 0
    while (i < arg.length && arg[i] === '\\') {
      numBackslashes++
      i++
    }
    if (i >= arg.length) {
      // End of string: double all backslashes
      result += '\\'.repeat(numBackslashes * 2)
    }
    else if (arg[i] === '"') {
      // Before a quote: double backslashes, then escape the quote
      result += '\\'.repeat(numBackslashes * 2 + 1)
      result += '"'
    }
    else {
      // Not before a quote: keep backslashes as-is
      result += '\\'.repeat(numBackslashes)
      result += arg[i]
    }
  }
  result += '"'
  return result
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  // Use XML task definition for reliable argument handling
  // Each arg is individually quoted for CommandLineToArgvW parsing,
  // then the whole string is XML-escaped for the task XML.
  const xmlArgs = args.map(a => winQuoteArg(a)).join(' ')
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
