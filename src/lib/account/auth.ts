import type { AccountType } from '~/lib/cli-validators'

import { Buffer } from 'node:buffer'
import process from 'node:process'

import { runDeviceFlow as runLegacyDeviceFlow } from '~/lib/token'
import { getGitHubUser } from '~/services/github/get-user'
import { createAccountContext } from './context'

const MAX_STDIN_TOKEN_BYTES = 8 * 1024

export interface VerifiedAccountToken {
  login: string
  token: string
  userId: number
}

export async function runDeviceFlow(): Promise<string> {
  return await runLegacyDeviceFlow()
}

export async function readTokenFromStdin(
  stream: NodeJS.ReadStream = process.stdin,
): Promise<string> {
  if (stream.isTTY)
    throw new Error('--token-stdin requires a pipe or redirected stdin; refusing to wait on an interactive TTY.')

  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.byteLength
    if (bytes > MAX_STDIN_TOKEN_BYTES)
      throw new Error(`GitHub token input exceeds ${MAX_STDIN_TOKEN_BYTES} bytes`)
    chunks.push(buffer)
  }

  let token = Buffer.concat(chunks).toString('utf8')
  if (token.endsWith('\r\n'))
    token = token.slice(0, -2)
  else if (token.endsWith('\n'))
    token = token.slice(0, -1)

  if (!token)
    throw new Error('GitHub token input is empty')
  if (/\s/.test(token))
    throw new Error('GitHub token input contains whitespace')
  return token
}

export async function verifyAccountToken(
  accountType: AccountType,
  token: string,
  expectedUserId?: number,
): Promise<VerifiedAccountToken> {
  const ctx = createAccountContext({ accountType, id: 'verification' })
  ctx.githubToken = token
  const user = await getGitHubUser(ctx)
  if (expectedUserId !== undefined && user.id !== expectedUserId) {
    throw new Error(
      `Authenticated GitHub identity does not match this account slot (expected user id ${expectedUserId}, received ${user.id}).`,
    )
  }
  return { login: user.login, token, userId: user.id }
}
