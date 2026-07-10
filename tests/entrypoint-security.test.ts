import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

const ENTRYPOINT_PATH = new URL('../entrypoint.sh', import.meta.url)

describe('container entrypoint security', () => {
  test('does not copy GH_TOKEN into process arguments', async () => {
    const entrypoint = await readFile(ENTRYPOINT_PATH, 'utf8')

    expect(entrypoint).not.toContain('-g "$GH_TOKEN"')
    expect(entrypoint).not.toContain('--github-token')
    expect(entrypoint).toContain('printf \'%s\' "$github_token" > "$token_dir/github_token"')
    expect(entrypoint).toContain('chmod 600 "$token_dir/github_token"')
    expect(entrypoint).toContain('unset github_token data_home token_dir GH_TOKEN GITHUB_TOKEN')
    expect(entrypoint).toContain('exec bun run dist/main.js start "$@"')
  })
})
