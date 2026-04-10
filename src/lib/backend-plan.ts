import type { BackendApiType } from './model-config'

import consola from 'consola'

import { isApiProbedUnsupported, isUnsupportedApiError, recordProbeResult } from './api-probe'
import { formatBackendApi } from './backend-api'
import { HTTPError } from './error'

export interface BackendPlanStep<T> {
  api: BackendApiType
  context?: string
  run: () => Promise<T>
}

export interface RunBackendPlanOptions<T> {
  model: string
  steps: Array<BackendPlanStep<T>>
  onAllUnsupported?: (unsupportedApis: BackendApiType[]) => Promise<T> | T
}

export async function runBackendPlan<T>(
  options: RunBackendPlanOptions<T>,
): Promise<T> {
  const steps = dedupeSteps(options.steps)
  const unsupportedApis: Array<BackendApiType> = []
  let lastUnsupportedError: HTTPError | undefined

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    const nextUncachedStep = findNextUncachedStep(
      steps,
      index + 1,
      options.model,
      unsupportedApis,
    )

    if (isApiProbedUnsupported(options.model, step.api) && nextUncachedStep) {
      unsupportedApis.push(step.api)
      consola.debug(
        `Skipping ${formatBackendApi(step.api)} for ${options.model} due to cached unsupported probe${formatContext(step.context)}; using ${formatBackendApi(nextUncachedStep.api)}`,
      )
      continue
    }

    try {
      return await step.run()
    }
    catch (error) {
      if (!(error instanceof HTTPError) || !await isUnsupportedApiError(error.response)) {
        throw error
      }

      recordProbeResult(options.model, step.api)
      unsupportedApis.push(step.api)
      lastUnsupportedError = error

      const nextStep = findNextStepToTry(
        steps,
        index + 1,
        options.model,
        unsupportedApis,
      )
      if (nextStep) {
        consola.info(
          `Model ${options.model} does not support ${formatBackendApi(step.api)}${formatContext(step.context)}, falling back to ${formatBackendApi(nextStep.api)}`,
        )
      }
    }
  }

  const uniqueUnsupportedApis = [...new Set(unsupportedApis)]
  if (options.onAllUnsupported) {
    return await options.onAllUnsupported(uniqueUnsupportedApis)
  }

  if (lastUnsupportedError) {
    throw lastUnsupportedError
  }

  throw new Error(`No backend plan steps available for ${options.model}`)
}

function dedupeSteps<T>(steps: Array<BackendPlanStep<T>>): Array<BackendPlanStep<T>> {
  const seen = new Set<BackendApiType>()
  return steps.filter((step) => {
    if (seen.has(step.api)) {
      return false
    }
    seen.add(step.api)
    return true
  })
}

function findNextUncachedStep<T>(
  steps: Array<BackendPlanStep<T>>,
  startIndex: number,
  model: string,
  unsupportedApis: Array<BackendApiType>,
): BackendPlanStep<T> | undefined {
  for (let index = startIndex; index < steps.length; index++) {
    const step = steps[index]
    if (unsupportedApis.includes(step.api)) {
      continue
    }
    if (!isApiProbedUnsupported(model, step.api)) {
      return step
    }
  }

  return undefined
}

function findNextStepToTry<T>(
  steps: Array<BackendPlanStep<T>>,
  startIndex: number,
  model: string,
  unsupportedApis: Array<BackendApiType>,
): BackendPlanStep<T> | undefined {
  return findNextUncachedStep(steps, startIndex, model, unsupportedApis)
    ?? findNextCachedStep(steps, startIndex, unsupportedApis)
}

function findNextCachedStep<T>(
  steps: Array<BackendPlanStep<T>>,
  startIndex: number,
  unsupportedApis: Array<BackendApiType>,
): BackendPlanStep<T> | undefined {
  for (let index = startIndex; index < steps.length; index++) {
    const step = steps[index]
    if (!unsupportedApis.includes(step.api)) {
      return step
    }
  }

  return undefined
}

function formatContext(context: string | undefined): string {
  return context ? ` (${context})` : ''
}
