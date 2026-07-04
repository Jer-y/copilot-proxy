import type { ResponsesPayload } from '~/services/copilot/create-responses'

import consola from 'consola'

/**
 * The Codex guardian ("auto-approve" reviewer) model id. Codex resolves this
 * from its bundled catalog and issues a /responses request for it regardless of
 * what this proxy advertises at /models, so the alias must live at the proxy.
 */
export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review'

/**
 * When the payload targets the Codex guardian model and an alias target is
 * configured, rewrite `payload.model` in place so the request routes to — and
 * is sent upstream as — the Responses-capable target.
 *
 * No-op (returns undefined) when the target is unset, the model does not match,
 * or the target is the guardian model itself (self-alias guard against
 * misconfiguration).
 *
 * Returns the applied target on success, otherwise undefined.
 */
export function applyCodexAutoReviewAlias(
  payload: ResponsesPayload,
  target: string | undefined,
): string | undefined {
  if (
    !target
    || payload.model !== CODEX_AUTO_REVIEW_MODEL
    || target === CODEX_AUTO_REVIEW_MODEL
  ) {
    return undefined
  }

  consola.debug(`Aliasing /responses model ${CODEX_AUTO_REVIEW_MODEL} → ${target}`)
  payload.model = target
  return target
}
