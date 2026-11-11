import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { MemoryCredentials } from './memory-credentials.ts'
import { completeAdminSsoLogin } from './sso-helper.ts'
import * as DshLogin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
let restoreAdminFetch: (() => void) | undefined

afterEach(async () => {
  restoreAdminFetch?.()
  restoreAdminFetch = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<{ ctx: Context; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-plugin-entry-'))
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<html><body>shell</body></html>')
  const dataDir = join(root, 'data')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- id: login",
    "  name: '@islibaodong/dsh-login'",
    '  config:',
    "    adminBaseUrl: 'http://admin.test/admin'",
    "    adminClientId: 'dsh'",
    "    publicBaseUrl: ''",
    `    distIndex: '${distIndex}'`,
    `    dataDir: '${dataDir}'`,
    '    sessionTtl: 3600',
    '    enabled: true',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@islibaodong/dsh-login', DshLogin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  await context.plugin(MemoryCredentials)
  return { ctx: context, port: context.webServer.port }
}

async function request(port: number, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`, { ...init, redirect: 'manual' })
}

describe('dsh-login plugin (Admin SSO composition)', () => {
  it('provides webApp (getAdvertisedUrl) for the DSH host', { timeout: 60_000 }, async () => {
    const { ctx, port } = await loadComposition()
    expect(ctx.webApp).toBeDefined()
    expect(ctx.webApp.getAdvertisedUrl()).toBe(`http://127.0.0.1:${String(port)}`)
  })

  it('redirects unauthenticated page requests to the Admin-only login page', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const response = await request(port, '/')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
    const loginPage = await request(port, '/login')
    expect(await loginPage.text()).toContain('href="/api/auth/login"')
  })

  it('offers a password-login redirect that preserves the SSO request', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const response = await request(port, '/api/auth/login?mode=password')
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location')!)
    expect(location.pathname).toBe('/admin/login')
    const redirect = new URL(location.searchParams.get('redirect')!, 'http://admin.test')
    expect(redirect.pathname).toBe('/admin/sso/authorize')
    expect(redirect.searchParams.get('client_id')).toBe('dsh')
    expect(redirect.searchParams.get('redirect_uri')).toContain('/api/auth/callback')
    expect(redirect.searchParams.get('state')).toBeTruthy()
  })

  it('creates a DSH session only after Admin SSO callback and userinfo verification', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const { cookie, restoreFetch } = await completeAdminSsoLogin(port)
    restoreAdminFetch = restoreFetch
    const response = await request(port, '/api/auth/me', { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      userId: 42,
      username: 'alice',
      displayName: 'Alice',
      roles: ['OPERATOR'],
      permissions: ['dsh:settings:manage', 'dsh:plugin:manage', 'dsh:agent-preset:manage'],
      expiresAt: '2099-01-01T00:00:00Z',
      isAdmin: false,
    })
    expect((await request(port, '/', { headers: { Cookie: cookie } })).status).toBe(200)
  })

  it('rejects an unbound callback and leaves local setup/login routes unavailable', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const callback = await request(port, '/api/auth/callback?code=not-issued&state=invalid')
    expect(callback.status).toBe(400)
    const setup = await request(port, '/api/auth/setup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'pw' }),
    })
    expect(setup.status).toBe(405)
    const localLogin = await request(port, '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: 'pw' }),
    })
    expect(localLogin.status).toBe(302)
    expect(new URL(localLogin.headers.get('location')!).pathname).toBe('/admin/sso/authorize')
  })

  it('same-origin logout revokes the session', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const { cookie } = await completeAdminSsoLogin(port)
    const origin = `http://127.0.0.1:${String(port)}`
    const logout = await request(port, '/api/auth/logout', {
      method: 'POST', headers: { Cookie: cookie, Origin: origin },
    })
    expect(logout.status).toBe(200)
    expect((await request(port, '/', { headers: { Cookie: cookie } })).status).toBe(302)
    expect((await request(port, '/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
  })

  it('does not mount an /api takeover', { timeout: 60_000 }, async () => {
    const { port } = await loadComposition()
    const response = await request(port, '/api/sessions.list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(405)
  })
})
