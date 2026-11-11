import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Admin identity lives in Great Admin; dsh-login's client only contributes the settings UI. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>
  dsh: { client?: { platform?: string; inject?: string[] } }
}

describe('dsh-login host-only SSO package', () => {
  it('registers only the settings client, not the retired local account flow', () => {
    expect(pkg.dsh.client?.platform).toBe('web')
    expect(pkg.dsh.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings',
    ])
  })

  it('keeps the host bundle as the package entry point', () => {
    expect(readFileSync(join(repoRoot, 'dist/index.js'), 'utf8')).toContain('/sso/userinfo')
  })
})
