import type { AccountsConfiguration } from './types'
import type { AccountType } from '~/lib/cli-validators'

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'

import { writeOwnerOnlyFileAtomically, writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory } from '~/daemon/atomic-file'
import { ensureOwnerOnlyDirectories, hardenOwnerOnlyPaths } from '~/lib/owner-only'
import { PATHS } from '~/lib/paths'

import { assertValidAccountId } from './identity'

export const MAX_ACCOUNTS = 8

const AccountTypeSchema = z.enum(['individual', 'business', 'enterprise'])
const ClientSurfaceSchema = z.enum([
  'responses-http',
  'responses-websocket',
  'anthropic-messages',
  'chat-completions',
  'embeddings',
])

const AccountDescriptorSchema = z.object({
  id: z.string(),
  accountType: AccountTypeSchema,
  githubLogin: z.string().min(1),
  githubUserId: z.number().int().positive().safe(),
  maxConcurrency: z.number().int().positive().safe().optional(),
}).strict()

const AccountsConfigurationSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  defaultAccount: z.string(),
  requiredRoutes: z.array(z.object({
    surface: ClientSurfaceSchema,
    model: z.string().min(1),
  }).strict()).default([]),
  accounts: z.array(AccountDescriptorSchema).min(1).max(MAX_ACCOUNTS),
  routes: z.array(z.object({
    match: z.string().min(1),
    account: z.string(),
  }).strict()).default([]),
}).strict()

export function readAccountsConfiguration(
  filePath = PATHS.ACCOUNTS_CONFIG,
): AccountsConfiguration | undefined {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  }
  catch (error) {
    if (isErrno(error, 'ENOENT'))
      return undefined
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(content)
  }
  catch (error) {
    throw new Error(`Invalid accounts configuration JSON at ${filePath}`, { cause: error })
  }

  const parsed = AccountsConfigurationSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`Invalid accounts configuration at ${filePath}: ${z.prettifyError(parsed.error)}`)
  }
  validateConfigurationReferences(parsed.data)
  return parsed.data
}

export function resolveConfiguredAccountTypes(
  fallbackAccountType: AccountType,
  configuration: AccountsConfiguration | undefined = readAccountsConfiguration(),
): AccountType[] {
  if (!configuration)
    return [fallbackAccountType]
  return [...new Set(configuration.accounts.map(account => account.accountType))]
}

export function writeAccountsConfiguration(
  configuration: AccountsConfiguration,
  filePath = PATHS.ACCOUNTS_CONFIG,
): void {
  const parsed = AccountsConfigurationSchema.safeParse(configuration)
  if (!parsed.success)
    throw new Error(`Invalid accounts configuration: ${z.prettifyError(parsed.error)}`)
  validateConfigurationReferences(parsed.data)
  const write = sameFilePath(filePath, PATHS.ACCOUNTS_CONFIG)
    ? writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory
    : writeOwnerOnlyFileAtomically
  write(filePath, `${JSON.stringify(parsed.data, null, 2)}\n`)
}

export function accountTokenPath(
  accountId: string,
  tokensDir = PATHS.TOKENS_DIR,
): string {
  assertValidAccountId(accountId)
  return path.join(tokensDir, accountId)
}

export function ensureAccountStoragePaths(tokensDir = PATHS.TOKENS_DIR): void {
  fs.mkdirSync(tokensDir, { recursive: true, mode: 0o700 })
  ensureOwnerOnlyDirectories([tokensDir])
}

export function hardenAccountStoragePaths(tokensDir = PATHS.TOKENS_DIR): void {
  fs.mkdirSync(tokensDir, { recursive: true, mode: 0o700 })
  const tokenFiles = fs.readdirSync(tokensDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => ({ path: path.join(tokensDir, entry.name) }))
  hardenOwnerOnlyPaths([
    { path: tokensDir, directory: true },
    ...tokenFiles,
  ])
}

export function readAccountToken(
  accountId: string,
  tokensDir = PATHS.TOKENS_DIR,
): string | undefined {
  const filePath = accountTokenPath(accountId, tokensDir)
  let token: string
  try {
    token = fs.readFileSync(filePath, 'utf8')
  }
  catch (error) {
    if (isErrno(error, 'ENOENT'))
      return undefined
    throw error
  }
  return normalizePersistedToken(token, accountId)
}

export function writeAccountToken(
  accountId: string,
  token: string,
  tokensDir = PATHS.TOKENS_DIR,
): void {
  ensureAccountStoragePaths(tokensDir)
  writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory(
    accountTokenPath(accountId, tokensDir),
    normalizePersistedToken(token, accountId),
  )
}

export function validateConfigurationReferences(
  configuration: AccountsConfiguration,
): void {
  const ids = new Set<string>()
  const userIds = new Set<number>()
  for (const account of configuration.accounts) {
    assertValidAccountId(account.id)
    if (ids.has(account.id))
      throw new Error(`Duplicate account id: ${account.id}`)
    if (userIds.has(account.githubUserId))
      throw new Error(`GitHub user id ${account.githubUserId} is already assigned to another account`)
    ids.add(account.id)
    userIds.add(account.githubUserId)
  }

  if (!ids.has(configuration.defaultAccount))
    throw new Error(`defaultAccount references unknown account: ${configuration.defaultAccount}`)
  for (const [index, route] of configuration.routes.entries()) {
    if (!ids.has(route.account))
      throw new Error(`routes[${index}] references unknown account: ${route.account}`)
  }
}

function normalizePersistedToken(token: string, accountId: string): string {
  const normalized = token.trim()
  if (!normalized)
    throw new Error(`GitHub token for account ${accountId} is empty`)
  if (/\s/.test(normalized))
    throw new Error(`GitHub token for account ${accountId} contains whitespace`)
  return normalized
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function sameFilePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left)
  const resolvedRight = path.resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}
