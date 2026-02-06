import consola from 'consola'

import { getModels } from '~/services/copilot/get-models'
import { getVSCodeVersion } from '~/services/get-vscode-version'

import { state } from './state'

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
