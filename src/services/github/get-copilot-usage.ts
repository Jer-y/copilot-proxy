import { GITHUB_API_BASE_URL, githubHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchGitHub } from '~/lib/upstream-fetch'

export async function getCopilotUsage(): Promise<CopilotUsageResponse> {
  const response = await fetchGitHub(`${GITHUB_API_BASE_URL}/copilot_internal/user`, {
    headers: githubHeaders(state),
  })

  if (!response.ok) {
    throw new HTTPError('Failed to get Copilot usage', response)
  }

  const usage = await response.json() as unknown
  if (!isRecord(usage)
    || typeof usage.copilot_plan !== 'string'
    || typeof usage.quota_reset_date !== 'string'
    || !isRecord(usage.quota_snapshots)) {
    throw new TypeError('Invalid Copilot usage response')
  }

  return {
    copilot_plan: usage.copilot_plan,
    quota_reset_date: usage.quota_reset_date,
    quota_snapshots: {
      chat: sanitizeQuotaDetail(usage.quota_snapshots, 'chat'),
      completions: sanitizeQuotaDetail(usage.quota_snapshots, 'completions'),
      premium_interactions: sanitizeQuotaDetail(usage.quota_snapshots, 'premium_interactions'),
    },
  }
}

export interface QuotaDetail {
  entitlement: number
  percent_remaining: number
  remaining: number
  unlimited: boolean
}

interface QuotaSnapshots {
  chat: QuotaDetail
  completions: QuotaDetail
  premium_interactions: QuotaDetail
}

interface CopilotUsageResponse {
  copilot_plan: string
  quota_reset_date: string
  quota_snapshots: QuotaSnapshots
}

function sanitizeQuotaDetail(
  snapshots: Record<string, unknown>,
  name: keyof QuotaSnapshots,
): QuotaDetail {
  const quota = snapshots[name]
  if (!isRecord(quota)
    || !isFiniteNumber(quota.entitlement)
    || !isFiniteNumber(quota.percent_remaining)
    || !isFiniteNumber(quota.remaining)
    || typeof quota.unlimited !== 'boolean') {
    throw new TypeError(`Invalid Copilot usage quota: ${name}`)
  }

  return {
    entitlement: quota.entitlement,
    percent_remaining: quota.percent_remaining,
    remaining: quota.remaining,
    unlimited: quota.unlimited,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
