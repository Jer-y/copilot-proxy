export interface UpstreamRequestController {
  signal: AbortSignal
  cancel: (response: Response, reason?: unknown) => Promise<void>
}

export function createUpstreamRequestController(externalSignal?: AbortSignal): UpstreamRequestController {
  const controller = new AbortController()
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal

  return {
    signal,
    async cancel(response: Response, reason?: unknown) {
      if (!controller.signal.aborted) {
        controller.abort(reason)
      }
      await response.body?.cancel(reason).catch(() => {})
    },
  }
}
