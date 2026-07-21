import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

const TESTS_ROOT = import.meta.dir

function findTestSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory())
      return findTestSources(filePath)
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [filePath] : []
  })
}

describe('packaged CLI test isolation', () => {
  test('forbids tests from cleaning or consuming the repository dist directory', () => {
    const violations: string[] = []

    for (const filePath of findTestSources(TESTS_ROOT)) {
      const source = fs.readFileSync(filePath, 'utf8')

      // An exact `bun run build` argv uses tsdown's configured shared dist/.
      // The fixture helper is allowed because it always appends --out-dir.
      if (/\[\s*(['"])run\1\s*,\s*(['"])build\2\s*\]/.test(source))
        violations.push(`${path.relative(TESTS_ROOT, filePath)} invokes the shared build output`)

      // This is the former packaged test path. Product-source string assertions
      // about dist/main.js remain valid; only an executable path is forbidden.
      if (/path\.resolve\(\s*(['"])dist\/main\.js\1\s*\)/.test(source))
        violations.push(`${path.relative(TESTS_ROOT, filePath)} consumes repository dist/main.js`)
    }

    expect(violations).toEqual([])
  })
})
