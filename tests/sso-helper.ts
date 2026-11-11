export async function completeAdminSsoLogin(port: number): Promise<{ cookie: string; callbackUrl: string; restoreFetch: () => void }> {
  const origin = `http://127.0.0.1:${String(port)}`
  const login = await fetch(`${origin}/api/auth/login`, { redirect: 'manual' })
  if (login.status !== 302) throw new Error(`SSO login did not redirect: ${String(login.status)}`)
  const authorizeUrl = new URL(login.headers.get('location')!)
  const callbackUrl = authorizeUrl.searchParams.get('redirect_uri')!
  const state = authorizeUrl.searchParams.get('state')!
  const nonceCookie = login.headers.get('set-cookie')?.split(';')[0]
  if (!nonceCookie || !state) throw new Error('SSO login did not issue state and nonce')

  const originalFetch = globalThis.fetch
  const mockedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/admin/sso/token') {
      return Response.json({
        accessToken: 'test-access-token',
        tokenType: 'Bearer',
        expiresIn: 600,
        refreshToken: 'test-refresh-token',
        refreshExpiresIn: 604800,
        user: {
          userId: 42,
          username: 'alice',
          displayName: 'Alice',
          roles: ['OPERATOR'],
          permissions: ['dsh:settings:manage', 'dsh:plugin:manage', 'dsh:agent-preset:manage'],
          expiresAt: '2099-01-01T00:00:00Z',
        },
      })
    }
    if (url.pathname === '/admin/sso/userinfo') {
      return Response.json({
        userId: 42,
        username: 'alice',
        displayName: 'Alice',
        roles: ['OPERATOR'],
        permissions: ['dsh:settings:manage', 'dsh:plugin:manage', 'dsh:agent-preset:manage'],
        expiresAt: '2099-01-01T00:00:00Z',
      })
    }
    return originalFetch(input, init)
  }
  globalThis.fetch = mockedFetch

  let callback
  try {
    callback = await originalFetch(`${callbackUrl}?code=test-code&state=${encodeURIComponent(state)}`, {
      redirect: 'manual',
      headers: { Cookie: nonceCookie },
    })
  } catch (error) {
    globalThis.fetch = originalFetch
    throw error
  }
  if (callback.status !== 302) {
    globalThis.fetch = originalFetch
    throw new Error(`SSO callback failed: ${String(callback.status)}`)
  }
  const sessionCookie = callback.headers.get('set-cookie')?.match(/dsh_session=[^;,]+/)?.[0]
  if (!sessionCookie) {
    globalThis.fetch = originalFetch
    throw new Error('SSO callback did not issue a DSH session')
  }
  return {
    cookie: sessionCookie,
    callbackUrl,
    restoreFetch: () => { if (globalThis.fetch === mockedFetch) globalThis.fetch = originalFetch },
  }
}
