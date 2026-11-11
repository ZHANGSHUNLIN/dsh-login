import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SessionStore } from './session.ts'
import { buildClearCookieHeader, extractSessionToken } from './auth.ts'
import { deriveCapabilities } from './capabilities.ts'

export interface AdminIdentity {
  userId: number | string
  username: string
  displayName: string
  roles: string[]
  permissions: string[]
  expiresAt: string
}

interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshExpiresAt: number
  identity: AdminIdentity
}

interface PendingLogin {
  state: string
  browserNonce: string
  expiresAt: number
}

const SSO_NONCE_COOKIE_PREFIX = 'dsh_sso_nonce_'

export interface AdminSsoConfig {
  adminBaseUrl: string
  clientId: string
  redirectUri: string
  sessionTtl: number
  autoTrustHosts: boolean
  hosts: { learn(host: string): boolean }
}

export function createAdminSso(config: AdminSsoConfig, sessions: SessionStore) {
  const tokens = new Map<string, TokenSet>()
  const refreshes = new Map<string, Promise<TokenSet>>()
  const pending = new Map<string, PendingLogin>()
  const loginListeners = new Set<(userId: string) => void | Promise<void>>()
  const logoutListeners = new Set<(userId: string) => void | Promise<void>>()
  const refreshAccessToken = async (userId: string): Promise<string> => (await refreshUserToken(userId)).accessToken
  const refreshUserToken = async (userId: string): Promise<TokenSet> => {
    const existing = tokens.get(userId)
    if (!existing || existing.refreshExpiresAt <= Date.now()) throw new Error('Admin login required')
    const inFlight = refreshes.get(userId)
    if (inFlight) return await inFlight
    const refresh = postJson<TokenSetResponse>(`${config.adminBaseUrl}/sso/refresh`, {
      refresh_token: existing.refreshToken,
      client_id: config.clientId,
    }).then(response => {
      const next = toTokenSet(response, normalizeIdentity(response.user ?? existing.identity))
      tokens.set(userId, next)
      sessions.updatePermissionsForUser(userId, next.identity.permissions)
      return next
    }).catch(async error => {
      tokens.delete(userId)
      sessions.revokeAllFor(userId)
      for (const listener of logoutListeners) await Promise.resolve(listener(userId)).catch(() => undefined)
      throw error
    }).finally(() => refreshes.delete(userId))
    refreshes.set(userId, refresh)
    return await refresh
  }
  const accessToken = async (userId: string): Promise<string> => {
    const current = tokens.get(userId)
    if (!current || current.refreshExpiresAt <= Date.now()) throw new Error('Admin login required')
    if (current.expiresAt <= Date.now() + 30_000) return await refreshAccessToken(userId)
    return current.accessToken
  }
  const userInfo = async (userId: string): Promise<AdminIdentity | undefined> => {
    try {
      const identity = normalizeIdentity(await postOrGetJson<AdminIdentity>(
        `${config.adminBaseUrl}/sso/userinfo`, await accessToken(userId),
      ))
      sessions.updatePermissionsForUser(userId, identity.permissions)
      return identity
    } catch {
      return undefined
    }
  }
  const logout = async (sessionToken: string | undefined): Promise<void> => {
    if (!sessionToken) return
    const session = sessions.verify(sessionToken)
    if (!session) return
    const tokenSet = tokens.get(session.user)
    sessions.revokeAllFor(session.user)
    for (const listener of logoutListeners) await Promise.resolve(listener(session.user)).catch(() => undefined)
    if (tokenSet) {
      tokens.delete(session.user)
      await fetch(`${config.adminBaseUrl}/sso/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSet.accessToken}` },
        body: JSON.stringify({ refresh_token: tokenSet.refreshToken }),
      }).catch(() => undefined)
    }
  }

  const loginRoute: WebRoute = {
    kind: 'exact',
    path: '/api/auth/login',
    handler: async (request, response) => {
      const now = Date.now()
      for (const [pendingState, grant] of pending) if (grant.expiresAt <= now) pending.delete(pendingState)
      const state = randomBytes(32).toString('base64url')
      const browserNonce = randomBytes(32).toString('base64url')
      const nonceCookie = `${SSO_NONCE_COOKIE_PREFIX}${state}`
      pending.set(state, { state, browserNonce, expiresAt: Date.now() + 5 * 60_000 })
      const url = new URL(`${config.adminBaseUrl}/sso/authorize`)
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('redirect_uri', config.redirectUri)
      url.searchParams.set('state', state)
      const mode = new URL(request.url ?? '/', config.redirectUri).searchParams.get('mode')
      const location = mode === 'password'
        ? buildPasswordLoginUrl(config.adminBaseUrl, url)
        : url.toString()
      const secure = config.redirectUri.startsWith('https://') ? '; Secure' : ''
      response.writeHead(302, {
        Location: location,
        'Set-Cookie': `${nonceCookie}=${browserNonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300${secure}`,
        'Cache-Control': 'no-store',
      })
      response.end()
    },
  }

  const callbackRoute: WebRoute = {
    kind: 'exact',
    path: new URL(config.redirectUri).pathname,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', config.redirectUri)
      const state = url.searchParams.get('state') ?? ''
      const grant = pending.get(state)
      pending.delete(state)
      const nonceCookie = `${SSO_NONCE_COOKIE_PREFIX}${state}`
      if (!grant || grant.expiresAt <= Date.now() || readCookie(request.headers.cookie, nonceCookie) !== grant.browserNonce) {
        sendHtml(response, 400, '登录链接无效或已过期，请重新登录。')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        sendHtml(response, 400, 'Admin 授权未完成，请重新登录。')
        return
      }
      try {
        const tokenSet = await postJson<TokenSetResponse>(`${config.adminBaseUrl}/sso/token`, {
          code,
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
        })
        if (!tokenSet.accessToken || !tokenSet.refreshToken) {
          throw new Error('invalid Admin SSO response')
        }
        const identity = normalizeIdentity(await postOrGetJson<AdminIdentity>(
          `${config.adminBaseUrl}/sso/userinfo`, tokenSet.accessToken,
        ))
        if (identity?.userId === undefined || !identity.username
            || (tokenSet.user?.userId !== undefined && String(tokenSet.user.userId) !== String(identity.userId))) {
          throw new Error('invalid Admin SSO identity')
        }
        const userId = String(identity.userId)
        tokens.set(userId, toTokenSet(tokenSet, identity))
        const session = sessions.create(userId, false, identity.permissions)
        if (config.autoTrustHosts && typeof request.headers.host === 'string') config.hosts.learn(request.headers.host)
        const secure = config.redirectUri.startsWith('https://') ? '; Secure' : ''
        response.setHeader('Set-Cookie', [
          `dsh_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtl}${secure}`,
          `${nonceCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
        ])
        for (const listener of loginListeners) void Promise.resolve(listener(userId)).catch(() => undefined)
        // Bust any cached shell so a re-login always rebuilds the boot graph
        // with the newly returned Admin permissions.
        response.writeHead(302, {
          Location: `/?dsh_login=${Date.now().toString(36)}`,
          'Cache-Control': 'no-store',
        })
        response.end()
      } catch {
        sendHtml(response, 502, '无法连接 Admin 完成登录，请稍后重试。')
      }
    },
  }

  const meRoute: WebRoute = { kind: 'exact', path: '/api/auth/me', handler: async (request, response) => {
    const session = currentSession(request.headers.cookie, sessions)
    if (!session) return sendJson(response, 401, { error: 'unauthorized' })
    const identity = await userInfo(session.user)
    if (!identity) return sendJson(response, 401, { error: 'unauthorized' })
    sendJson(response, 200, { ...identity, isAdmin: false })
  } }

  const capabilitiesRoute: WebRoute = { kind: 'exact', path: '/api/auth/capabilities', handler: async (request, response) => {
    const session = currentSession(request.headers.cookie, sessions)
    if (!session) return sendJson(response, 401, { error: 'unauthorized' })
    const identity = await userInfo(session.user)
    if (!identity) return sendJson(response, 401, { error: 'unauthorized' })
    sendJson(response, 200, {
      capabilities: deriveCapabilities({
        username: identity.username,
        isAdmin: false,
        permissions: identity.permissions,
      }),
    })
  } }

  const logoutRoute: WebRoute = { kind: 'exact', path: '/api/auth/logout', handler: async (request, response) => {
    if (request.headers.origin !== new URL(config.redirectUri).origin) {
      response.writeHead(403, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    const token = extractSessionToken(request.headers.cookie)
    if (token) await logout(token)
    response.setHeader('Set-Cookie', buildClearCookieHeader())
    response.writeHead(200, { 'Cache-Control': 'no-store' })
    response.end()
  } }

  return {
    routes: [loginRoute, callbackRoute, meRoute, capabilitiesRoute, logoutRoute],
    accessToken,
    refreshAccessToken,
    isUserAuthenticated: (userId: string) => sessions.hasUser(userId),
    userInfo,
    logout,
    async currentUser(cookie: string | undefined): Promise<AdminIdentity | undefined> {
      const session = currentSession(cookie, sessions)
      return session ? await userInfo(session.user) : undefined
    },
    onLogin(listener: (userId: string) => void | Promise<void>): () => void {
      loginListeners.add(listener)
      return () => loginListeners.delete(listener)
    },
    onLogout(listener: (userId: string) => void | Promise<void>): () => void {
      logoutListeners.add(listener)
      return () => logoutListeners.delete(listener)
    },
    clear(): void { pending.clear(); tokens.clear(); refreshes.clear(); loginListeners.clear(); logoutListeners.clear() },
  }
}

/** Open Admin's real username/password page while preserving this SSO grant. */
function buildPasswordLoginUrl(adminBaseUrl: string, authorizeUrl: URL): string {
  const loginUrl = new URL(`${adminBaseUrl.replace(/\/+$/, '')}/login`)
  loginUrl.searchParams.set('mode', 'password')
  loginUrl.searchParams.set('redirect', `${authorizeUrl.pathname}${authorizeUrl.search}`)
  return loginUrl.toString()
}

function currentSession(cookie: string | undefined, sessions: SessionStore) {
  const token = extractSessionToken(cookie)
  return token ? sessions.verify(token) : undefined
}

function normalizeIdentity(identity: AdminIdentity): AdminIdentity {
  return {
    ...identity,
    roles: Array.isArray(identity.roles) ? identity.roles : [],
    permissions: Array.isArray(identity.permissions)
      ? [...new Set(identity.permissions.filter(permission => typeof permission === 'string'))]
      : [],
  }
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined
  for (const part of cookieHeader.split(';')) {
    const item = part.trim()
    if (item.startsWith(`${name}=`)) return item.slice(name.length + 1)
  }
  return undefined
}

interface TokenSetResponse {
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresIn: number
  user: AdminIdentity
}

function toTokenSet(response: TokenSetResponse, identity: AdminIdentity): TokenSet {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: Date.now() + response.expiresIn * 1000,
    refreshExpiresAt: Date.now() + response.refreshExpiresIn * 1000,
    identity,
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Admin SSO request failed (${response.status})`)
  return unwrapData(await response.json()) as T
}

async function postOrGetJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!response.ok) throw new Error(`Admin SSO request failed (${response.status})`)
  return unwrapData(await response.json()) as T
}

function unwrapData(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const response = value as { data?: unknown; accessToken?: unknown }
  return response.data !== undefined && response.accessToken === undefined ? response.data : value
}

function sendHtml(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  })
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Admin 登录</title><body style="font:16px system-ui;max-width:640px;margin:64px auto;padding:0 20px"><p>${message}</p><a href="/login">返回登录</a></body></html>`)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}
