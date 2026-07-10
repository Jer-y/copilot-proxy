import consola from 'consola'

import { getModels } from '~/services/copilot/get-models'
import { getVSCodeVersion } from '~/services/get-vscode-version'

import { state } from './state'

export const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 15 * 60 * 1000

type ModelRefreshTimer = ReturnType<typeof setTimeout>
let modelRefreshTimer: ModelRefreshTimer | undefined
let modelRefreshGeneration = 0

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

export async function refreshModelsSafely(
  fetchModels: typeof getModels = getModels,
): Promise<boolean> {
  try {
    const models = await fetchModels()
    // Replace the complete snapshot atomically so requests already holding the
    // previous object keep a consistent view while new requests see the update.
    state.models = models
    consola.info(`Refreshed Copilot model inventory (${models.data.length} models)`)
    return true
  }
  catch (error) {
    consola.warn('Failed to refresh Copilot model inventory; keeping the previous snapshot.', error)
    return false
  }
}

export function startModelRefresh(
  intervalMs = DEFAULT_MODEL_REFRESH_INTERVAL_MS,
): void {
  stopModelRefresh()
  const generation = modelRefreshGeneration
  const scheduleNext = () => {
    if (generation !== modelRefreshGeneration)
      return
    modelRefreshTimer = setTimeout(() => {
      modelRefreshTimer = undefined
      void refreshModelsSafely().finally(scheduleNext)
    }, intervalMs)
    modelRefreshTimer.unref?.()
  }
  scheduleNext()
}

export function stopModelRefresh(): void {
  modelRefreshGeneration++
  if (modelRefreshTimer !== undefined) {
    clearTimeout(modelRefreshTimer)
    modelRefreshTimer = undefined
  }
}

export function isModelRefreshScheduled(): boolean {
  return modelRefreshTimer !== undefined
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
