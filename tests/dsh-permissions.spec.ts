import { describe, expect, it } from 'vitest'
import { canUseWireMethod, DSH_PERMISSIONS, permittedUiPlugins } from '../src/dsh-permissions.ts'
import { ADMIN_ONLY_UI_PLUGINS } from '../src/capabilities.ts'

describe('Admin-provided DSH permissions', () => {
  it('allows settings methods only with the DSH settings permission', () => {
    const user = { isAdmin: false, permissions: [DSH_PERMISSIONS.settings] }
    expect(canUseWireMethod('settings.describe', user)).toBe(true)
    expect(canUseWireMethod('settings.update', user)).toBe(true)
    expect(canUseWireMethod('pluginManager.listPlugins', user)).toBe(false)
    expect(canUseWireMethod('credentials.describe', user)).toBe(false)
  })

  it('grants plugin and agent preset methods independently', () => {
    expect(canUseWireMethod('pluginManager.installBundle', {
      isAdmin: false,
      permissions: [DSH_PERMISSIONS.plugins],
    })).toBe(true)
    expect(canUseWireMethod('agentPresets.select', {
      isAdmin: false,
      permissions: [DSH_PERMISSIONS.agentPresets],
    })).toBe(true)
    expect(canUseWireMethod('settings.update', {
      isAdmin: false,
      permissions: [DSH_PERMISSIONS.agentPresets],
    })).toBe(false)
  })

  it('maps the singular Agent Preset Remote methods without granting host document access', () => {
    const user = { isAdmin: false, permissions: [DSH_PERMISSIONS.agentPresets] }
    for (const method of [
      'agentPreset.list', 'agentPreset.select', 'agentPreset.read',
      'agentPreset.copy', 'agentPreset.remove',
    ]) {
      expect(canUseWireMethod(method, user), method).toBe(true)
    }
    expect(canUseWireMethod('agentPreset.openDocument', user)).toBe(false)
    expect(canUseWireMethod('agentPreset.copy', { isAdmin: false, permissions: [] })).toBe(false)
  })

  it('shows only the UI bundle granted by the permission list', () => {
    const plugins = permittedUiPlugins(ADMIN_ONLY_UI_PLUGINS, {
      isAdmin: false,
      permissions: [DSH_PERMISSIONS.plugins],
    })
    expect(plugins).toContain('@linxin666/dsh-client-ui-plugin-manager')
    expect(plugins).not.toContain('@linxin666/dsh-client-ui-web-ui-settings')
    expect(plugins).not.toContain('@linxin666/dsh-doctor')
  })

  it('keeps the settings shell available without management permissions', () => {
    const plugins = permittedUiPlugins([
      '@deepseek-ai/dsh-client-ui-settings-general',
      '@deepseek-ai/dsh-client-ui-settings-models',
    ], { isAdmin: false, permissions: [] })
    expect(plugins).toEqual(['@deepseek-ai/dsh-client-ui-settings-general'])
  })

  it('recognizes Agent preset UI bundles without relying on a fixed package name', () => {
    const plugins = permittedUiPlugins([
      '@deepseek-ai/dsh-client-ui-agent-preset',
      '@linxin666/dsh-client-ui-agentPreset',
    ], { isAdmin: false, permissions: [DSH_PERMISSIONS.agentPresets] })
    expect(plugins).toHaveLength(2)
  })
})
