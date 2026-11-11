import { describe, expect, it } from 'vitest'
import { renderLoginPage } from '../src/login-page.ts'

describe('renderLoginPage', () => {
  const html = renderLoginPage()

  it('offers the Admin SSO entry point', () => {
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('href="/api/auth/login"')
    expect(html).toContain('快捷登录')
    expect(html).toContain('href="/api/auth/login?mode=password"')
    expect(html).toContain('账号密码登录')
  })

  it('does not expose the retired local username/password flow', () => {
    expect(html).not.toContain('name="username"')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('/api/auth/setup')
  })
})
