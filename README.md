# dsh-login

English | [简体中文](./README.zh.md)

This fork integrates the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI with Great Admin SSO. Great Admin is the only identity source; local DSH accounts and user management are disabled. DSH conversations are isolated by Admin `userId`, and the Admin MCP plugin consumes the same identity and token through the Host `dshLoginAuth` service.

| Login page |
|:---:|
| Continue with Great Admin |

## The problem it solves

The DSH Web GUI ships with **no login** — it assumes a single user on localhost. The moment you bind it to `0.0.0.0` (phone access, LAN sharing, a small team), **anyone on that network can open your GUI**: read every conversation, burn your configured model API keys, even change host settings.

`dsh-login` turns that exposure into a multi-user deployment:

- 🔐 **Login wall** — pages, static assets, SPA routes, the API, and WebSockets all require a valid session; unauthenticated visitors are redirected to `/login`
- 👥 **Admin identity** — users authenticate with Great Admin accounts; this fork does not create or manage local DSH accounts
- 🙈 **Conversation isolation** — ordinary users see and act on **their own** conversations only (including their subagents/forks); the bridge wall denies non-whitelisted methods and narrows `session.list`/`session.search`/`workspace.list` responses to owned sessions, and the dispatch-seam guard ownership-checks every dispatch (including per-user `workspace.follow` frame filtering); other users' sessions, messages, and workspaces are invisible; credentials, host settings, and other admin domains are forbidden wholesale
- 🎭 **Whole-UI role gate** — for ordinary users the gateway filters the client boot graph (`window.__DSH_BOOT__`) before serving the page, so admin-only UI plugins never mount (`uiRoleGate`, on by default)
- 🛡 **Admin-managed DSH access** — roles grant only the settings, plugin-management, and Agent preset permissions assigned in Great Admin; unrelated host-admin methods stay denied
- 🚪 **Shared logout** — the Admin MCP settings card and `/api/auth/logout` use the same DSH session
- 🌐 **Remote access friendly** — the `/api` host-trust fence uses the live set (LAN literals + `trustedHosts` + auto-learned hosts)

---
## Current status

**Adaptation baseline: `@islibaodong/dsh-login@0.3.12`, DSH `0.2.2-rc.1`.** This fork replaces upstream's local-account flow. Great Admin is the only identity source; DSH permissions are assigned to roles in Great Admin and enforced by the DSH UI and API.

0.3.12 is a **security release**. It fixes [issue #11](https://github.com/islibaodong/dsh-login/issues/11): streaming methods (`workspace.follow` workspace trees, and id-carrying invokes such as `session.page`) travel the `/api/remote.mux` WebSocket, which the POST-only bridge wall never saw — an ordinary user could enumerate and enter other users' workspaces. Since 0.3.12 a **dispatch-seam guard** ships in-plugin: connection admission requires a live dsh-login session on the browser path (the WebSocket upgrade included), and the gateway's dispatch seams gate every browser call per user — non-user methods denied, id arguments ownership-checked, `workspace.follow` frames filtered per frame. It also carries the merged PR #12 fix (DSH 0.2.2 homepage 400) and the CI rewrite (Node 24 matrix, dist freshness gate).

### Compatibility history

| dsh-login | DSH | Notes |
|-----------|-----|-------|
| 0.3.12 | 0.2.2-rc.1 | issue #11 streaming-method isolation + PR #12 gateway fix |
| 0.3.11 | 0.2.2-rc.1 | dependency retarget onto the rc.1 line (vendor stable) |
| 0.3.10 | 0.2.2-alpha.3 | wire surface re-pinned 199 → 204 (schedule CRUD split, forge review) |
| 0.3.9 | 0.2.1-rc.5 | issue #10: the launch token never reaches remote clients |
| 0.3.8 | 0.2.2-alpha.2 | wire surface 146 → 199 (forge panel, session observation, CUA, liveshareShares) |
| 0.3.7 | 0.2.1-rc.3 | client-UI-only upstream release; zero adapter impact |
| 0.3.6 | 0.2.1-rc.2 | issue #4: allow-list re-derived from the real wire surface |

Older releases: see the [releases page](https://github.com/islibaodong/dsh-login/releases).

### Upstream multi-user watch

Upstream DSH still ships **no native user accounts** — no user store, no login, no identity UI. What DSH 0.2.1-alpha.3 added is an authorize-only RBAC engine for non-owner Peers (`packages/api/remote-access`) plus multi-principal connection machinery; it never gates owner principals, and every dsh-login user arrives as one. dsh-login remains the account/authn layer.
- **Ordinary users are conversation-only.** In option A the native `connection`/`api-gateway` owns `/api` and is agent-keyed. Three seams enforce the boundary — the first two ship in-plugin and are on by default:
  1. **Method allow-list + response narrowing on the bridge wall (`apiBridgeAuth`):** a non-admin POST whose wire endpoint is not on the `USER_ALLOWED` allow-list is denied — with `quietDenials` (default) as a wire-correct forbidden envelope, otherwise a plain 403. `session.list`/`session.search`/`workspace.list` responses are narrowed to the user's own sessions/workspaces.
  2. **Dispatch-seam guard (shipped in 0.3.12, automatic — fixes [issue #11](https://github.com/islibaodong/dsh-login/issues/11)):** connection admission requires a live dsh-login session on the browser path — including the `/api/remote.mux` WebSocket upgrade — and tags each browser peer with its dsh-login identity. The gateway's dispatch seams (`dispatchRpc`/`openWireStream`) then gate every browser call per user: non-user methods are denied, every id argument (`sessionId`/`workspaceId`/`agentId`/…) is ownership-checked against the sidecar, and `workspace.follow` streams are filtered per frame with upstream's own per-principal semantics (narrowed baselines, delivered-set accounting, replace-resync on visibility loss, fail-closed on unknown frames). Untagged peers (launch-token CLI/SDK, host-internal calls) keep upstream semantics exactly.
  3. **REMOTE-layer guard (`wrapRemoteGateway`, exported, optional):** the deployment-side composition primitive over the public gateway API ([`docs/compose-guard.md`](docs/compose-guard.md)). Since 0.3.12 the in-plugin guard already covers browser traffic, so composing this is optional belt-and-suspenders.
  Everything else is off limits:
  - physical allow-list: the user-facing wire surface (`USER_ALLOWED`, 124 of the 204 methods DSH 0.2.2-rc.1 exposes) — `session.*` (prompt/page/modelCatalog/selectModel/fork/attachment, the events/observe/state family, …), `workspace.*`, `goals.*`, `subagents.*`, `terminal.*`, `job.*`, the read-only `workspaceFiles.*`/`officeToPdf.*` document preview, the `llm.*` model-picker reads, `skills.list`, `commands.*`, `directoryPicker.*`, `schedule.*`, `speech.*`, `userQuestions.*`, `messageFeedback.*`, `sessionFeedback.record`, `fileUploads.upload`, `fileReferences.list`, `permissionPresets.catalog`, `productAnalytics.*`, `cotTranslation.*`, `sessionReferenceResolver.candidates`, the `remoteAccess.follow` grant stream, and the 0.2.2 additions (`forgePanel.*` per-session, `toolResults.watch`, `actionCards.act`, `pluginRecommendations.describe`); any other wire method is refused. The list is exhaustive against the wire surface: `tests/wire-surface.spec.ts` fails if upstream renames or adds a method without a bucket (see [`docs/adapt-dsh-0.2.1-rc.2-issue-4.md`](docs/adapt-dsh-0.2.1-rc.2-issue-4.md))
  - admin-only domains (`ADMIN_ONLY_METHODS`, 79): `credentials.*`, `settings.*`, `agentPresets.*`, the native plugin manager (`pluginManager.*`, `pluginMarket.*`, `pluginRegistryProbe.*`, `pluginInventory.*`), `dynamicCordisRunner.*`, `claudeCodeMods.*`, the whole `account.*` namespace (the single process-wide upstream DeepSeek Platform grant), CUA consent (`cuaAccess.*`), `schedule.deleteInactive`, and the `liveshareShares.*` share-management surface
  - host-internal: `workspace.initializeDefault` (first-use plumbing; denied to users and never advertised)
  - an unknown method (not on this build's wire surface) is logged once per method to the host log with the target version, so an upstream rename leaves a diagnostic instead of a silent user-facing denial — refresh `src/api-filter.ts` from the checkout with `node scripts/dump-wire-surface.mjs`
  - workspace-scoped mutations are ownership-guarded by `workspaceId`: an Admin SSO user may only `rename`/`delete`/`insertBefore` a workspace that holds one of their sessions, and `create` is confined to their own sandbox (`workspaceRoot/<userId>`)
  - the physical `session.export` channel (target in the query string, outside the envelope) is ownership-guarded at the carrier
  - streaming: `workspace.follow` frames are filtered per user at the dispatch seam (above) — a user's workspace tree never contains another user's workspaces or sessionIds
- **Admin-managed DSH access (`uiRoleGate`, on by default):** Great Admin SSO returns the user's `dsh:*` permission codes. The same permission policy filters UI bundles and authorizes matching RPC methods; unassigned host-wide methods remain denied. `dsh:settings:manage` covers the full DSH settings page, including model configuration.
- **Default user workspace (`defaultWorkspace`, on by default):** every Admin identity gets a per-user isolated default workspace on first `/api` access under `workspaceRoot/<userId>` (default `<DSH_HOME>/workspaces/<userId>`), and new sessions are recorded in the ownership index. Configure this through DSH plugin config; this fork does not ship the upstream user-management settings panel. Provisioning is idempotent and best-effort.
- **Remote access compat (`remoteWebUiCompat`, on by default):** configures `@linxin666/dsh-remote-web-ui` through `remoteWebUiCompat` and `remoteWebUiPublicBaseUrl` plugin settings. This fork does not ship the upstream user-management settings panel, so set these values in DSH configuration.
- **Capability discovery + quiet denials (`quietDenials`, on by default):** stops the browser-splashing "forbidden" walls that installed UI plugins (task-board, plugin-manager, agentPreset, doctor, …) trigger on an ordinary-user session when they probe `/api/*` they cannot use. Three layers: (1) `GET /api/auth/capabilities` returns the authenticated identity's method/domain/UI-plugin surface (ordinary = the `USER_ALLOWED` allow-list + core plugins; admin = everything), and dsh-login injects a static non-admin baseline into `window.__DSH_SESSION__` at index-render time so clients that read it render no unauthorized feature instead of probing; (2) on the `/api` bridge wall, a denied non-admin POST is answered with a **wire-correct `server-response` envelope carrying `{ ok: false, code: 'forbidden' }` (HTTP 200)** — the wall consumes the request body to echo the caller's `rpcId`, so the browser surfaces an ordinary denied-RPC error instead of a transport-failure splash; (3) with `quietDenials` off, denied POSTs fall back to a plain **403**. Authorization is never loosened — only the shape of the denial is quieter. Admins can flip `quietDenials` off to restore plain 403 everywhere.
- **`/api` bridge auth wall (`apiBridgeAuth`, on by default; DSH ≥ 0.1.6-alpha.2):** on the upstream `connection/request` hook dsh-login answers **401 for any bridged `/api` request without a live `dsh_session`** — so logout/expiry/revocation actually cut `/api` access even though the browser keeps the connection row's process-wide browser-auth cookie. Beyond authentication, the wall is the per-user enforcement seam: the method allow-list gate (above) and the response narrowing for `session.list`/`session.search`/`workspace.list` ride the same hook, and admitted `session.create`/`session.fork`/`workspace.create` responses are observed to keep the ownership sidecar warm (admin-created resources are recorded too, record-only, so the composed REMOTE-layer guard can attribute admin sessions). Plugin-exact routes (`/api/auth/*`, remote-web-ui's `/api/pair/*` pairing) never touch the bridge and keep working pre-login; since 0.3.12 the stream-mux WebSocket upgrade (`/api/remote.mux`) also passes the dispatch-seam guard's admission check, which requires a live `dsh_session` too. Turn it off only if you serve the bridge to clients that cannot carry the `dsh_session` cookie — e.g. remote-web-ui's `/remote` paired-device channel re-issues requests server-side without it (pairing is by design a full-control credential outside dsh-login's user model). On DSH < 0.1.6-alpha.2 the hook does not exist and this is a harmless no-op.
- **DSH privileges:** Great Admin roles grant only the mapped DSH permissions. Unmapped host-administrator methods remain denied.
- **Logout:** the Admin MCP settings card calls `POST /api/auth/logout`, which revokes the shared DSH and Admin SSO session.
- **Local account management:** the upstream user-management client and its routes are not registered by this fork. Manage accounts and permissions in Great Admin.

## Data locations

| Data | Location |
|------|----------|
| Admin access/refresh tokens | DSH Host process memory only; sign in again after restart |
| Session→Admin-user ownership sidecar | `<DSH_HOME>/.dsh-login/ownership-v2.json` (configurable via `dataDir`; `DSH_HOME` env or `~/.dsh`) |
| Legacy username ownership | `<DSH_HOME>/.dsh-login/ownership.json` is retained but ignored |
| Auto-learned / admin Host whitelist | `<DSH_HOME>/.dsh-login/trusted-hosts.json` (configurable via `dataDir`) |
| Default-user-workspace toggle | `<DSH_HOME>/.dsh-login/settings.json` (configurable via `dataDir`) |
| Remote-web-ui compat toggle | `<DSH_HOME>/.dsh-login/settings-remote-web-ui.json` (configurable via `dataDir`) |
| DSH login sessions | DSH Host process memory only; cookies are invalid after restart |

## `/api` integration (option A, DSH ≥ 0.1.5-alpha.1)

For DSH ≥ 0.1.5-alpha.1 dsh-login **no longer takes over the `/api` carrier**: `cordis.patch.yml`
leaves the shipped `connection` row enabled, so `dsh-client-connection` + `api-remotes` /
`api-gateway` own the `/api` transport and the live Remote streams. dsh-login composes its
per-user layer on top of that native stack (see [`docs/adapt-dsh-0.1.5.md`](docs/adapt-dsh-0.1.5.md)
and the verification checklist [`docs/verify-option-A.md`](docs/verify-option-A.md)):
fallback login wall + static serving through the native `serveStatic`, plus
`connection.authorizeIndex` on index responses so the browser receives its upstream `/api`
cookie. The old `src/connection.ts` carrier takeover and its `dist/client.js` re-stamp were
removed with the `dsh-host-apiproxy`-based per-user `ApiProxy`. Since 0.3.12 the per-user
conversation/workspace isolation is enforced automatically by the in-plugin **dispatch-seam
guard** (admission tagging + per-user dispatch gating + `workspace.follow` frame filtering) —
no deployment-side composition is required. The REMOTE-layer guard (`wrapRemoteGateway` +
`createRemoteIsolation`, with the `composeDshLoginGuard` glue that publishes the ownership
sidecar as `dshLoginOwnership`) remains exported as an optional deployment-side composition;
see [`docs/compose-guard.md`](docs/compose-guard.md).

**Host trust is evaluated live per request.** The `/api` fence uses a deduped effective set —
LAN literals from the web runtime + `trustedHosts` + the persisted whitelist (`src/hosts.ts`).
A successful SSO callback auto-learns the request Host (gated by `autoTrustHosts`, default
true), so a public host reached through frp/隧道/tunnels is trusted after one login; learned
hosts bind immediately and removals apply without a restart.

## Security notes

### Protected by the gateway

| Asset | Protection |
|-------|-----------|
| Page navigation (`/`) | 302 redirect to `/login` if unauthenticated |
| Static assets (`/assets/*.js`, `.css`, etc.) | Same gateway check |
| SPA routes (`/conversations`, `/settings`, etc.) | Same gateway check |

**The process launch token never reaches remote clients (issue #10).** The
core mints one random launch token per process; `dsh web` prints the
`/?token=…` URL in the **local console only**, and that token is what mints
the browser cookie and what `GET /connect` exchanges for an owner-principal
API credential. Earlier releases bootstrapped a fresh device by bouncing the
browser to `/?token=<launchToken>`, which exposed the token to the remote
client (Location header → browser history, proxy access logs) — dsh-login
0.3.9 instead runs the same exchange server-side and serves the index
directly with the minted cookie, so the token never appears on the wire. A
remote user can therefore never reach owner credentials through dsh-login;
the token remains a local-console-only secret, exactly as upstream delivers
it.

### Protected by the bridge wall

| Asset | Protection |
|-------|-----------|
| API requests (`/api/*`) | `isTrustedApiRequest` host trust **and** a valid `dsh_session` cookie (401 without one); non-allowed POST methods denied for ordinary users (wire-correct forbidden envelope with `quietDenials`, else 403); `session.list`/`session.search`/`workspace.list` responses narrowed to owned sessions |
| WebSocket (`/api/remote.mux`) | Host-trust + browser-auth checks on upgrade (upstream fence); since 0.3.12 the dispatch-seam guard also requires a live `dsh_session` on the upgrade and filters `workspace.follow` frames per user |

### Recommendations for public exposure

1. With `autoTrustHosts` on (default), a successful SSO callback learns its Host into the whitelist, so an frp/tunnel host is trusted after one login — no `trustedHosts` editing needed. Manage explicit entries through DSH configuration.
2. Use a reverse proxy (nginx/caddy) with TLS termination in front of DSH.
3. The DSH session cookie uses `HttpOnly; SameSite=Lax`; the logout endpoint also validates the same-origin `Origin`.

**Troubleshooting: a non-admin user "cannot add a workspace" over a public tunnel?**

This is almost never the host whitelist (`autoTrustHosts` already learns the public host and login succeeds). Since 0.3.6 the native directory picker (`directoryPicker.*`) is admitted to DSH users and `workspace.create` is confined to the caller's sandbox (`workspaceRoot/<userId>`), so the native add-workspace flow works; `defaultWorkspace` (on by default) also pre-provisions an isolated sandbox on first `/api` access. If `/api` still answers `not permitted for this user` on a current build, the method is off this build's wire surface: check the host log for the one-per-method `dsh-login: /api/<method> was denied …` line and re-sync with `node scripts/dump-wire-surface.mjs`.

## Architecture note: fallback vs prefix /

The gateway uses `registerFallback()` (not `register({ kind: 'prefix', path: '/' })`) because the DSH WebServer's prefix matching checks `pathname.startsWith(prefix + '/')`. For prefix `/`, this becomes `//`, which no normal path starts with -- a `prefix /` route only matches the exact path `/`. The fallback handler catches everything no named route claims, which is the correct catch-all behavior for the authentication gateway.

The WebServer has a single fallback seat. dsh-web-app's `web-runtime` row mounts frontend-static over it unconditionally, so the `web-runtime` row must be disabled when using `dsh-login`; dsh-login re-provides the `webRuntime` service that row owned (LAN trust, `DSH_WEB_URL`), leaving the rest of the composition intact.

## Running tests

```bash
# Use Node >=24.9.0 with DSH 0.2.2-rc.1.
# Install the released DSH dependencies pinned in the lockfile; no checkout required.
npm ci
npm test
npm run verify:imports
npm run build
```

The upstream `.spec.ts` files describe the multi-user isolation layer. This Admin SSO adaptation still needs its own auth-flow, identity-mapping, and logout coverage before it is release-ready; the upstream local-login/setup integration cases do not cover this fork's SSO behavior.

## Project structure

```
src/
├── index.ts          # Cordis plugin entry: registers auth routes, fallback login gateway, webRuntime
├── config.ts         # schemastery config schema (Admin SSO, distIndex, dataDir, sessionTtl, ...)
├── admin-sso.ts      # authorize/callback, token exchange/refresh, userinfo, logout, Host identity service
├── session.ts        # in-memory DSH sessions keyed by stable Admin userId
├── ownership.ts      # OwnershipIndex: DSH sessionId → Admin userId sidecar
├── hosts.ts          # TrustedHosts: trusted-host whitelist (live set + debounced JSON persistence)
├── api-filter.ts     # pure predicates (AuthUser/USER_ALLOWED/isUserAllowed) for the per-user admission seam
├── bridge-list-filter.ts  # wire-response observation: owned-session closure + session/workspace.list narrowing (used by the bridge wall)
├── host-session-access.ts  # lazy host-side session surface (sessionController first, typertGateway fallback) for provisioning/list-probe
├── provision.ts      # DefaultWorkspaceProvisioner: per-user sandbox + registry workspace + seeded attached session
├── glue.ts           # deployment-side composition glue (dshLoginOwnership service + composeDshLoginGuard), see docs/compose-guard.md
├── settings-panel.client.js  # legacy upstream client; not registered by this fork
├── workspace-setting.ts  # 默认用户工作空间 runtime toggle (extends BooleanSetting)
├── boolean-setting.ts  # live + persisted {enabled} runtime flag shared by admin switches
├── remote-web-ui-compat.ts  # writes remote-web-ui's enabled+requirePairingForLan+publicBaseUrl (settings-backed, live) to mount its routes & bypass pairing / trust the public host
├── capabilities.ts  # capability discovery (deriveCapabilities) + read-probe classifier (isReadProbe/QUIET_DENY_METHODS)
├── admin-api.ts      # legacy local-account routes; not registered by this fork
├── auth.ts           # Cookie helpers
├── gateway.ts        # Auth gateway fallback (login wall + serveStatic + upstream connection.authorizeIndex)
├── login-api.ts      # legacy local-account routes; not registered by this fork
├── login-page.ts     # Admin SSO entry page (legacy setup markup is unreachable)
├── http-json.ts      # readBody/sendJson helpers + resolveDshHome
├── remote-guard.ts   # REMOTE-layer per-user isolation guard (wrapRemoteGateway + createRemoteIsolation), exported from the host bundle
├── api-bridge-auth.ts  # shared /api bridge wall: 401 + method gate + quiet denials + response tee
├── dispatch-guard.ts   # dispatch-seam guard: admission tagging + per-user dispatch gating + workspace.follow frame filtering (issue #11)
└── web-runtime.ts    # webRuntime takeover: LAN trust + DSH_WEB_URL
tests/ (upstream isolation tests; Admin SSO coverage is pending)
└── *.spec.ts         # vitest test definitions
```

## License

MIT
