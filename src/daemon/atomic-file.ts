import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { ensureOwnerOnlyDirectories, hardenOwnerOnlyPath } from '~/lib/owner-only'

export function writeOwnerOnlyFileAtomically(
  filePath: string,
  content: string | Uint8Array,
): void {
  writeFileAtomicallyInternal(filePath, content, 0o600, false)
}

export function writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory(
  filePath: string,
  content: string | Uint8Array,
): void {
  writeFileAtomicallyInternal(filePath, content, 0o600, true)
}

export function writeFileAtomically(
  filePath: string,
  content: string | Uint8Array,
  mode: number,
): void {
  writeFileAtomicallyInternal(filePath, content, mode, false)
}

function writeFileAtomicallyInternal(
  filePath: string,
  content: string | Uint8Array,
  mode: number,
  inheritOwnerOnlyAcl: boolean,
): void {
  const parentDirectory = path.dirname(filePath)
  fs.mkdirSync(parentDirectory, { recursive: true })
  if (inheritOwnerOnlyAcl)
    ensureOwnerOnlyDirectories([parentDirectory])
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined

  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode)
    fs.fchmodSync(descriptor, mode)
    if (mode === 0o600 && !inheritOwnerOnlyAcl)
      hardenOwnerOnlyPath(temporaryPath)
    fs.writeFileSync(descriptor, content)
    const completedDescriptor = descriptor
    descriptor = undefined
    fs.closeSync(completedDescriptor)

    // Keep the temporary file in the destination directory so rename is a
    // same-filesystem atomic replacement. Node/Bun map this to rename(2) on
    // Unix and MoveFileEx(..., REPLACE_EXISTING) on Windows. If replacement is
    // unavailable (for example, a Windows file is held open), fail without
    // first deleting or partially overwriting the previous file.
    fs.renameSync(temporaryPath, filePath)
    if (mode === 0o600 && !inheritOwnerOnlyAcl)
      hardenOwnerOnlyPath(filePath)
  }
  finally {
    if (descriptor !== undefined)
      fs.closeSync(descriptor)
    fs.rmSync(temporaryPath, { force: true })
  }
}
