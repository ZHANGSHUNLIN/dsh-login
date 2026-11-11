// src/index.ts
import { join as join4 } from "node:path";

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  adminBaseUrl: z.string().default("http://127.0.0.1:8080/admin"),
  adminClientId: z.string().default("dsh"),
  publicBaseUrl: z.string().default(""),
  distIndex: z.string().default(""),
  dataDir: z.string().default(""),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
  takeOverWebRuntime: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  autoTrustHosts: z.boolean().default(true),
  defaultWorkspace: z.boolean().default(true),
  workspaceRoot: z.string().default(""),
  remoteWebUiCompat: z.boolean().default(true),
  remoteWebUiPublicBaseUrl: z.string().default(""),
  quietDenials: z.boolean().default(true),
  apiBridgeAuth: z.boolean().default(true),
  uiRoleGate: z.boolean().default(true)
});

// src/session.ts
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
var SAVE_DEBOUNCE_MS = 200;
var SessionStore = class {
  constructor(ttlSeconds, filePath) {
    this.ttlSeconds = ttlSeconds;
    this.filePath = filePath;
    if (filePath !== void 0) this.load();
  }
  ttlSeconds;
  filePath;
  store = /* @__PURE__ */ new Map();
  saveTimer;
  saving = Promise.resolve();
  /** Generate a 32-byte random DSH token for an Admin user ID. */
  create(user, isAdmin, permissions = []) {
    const token = randomBytes(32).toString("hex");
    const createdAt = Date.now();
    const session = {
      token,
      user,
      isAdmin,
      permissions: [...new Set(permissions)],
      authSource: "admin-sso",
      createdAt,
      expiresAt: createdAt + this.ttlSeconds * 1e3
    };
    this.store.set(token, session);
    this.scheduleSave();
    return session;
  }
  updatePermissionsForUser(user, permissions) {
    const next = [...new Set(permissions)];
    let changed = false;
    for (const [token, session] of this.store) {
      if (session.user !== user) continue;
      this.store.set(token, { ...session, permissions: next });
      changed = true;
    }
    if (changed) this.scheduleSave();
  }
  /** Return the live session for a token, or undefined. */
  verify(token) {
    if (token.length === 0) return void 0;
    const session = this.store.get(token);
    if (session === void 0) return void 0;
    if (Date.now() > session.expiresAt) {
      this.store.delete(token);
      this.scheduleSave();
      return void 0;
    }
    return session;
  }
  lookupUser(token) {
    return this.verify(token)?.user;
  }
  hasUser(userId) {
    for (const token of this.store.keys()) {
      const session = this.verify(token);
      if (session?.user === userId) return true;
    }
    return false;
  }
  permissionsForUser(userId) {
    for (const session of this.store.values()) {
      if (session.user === userId && Date.now() <= session.expiresAt) return [...session.permissions];
    }
    return [];
  }
  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token) {
    if (this.store.delete(token)) this.scheduleSave();
  }
  /**
   * Revoke every live session belonging to an Admin user ID. Returns the
   * number of sessions removed.
   */
  revokeAllFor(user) {
    let removed = 0;
    for (const [token, session] of this.store) {
      if (session.user === user) {
        this.store.delete(token);
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
    return removed;
  }
  /**
   * Count live (unexpired) sessions per Admin user ID.
   */
  onlineCounts() {
    const counts = /* @__PURE__ */ new Map();
    const now = Date.now();
    let swept = false;
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token);
        swept = true;
        continue;
      }
      counts.set(session.user, (counts.get(session.user) ?? 0) + 1);
    }
    if (swept) this.scheduleSave();
    return counts;
  }
  /** Remove all expired sessions. */
  cleanup() {
    const now = Date.now();
    let swept = false;
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token);
        swept = true;
      }
    }
    if (swept) this.scheduleSave();
  }
  /** Force the pending save; resolves when the queued write settled (teardown). */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.saving;
    await this.writeNow();
  }
  load() {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [];
      const now = Date.now();
      for (const entry of list) {
        if (typeof entry !== "object" || entry === null) continue;
        const s = entry;
        if (s.authSource !== "admin-sso" || typeof s.token !== "string" || typeof s.user !== "string" || typeof s.isAdmin !== "boolean") continue;
        if (typeof s.createdAt !== "number" || typeof s.expiresAt !== "number") continue;
        if (now > s.expiresAt) continue;
        this.store.set(s.token, {
          token: s.token,
          user: s.user,
          isAdmin: false,
          permissions: Array.isArray(s.permissions) ? s.permissions : [],
          authSource: "admin-sso",
          createdAt: s.createdAt,
          expiresAt: s.expiresAt
        });
      }
    } catch {
    }
  }
  scheduleSave() {
    if (this.filePath === void 0 || this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }
  async writeNow() {
    if (this.filePath === void 0) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify([...this.store.values()])}
`, { encoding: "utf8", mode: 384 });
    } catch {
    }
  }
};

// src/ownership.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var SAVE_DEBOUNCE_MS2 = 200;
var OwnershipIndex = class {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      const raw = readFileSync2(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.version === 2 && parsed.owners !== null && typeof parsed.owners === "object") {
        for (const [k, v] of Object.entries(parsed.owners)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch {
    }
  }
  filePath;
  map = /* @__PURE__ */ new Map();
  saveTimer;
  saving = Promise.resolve();
  record(sessionId, userId) {
    this.map.set(sessionId, userId);
    this.scheduleSave();
  }
  lookup(sessionId) {
    return this.map.get(sessionId);
  }
  has(sessionId) {
    return this.map.has(sessionId);
  }
  knownUsernames() {
    return new Set(this.map.values());
  }
  /** All recorded [sessionId, username] pairs (snapshot). */
  entries() {
    return [...this.map.entries()];
  }
  /** Force the pending save; resolves when the file write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.saving;
    await this.writeNow();
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.writeNow();
    }, SAVE_DEBOUNCE_MS2);
  }
  async writeNow() {
    try {
      await mkdir2(dirname2(this.filePath), { recursive: true });
      await writeFile2(this.filePath, `${JSON.stringify({ version: 2, owners: Object.fromEntries(this.map) })}
`, "utf8");
    } catch {
    }
  }
};

// src/hosts.ts
import { mkdir as mkdir3, writeFile as writeFile3 } from "node:fs/promises";
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
var SAVE_DEBOUNCE_MS3 = 200;
var MAX_HOST_LENGTH = 255;
function canonicalAuthority(host) {
  let entryUrl;
  try {
    entryUrl = new URL(`http://${host}`);
  } catch {
    return void 0;
  }
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${host}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isBareAuthority(host) {
  const c = canonicalAuthority(host);
  return c !== void 0 && c === host.toLowerCase() && host.length <= MAX_HOST_LENGTH;
}
function isLoopbackCanonical(authority) {
  const hostname = (authority.split(":")[0] ?? "").toLowerCase();
  if (hostname === "localhost") return true;
  if (hostname === "::1") return true;
  if (/^127\./.test(hostname)) return true;
  if (hostname === "0.0.0.0") return true;
  if (/^\[?::1\]?/.test(authority)) return true;
  return false;
}
var TrustedHosts = class {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      const raw = readFileSync3(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" ? Object.keys(parsed) : [];
      for (const entry of entries) {
        if (typeof entry === "string") {
          const c = canonicalAuthority(entry);
          if (c !== void 0) this.set.add(c);
        }
      }
    } catch {
    }
  }
  filePath;
  set = /* @__PURE__ */ new Set();
  saveTimer;
  /** Tail of a single serialized write queue; writes never overlap. */
  saving = Promise.resolve();
  /** Canonicalize an authority; undefined when not a bare authority. */
  canonicalize(host) {
    return canonicalAuthority(host);
  }
  /** Whether this authority is currently trusted (canonical comparison). */
  has(authority) {
    const c = canonicalAuthority(authority);
    return c !== void 0 && this.set.has(c);
  }
  /**
   * Add one (auto-learned) Host authority, skipping loopback, invalid and
   * non-bare inputs. Returns true when newly recorded. Idempotent.
   */
  learn(host) {
    if (!isBareAuthority(host)) return false;
    const c = canonicalAuthority(host);
    if (isLoopbackCanonical(c)) return false;
    if (this.set.has(c)) return false;
    this.set.add(c);
    this.scheduleSave();
    return true;
  }
  /** Add a validated authority (admin manual add). Returns true when new. */
  add(authority) {
    if (!isBareAuthority(authority)) return false;
    const c = canonicalAuthority(authority);
    if (isLoopbackCanonical(c)) return false;
    if (this.set.has(c)) return false;
    this.set.add(c);
    this.scheduleSave();
    return true;
  }
  /** Remove an authority; returns true when it existed. Idempotent. */
  remove(authority) {
    const c = canonicalAuthority(authority);
    const key = c ?? authority;
    const existed = this.set.delete(key);
    if (existed) this.scheduleSave();
    return existed;
  }
  /** Snapshot of the currently trusted authorities. */
  list() {
    return [...this.set];
  }
  /** Force the pending save; resolves when the queued write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.saving = this.saving.then(() => this.writeNow());
    await this.saving;
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.saving.then(() => this.writeNow());
    }, SAVE_DEBOUNCE_MS3);
  }
  async writeNow() {
    try {
      await mkdir3(dirname3(this.filePath), { recursive: true });
      await writeFile3(this.filePath, `${JSON.stringify(this.list())}
`, "utf8");
    } catch {
    }
  }
};

// src/boolean-setting.ts
import { mkdir as mkdir4, writeFile as writeFile4 } from "node:fs/promises";
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname4 } from "node:path";
var SAVE_DEBOUNCE_MS4 = 200;
var BooleanSetting = class {
  constructor(filePath, initial) {
    this.filePath = filePath;
    this.enabled = initial;
    try {
      const raw = readFileSync4(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.enabled === "boolean") {
        this.enabled = parsed.enabled;
      }
    } catch {
    }
  }
  filePath;
  enabled;
  saveTimer;
  /** Tail of a single serialized write queue; writes never overlap. */
  saving = Promise.resolve();
  /** Whether the toggle is currently on. */
  get() {
    return this.enabled;
  }
  /** Set the flag and persist it (best-effort). Returns the new value. */
  set(enabled) {
    this.enabled = enabled;
    this.scheduleSave();
    return this.enabled;
  }
  /** Force the pending save; resolves when the queued write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.saving = this.saving.then(() => this.writeNow());
    await this.saving;
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.saving.then(() => this.writeNow());
    }, SAVE_DEBOUNCE_MS4);
  }
  async writeNow() {
    try {
      await mkdir4(dirname4(this.filePath), { recursive: true });
      await writeFile4(this.filePath, `${JSON.stringify({ enabled: this.enabled })}
`, "utf8");
    } catch {
    }
  }
};

// src/workspace-setting.ts
var DefaultWorkspaceSetting = class extends BooleanSetting {
};

// src/remote-web-ui-compat.ts
var REMOTE_WEB_UI_NAMESPACE = "remote-web-ui";
var RemoteWebUiCompat = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  /**
   * Apply the compat document to remote-web-ui's settings namespace.
   * @param compatEnabled - when true, mount the host routes and open the pairing
   * gate; when false, restore the pairing requirement only.
   * @param publicBaseUrl - optional public base URL (e.g. `http://host:port`) to
   * write so remote-web-ui's `/api/pair/*` fence trusts the public origin. Only
   * written when compat is on and the value is a non-empty http(s) URL.
   */
  async apply(compatEnabled, publicBaseUrl) {
    const settings = this.deps.getSettings();
    if (settings === void 0) return "skipped";
    let patch;
    if (compatEnabled) {
      patch = { enabled: true, requirePairingForLan: false };
      if (typeof publicBaseUrl === "string" && isHttpUrl(publicBaseUrl)) patch.publicBaseUrl = publicBaseUrl;
    } else {
      patch = { requirePairingForLan: true };
    }
    try {
      await settings.update(REMOTE_WEB_UI_NAMESPACE, patch);
      return "ok";
    } catch (error) {
      if (isUnregisteredNamespace(error)) return "unregistered";
      throw error;
    }
  }
};
function isUnregisteredNamespace(error) {
  const message = String(error instanceof Error ? error.message : error);
  return message.includes("not registered") || message.includes("No configurable plugin entry");
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
async function applyWithRetry(compat, enabled, publicBaseUrl, attempts = 60, delayMs = 250) {
  let last = "unregistered";
  for (let i = 0; i < attempts; i++) {
    const result = await compat.apply(enabled, publicBaseUrl);
    if (result === "ok") return "ok";
    last = result;
    await new Promise((resolve2) => setTimeout(resolve2, delayMs));
  }
  return last;
}

// src/gateway.ts
import { readFile as readFile2 } from "node:fs/promises";
import { dirname as dirname5 } from "node:path";

// src/serve-static.ts
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
var HTML_MIME = "text/html; charset=utf-8";
var MIME = {
  ".html": HTML_MIME,
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  // Launchers require an image Content-Type for the install icons.
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  ".gz": "application/gzip"
};
var STATIC_MISS_CODES = /* @__PURE__ */ new Set([
  "ENOENT",
  "EISDIR",
  "ENOTDIR"
]);
async function serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex) {
  const target = resolve(normalize(join(distRoot, pathname)));
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  let body;
  let type;
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return;
      body = await renderIndex();
      type = HTML_MIME;
    } else {
      body = await readFile(target);
      type = MIME[extname(target)] ?? "application/octet-stream";
    }
  } catch (error) {
    if (!STATIC_MISS_CODES.has(error.code)) throw error;
    res.writeHead(404);
    res.end();
    return;
  }
  const headers = { "content-type": type };
  if (target === distRoot || target === distIndex) {
    headers["cache-control"] = "no-store, no-cache, must-revalidate";
    headers.pragma = "no-cache";
  }
  res.writeHead(200, headers);
  res.end(body);
}

// src/auth.ts
var COOKIE_NAME = "dsh_session";
function extractSessionToken(cookieHeader) {
  if (cookieHeader === void 0) return void 0;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return void 0;
}
function buildClearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// src/api-filter.ts
var WIRE_SURFACE_DSH_VERSION = "0.2.2-rc.1";
var USER_ALLOWED = /* @__PURE__ */ new Set([
  // ── session: the conversation surface ─────────────────────────────────────
  // `page` replaced the old `session.history`; `modelCatalog` replaced
  // `session.models`; `initializeDefaultModel`/`selectModel` are the model
  // picker; `canOpenWorkspacePath`/`openWorkspacePath`/
  // `workspacePathApplications` back the "open folder" flow; `control` is the
  // per-session steering stream; `projections` is the timeline projection.
  "session.attachment",
  "session.cancel",
  "session.canOpenWorkspacePath",
  "session.control",
  "session.create",
  "session.events",
  "session.follow",
  "session.fork",
  "session.initializeDefaultModel",
  "session.list",
  "session.modelCatalog",
  "session.observeEvent",
  "session.observeProjections",
  "session.observeState",
  "session.openWorkspacePath",
  "session.page",
  "session.projections",
  "session.prompt",
  "session.rename",
  "session.search",
  "session.selectModel",
  "session.state",
  "session.updateQueue",
  "session.wait",
  "session.workspacePathApplications",
  // ── workspace: the sidebar tree (read + the user's own mutations) ─────────
  // `follow` is the tree snapshot stream (the old `workspace.list`); every
  // mutation carries ids the guard ownership-checks.
  "workspace.archiveSession",
  "workspace.create",
  "workspace.delete",
  "workspace.follow",
  "workspace.insertBefore",
  "workspace.insertSessionBefore",
  "workspace.pinSession",
  "workspace.rename",
  "workspace.unarchiveSession",
  "workspace.unpinSession",
  // ── goals: per-session goal tracking (renamed from `goal.*`) ──────────────
  "goals.clear",
  "goals.complete",
  "goals.create",
  "goals.edit",
  "goals.get",
  "goals.pause",
  "goals.resume",
  // ── subagents: the caller's own agent subtree ─────────────────────────────
  "subagents.interruptByParent",
  "subagents.prompt",
  // ── actionCards: user actions on in-chat cards ─────────────────────────────
  // `act` applies one verb to one card of the displayed Session; the Gateway
  // resolves `agent` server-side from the Session id, so it reaches only the
  // caller's own conversation (same trust shape as `terminal.*`).
  "actionCards.act",
  // ── forgePanel: the per-session git worktree / change-request panel ────────
  // Every method is Session-scoped (first wire arg `sessionId: SessionId`, a
  // resource the Gateway resolves and the remote guard ownership-checks): it
  // inspects the Session's own checkout, follows, reviews or merges the
  // Session's bound change requests (0.2.2-alpha.3 adds the CI-checks read
  // `changeRequestChecks` and the review publisher `submitReview` — the same
  // trust shape as the already-admitted `merge`/`markReady`, since publishing
  // a review acts on the Session's own code host exactly like merging does),
  // and creates/enters worktrees for that Session — the same
  // trust shape as `terminal.*` (the agent can already run git/shell for the
  // user inside the Session's world). Host-wide secrets are not touched; the
  // sign-in probe reports only the state of the code host of the Session's
  // own checkout.
  "forgePanel.branches",
  "forgePanel.cancelWorktree",
  "forgePanel.changeRequestChecks",
  "forgePanel.changeRequestDiff",
  "forgePanel.changeRequestStates",
  "forgePanel.changeRequestText",
  "forgePanel.continueInProject",
  "forgePanel.dismiss",
  "forgePanel.follow",
  "forgePanel.localDiff",
  "forgePanel.localText",
  "forgePanel.markReady",
  "forgePanel.merge",
  "forgePanel.refresh",
  "forgePanel.requestWorktree",
  "forgePanel.restoreWorktree",
  "forgePanel.retryWorktree",
  "forgePanel.stopCreation",
  "forgePanel.submitReview",
  "forgePanel.track",
  // ── llm: the provider/model catalogs the picker renders ───────────────────
  // (`llm.providers`/`llm.models` never existed on this wire line; these are
  // the real names — discovery is what settings→models failed on in issue #4.)
  "llm.discoverModels",
  "llm.listConfigurableProviders",
  "llm.listProviders",
  // ── skills: the slash-command skill list (`skills.list`) ──────────────────
  "skills.list",
  // ── job: the background job controller ────────────────────────────────────
  "job.follow",
  "job.kill",
  "job.list",
  // ── terminal: the sidebar terminal ────────────────────────────────────────
  // Every method is session-agent-scoped by the Gateway (the `agent` argument
  // is supplied server-side, never by the browser), so it stays inside the
  // caller's own agent subtree — the same trust boundary as `session.prompt`
  // (an agent can already run shell for the user). `list`/`retain` address a
  // session explicitly and are ownership-checked. NOTE: since 0.1.6-alpha.2
  // user terminals run with the execution environment's system-user
  // permissions (no Agent sandbox); a stricter deployment subtracts these
  // (docs/adapt-dsh-0.1.6-alpha.2.md §4).
  "terminal.attach",
  "terminal.close",
  "terminal.create",
  "terminal.environment",
  "terminal.list",
  "terminal.rename",
  "terminal.retain",
  "terminal.shells",
  // ── remoteAccess: the client's own grant snapshot stream ──────────────────
  // The gateway always allows it and it answers with only the caller's own
  // grants, so admitting it keeps the mount silent on every page load.
  "remoteAccess.follow",
  // ── document preview: read-only Files surface + Office→PDF ────────────────
  // Each call carries the scoped session identity (workspaceFileScopeId),
  // resolved and ownership-checked by the Gateway. No write method is exposed.
  "workspaceFiles.changes",
  "workspaceFiles.list",
  "workspaceFiles.read",
  "workspaceFiles.readBytes",
  "workspaceFiles.stat",
  "officeToPdf.generation",
  "officeToPdf.render",
  // ── speech: per-user dictation preferences + transcription ────────────────
  // `configure` persists the caller's own recognizer settings.
  "speech.cancelPreparation",
  "speech.catalog",
  "speech.configure",
  "speech.follow",
  "speech.prepare",
  "speech.transcribe",
  // ── schedule: the user's own scheduled runs ───────────────────────────────
  // 0.2.2-alpha.3 reshaped the surface: the retired `update`/`delete` pair is
  // folded into `edit` (one call updates or deletes a task), and `create`,
  // `run` (deliver one task now), `view` (read one task) and `deliveryLimits`
  // (the recurrence picker's interval constraint) join the already-admitted
  // `catalog`/`list`/`history` reads. Same trust shape as before: tasks are
  // addressed by id on the Host's shared schedule domain (upstream models no
  // per-task ownership — the pre-existing reads already expose it), and the
  // host-wide sweep `deleteInactive` stays admin-only.
  "schedule.catalog",
  "schedule.create",
  "schedule.deliveryLimits",
  "schedule.edit",
  "schedule.history",
  "schedule.list",
  "schedule.run",
  "schedule.view",
  // ── composer + pickers the GUI calls on ordinary-user pages ───────────────
  // `directoryPicker.*` is the "add workspace" directory chooser
  // (`ui-workspace/src/client/navigation.ts`), i.e. issue #4 symptom 1. It is
  // admitted because the capability class is already open to ordinary users
  // (`terminal.*` runs shell as the same system user), and because the
  // dangerous half — registering the picked directory — stays guarded:
  // `workspace.create` is confined to the caller's sandbox by the workspace
  // mutation guard, so a pick outside it is rejected at that call, not here.
  "commands.execute",
  "commands.list",
  "directoryPicker.createDirectory",
  "directoryPicker.list",
  "directoryPicker.pick",
  // ── attachments, references, feedback, telemetry ──────────────────────────
  "fileReferences.list",
  "fileUploads.upload",
  "messageFeedback.delete",
  "messageFeedback.list",
  "messageFeedback.put",
  "sessionFeedback.record",
  "sessionReferenceResolver.candidates",
  "permissionPresets.catalog",
  "productAnalytics.enabled",
  "productAnalytics.report",
  "productAnalytics.watchPolicy",
  // ── chain-of-thought translation (a per-user reading aid) ─────────────────
  "cotTranslation.limits",
  "cotTranslation.translate",
  // ── pluginRecommendations: the enable-official-plugin card's text ──────────
  // `describe` reads the catalog text behind one logged card; `agent` is
  // Gateway-resolved and the `callId` must name a live card of that Session,
  // so it is session-scoped like `actionCards.act`.
  "pluginRecommendations.describe",
  // ── the agent's ask-the-user dialog ───────────────────────────────────────
  "userQuestions.answer",
  "userQuestions.attachWait",
  // ── toolResults: the Session's own tool-result trajectory stream ──────────
  "toolResults.watch"
]);
var ADMIN_ONLY_METHODS = /* @__PURE__ */ new Set([
  "account.ackBonusNotified",
  "account.cancelSignIn",
  "account.getBalance",
  "account.getProfile",
  "account.getState",
  "account.getUnnotifiedBonuses",
  "account.hasRunningAccountTasks",
  "account.signOut",
  "account.startSignIn",
  "account.watch",
  "account.watchExpiry",
  "agentPresets.list",
  "agentPresets.read",
  "agentPresets.select",
  "claudeCodeMods.pressBand",
  "claudeCodeMods.watchBand",
  "credentials.describe",
  "credentials.set",
  "credentials.unset",
  "dynamicCordisRunner.getClientCode",
  "dynamicCordisRunner.inventory",
  "dynamicCordisRunner.invoke",
  "dynamicCordisRunner.reportClientGuardFailure",
  "dynamicCordisRunner.reportRenderFailure",
  "dynamicCordisRunner.resolveInspectQuery",
  "dynamicCordisRunner.resolveRequestRun",
  "dynamicCordisRunner.runHostHalf",
  "dynamicCordisRunner.settleUserRun",
  "dynamicCordisRunner.stopFromPanel",
  "dynamicCordisRunner.syncInspectManifest",
  "dynamicCordisRunner.undefineFromPanel",
  "pluginInventory.list",
  "pluginManager.cancelInstall",
  "pluginManager.inspect",
  "pluginManager.installBundle",
  "pluginManager.listBundles",
  "pluginManager.listPlugins",
  "pluginManager.listVersionExemptions",
  "pluginManager.listVersions",
  "pluginManager.readBundleDetail",
  "pluginManager.registries",
  "pluginManager.removeBundle",
  "pluginManager.setBundleEnabled",
  "pluginManager.setPluginEnabled",
  "pluginManager.setVersionExemption",
  "pluginManager.updateBundle",
  "pluginManager.waitForInstall",
  "pluginMarket.listIndexes",
  "pluginMarket.readEntryDetail",
  "pluginMarket.search",
  "pluginMarket.setIndexes",
  "pluginRegistryProbe.fastest",
  // ── cuaAccess: host-native permission and application consent controls ────
  // The whole surface drives the HOST machine (macOS privacy prompts through
  // the native helper, the shared application-consent store, and the
  // host-wide PTC profile edit behind `enablePersistentPtc`), so it stays
  // operator territory even though the client page lives in a Session.
  "cuaAccess.applicationIcons",
  "cuaAccess.applications",
  "cuaAccess.enablePersistentPtc",
  "cuaAccess.openSettings",
  "cuaAccess.ptcConfiguration",
  "cuaAccess.requestPermission",
  "cuaAccess.retryApproval",
  "cuaAccess.revoke",
  "cuaAccess.systemStatus",
  // ── liveshareShares: the host's share publishing and relay management ──────
  // Upstream declares the whole surface the "Owner-only Remote surface over
  // the share-management operations": publishing Sessions to external viewers
  // through the Liveshare server, the host's relay connection, its owner
  // identity and the share audit trail. That is operator territory in a
  // multi-user deployment (external exposure + host-wide state), so the whole
  // namespace stays admin-side; a future user-scoped subset would need
  // per-share ownership checks dsh-login does not model yet.
  "liveshareShares.audit",
  "liveshareShares.capabilities",
  "liveshareShares.create",
  "liveshareShares.identity",
  "liveshareShares.list",
  "liveshareShares.relay",
  "liveshareShares.setCapabilities",
  "liveshareShares.setRelay",
  "liveshareShares.stop",
  "liveshareShares.testPublish",
  "liveshareShares.testRelay",
  "liveshareShares.updatePermissions",
  // `deleteInactive` sweeps every ended task across the whole Host domain
  // (no Session scope on the wire), so it is an operator action even though
  // the rest of `schedule.*` is the caller's own surface.
  "schedule.deleteInactive",
  "settings.describe",
  "settings.mutate",
  "settings.openSettingsDocument",
  "settings.replace",
  "settings.update"
]);
var HOST_INTERNAL_METHODS = /* @__PURE__ */ new Set([
  "workspace.initializeDefault"
]);
var WIRE_SURFACE = /* @__PURE__ */ new Set([
  ...USER_ALLOWED,
  ...ADMIN_ONLY_METHODS,
  ...HOST_INTERNAL_METHODS
]);
function classifyWireMethod(method) {
  if (USER_ALLOWED.has(method)) return "user";
  if (ADMIN_ONLY_METHODS.has(method)) return "admin";
  if (HOST_INTERNAL_METHODS.has(method)) return "host-internal";
  return "unknown";
}
function isKnownWireMethod(method) {
  return WIRE_SURFACE.has(method);
}

// src/dsh-permissions.ts
var DSH_PERMISSIONS = {
  settings: "dsh:settings:manage",
  plugins: "dsh:plugin:manage",
  agentPresets: "dsh:agent-preset:manage"
};
var CORE_UI_PLUGINS = [
  "@islibaodong/dsh-login",
  "@duhome/dsh-admin-mcp",
  // The settings shell owns the launcher slot used by the Admin account
  // card. Its privileged sections are gated independently.
  "@deepseek-ai/dsh-client-ui-settings-general"
];
var METHOD_PERMISSIONS = new Map([
  ...[
    "settings.describe",
    "settings.mutate",
    "settings.openSettingsDocument",
    "settings.replace",
    "settings.update"
  ].map((method) => [method, DSH_PERMISSIONS.settings]),
  ...[
    "agentPresets.list",
    "agentPresets.read",
    "agentPresets.select",
    // The preset UI's Remote contract uses the singular namespace. Listing,
    // selecting, reading and editing the preset roster are covered by the
    // same Admin-managed permission; opening a host document is not.
    "agentPreset.list",
    "agentPreset.select",
    "agentPreset.read",
    "agentPreset.copy",
    "agentPreset.remove"
  ].map((method) => [method, DSH_PERMISSIONS.agentPresets]),
  ...[
    "pluginManager.cancelInstall",
    "pluginManager.inspect",
    "pluginManager.installBundle",
    "pluginManager.listBundles",
    "pluginManager.listPlugins",
    "pluginManager.listVersionExemptions",
    "pluginManager.listVersions",
    "pluginManager.readBundleDetail",
    "pluginManager.registries",
    "pluginManager.removeBundle",
    "pluginManager.setBundleEnabled",
    "pluginManager.setPluginEnabled",
    "pluginManager.setVersionExemption",
    "pluginManager.updateBundle",
    "pluginManager.waitForInstall",
    "pluginMarket.listIndexes",
    "pluginMarket.readEntryDetail",
    "pluginMarket.search",
    "pluginMarket.setIndexes",
    "pluginInventory.list",
    "pluginRegistryProbe.fastest"
  ].map((method) => [method, DSH_PERMISSIONS.plugins])
]);
var UI_PLUGIN_PERMISSIONS = {
  "@deepseek-ai/dsh-client-ui-plugin-manager": [DSH_PERMISSIONS.plugins],
  "@deepseek-ai/dsh-client-ui-settings-plugin-inventory": [DSH_PERMISSIONS.plugins],
  "@deepseek-ai/dsh-client-ui-settings-plugins": [DSH_PERMISSIONS.plugins],
  "@deepseek-ai/dsh-client-ui-entry-customization": [DSH_PERMISSIONS.plugins],
  "@deepseek-ai/dsh-client-ui-settings-models": [DSH_PERMISSIONS.settings],
  "@deepseek-ai/dsh-client-ui-settings-shell": [DSH_PERMISSIONS.settings],
  "@deepseek-ai/dsh-client-ui-settings-agent-loop": [DSH_PERMISSIONS.settings],
  "@deepseek-ai/dsh-client-ui-settings-subagent": [DSH_PERMISSIONS.settings],
  "@deepseek-ai/dsh-client-ui-settings-web-search": [DSH_PERMISSIONS.settings],
  "@deepseek-ai/dsh-client-ui-settings-session-log": [DSH_PERMISSIONS.settings],
  "@linxin666/dsh-client-ui-plugin-manager": [DSH_PERMISSIONS.plugins],
  "@linxin666/dsh-client-ui-market": [DSH_PERMISSIONS.plugins],
  "@linxin666/dsh-client-ui-community-plugins": [DSH_PERMISSIONS.plugins],
  "@linxin666/dsh-client-ui-web-ui-settings": [DSH_PERMISSIONS.settings],
  "@tencent-connect/dsh-qqbot": [DSH_PERMISSIONS.settings]
};
function hasDshPermission(user, permission) {
  return user.isAdmin || user.permissions?.includes(permission) === true;
}
function permissionForUiPlugin(plugin) {
  const mapped = UI_PLUGIN_PERMISSIONS[plugin];
  if (mapped) return mapped[0];
  if (plugin.startsWith("@deepseek-ai/dsh-client-ui-settings-") && plugin !== "@deepseek-ai/dsh-client-ui-settings-general") return DSH_PERMISSIONS.settings;
  return /agent[-.]?preset/i.test(plugin) ? DSH_PERMISSIONS.agentPresets : void 0;
}
function canUseWireMethod(method, user) {
  if (user.isAdmin || USER_ALLOWED.has(method)) return true;
  const required = METHOD_PERMISSIONS.get(method);
  return required !== void 0 && hasDshPermission(user, required);
}
function permittedWireMethods(user) {
  return user.isAdmin ? [...USER_ALLOWED, ...ADMIN_ONLY_METHODS] : [
    ...USER_ALLOWED,
    ...[...ADMIN_ONLY_METHODS].filter((method) => canUseWireMethod(method, user))
  ];
}
function permittedUiPlugins(plugins, user) {
  if (user.isAdmin) return [...plugins];
  return plugins.filter((plugin) => {
    if (CORE_UI_PLUGINS.includes(plugin)) return true;
    const required = permissionForUiPlugin(plugin);
    return required !== void 0 && hasDshPermission(user, required);
  });
}
function permissionForWireMethod(method) {
  return METHOD_PERMISSIONS.get(method);
}

// src/capabilities.ts
var USER_DOMAINS = [
  ...new Set([...USER_ALLOWED].map((method) => method.slice(0, method.indexOf("."))))
].sort();
var ADMIN_ONLY_UI_PLUGINS = [
  // DSH 0.2.2 built-in admin surfaces.
  "@deepseek-ai/dsh-client-ui-plugin-manager",
  "@deepseek-ai/dsh-client-ui-settings-plugin-inventory",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-agent-preset",
  "@deepseek-ai/dsh-client-ui-entry-customization",
  "@deepseek-ai/dsh-client-ui-settings-models",
  "@deepseek-ai/dsh-client-ui-settings-shell",
  "@deepseek-ai/dsh-client-ui-settings-agent-loop",
  "@deepseek-ai/dsh-client-ui-settings-subagent",
  "@deepseek-ai/dsh-client-ui-settings-web-search",
  "@deepseek-ai/dsh-client-ui-settings-session-log",
  "@tencent-connect/dsh-qqbot",
  // Older community bundle ids kept for mixed-version profiles.
  "@linxin666/dsh-client-ui-plugin-manager",
  "@linxin666/dsh-client-ui-skill-explorer",
  "@linxin666/dsh-client-ui-skin-center",
  "@linxin666/dsh-client-ui-market",
  "@linxin666/dsh-client-ui-git-graph",
  "@linxin666/dsh-client-ui-community-plugins",
  "@linxin666/dsh-client-ui-web-ui-settings",
  "@linxin666/dsh-client-ui-aionui-panel",
  "@linxin666/dsh-client-ui-task-board",
  "@linxin666/dsh-desktop-launcher",
  "@linxin666/dsh-doctor",
  "@linxin666/dsh-pet",
  "@linxin666/dsh-ssh",
  "@linxin666/dsh-perf",
  "@linxin666/dsh-liangshen"
];
function deriveCapabilities(user) {
  const methods = permittedWireMethods(user);
  const uiPlugins = permittedUiPlugins(CORE_UI_PLUGINS.concat(ADMIN_ONLY_UI_PLUGINS), user);
  return {
    methods,
    domains: [...new Set(methods.map((method) => method.slice(0, method.indexOf("."))))].sort(),
    uiPlugins
  };
}

// src/ui-gate.ts
var BOOT_MARKER = '<script>globalThis["__DSH_BOOT__"] = ';
function deniedUiPlugins(user, pluginIds) {
  if (user.isAdmin) return /* @__PURE__ */ new Set();
  return new Set(pluginIds.filter((id) => {
    if (CORE_UI_PLUGINS.includes(id)) return false;
    const required = permissionForUiPlugin(id);
    return required !== void 0 ? !hasDshPermission(user, required) : ADMIN_ONLY_UI_PLUGINS.includes(id);
  }));
}
function filterBootGraph(graph, user = { isAdmin: false }) {
  if (typeof graph !== "object" || graph === null) return null;
  const shape = graph;
  if (typeof shape.rev !== "string" || !Array.isArray(shape.entries) || !Array.isArray(shape.batches)) {
    return null;
  }
  const kept = [];
  const removed = /* @__PURE__ */ new Set();
  const pluginIds = shape.entries.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const id = row.id;
    return typeof id === "string" ? [stripClient(id)] : [];
  });
  const denied = deniedUiPlugins(user, [...ADMIN_ONLY_UI_PLUGINS, ...pluginIds]);
  for (const row of shape.entries) {
    if (typeof row !== "object" || row === null) return null;
    const entry = row;
    if (typeof entry.id !== "string") return null;
    const pluginId = stripClient(entry.id);
    if (denied.has(pluginId)) {
      removed.add(entry.id);
      removed.add(pluginId);
      continue;
    }
    kept.push(row);
  }
  const batches = [];
  for (const row of shape.batches) {
    if (typeof row !== "object" || row === null) return null;
    const batch = row;
    if (!Array.isArray(batch.entries) || batch.entries.some((id) => typeof id !== "string")) return null;
    if (batch.url !== void 0 && typeof batch.url !== "string") return null;
  }
  if (removed.size === 0) return graph;
  for (const row of kept) {
    for (const field of ["inject", "external"]) {
      const value = row[field];
      if (value === void 0) continue;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
      if (value.some((item) => removed.has(item) || removed.has(stripClient(item)))) return null;
    }
  }
  for (const row of shape.batches) {
    const batch = row;
    const remaining = batch.entries.filter((id) => typeof id === "string" && !removed.has(id));
    if (remaining.length === 0) continue;
    const url = typeof batch.url === "string" ? filterBatchUrl(batch.url, removed) : void 0;
    const entriesChanged = remaining.length !== batch.entries.length;
    const urlChanged = url !== batch.url;
    batches.push(entriesChanged || urlChanged ? {
      ...row,
      entries: remaining,
      ...url === void 0 ? {} : { url }
    } : row);
  }
  return { ...graph, entries: kept, batches };
}
function stripClient(spec) {
  if (spec.endsWith("/client.js")) return spec.slice(0, -"/client.js".length);
  return spec.endsWith("/client") ? spec.slice(0, -"/client".length) : spec;
}
function filterBatchUrl(url, removed) {
  const marker = url.indexOf("??");
  if (marker === -1) return url;
  const modulesStart = marker + 2;
  const suffixStart = url.indexOf("&", modulesStart);
  const modulesEnd = suffixStart === -1 ? url.length : suffixStart;
  const modules = url.slice(modulesStart, modulesEnd).split(",");
  const remaining = modules.filter((spec) => {
    const id = spec.endsWith("/client.js") ? spec.slice(0, -"/client.js".length) : stripClient(spec);
    return !removed.has(id);
  });
  if (remaining.length === modules.length) return url;
  return `${url.slice(0, modulesStart)}${remaining.join(",")}${url.slice(modulesEnd)}`;
}
function applyUiGate(html, user = { isAdmin: false }) {
  const start = html.indexOf(BOOT_MARKER);
  if (start === -1) return html;
  const jsonStart = start + BOOT_MARKER.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end === -1) return html;
  const raw = html.slice(jsonStart, end);
  let graph;
  try {
    graph = JSON.parse(raw);
  } catch {
    return html;
  }
  const filtered = filterBootGraph(graph, user);
  if (filtered === null) return html;
  const rebuilt = JSON.stringify(filtered).replaceAll("<", "\\u003c");
  return `${html.slice(0, jsonStart)}${rebuilt}${html.slice(end)}`;
}

// src/gateway.ts
function indexRenderer(ctx, distIndex) {
  return async () => {
    const body = await readFile2(distIndex, "utf8");
    const webServer = ctx.webServer;
    const render = webServer.renderIndex ?? webServer.applyIndexTaps.bind(webServer);
    return render.call(webServer, body, { principal: { kind: "owner" } });
  };
}
function createCaptureResponse() {
  const headers = {};
  let status = 0;
  const capture = {
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    writeHead(code, writeHeaders) {
      status = code;
      if (writeHeaders !== void 0) {
        for (const [name2, value] of Object.entries(writeHeaders)) {
          headers[name2.toLowerCase()] = value;
        }
      }
    },
    setHeader(name2, value) {
      headers[name2.toLowerCase()] = value;
    },
    end(..._) {
    }
  };
  return capture;
}
function mintCoreCookie(connection, launchToken, req) {
  const synthesized = {
    method: "GET",
    url: `/?token=${encodeURIComponent(launchToken)}`,
    headers: req.headers
  };
  const capture = createCaptureResponse();
  try {
    connection.authorizeIndex(synthesized, capture);
  } catch {
    return void 0;
  }
  const cookie = capture.headers["set-cookie"];
  return typeof cookie === "string" || Array.isArray(cookie) ? cookie : void 0;
}
function createAuthorizeIndex(ctx) {
  return (req, res) => {
    const connection = ctx.get("connection");
    if (connection === void 0) return true;
    const auth = connection.browserAuth ?? connection;
    const secure = ctx.webServer?.protocol === "https:";
    const hasTokenParam = req.url !== void 0 && /[?&]token=/.test(req.url);
    if (!hasTokenParam && typeof auth.isAuthenticated === "function" && !auth.isAuthenticated(req, secure) && typeof auth.launchToken === "string" && auth.launchToken.length > 0) {
      const minted = mintCoreCookie(connection, auth.launchToken, req);
      if (minted !== void 0) {
        res.setHeader("set-cookie", minted);
        return true;
      }
    }
    return connection.authorizeIndex(req, res);
  };
}
function createGatewayHandler(ctx, config, store, currentIdentity) {
  const distRoot = dirname5(config.distIndex);
  const renderIndex = indexRenderer(ctx, config.distIndex);
  const authorizeIndex = createAuthorizeIndex(ctx);
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const token = extractSessionToken(req.headers.cookie);
    const session = token === void 0 ? void 0 : store.verify(token);
    if (session === void 0) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    store.cleanup();
    const rawPath = new URL(req.url ?? "/", "http://x").pathname;
    const render = config.uiRoleGate && !session.isAdmin ? async () => {
      let currentSession2 = session;
      if (currentIdentity !== void 0) {
        const identity = await currentIdentity(session.user);
        store.updatePermissionsForUser(session.user, identity?.permissions ?? []);
        currentSession2 = store.verify(token) ?? { ...session, permissions: [] };
      }
      return applyUiGate(await renderIndex(), {
        isAdmin: currentSession2.isAdmin,
        permissions: currentSession2.permissions
      });
    } : renderIndex;
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      config.distIndex,
      () => authorizeIndex(req, res),
      render
    );
  };
}

// src/bridge-list-filter.ts
function extractSessionItems(value) {
  const items = envelopeValue(value);
  if (items === void 0) return void 0;
  const record = items;
  if (!Array.isArray(record.items)) return void 0;
  const headers = [];
  for (const item of record.items) {
    if (typeof item !== "object" || item === null) return void 0;
    const sessionId = item.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") return void 0;
    const parentSessionId = item.parentSessionId;
    headers.push(
      typeof parentSessionId === "string" && parentSessionId !== "" ? { sessionId, parentSessionId } : { sessionId }
    );
  }
  return headers;
}
function envelopeValue(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const result = value.result;
  if (typeof result !== "object" || result === null) return value;
  const record = result;
  return record.ok === true ? record.value : void 0;
}
function ownedSessionClosure(username, items, ownership) {
  const owned = /* @__PURE__ */ new Set();
  for (const [sid, owner] of ownership.entries()) {
    if (owner === username) owned.add(sid);
  }
  const byParent = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (item.parentSessionId === void 0) continue;
    const list = byParent.get(item.parentSessionId);
    if (list === void 0) byParent.set(item.parentSessionId, [item.sessionId]);
    else list.push(item.sessionId);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const sid of [...owned]) {
      for (const child of byParent.get(sid) ?? []) {
        if (!owned.has(child)) {
          owned.add(child);
          ownership.record(child, username);
          grew = true;
        }
      }
    }
  }
  return owned;
}
async function probeOwnedSessionIds(username, ownership, gateway) {
  let items = [];
  if (gateway !== void 0) {
    try {
      const value = await gateway.invoke({ namespace: "session", method: "list", args: {} });
      const extracted = extractSessionItems(value);
      if (extracted !== void 0) items = extracted;
    } catch {
    }
  }
  return ownedSessionClosure(username, items, ownership);
}
function filterSessionItemsValue(value, owned) {
  if (typeof value !== "object" || value === null) return void 0;
  const payload = envelopeValue(value);
  if (payload === void 0) return void 0;
  const record = payload;
  if (!Array.isArray(record.items)) return void 0;
  const items = [];
  for (const item of record.items) {
    if (typeof item !== "object" || item === null) return void 0;
    const sessionId = item.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") return void 0;
    if (owned.has(sessionId)) items.push(item);
  }
  const filtered = { ...payload, items };
  if (value.result !== void 0) {
    return { ...value, result: { ok: true, value: filtered } };
  }
  return filtered;
}
function filterWorkspaceListValue(value, owned) {
  if (typeof value !== "object" || value === null) return void 0;
  const payload = envelopeValue(value);
  if (payload === void 0) return void 0;
  const record = payload;
  if (!Array.isArray(record.items) || !Array.isArray(record.archivedSessionIds)) return void 0;
  const items = [];
  for (const workspace of record.items) {
    if (typeof workspace !== "object" || workspace === null) return void 0;
    const sessionIds = workspace.sessionIds;
    if (!Array.isArray(sessionIds)) return void 0;
    const kept = sessionIds.filter((id) => typeof id === "string" && owned.has(id));
    if (kept.length > 0) items.push({ ...workspace, sessionIds: kept });
  }
  const archivedSessionIds = record.archivedSessionIds.filter(
    (id) => typeof id === "string" && owned.has(id)
  );
  const filtered = { ...payload, items, archivedSessionIds };
  if (value.result !== void 0) {
    return { ...value, result: { ok: true, value: filtered } };
  }
  return filtered;
}
var RECORD_METHODS = /* @__PURE__ */ new Set(["session.create", "session.fork", "workspace.create"]);
var FILTER_METHODS = /* @__PURE__ */ new Set(["session.list", "session.search", "workspace.list"]);
function recordOwnershipFromResponse(envelope, username, ownership) {
  const payload = envelopeValue(envelope);
  if (typeof payload !== "object" || payload === null) return;
  const sessionId = payload.sessionId;
  const id = payload.id;
  if (typeof sessionId === "string" && sessionId !== "") {
    ownership.record(sessionId, username);
    return;
  }
  if (typeof id === "string" && id !== "") ownership.record(id, username);
  const workspace = payload.workspace;
  if (typeof workspace === "object" && workspace !== null) {
    const workspaceId = workspace.workspaceId;
    if (typeof workspaceId === "string" && workspaceId !== "") ownership.record(workspaceId, username);
  }
}

// src/api-bridge-auth.ts
var DENY_BODY_LIMIT_BYTES = 1 << 20;
function endpointFromUrl(url) {
  if (url === void 0) return void 0;
  const path = url.split("?")[0].split("#")[0];
  if (!path.startsWith("/api/")) return void 0;
  return path.slice("/api/".length).split("/").join(".");
}
function createApiBridgeAuth(deps) {
  const deny403 = (response) => {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("forbidden");
  };
  const denyQuiet = async (request, response) => {
    const rpcId = await readRequestRpcId(request);
    if (rpcId === void 0) {
      deny403(response);
      return;
    }
    const body = JSON.stringify({
      type: "server-response",
      rpcId,
      result: { ok: false, error: { code: "forbidden", message: "not permitted for this user", details: {} } }
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body))
    });
    response.end(body);
  };
  return async (request, response, next) => {
    const token = extractSessionToken(request.headers.cookie);
    const session = token === void 0 ? void 0 : store_verify(deps, token);
    if (session === void 0) {
      response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      response.end("unauthorized");
      return;
    }
    deps.store.cleanup();
    const user = { username: session.user, isAdmin: session.isAdmin, permissions: session.permissions };
    if (request.method !== "POST") return next();
    if (user.isAdmin) {
      const adminEndpoint = endpointFromUrl(request.url);
      if (adminEndpoint !== void 0 && RECORD_METHODS.has(adminEndpoint)) {
        attachResponseTee(response, {
          endpoint: adminEndpoint,
          username: user.username,
          ownership: deps.ownership,
          owned: void 0
        });
      }
      return next();
    }
    if (deps.provisioner !== void 0) {
      void deps.provisioner.ensure({ username: user.username, isAdmin: user.isAdmin }).catch(() => {
      });
    }
    const endpoint = endpointFromUrl(request.url);
    if (endpoint === void 0) return next();
    if (!canUseWireMethod(endpoint, user)) {
      if (!isKnownWireMethod(endpoint)) {
        try {
          deps.onUnknownMethod?.(endpoint, user.username);
        } catch {
        }
      }
      if (deps.quietDenials) {
        await denyQuiet(request, response);
        return;
      }
      deny403(response);
      return;
    }
    if (FILTER_METHODS.has(endpoint) || RECORD_METHODS.has(endpoint)) {
      const owned = FILTER_METHODS.has(endpoint) ? await resolveOwned(deps, user.username) : void 0;
      attachResponseTee(response, {
        endpoint,
        username: user.username,
        ownership: deps.ownership,
        owned
      });
    }
    return next();
  };
}
function store_verify(deps, token) {
  return deps.store.verify(token);
}
async function resolveOwned(deps, username) {
  if (deps.ownedProvider === void 0) return void 0;
  try {
    return await deps.ownedProvider(username);
  } catch {
    return void 0;
  }
}
async function readRequestRpcId(request) {
  try {
    const chunks = [];
    let size = 0;
    request.setEncoding?.("utf8");
    for await (const chunk of request) {
      const piece = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += piece.length;
      if (size > DENY_BODY_LIMIT_BYTES) return void 0;
      chunks.push(piece);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed.type !== "client-request" || typeof parsed.rpcId !== "string" || parsed.rpcId === "") {
      return void 0;
    }
    return parsed.rpcId;
  } catch {
    return void 0;
  }
}
function attachResponseTee(response, context) {
  const raw = response;
  const rawWriteHead = raw.writeHead.bind(response);
  const rawSetHeader = raw.setHeader.bind(response);
  const rawWrite = raw.write.bind(response);
  const rawEnd = raw.end.bind(response);
  const headers = {};
  let status;
  let statusMessage;
  const chunks = [];
  let finalCallback;
  let flushed = false;
  const captureHeader = (name2, value) => {
    headers[String(name2).toLowerCase()] = value;
  };
  response.setHeader = function(name2, value) {
    captureHeader(name2, value);
    return this;
  };
  response.writeHead = function(...args) {
    const first = args[0];
    if (typeof first === "number") status = first;
    for (const arg of args.slice(1)) {
      if (typeof arg === "string" && statusMessage === void 0 && status !== void 0 && args.length === 2) {
        statusMessage = arg;
        continue;
      }
      if (typeof arg === "object" && arg !== null) {
        for (const [key, value] of Object.entries(arg)) {
          captureHeader(key, value);
        }
      }
    }
    return this;
  };
  response.write = function(...args) {
    captureChunk(args);
    return true;
  };
  response.end = function(...args) {
    captureChunk(args);
    flush();
    return this;
  };
  function captureChunk(args) {
    let cb;
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const arg = args[index];
      if (typeof arg === "function") {
        cb = arg;
        continue;
      }
      if (arg !== void 0 && arg !== null && arg !== 0) break;
    }
    const first = args[0];
    if (typeof first === "string" || first instanceof Buffer || first instanceof Uint8Array) {
      const encoding = typeof args[1] === "string" ? args[1] : "utf8";
      const data = first instanceof Buffer ? first : Buffer.from(first, encoding);
      chunks.push({ data, cb });
    } else if (cb !== void 0 && chunks.length > 0) {
      chunks[chunks.length - 1].cb = cb;
    } else if (cb !== void 0) {
      finalCallback = cb;
    }
  }
  function flush() {
    if (flushed) return;
    flushed = true;
    const original = Buffer.concat(chunks.map((chunk) => chunk.data));
    let body = original;
    let replayHeaders = true;
    try {
      if (status === 200 && isJsonBody(headers)) {
        const parsed = JSON.parse(original.toString("utf8"));
        if (FILTER_METHODS.has(context.endpoint)) {
          if (context.owned !== void 0) {
            const filtered = context.endpoint === "workspace.list" ? filterWorkspaceListValue(parsed, context.owned) : filterSessionItemsValue(parsed, context.owned);
            if (filtered !== void 0) body = Buffer.from(JSON.stringify(filtered), "utf8");
          }
        } else {
          recordOwnershipFromResponse(parsed, context.username, context.ownership);
        }
      }
    } catch {
    }
    void replayHeaders;
    if (!response.headersSent) {
      const outgoing = {};
      for (const [key, value] of Object.entries(headers)) {
        if (value !== void 0) outgoing[key] = value;
      }
      if (status !== void 0 || chunks.length > 0) {
        outgoing["content-length"] = String(body.length);
        delete outgoing["transfer-encoding"];
      }
      rawWriteHead(status ?? 200, statusMessage ?? "", outgoing);
    }
    if (body !== original) {
      const last = chunks[chunks.length - 1];
      if (last?.cb !== void 0) rawWrite(body, last.cb);
      else rawWrite(body);
    } else {
      for (const chunk of chunks) {
        if (chunk.cb !== void 0) {
          rawWrite(chunk.data, chunk.cb);
        } else {
          rawWrite(chunk.data);
        }
      }
    }
    if (finalCallback !== void 0) rawEnd(finalCallback);
    else rawEnd();
  }
}
function isJsonBody(headers) {
  const type = headers["content-type"];
  return typeof type === "string" && type.includes("application/json");
}

// src/remote-guard.ts
var ADMIN_ONLY_NAMESPACES = /* @__PURE__ */ new Set([
  "credentials",
  "settings",
  "agentPresets",
  // DSH 0.1.6-alpha.2: the native plugin manager installs, enables, disables,
  // and removes profile bundles — never reachable by an ordinary user.
  "pluginManager",
  // DSH 0.1.7-alpha.2: the account controller (`namespace: 'account'`) drives
  // the process-wide upstream DeepSeek Platform grant — startSignIn/signOut/
  // cancelSignIn rebind or revoke THE instance's account — and even the read
  // projections (getState/getProfile/getBalance) expose the operator's
  // profile and recharge-wallet balance. Entire namespace is admin-only;
  // ordinary users are denied by default (absent from USER_ALLOWED), this is
  // defense-in-depth, and capabilities.ts mirrors it in the two-segment deny
  // list and the quiet-deny set.
  "account",
  // DSH 0.2.1-alpha.4: the plugin market (`namespace: 'pluginMarket'`) reads
  // and WRITES the instance-wide market index list — `setIndexes` reconfigures
  // which registries every install resolves against — and the same posture as
  // pluginManager applies. Ordinary users are denied by default (absent from
  // USER_ALLOWED), this is defense-in-depth, and capabilities.ts mirrors it in
  // the two-segment deny list and the quiet-deny set.
  "pluginMarket",
  // DSH 0.2.1-rc.2 (dsh-login 0.3.6, issue #4): namespaces the real wire
  // registry carries that the pre-rename allow-list never mentioned. Their
  // methods are admin-only by construction (and already absent from
  // USER_ALLOWED); listing the namespaces keeps this seam explicit so a future
  // USER_ALLOWED edit cannot quietly open host-side code execution
  // (`dynamicCordisRunner` runs plugin code on the host, `claudeCodeMods`
  // toggles host integrations, `pluginInventory` enumerates the host plugin
  // tree, `pluginRegistryProbe` is the plugin manager's probe).
  "pluginInventory",
  "pluginRegistryProbe",
  "dynamicCordisRunner",
  "claudeCodeMods"
]);
var GUARDED_ID_FIELDS = [
  "sessionId",
  "sessionIds",
  "parentSessionId",
  "parentSessionIds",
  "childSessionId",
  "childSessionIds",
  "agentId",
  "workspaceId",
  "beforeSessionId",
  // DSH 0.1.6-alpha.2: the scoped session identity the Gateway's
  // workspaceFileScope lookup resolves for the document-preview surface
  // (`workspaceFiles.*`, `officeToPdf.render`) — carries a SessionId on the
  // wire exactly like `sessionId`.
  "workspaceFileScopeId"
];
function collectIds(value) {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (typeof value === "object" && value !== null) {
    const record = value;
    for (const key of ["id", "sessionId", "sessionIds", "agentId", "workspaceId"]) {
      const nested = record[key];
      if (nested !== void 0) return collectIds(nested);
    }
    for (const [k, v] of Object.entries(record)) {
      if (GUARDED_ID_FIELDS.includes(k)) {
        return collectIds(v);
      }
    }
  }
  return [];
}
function forbidden(namespace, method) {
  return Object.assign(new Error(`dsh-login: forbidden: ${namespace}.${method}`), { code: "forbidden" });
}
function wrapRemoteGateway(gateway, resolveUser, owns = () => false) {
  const allowed = (user, namespace, method) => {
    if (user.isAdmin) return true;
    const endpoint = `${namespace}.${method}`;
    if (ADMIN_ONLY_NAMESPACES.has(namespace) && permissionForWireMethod(endpoint) === void 0) return false;
    return canUseWireMethod(endpoint, user);
  };
  const ownershipGuarded = (user, request) => {
    if (user.isAdmin) return true;
    for (const field of GUARDED_ID_FIELDS) {
      for (const id of collectIds(request.args[field])) {
        if (id !== "" && !owns(id)) return false;
      }
    }
    return true;
  };
  const refuse = (user, request) => user === void 0 || !allowed(user, request.namespace, request.method) || !ownershipGuarded(user, request);
  return {
    // Forward every non-dispatch member of the live gateway unchanged
    // (e.g. DSH 0.2.0-rc.2's `hasLiveClient()`), then override the two
    // dispatch methods with the guarded implementations.
    ...gateway,
    async invoke(request) {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method);
      return gateway.invoke(request);
    },
    async stream(request) {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method);
      return gateway.stream(request);
    }
  };
}
function createRemoteIsolation(options) {
  const resolveUser = () => {
    const sid = options.currentSessionId();
    if (sid === void 0) return void 0;
    const adminUser = options.isAdminSession?.(sid);
    if (adminUser !== void 0 && adminUser !== "") {
      return { username: adminUser, isAdmin: true };
    }
    const username = options.ownership.lookup(sid);
    if (username === void 0 || username === "") return void 0;
    const permissions = options.permissions?.(username);
    return {
      username,
      isAdmin: options.isAdmin?.(username) ?? false,
      ...permissions === void 0 ? {} : { permissions }
    };
  };
  const owns = (id) => {
    const user = resolveUser();
    if (user === void 0) return false;
    if (user.isAdmin) return true;
    return options.ownership.lookup(id) === user.username;
  };
  return { resolveUser, owns };
}

// src/dispatch-guard.ts
var REMOTE_EVENT_STREAM_ENDPOINT = "$events";
var REMOTE_EVENT_RESULT_ENDPOINT = "$events/result";
var WORKSPACE_FOLLOW_ENDPOINT = "workspace/follow";
var WRAPPER_CACHE_LIMIT = 1024;
var PEER_USER = /* @__PURE__ */ Symbol("dsh-login.peer-user");
function deniedRpc() {
  return { ok: false, error: { code: "forbidden", message: "not permitted for this user", details: {} } };
}
function deniedStreamError(endpoint) {
  return Object.assign(new Error(`dsh-login: forbidden stream: ${endpoint}`), { code: "forbidden" });
}
function peerUser(peer) {
  if (typeof peer !== "object" || peer === null) return void 0;
  const tagged = peer;
  const user = tagged[PEER_USER];
  if (typeof user !== "object" || user === null) return void 0;
  const username = user.username;
  if (typeof username !== "string" || username === "") return void 0;
  const permissions = Array.isArray(user.permissions) ? user.permissions.filter((permission) => typeof permission === "string") : [];
  return { username, isAdmin: user.isAdmin === true, permissions };
}
function installAdmitShadow(connection, deps, warn) {
  const target = connection;
  if (typeof target.admit !== "function") {
    warn("dsh-login: stream guard skipped \u2014 connection service has no admit(request) surface");
    return () => {
    };
  }
  const original = target.admit;
  const hadOwnAdmit = Object.prototype.hasOwnProperty.call(target, "admit");
  const browserPeer = target.browserPeer;
  const wrappers = /* @__PURE__ */ new Map();
  const shadow = function admit(request) {
    const admission = original.call(this, request);
    if (typeof admission !== "object" || admission === null) return admission;
    if (admission.peer === void 0 || admission.peer === null) return admission;
    const isBrowser = browserPeer !== void 0 && admission.peer === browserPeer;
    const token = extractSessionToken(request.headers?.cookie);
    if (token !== void 0) {
      const session = deps.store.verify(token);
      if (session !== void 0) {
        return {
          ...admission,
          peer: wrapTagged(admission.peer, {
            username: session.user,
            isAdmin: session.isAdmin,
            permissions: session.permissions
          }, token, wrappers)
        };
      }
    }
    return isBrowser ? { rejection: 401 } : admission;
  };
  target.admit = shadow;
  return () => {
    if (target.admit !== shadow) return;
    if (hadOwnAdmit) target.admit = original;
    else delete target.admit;
  };
}
function wrapTagged(peer, user, token, cache) {
  const key = `${peer.id}|${token}`;
  const existing = cache.get(key);
  if (existing !== void 0) return existing;
  const wrapper = Object.create(peer);
  Object.defineProperty(wrapper, PEER_USER, { value: user, enumerable: false, writable: false, configurable: false });
  cache.set(key, wrapper);
  if (cache.size > WRAPPER_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return wrapper;
}
function installDispatchShadows(gateway, deps, warn) {
  if (gateway === void 0) {
    warn("dsh-login: stream guard skipped \u2014 typertGateway service is unavailable");
    return () => {
    };
  }
  const target = gateway;
  const uninstalls = [];
  if (typeof target.dispatchRpc === "function") {
    uninstalls.push(shadowRpc(target, deps, warn));
  } else {
    warn("dsh-login: stream guard skipped \u2014 gateway service has no dispatchRpc surface");
  }
  if (typeof target.openWireStream === "function") {
    uninstalls.push(shadowStream(target, deps, warn));
  } else {
    warn("dsh-login: stream guard skipped \u2014 gateway service has no openWireStream surface (streaming methods stay unguarded)");
  }
  return () => {
    for (const uninstall of uninstalls) uninstall();
  };
}
function shadowRpc(target, deps, warn) {
  const original = target.dispatchRpc;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, "dispatchRpc");
  const warnedUnknown = /* @__PURE__ */ new Set();
  const shadow = function dispatchRpc(...args) {
    if (dispatchVerdict(args[0], args[1], args[3], deps, warnedUnknown, warn) === "deny") return deniedRpc();
    return original.apply(this, args);
  };
  target.dispatchRpc = shadow;
  return () => {
    if (target.dispatchRpc !== shadow) return;
    if (hadOwn) target.dispatchRpc = original;
    else delete target.dispatchRpc;
  };
}
function shadowStream(target, deps, warn) {
  const original = target.openWireStream;
  const hadOwn = Object.prototype.hasOwnProperty.call(target, "openWireStream");
  const warnedUnknown = /* @__PURE__ */ new Set();
  const shadow = async function openWireStream(...args) {
    const endpoint = args[0];
    if (dispatchVerdict(endpoint, args[1], args[3], deps, warnedUnknown, warn) === "deny") {
      throw deniedStreamError(typeof endpoint === "string" ? endpoint : "stream");
    }
    const result = await original.apply(this, args);
    if (endpoint === WORKSPACE_FOLLOW_ENDPOINT) {
      return wrapFollowSource(result, args[3], deps, warn);
    }
    return result;
  };
  target.openWireStream = shadow;
  return () => {
    if (target.openWireStream !== shadow) return;
    if (hadOwn) target.openWireStream = original;
    else delete target.openWireStream;
  };
}
function dispatchVerdict(endpoint, payload, peer, deps, warnedUnknown, warn) {
  const user = peerUser(peer);
  if (user === void 0) return "pass";
  if (user.isAdmin) return "pass";
  if (typeof endpoint !== "string" || endpoint === "") return "pass";
  if (endpoint === REMOTE_EVENT_STREAM_ENDPOINT || endpoint === REMOTE_EVENT_RESULT_ENDPOINT) return "pass";
  const parts = endpoint.split("/");
  if (parts.length !== 2) return "pass";
  const dotted = `${parts[0]}.${parts[1]}`;
  const classification = classifyWireMethod(dotted);
  if (!canUseWireMethod(dotted, user)) {
    if (classification === "unknown" && !warnedUnknown.has(dotted)) {
      warnedUnknown.add(dotted);
      warn(`dsh-login: stream guard denied unknown wire method '${dotted}' \u2014 upstream may have renamed it; refresh src/api-filter.ts`);
    }
    return "deny";
  }
  const args = readDispatchArgs(payload);
  for (const id of guardedIds(args)) {
    if (deps.ownership.lookup(id) !== user.username) return "deny";
  }
  return "pass";
}
function readDispatchArgs(payload) {
  if (typeof payload !== "object" || payload === null) return void 0;
  return payload.args;
}
function guardedIds(args) {
  if (typeof args !== "object" || args === null) return [];
  const ids = [];
  for (const [key, value] of Object.entries(args)) {
    if (!GUARDED_ID_FIELDS.includes(key)) continue;
    for (const id of collectIds(value)) ids.push(id);
  }
  return ids;
}
function wrapFollowSource(source, peer, deps, warn) {
  const user = peerUser(peer);
  if (user === void 0 || user.isAdmin) return source;
  if (typeof source !== "object" || source === null) return source;
  if (typeof source[Symbol.asyncIterator] !== "function") {
    warn("dsh-login: workspace.follow guard skipped \u2014 upstream stream handle is not async-iterable");
    return source;
  }
  return filterWorkspaceFollowFrames(source, deps, user);
}
async function* filterWorkspaceFollowFrames(source, deps, user) {
  const model = /* @__PURE__ */ new Map();
  const delivered = /* @__PURE__ */ new Set();
  let order = [];
  let archived = [];
  let pinned = [];
  const stringList = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry !== "") : [];
  const ownsWorkspace = (item, owned) => {
    const workspaceId = item.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId === "") return false;
    if (deps.ownership.lookup(workspaceId) === user.username) return true;
    for (const sessionId of stringList(item.sessionIds)) {
      if (owned.has(sessionId)) return true;
    }
    return false;
  };
  const narrowItem = (item, owned) => ({
    ...item,
    sessionIds: stringList(item.sessionIds).filter((sessionId) => owned.has(sessionId))
  });
  const filteredBaseline = (owned) => {
    const ids = order.length > 0 ? order : [...model.keys()];
    const items = [];
    for (const id of ids) {
      const item = model.get(id);
      if (item !== void 0 && ownsWorkspace(item, owned)) items.push(narrowItem(item, owned));
    }
    return {
      type: "replace",
      value: {
        items,
        archivedSessionIds: archived.filter((sessionId) => owned.has(sessionId)),
        pinnedSessionIds: pinned.filter((sessionId) => owned.has(sessionId))
      }
    };
  };
  const visibleId = (id, owned) => {
    const item = model.get(id);
    return item !== void 0 && ownsWorkspace(item, owned);
  };
  for await (const raw of source) {
    if (typeof raw !== "object" || raw === null) continue;
    const frame = raw;
    const owned = await probeOwnedSessionIds(user.username, deps.ownership, deps.sessionSource());
    switch (frame.type) {
      case "baseline":
      case "replace": {
        const value = frame.value;
        if (typeof value !== "object" || value === null || !Array.isArray(value.items)) continue;
        const baseline = value;
        model.clear();
        delivered.clear();
        archived = stringList(baseline.archivedSessionIds);
        pinned = stringList(baseline.pinnedSessionIds);
        const items = [];
        for (const entry of baseline.items) {
          if (typeof entry !== "object" || entry === null) continue;
          const item = entry;
          const workspaceId = item.workspaceId;
          if (typeof workspaceId !== "string" || workspaceId === "") continue;
          model.set(workspaceId, item);
          if (ownsWorkspace(item, owned)) {
            delivered.add(workspaceId);
            items.push(narrowItem(item, owned));
          }
        }
        yield {
          type: frame.type,
          value: {
            ...baseline,
            items,
            archivedSessionIds: archived.filter((sessionId) => owned.has(sessionId)),
            pinnedSessionIds: pinned.filter((sessionId) => owned.has(sessionId))
          }
        };
        break;
      }
      case "upsert": {
        const workspace = frame.workspace;
        if (typeof workspace !== "object" || workspace === null) continue;
        const item = workspace;
        const workspaceId = item.workspaceId;
        if (typeof workspaceId !== "string" || workspaceId === "") continue;
        model.set(workspaceId, item);
        if (ownsWorkspace(item, owned)) {
          delivered.add(workspaceId);
          yield { type: "upsert", workspace: narrowItem(item, owned) };
        } else if (delivered.has(workspaceId)) {
          delivered.delete(workspaceId);
          yield filteredBaseline(owned);
        }
        break;
      }
      case "remove": {
        const workspaceId = frame.workspaceId;
        if (typeof workspaceId !== "string" || workspaceId === "") continue;
        model.delete(workspaceId);
        if (delivered.delete(workspaceId)) yield frame;
        break;
      }
      case "order": {
        order = stringList(frame.workspaceIds);
        if (delivered.size === 0) break;
        let lost = false;
        for (const id of delivered) {
          if (!visibleId(id, owned)) {
            lost = true;
            break;
          }
        }
        if (lost) {
          yield filteredBaseline(owned);
          break;
        }
        const ids = order.length > 0 ? order : [...model.keys()];
        yield { type: "order", workspaceIds: ids.filter((id) => visibleId(id, owned)) };
        break;
      }
      case "archived": {
        archived = stringList(frame.archivedSessionIds);
        yield { type: "archived", archivedSessionIds: archived.filter((sessionId) => owned.has(sessionId)) };
        break;
      }
      case "pinned": {
        pinned = stringList(frame.pinnedSessionIds);
        yield { type: "pinned", pinnedSessionIds: pinned.filter((sessionId) => owned.has(sessionId)) };
        break;
      }
      default:
        continue;
    }
  }
}

// src/provision.ts
import { mkdir as mkdir5 } from "node:fs/promises";
import { join as join2 } from "node:path";
function sandboxSegment(username) {
  return username.split(/[/\\]/).join("_").replace(/\.\.+/g, "_").replace(/^\.+/, "_").replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "user";
}
var DefaultWorkspaceProvisioner = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  done = /* @__PURE__ */ new Set();
  /** Workspaces already registered but not yet seeded with a session, by username. */
  pending = /* @__PURE__ */ new Map();
  /**
   * Ensure `user` has a default workspace+sandbox. A no-op for admins and
   * for users already provisioned this run; skipped (without marking done)
   * while the toggle is off or no registry is resolvable yet.
   * Best-effort: any error is swallowed so the triggering request survives;
   * a partially completed provisioning (workspace created, session seed
   * failed) stays pending and retries only the missing half.
   */
  async ensure(user) {
    if (user.isAdmin) return;
    if (this.deps.enabled !== void 0 && !this.deps.enabled()) {
      this.done.delete(user.username);
      return;
    }
    if (this.done.has(user.username)) return;
    const registry = this.deps.workspaceRegistry ?? this.deps.getRegistry?.();
    if (registry === void 0) return;
    this.done.add(user.username);
    try {
      await this.provision(user.username, registry);
    } catch {
      this.done.delete(user.username);
    }
  }
  async provision(username, registry) {
    let workspaceId = this.pending.get(username);
    if (workspaceId === void 0) {
      const dir = join2(this.deps.workspaceRoot, sandboxSegment(username));
      await mkdir5(dir, { recursive: true });
      const workspace = await registry.create(dir, this.deps.title ?? username);
      workspaceId = workspace.id;
      this.pending.set(username, workspaceId);
    }
    this.deps.ownership.record(workspaceId, username);
    const api = this.deps.getApi();
    const create = api?.sessions?.create;
    if (create === void 0) {
      throw new Error("dsh-login: no session.create adapter available for default-workspace provisioning");
    }
    const res = await create({ rpcId: "dsh-login-default-workspace", payload: { workspaceId } });
    if (res?.result?.ok !== true || typeof res.result.value?.sessionId !== "string") {
      throw new Error("dsh-login: session.create returned no usable sessionId for default-workspace provisioning");
    }
    this.deps.ownership.record(res.result.value.sessionId, username);
    this.pending.delete(username);
  }
};

// src/host-session-access.ts
function tryGetService(ctx, key) {
  try {
    const get = ctx.get;
    return get.call(ctx, key);
  } catch {
    return void 0;
  }
}
function extractSessionId(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const direct = value.sessionId;
  if (typeof direct === "string" && direct !== "") return direct;
  for (const level of [value.value, envelopeValue(value)]) {
    if (typeof level !== "object" || level === null) continue;
    const sessionId = level.sessionId;
    if (typeof sessionId === "string" && sessionId !== "") return sessionId;
  }
  return void 0;
}
async function createSessionValue(ctx, payload) {
  const controller = tryGetService(ctx, "sessionController");
  if (typeof controller?.create === "function") {
    return controller.create(payload);
  }
  const gateway = tryGetService(ctx, "typertGateway");
  if (typeof gateway?.invoke === "function") {
    return gateway.invoke({ namespace: "session", method: "create", args: payload });
  }
  throw new Error("dsh-login: neither sessionController nor typertGateway is available for session.create");
}
function createHostSessionApi(ctx) {
  return () => ({
    sessions: {
      create: async (request) => {
        const value = await createSessionValue(ctx, request.payload);
        const sessionId = extractSessionId(value);
        if (sessionId === void 0) {
          throw new Error("dsh-login: session.create returned no sessionId");
        }
        return { result: { ok: true, value: { sessionId } } };
      }
    }
  });
}
function createHostSessionSource(ctx) {
  return {
    async invoke() {
      const controller = tryGetService(ctx, "sessionController");
      if (typeof controller?.list === "function") {
        return controller.list({}, new AbortController().signal);
      }
      const gateway = tryGetService(ctx, "typertGateway");
      if (typeof gateway?.invoke === "function") {
        return gateway.invoke({ namespace: "session", method: "list", args: {} });
      }
      throw new Error("dsh-login: neither sessionController nor typertGateway is available for session.list");
    }
  };
}

// src/login-page.ts
function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u767B\u5F55 DSH</title><body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:24px;color:#172033"><h1>\u767B\u5F55 DSH</h1><p>\u4F7F\u7528 Admin \u8D26\u53F7\u7EE7\u7EED\u3002</p><p style="display:flex;flex-wrap:wrap;gap:12px"><a href="/api/auth/login" style="display:inline-block;padding:12px 20px;background:#2458d3;color:white;text-decoration:none;border-radius:6px">\u5FEB\u6377\u767B\u5F55</a><a href="/api/auth/login?mode=password" style="display:inline-block;padding:12px 20px;border:1px solid #2458d3;color:#2458d3;text-decoration:none;border-radius:6px">\u8D26\u53F7\u5BC6\u7801\u767B\u5F55</a></p><p style="font-size:14px;color:#667085">\u8D26\u53F7\u5BC6\u7801\u767B\u5F55\u4F1A\u6253\u5F00 Admin \u767B\u5F55\u9875\uFF0C\u767B\u5F55\u6210\u529F\u540E\u81EA\u52A8\u8FD4\u56DE DSH\u3002</p></body></html>`;
}

// src/admin-sso.ts
import { randomBytes as randomBytes2 } from "node:crypto";
var SSO_NONCE_COOKIE_PREFIX = "dsh_sso_nonce_";
function createAdminSso(config, sessions) {
  const tokens = /* @__PURE__ */ new Map();
  const refreshes = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const loginListeners = /* @__PURE__ */ new Set();
  const logoutListeners = /* @__PURE__ */ new Set();
  const refreshAccessToken = async (userId) => (await refreshUserToken(userId)).accessToken;
  const refreshUserToken = async (userId) => {
    const existing = tokens.get(userId);
    if (!existing || existing.refreshExpiresAt <= Date.now()) throw new Error("Admin login required");
    const inFlight = refreshes.get(userId);
    if (inFlight) return await inFlight;
    const refresh = postJson(`${config.adminBaseUrl}/sso/refresh`, {
      refresh_token: existing.refreshToken,
      client_id: config.clientId
    }).then((response) => {
      const next = toTokenSet(response, normalizeIdentity(response.user ?? existing.identity));
      tokens.set(userId, next);
      sessions.updatePermissionsForUser(userId, next.identity.permissions);
      return next;
    }).catch(async (error) => {
      tokens.delete(userId);
      sessions.revokeAllFor(userId);
      for (const listener of logoutListeners) await Promise.resolve(listener(userId)).catch(() => void 0);
      throw error;
    }).finally(() => refreshes.delete(userId));
    refreshes.set(userId, refresh);
    return await refresh;
  };
  const accessToken = async (userId) => {
    const current = tokens.get(userId);
    if (!current || current.refreshExpiresAt <= Date.now()) throw new Error("Admin login required");
    if (current.expiresAt <= Date.now() + 3e4) return await refreshAccessToken(userId);
    return current.accessToken;
  };
  const userInfo = async (userId) => {
    try {
      const identity = normalizeIdentity(await postOrGetJson(
        `${config.adminBaseUrl}/sso/userinfo`,
        await accessToken(userId)
      ));
      sessions.updatePermissionsForUser(userId, identity.permissions);
      return identity;
    } catch {
      return void 0;
    }
  };
  const logout = async (sessionToken) => {
    if (!sessionToken) return;
    const session = sessions.verify(sessionToken);
    if (!session) return;
    const tokenSet = tokens.get(session.user);
    sessions.revokeAllFor(session.user);
    for (const listener of logoutListeners) await Promise.resolve(listener(session.user)).catch(() => void 0);
    if (tokenSet) {
      tokens.delete(session.user);
      await fetch(`${config.adminBaseUrl}/sso/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenSet.accessToken}` },
        body: JSON.stringify({ refresh_token: tokenSet.refreshToken })
      }).catch(() => void 0);
    }
  };
  const loginRoute = {
    kind: "exact",
    path: "/api/auth/login",
    handler: async (request, response) => {
      const now = Date.now();
      for (const [pendingState, grant] of pending) if (grant.expiresAt <= now) pending.delete(pendingState);
      const state = randomBytes2(32).toString("base64url");
      const browserNonce = randomBytes2(32).toString("base64url");
      const nonceCookie = `${SSO_NONCE_COOKIE_PREFIX}${state}`;
      pending.set(state, { state, browserNonce, expiresAt: Date.now() + 5 * 6e4 });
      const url = new URL(`${config.adminBaseUrl}/sso/authorize`);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.redirectUri);
      url.searchParams.set("state", state);
      const mode = new URL(request.url ?? "/", config.redirectUri).searchParams.get("mode");
      const location = mode === "password" ? buildPasswordLoginUrl(config.adminBaseUrl, url) : url.toString();
      const secure = config.redirectUri.startsWith("https://") ? "; Secure" : "";
      response.writeHead(302, {
        Location: location,
        "Set-Cookie": `${nonceCookie}=${browserNonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300${secure}`,
        "Cache-Control": "no-store"
      });
      response.end();
    }
  };
  const callbackRoute = {
    kind: "exact",
    path: new URL(config.redirectUri).pathname,
    handler: async (request, response) => {
      const url = new URL(request.url ?? "/", config.redirectUri);
      const state = url.searchParams.get("state") ?? "";
      const grant = pending.get(state);
      pending.delete(state);
      const nonceCookie = `${SSO_NONCE_COOKIE_PREFIX}${state}`;
      if (!grant || grant.expiresAt <= Date.now() || readCookie(request.headers.cookie, nonceCookie) !== grant.browserNonce) {
        sendHtml(response, 400, "\u767B\u5F55\u94FE\u63A5\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        sendHtml(response, 400, "Admin \u6388\u6743\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002");
        return;
      }
      try {
        const tokenSet = await postJson(`${config.adminBaseUrl}/sso/token`, {
          code,
          client_id: config.clientId,
          redirect_uri: config.redirectUri
        });
        if (!tokenSet.accessToken || !tokenSet.refreshToken) {
          throw new Error("invalid Admin SSO response");
        }
        const identity = normalizeIdentity(await postOrGetJson(
          `${config.adminBaseUrl}/sso/userinfo`,
          tokenSet.accessToken
        ));
        if (identity?.userId === void 0 || !identity.username || tokenSet.user?.userId !== void 0 && String(tokenSet.user.userId) !== String(identity.userId)) {
          throw new Error("invalid Admin SSO identity");
        }
        const userId = String(identity.userId);
        tokens.set(userId, toTokenSet(tokenSet, identity));
        const session = sessions.create(userId, false, identity.permissions);
        if (config.autoTrustHosts && typeof request.headers.host === "string") config.hosts.learn(request.headers.host);
        const secure = config.redirectUri.startsWith("https://") ? "; Secure" : "";
        response.setHeader("Set-Cookie", [
          `dsh_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtl}${secure}`,
          `${nonceCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
        ]);
        for (const listener of loginListeners) void Promise.resolve(listener(userId)).catch(() => void 0);
        response.writeHead(302, {
          Location: `/?dsh_login=${Date.now().toString(36)}`,
          "Cache-Control": "no-store"
        });
        response.end();
      } catch {
        sendHtml(response, 502, "\u65E0\u6CD5\u8FDE\u63A5 Admin \u5B8C\u6210\u767B\u5F55\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      }
    }
  };
  const meRoute = { kind: "exact", path: "/api/auth/me", handler: async (request, response) => {
    const session = currentSession(request.headers.cookie, sessions);
    if (!session) return sendJson(response, 401, { error: "unauthorized" });
    const identity = await userInfo(session.user);
    if (!identity) return sendJson(response, 401, { error: "unauthorized" });
    sendJson(response, 200, { ...identity, isAdmin: false });
  } };
  const capabilitiesRoute = { kind: "exact", path: "/api/auth/capabilities", handler: async (request, response) => {
    const session = currentSession(request.headers.cookie, sessions);
    if (!session) return sendJson(response, 401, { error: "unauthorized" });
    const identity = await userInfo(session.user);
    if (!identity) return sendJson(response, 401, { error: "unauthorized" });
    sendJson(response, 200, {
      capabilities: deriveCapabilities({
        username: identity.username,
        isAdmin: false,
        permissions: identity.permissions
      })
    });
  } };
  const logoutRoute = { kind: "exact", path: "/api/auth/logout", handler: async (request, response) => {
    if (request.headers.origin !== new URL(config.redirectUri).origin) {
      response.writeHead(403, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const token = extractSessionToken(request.headers.cookie);
    if (token) await logout(token);
    response.setHeader("Set-Cookie", buildClearCookieHeader());
    response.writeHead(200, { "Cache-Control": "no-store" });
    response.end();
  } };
  return {
    routes: [loginRoute, callbackRoute, meRoute, capabilitiesRoute, logoutRoute],
    accessToken,
    refreshAccessToken,
    isUserAuthenticated: (userId) => sessions.hasUser(userId),
    userInfo,
    logout,
    async currentUser(cookie) {
      const session = currentSession(cookie, sessions);
      return session ? await userInfo(session.user) : void 0;
    },
    onLogin(listener) {
      loginListeners.add(listener);
      return () => loginListeners.delete(listener);
    },
    onLogout(listener) {
      logoutListeners.add(listener);
      return () => logoutListeners.delete(listener);
    },
    clear() {
      pending.clear();
      tokens.clear();
      refreshes.clear();
      loginListeners.clear();
      logoutListeners.clear();
    }
  };
}
function buildPasswordLoginUrl(adminBaseUrl, authorizeUrl) {
  const loginUrl = new URL(`${adminBaseUrl.replace(/\/+$/, "")}/login`);
  loginUrl.searchParams.set("mode", "password");
  loginUrl.searchParams.set("redirect", `${authorizeUrl.pathname}${authorizeUrl.search}`);
  return loginUrl.toString();
}
function currentSession(cookie, sessions) {
  const token = extractSessionToken(cookie);
  return token ? sessions.verify(token) : void 0;
}
function normalizeIdentity(identity) {
  return {
    ...identity,
    roles: Array.isArray(identity.roles) ? identity.roles : [],
    permissions: Array.isArray(identity.permissions) ? [...new Set(identity.permissions.filter((permission) => typeof permission === "string"))] : []
  };
}
function readCookie(cookieHeader, name2) {
  if (typeof cookieHeader !== "string") return void 0;
  for (const part of cookieHeader.split(";")) {
    const item = part.trim();
    if (item.startsWith(`${name2}=`)) return item.slice(name2.length + 1);
  }
  return void 0;
}
function toTokenSet(response, identity) {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: Date.now() + response.expiresIn * 1e3,
    refreshExpiresAt: Date.now() + response.refreshExpiresIn * 1e3,
    identity
  };
}
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Admin SSO request failed (${response.status})`);
  return unwrapData(await response.json());
}
async function postOrGetJson(url, accessToken) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Admin SSO request failed (${response.status})`);
  return unwrapData(await response.json());
}
function unwrapData(value) {
  if (typeof value !== "object" || value === null) return value;
  const response = value;
  return response.data !== void 0 && response.accessToken === void 0 ? response.data : value;
}
function sendHtml(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer"
  });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Admin \u767B\u5F55</title><body style="font:16px system-ui;max-width:640px;margin:64px auto;padding:0 20px"><p>${message}</p><a href="/login">\u8FD4\u56DE\u767B\u5F55</a></body></html>`);
}
function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

// src/web-runtime.ts
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
var ALL_INTERFACES_HOST = "0.0.0.0";
function resolveLanTrust(bindHost, extra) {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => iface.address) : [];
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] };
}
function resolveDistIndex() {
  const require2 = createRequire(import.meta.url);
  try {
    return require2.resolve("@deepseek-ai/dsh-web-frontend/dist/index.html");
  } catch {
    throw new Error("dsh-login: frontend dist not found; run pnpm run build from the deepseek-harness repository root first, or set config.distIndex explicitly");
  }
}
var DSH_WEB_URL = "DSH_WEB_URL";
var LOOPBACK_HOST = "127.0.0.1";
function urlHost(bindHost) {
  return bindHost === ALL_INTERFACES_HOST ? LOOPBACK_HOST : bindHost;
}
function printWebUrl(ctx, runtime) {
  const print = () => {
    const webServer = ctx.get("webServer");
    if (webServer === void 0) return;
    const host = urlHost(webServer.host);
    const lanCandidate = runtime.lanAddresses[0];
    const suffix = lanCandidate === void 0 ? "" : ` (LAN: http://${lanCandidate}:${String(webServer.port)})`;
    console.log(`dsh web: http://${host}:${String(webServer.port)}${suffix}`);
  };
  const settled = ctx.get("loader")?.await();
  if (settled === void 0) print();
  else void settled.then(() => print(), () => {
  });
}
function advertisedUrl(ctx) {
  const webServer = ctx.get("webServer");
  if (webServer === void 0) return "";
  const origin = webServer;
  if (typeof origin.getOrigin === "function") {
    try {
      return origin.getOrigin();
    } catch {
    }
  }
  return `http://${urlHost(webServer.host)}:${String(webServer.port)}`;
}
function provideWebRuntime(ctx, trustedHosts) {
  const runtime = resolveLanTrust(ctx.webServer.host, trustedHosts);
  ctx.provide("webRuntime", runtime);
  ctx.provide("webApp", { getAdvertisedUrl: () => advertisedUrl(ctx) });
  printWebUrl(ctx, runtime);
  const shellEnv = ctx.get("shellEnv");
  if (shellEnv !== void 0) {
    ctx.effect(() => shellEnv.register({
      name: "web-runtime",
      variables: {
        [DSH_WEB_URL]: { description: "Canonical local URL of the DeepSeek Harness Web GUI serving this session." }
      },
      resolve: () => {
        const webServer = ctx.get("webServer");
        if (webServer === void 0) return { [DSH_WEB_URL]: "" };
        return { [DSH_WEB_URL]: `http://${urlHost(webServer.host)}:${String(webServer.port)}` };
      }
    }), "dsh-login: DSH_WEB_URL shell variable");
  }
  return runtime;
}

// src/http-json.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  return env !== void 0 && env.length > 0 ? env : join3(homedir(), ".dsh");
}

// src/glue.ts
var DSH_LOGIN_OWNERSHIP_SERVICE = "dshLoginOwnership";
function createDshLoginIsolation(deps) {
  return createRemoteIsolation({
    ownership: deps.ownership,
    currentSessionId: deps.currentSessionId ?? (() => void 0),
    isAdmin: deps.isAdmin,
    permissions: deps.permissionsForUser
  });
}
function composeGuardedGateway(gateway, isolation) {
  return wrapRemoteGateway(gateway, isolation.resolveUser, isolation.owns);
}
function getDshLoginOwnership(ctx) {
  try {
    const get = ctx.get;
    return get.call(ctx, DSH_LOGIN_OWNERSHIP_SERVICE);
  } catch {
    return void 0;
  }
}
function composeDshLoginGuard(ctx, gateway) {
  const ownership = getDshLoginOwnership(ctx);
  if (ownership === void 0) return gateway;
  const agents = ctx.agents;
  const isolation = createDshLoginIsolation({
    ownership,
    currentSessionId: () => agents?.currentInitiator?.()?.id,
    permissionsForUser: dshLoginPermissionLookup(ctx)
  });
  return composeGuardedGateway(gateway, isolation);
}
function dshLoginPermissionLookup(ctx) {
  return (userId) => {
    try {
      const get = ctx.get;
      const auth = get.call(ctx, "dshLoginAuth");
      return auth?.permissionsForUser?.(userId) ?? [];
    } catch {
      return [];
    }
  };
}

// src/index.ts
var name = "dsh-login";
var inject = ["webServer"];
function apply(ctx, config) {
  if (!config.enabled) return;
  const dataDir = config.dataDir === "" ? join4(resolveDshHome(), ".dsh-login") : config.dataDir;
  const store = new SessionStore(config.sessionTtl);
  const ownership = new OwnershipIndex(join4(dataDir, "ownership-v2.json"));
  const hosts = new TrustedHosts(join4(dataDir, "trusted-hosts.json"));
  const defaultWorkspaceSetting = new DefaultWorkspaceSetting(join4(dataDir, "settings.json"), config.defaultWorkspace);
  const remoteWebUiSetting = new BooleanSetting(join4(dataDir, "settings-remote-web-ui.json"), config.remoteWebUiCompat);
  const remoteWebUiCompat = new RemoteWebUiCompat({
    getSettings: () => ctx.get("settings")
  });
  const distIndex = config.distIndex === "" ? resolveDistIndex() : config.distIndex;
  const gatewayConfig = { ...config, distIndex };
  const publicBaseUrl = config.publicBaseUrl || ctx.webServer.getOrigin();
  const adminSso = createAdminSso({
    adminBaseUrl: config.adminBaseUrl.replace(/\/+$/, ""),
    clientId: config.adminClientId,
    redirectUri: `${publicBaseUrl.replace(/\/+$/, "")}/api/auth/callback`,
    sessionTtl: config.sessionTtl,
    autoTrustHosts: config.autoTrustHosts,
    hosts
  }, store);
  const runtime = config.takeOverWebRuntime ? provideWebRuntime(ctx, config.trustedHosts) : void 0;
  const workspaceRoot = config.workspaceRoot === "" ? join4(resolveDshHome(), "workspaces") : config.workspaceRoot;
  const provisioner = new DefaultWorkspaceProvisioner({
    workspaceRoot,
    getApi: createHostSessionApi(ctx),
    ownership,
    getRegistry: () => tryGetService(ctx, "workspaceRegistry"),
    enabled: () => defaultWorkspaceSetting.get()
  });
  ctx.provide("dshLoginOwnership", ownership);
  const loginPageRoute = {
    kind: "exact",
    path: "/login",
    handler: async (_req, res) => {
      const html = renderLoginPage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
  };
  const gatewayHandler = createGatewayHandler(ctx, gatewayConfig, store, adminSso.userInfo);
  ctx.effect(() => ctx.webServer.register(loginPageRoute), "dsh-login: /login");
  for (const route of adminSso.routes) {
    ctx.effect(() => ctx.webServer.register(route), `dsh-login: ${route.path}`);
  }
  ctx.provide("dshLoginAuth", {
    accessToken: adminSso.accessToken,
    refreshAccessToken: adminSso.refreshAccessToken,
    isUserAuthenticated: adminSso.isUserAuthenticated,
    userInfo: adminSso.userInfo,
    permissionsForUser: (userId) => store.permissionsForUser(userId),
    resolveAgentUserId: (agentSessionId) => ownership.lookup(agentSessionId),
    currentUser: adminSso.currentUser,
    onLogin: adminSso.onLogin,
    onLogout: adminSso.onLogout
  });
  const bootCompat = applyWithRetry(remoteWebUiCompat, remoteWebUiSetting.get(), config.remoteWebUiPublicBaseUrl);
  void bootCompat;
  ctx.effect(() => ctx.webServer.registerFallback(gatewayHandler), "dsh-login: gateway fallback");
  if (config.apiBridgeAuth) {
    const reported = /* @__PURE__ */ new Set();
    const reportUnknownMethod = (method, username) => {
      if (reported.has(method)) return;
      reported.add(method);
      const message = `dsh-login: /api/${method} was denied for '${username}' but is not part of the DSH ${WIRE_SURFACE_DSH_VERSION} wire surface this build knows \u2014 upstream may have renamed it; refresh src/api-filter.ts (node scripts/dump-wire-surface.mjs)`;
      const logger = ctx.logger;
      if (typeof logger?.warn === "function") logger.warn(message);
      else console.warn(message);
    };
    const ownedProvider = (username) => probeOwnedSessionIds(username, ownership, createHostSessionSource(ctx));
    ctx.effect(
      () => ctx.on("connection/request", createApiBridgeAuth({
        store,
        ownership,
        quietDenials: config.quietDenials,
        ownedProvider,
        provisioner,
        onUnknownMethod: reportUnknownMethod
      }), { global: true }),
      "dsh-login: /api bridge auth wall"
    );
  }
  if (config.apiBridgeAuth) {
    const warnLog = (message) => {
      const logger = ctx.logger;
      if (typeof logger?.warn === "function") logger.warn(message);
      else console.warn(message);
    };
    const guardDeps = {
      store,
      ownership,
      sessionSource: () => createHostSessionSource(ctx)
    };
    ctx.inject(["connection", "typertGateway"], (fork) => {
      fork.effect(() => {
        const uninstallAdmit = installAdmitShadow(fork.connection, guardDeps, warnLog);
        const uninstallDispatch = installDispatchShadows(tryGetService(fork, "typertGateway"), guardDeps, warnLog);
        return () => {
          uninstallAdmit();
          uninstallDispatch();
        };
      }, "dsh-login: dispatch-seam guard");
    });
  }
  const cap = deriveCapabilities({ username: "", isAdmin: false, permissions: [] });
  const sessionBaselineScript = `window.__DSH_SESSION__={username:null,isAdmin:false,capabilities:${JSON.stringify(cap)}};`;
  ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script", placement: "head", text: sessionBaselineScript });
  }), "dsh-login: capability baseline injection");
  ctx.effect(() => () => {
    adminSso.clear();
    return Promise.all([store.flush(), ownership.flush(), hosts.flush(), defaultWorkspaceSetting.flush(), remoteWebUiSetting.flush()]);
  }, "dsh-login: sessions + ownership + hosts + settings flush");
}
export {
  Config,
  DSH_LOGIN_OWNERSHIP_SERVICE,
  apply,
  composeDshLoginGuard,
  composeGuardedGateway,
  createDshLoginIsolation,
  createRemoteIsolation,
  getDshLoginOwnership,
  inject,
  name,
  wrapRemoteGateway
};
//# sourceMappingURL=index.js.map
