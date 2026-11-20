/** Standalone browser entry for an organization's complete original Superagent settings. */
import { createRoot } from 'react-dom/client'
import { caller } from './api.ts'
import { Button } from './controls.tsx'
import { zh, en } from './locales.ts'
import { PanelProvider, usePanel, usePanelData, type DraftActivity } from './provider.tsx'
import { SETTINGS_GROUPS, type Route, type SettingsGroup } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { ModelPickerContext, type MountModelPicker } from './settings-kit.tsx'
import type { T } from './text.ts'
import { LoadState, SessionButton } from './widgets.tsx'
import { WorkerCapabilities } from './worker-capabilities.tsx'

export interface OrganizationSettingsLocation { group: SettingsGroup; source?: string; version?: string }
export interface OrganizationSettingsOptions {
  instanceId: string; csrf: string; location: OrganizationSettingsLocation
  onNavigate: (location: OrganizationSettingsLocation) => void
  onDraftStateChange?: (activity: { dirty: boolean; busy: boolean }) => void
  openSession?: (id: string) => Promise<void>; locale?: 'zh' | 'en'
  mountModelPicker?: MountModelPicker
}
export interface OrganizationSettingsController {
  update: (location: OrganizationSettingsLocation) => void
  isDirty: () => boolean; isBusy: () => boolean; discard: () => void; unmount: () => void
}

function OrganizationPage({ location }: { location: OrganizationSettingsLocation }) {
  const { t } = usePanel()
  const { state, error, reload } = usePanelData()
  if (!state) return <><LoadState error={error} loading />{error && <Button onClick={() => { void reload() }}>{t('engineRetry')}</Button>}</>
  return <><div className="dt-actions dt-organization-actions"><SessionButton sessionId={state.masterId} label={t('openMaster')} /></div>
    {error && <LoadState error={error} loading={false} />}<SettingsPage group={location.group} query={location}
    state={state} deploymentForm={undefined} machineApi keepMounted executionAddon={<WorkerCapabilities />} /></>
}

/** The scope and CSRF token are copied at mount; an existing controller cannot be redirected into another organization. */
export function mountSuperagentSettings(container: HTMLElement, options: OrganizationSettingsOptions): OrganizationSettingsController {
  if (!options.instanceId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.instanceId)) throw new Error('Invalid organization identity')
  const apiScope = { base: `/jarvis/api/system/instances/${encodeURIComponent(options.instanceId)}/superagent`, csrf: options.csrf }
  // Validate before mounting, so a malformed target never leaves an unusable React root.
  caller(() => { throw new Error('Only validating the API scope') }, apiScope)
  const dictionary = options.locale === 'en' ? en : zh
  const t = ((key: keyof typeof dictionary, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
  }) as T
  const content = document.createElement('div'), portals = document.createElement('div')
  content.className = 'dt-organization-content'; portals.className = 'superagent-organization dt-organization-portals'
  container.classList.add('superagent-organization')
  container.replaceChildren(content)
  // Body-level portals retain the original viewport focus/mask behavior outside the engine's scrolling query container.
  document.body.append(portals)
  const root = createRoot(content)
  let mounted = true, activity: DraftActivity = { dirty: false, busy: false, discard: () => {} }
  const changed = (value: DraftActivity) => { activity = value; if (mounted) options.onDraftStateChange?.(value) }
  const openSession = options.openSession ?? (async (id: string) => { throw new Error(t('engineSessionUnavailable', { id })) })
  const navigate = (route: Route) => {
    if (activity.busy) return
    if (route.page === 'settings') options.onNavigate({ ...route.query })
    else throw new Error(t('engineSettingsOnly'))
  }
  const render = (location: OrganizationSettingsLocation) => {
    if (!mounted || !SETTINGS_GROUPS.includes(location.group)) return
    root.render(<PanelProvider t={t} apiScope={apiScope} navigate={navigate} openSession={openSession} portalRoot={portals}
      onDraftStateChange={changed}><ModelPickerContext.Provider value={options.mountModelPicker}>
        <OrganizationPage location={{ ...location }} />
      </ModelPickerContext.Provider></PanelProvider>)
  }
  render(options.location)
  return { update: render, isDirty: () => activity.dirty, isBusy: () => activity.busy,
    discard: () => { if (!activity.busy) activity.discard() }, unmount: () => {
      if (!mounted) return
      mounted = false; root.unmount(); portals.remove(); container.replaceChildren(); container.classList.remove('superagent-organization')
    } }
}
