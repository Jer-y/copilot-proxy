import { describe, expect, test } from 'bun:test'

import { buildLaunchctlKickstartArgs } from '../src/daemon/platform/darwin'

describe('launchd restart', () => {
  test('targets the GUI domain for reliable loaded-agent restarts', () => {
    expect(buildLaunchctlKickstartArgs(501)).toEqual([
      'kickstart',
      '-k',
      'gui/501/com.copilot-proxy',
    ])
  })

  test('falls back to the label when no user id is available', () => {
    expect(buildLaunchctlKickstartArgs()).toEqual([
      'kickstart',
      '-k',
      'com.copilot-proxy',
    ])
  })
})
