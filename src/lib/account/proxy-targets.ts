import type { AccountType } from '~/lib/cli-validators'

export function buildAccountNetworkTargets(options: {
  accountTypes?: Iterable<AccountType>
  deviceFlow?: boolean
  vsCode?: boolean
}): string[] {
  const accountTypes = [...new Set(options.accountTypes ?? [])]
  return [
    ...(options.deviceFlow ? ['https://github.com'] : []),
    'https://api.github.com',
    ...accountTypes.map(accountType => accountType === 'individual'
      ? 'https://api.githubcopilot.com'
      : `https://api.${accountType}.githubcopilot.com`),
    ...(options.vsCode ? ['https://update.code.visualstudio.com'] : []),
  ]
}
