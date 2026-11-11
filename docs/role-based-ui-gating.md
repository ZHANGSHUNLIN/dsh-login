# Role-based whole-UI gating — evaluation (2026-11-10, re-verified 2026-11-11)

**Status: implemented in the current source tree; release and deployment pending.**
Great Admin remains the role and permission source. DSH consumes `dsh:*`
permission codes from SSO and applies a shared method and UI bundle policy.

## 1. What ships today (verified at dsh-login 0.3.12 / DSH 0.2.2-rc.1)

| Layer | Module | Model |
|-------|--------|-------|
| Page / whole UI | `src/ui-gate.ts` (`applyUiGate` → `filterBootGraph`) | `ADMIN_ONLY_UI_PLUGINS` deny-list applied to `window.__DSH_BOOT__` entries + batches |
| Wire / `/api` | `src/api-filter.ts` (`classifyWireMethod`) | `USER_ALLOWED` (124 of 204) / `ADMIN_ONLY_METHODS` (79) / host-internal |
| Two-segment domains | `src/capabilities.ts` (`ADMIN_ONLY_TWO_SEGMENT_DOMAINS`) | admin-only deny-list |
| Identity | Admin SSO `permissions`, `src/session.ts` | stable Admin user ID plus DSH permission codes |
| Discovery | `src/capabilities.ts` (`deriveCapabilities`) | per-identity methods/domains/uiPlugins, echoed by `GET /api/auth/capabilities` |

Enforcement seams: the `/api` bridge wall (`apiBridgeAuth`), the dispatch-seam
guard (`dispatch-guard.ts` — `dispatchRpc`/`openWireStream`, issue #11), and the
page gate (`uiRoleGate`). All three resolve identity to `isAdmin`.

The boot-graph half is already a **pure per-entry JSON transform**: `entries`
rows are kept or dropped by id, batches are re-emitted with the surviving ids,
empty batches disappear, and every unexpected shape fails open (serving the
original HTML). Nothing about it is hard-wired to two roles — only the
`DENIED_IDS` set is a constant.

## 2. Permission policy

1. Admin registers `dsh:settings:manage`, `dsh:plugin:manage`, and
   `dsh:agent-preset:manage` under `platform.dsh`; roles assign these through
   the existing permission catalog.
2. SSO exposes only `dsh:*` permission codes and reloads them on token refresh.
3. DSH applies the shared `dsh-permissions.ts` mapping at the UI boot graph,
   HTTP bridge, dispatch seam, and optional Remote guard.
4. Unmapped admin methods remain denied. The settings permission explicitly
   covers all `settings.*` because model settings share the DSH settings API.

## 3. Feasibility verdict

**Feasible without any upstream change.** The boot-graph rewrite and dispatch
hooks support per-user policy. Admin's existing role editor already consumes
the permission catalog, so no separate DSH role editor is needed.

**Bounds that do not go away:**

- *Per-package granularity only* — hiding one slot/section inside an allowed
  bundle still needs dsh-login's own client half to wrap the slot registry.
- *Presentation-only* — the `/api` allow-list stays the security boundary; a
  role that hides a plugin from the page does not remove the method from a
  hand-crafted call.
- *Dev-mode HMR bypass* — a `pnpm run dev:web` rebuild re-syncs the full roster.
- *Upstream RBAC is not a substitute* — `packages/api/remote-access` authorizes
  **non-owner** peers only; every dsh-login user arrives as an owner principal,
  so its role engine never applies to them.

## 4. Limits

- UI bundle visibility cannot hide individual panels inside a shared bundle. Agent preset bundle IDs are classified from the DSH runtime graph because upstream package names can vary.
- `dsh:settings:manage` is deliberately broad because the model settings UI
  uses the general `settings.*` API.
- Permission changes are applied when DSH receives an updated SSO identity;
  users may need to reload or reauthenticate after role assignment changes.
- Plugin installation can execute third-party code on the host and should be
  assigned only to trusted roles.

## 5. Re-verification log

**2026-11-11 (scheduled watch)** — re-checked against upstream master tip
`fcc0ad4621` (still 811 commits past the newest tag `dsh-v0.2.2-rc.1`; still no
`dsh-v0.2.2` stable tag, no new release on npm):

| Claim in §2 | Re-verified evidence at the master tip |
|---|---|
| Page gate is a per-request transform | `renderIndex(html: string, peer: PeerScope)` at `packages/host/webserver/src/index.ts:738`; the graph row `{ kind: 'global', name: '__DSH_BOOT__', value: graph }` at `packages/client/modules/src/index.ts:635`; `webCtx.on('webserver/index-inject', (table, peer) => …)` at `packages/api/remote-access/src/index.ts:139` |
| No upstream role model to reuse | `git grep -nEi 'multi.?user\|multiuser\|role.?based\|\brbac\b' origin/master -- packages apps` = 1 hit, `packages/api/remote-access/README.md:2`; that engine "never checks" the owner principal, and every dsh-login user is an owner |
| Wire classifier is bucketed | unchanged at dsh-login 0.3.12: 124 / 79 / 1 of 204 (`src/api-filter.ts`) |
| No upstream RFC pending | upstream repo public, 0 open issues, `pushed_at` 2026-11-04T13:06:39Z; issue search for multi-user / rbac / login+accounts = 0 hits |

One new observation: upstream now renders index pages **per Peer**
(`snapshotFor(peer.principal)`, so a liveshare viewer page opens with that
viewer's grants). That makes the page-render seam peer-aware, which is the shape
a future role model would ride — while dsh-login continues to enforce Admin-
provided roles for owner identities at its own UI, HTTP, and dispatch seams.

