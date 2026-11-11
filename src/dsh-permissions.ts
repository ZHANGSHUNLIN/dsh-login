import { ADMIN_ONLY_METHODS, USER_ALLOWED } from './api-filter.ts'

export const DSH_PERMISSIONS = {
  settings: 'dsh:settings:manage',
  plugins: 'dsh:plugin:manage',
  agentPresets: 'dsh:agent-preset:manage',
} as const

export interface DshAccessUser {
  isAdmin: boolean
  permissions?: readonly string[]
}

/** UI plugins that must remain available to every authenticated user. */
export const CORE_UI_PLUGINS: readonly string[] = [
  '@islibaodong/dsh-login',
  '@duhome/dsh-admin-mcp',
  // The settings shell owns the launcher slot used by the Admin account
  // card. Its privileged sections are gated independently.
  '@deepseek-ai/dsh-client-ui-settings-general',
]

const METHOD_PERMISSIONS = new Map<string, string>([
  ...[
    'settings.describe', 'settings.mutate', 'settings.openSettingsDocument',
    'settings.replace', 'settings.update',
  ].map(method => [method, DSH_PERMISSIONS.settings] as const),
  ...[
    'agentPresets.list', 'agentPresets.read', 'agentPresets.select',
    // The preset UI's Remote contract uses the singular namespace. Listing,
    // selecting, reading and editing the preset roster are covered by the
    // same Admin-managed permission; opening a host document is not.
    'agentPreset.list', 'agentPreset.select', 'agentPreset.read',
    'agentPreset.copy', 'agentPreset.remove',
  ].map(method => [method, DSH_PERMISSIONS.agentPresets] as const),
  ...[
    'pluginManager.cancelInstall', 'pluginManager.inspect', 'pluginManager.installBundle',
    'pluginManager.listBundles', 'pluginManager.listPlugins', 'pluginManager.listVersionExemptions',
    'pluginManager.listVersions', 'pluginManager.readBundleDetail', 'pluginManager.registries',
    'pluginManager.removeBundle', 'pluginManager.setBundleEnabled', 'pluginManager.setPluginEnabled',
    'pluginManager.setVersionExemption', 'pluginManager.updateBundle', 'pluginManager.waitForInstall',
    'pluginMarket.listIndexes', 'pluginMarket.readEntryDetail', 'pluginMarket.search', 'pluginMarket.setIndexes',
    'pluginInventory.list', 'pluginRegistryProbe.fastest',
  ].map(method => [method, DSH_PERMISSIONS.plugins] as const),
])

const UI_PLUGIN_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-client-ui-plugin-manager': [DSH_PERMISSIONS.plugins],
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory': [DSH_PERMISSIONS.plugins],
  '@deepseek-ai/dsh-client-ui-settings-plugins': [DSH_PERMISSIONS.plugins],
  '@deepseek-ai/dsh-client-ui-entry-customization': [DSH_PERMISSIONS.plugins],
  '@deepseek-ai/dsh-client-ui-settings-models': [DSH_PERMISSIONS.settings],
  '@deepseek-ai/dsh-client-ui-settings-shell': [DSH_PERMISSIONS.settings],
  '@deepseek-ai/dsh-client-ui-settings-agent-loop': [DSH_PERMISSIONS.settings],
  '@deepseek-ai/dsh-client-ui-settings-subagent': [DSH_PERMISSIONS.settings],
  '@deepseek-ai/dsh-client-ui-settings-web-search': [DSH_PERMISSIONS.settings],
  '@deepseek-ai/dsh-client-ui-settings-session-log': [DSH_PERMISSIONS.settings],
  '@linxin666/dsh-client-ui-plugin-manager': [DSH_PERMISSIONS.plugins],
  '@linxin666/dsh-client-ui-market': [DSH_PERMISSIONS.plugins],
  '@linxin666/dsh-client-ui-community-plugins': [DSH_PERMISSIONS.plugins],
  '@linxin666/dsh-client-ui-web-ui-settings': [DSH_PERMISSIONS.settings],
  '@tencent-connect/dsh-qqbot': [DSH_PERMISSIONS.settings],
}

export function hasDshPermission(user: DshAccessUser, permission: string): boolean {
  return user.isAdmin || user.permissions?.includes(permission) === true
}

export function permissionForUiPlugin(plugin: string): string | undefined {
  const mapped = UI_PLUGIN_PERMISSIONS[plugin]
  if (mapped) return mapped[0]
  // DSH adds settings cards as separate client bundles. Keep new settings
  // cards behind the same permission even before this table is updated.
  if (plugin.startsWith('@deepseek-ai/dsh-client-ui-settings-')
      && plugin !== '@deepseek-ai/dsh-client-ui-settings-general') return DSH_PERMISSIONS.settings
  return /agent[-.]?preset/i.test(plugin) ? DSH_PERMISSIONS.agentPresets : undefined
}

export function canUseWireMethod(method: string, user: DshAccessUser): boolean {
  if (user.isAdmin || USER_ALLOWED.has(method)) return true
  const required = METHOD_PERMISSIONS.get(method)
  return required !== undefined && hasDshPermission(user, required)
}

export function permittedWireMethods(user: DshAccessUser): string[] {
  return user.isAdmin
    ? [...USER_ALLOWED, ...ADMIN_ONLY_METHODS]
    : [
        ...USER_ALLOWED,
        ...[...ADMIN_ONLY_METHODS].filter(method => canUseWireMethod(method, user)),
      ]
}

export function permittedUiPlugins<T extends string>(plugins: readonly T[], user: DshAccessUser): T[] {
  if (user.isAdmin) return [...plugins]
  return plugins.filter(plugin => {
    if (CORE_UI_PLUGINS.includes(plugin)) return true
    const required = permissionForUiPlugin(plugin)
    return required !== undefined && hasDshPermission(user, required)
  })
}

export function permissionForWireMethod(method: string): string | undefined {
  return METHOD_PERMISSIONS.get(method)
}
