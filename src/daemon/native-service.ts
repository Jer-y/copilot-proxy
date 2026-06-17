import process from 'node:process'

export interface NativeServiceLogOptions {
  follow: boolean
  lines: number
}

export interface NativeServiceCommands {
  isAutoStartInstalled: () => boolean
  stopAutoStartService: () => boolean
  restartAutoStartService: () => boolean
  showAutoStartStatus: () => boolean
  showAutoStartLogs: (options: NativeServiceLogOptions) => boolean
}

export async function loadNativeServiceCommands(): Promise<NativeServiceCommands | null> {
  if (process.platform === 'linux')
    return import('~/daemon/platform/linux')
  if (process.platform === 'darwin')
    return import('~/daemon/platform/darwin')
  if (process.platform === 'win32')
    return import('~/daemon/platform/win32')

  return null
}

export async function loadInstalledNativeServiceCommands(): Promise<NativeServiceCommands | null> {
  const commands = await loadNativeServiceCommands()
  if (!commands || !commands.isAutoStartInstalled())
    return null

  return commands
}
