import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export interface FileSnapshot {
  content: Uint8Array
  mode: number
}

export function readFileSnapshot(filePath: string): FileSnapshot | undefined {
  try {
    const stat = fs.statSync(filePath)
    return {
      content: fs.readFileSync(filePath),
      mode: stat.mode & 0o777,
    }
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

export function writeOwnerOnlyFileAtomically(
  filePath: string,
  content: string | Uint8Array,
): void {
  writeFileAtomically(filePath, content, 0o600)
}

export function writeFileAtomically(
  filePath: string,
  content: string | Uint8Array,
  mode: number,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`

  try {
    fs.writeFileSync(temporaryPath, content, { mode })
    fs.chmodSync(temporaryPath, mode)

    // Keep the temporary file in the destination directory so rename is a
    // same-filesystem atomic replacement. Node/Bun map this to rename(2) on
    // Unix and MoveFileEx(..., REPLACE_EXISTING) on Windows. If replacement is
    // unavailable (for example, a Windows file is held open), fail without
    // first deleting or partially overwriting the previous file.
    fs.renameSync(temporaryPath, filePath)
  }
  finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

export function restoreFileSnapshot(
  filePath: string,
  snapshot: FileSnapshot | undefined,
): void {
  if (!snapshot) {
    fs.rmSync(filePath, { force: true })
    return
  }

  writeFileAtomically(filePath, snapshot.content, snapshot.mode)
}
