/**
 * Deployment settings view shared between the panel Settings tab and the DSH Plugin Manager config page.
 * Edits the actual owner's machine limits through its API, or the standalone DSH `ConfigForm`.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { LIMITS } from '../limits.ts'
import { usePoll, type ApiResponse, type SetupView } from './api.ts'
import { InfoTip, Input } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { setupText, type T } from './text.ts'
import { CheckSetupButton, Hint, KeyValues, LoadState, Section, SetupMessage } from './widgets.tsx'

export type DeploymentForm = ConfigPageForm | undefined
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

const MACHINE_LIMITS = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs'] as const
type Limits = Record<typeof MACHINE_LIMITS[number], string>
const text = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const limitsOf = (values: object | undefined): Limits =>
  Object.fromEntries(MACHINE_LIMITS.map(key => [key, text((values as Record<string, unknown> | undefined)?.[key])])) as Limits

export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): DeploymentForm {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

/** Deployment configuration form; falls back to read-only display when DSH config forms are unavailable or read-only. */
export function DeploymentPage(props: { setup: SetupView; form: DeploymentForm; accounts?: boolean; machineApi?: boolean }) {
  return props.machineApi || props.setup.machineApi ? <MachineDeploymentPage setup={props.setup} accounts={props.accounts} /> : <DshDeploymentPage {...props} />
}
function DshDeploymentPage({ setup, form, accounts: showAccounts }: { setup: SetupView; form: DeploymentForm; accounts?: boolean }) {
  const { t, notify } = usePanel()
  const snapshot = form?.state
  const editable = snapshot?.status === 'ready' && snapshot.writable
  // Pass `revision` only while DSH serves writable values so a draft started before `ready` rebases once writable.
  const draft = useDraft({ saved: limitsOf(editable ? snapshot.value : setup.machine), revision: editable ? snapshot.revision : undefined,
    reload: async () => {},
    save: async (value, revision, base) => {
      const ops: Op[] = MACHINE_LIMITS.filter(key => value[key].trim() !== base[key].trim())
        .map(key => value[key].trim() ? { op: 'set', path: [key], value: Number(value[key]) } : { op: 'unset', path: [key] })
      if (!form || !await form.mutate(ops, revision)) throw new Error(t('deploymentRefused'))
      notify(t('saved'))
      return { revision: revision + 1, restarting: false }
    } })
  // Remote browsers (`memory` mode) are read-only; `unavailable` indicates `dsh-superagent` is still starting.
  const readOnlyHint = !form ? t('deploymentNoForms') : snapshot?.mode === 'memory' ? t('deploymentReadOnly')
    : snapshot?.status === 'loading' ? t('loading') : snapshot?.status === 'unavailable' ? t('deploymentUnavailable')
    : !editable ? t('deploymentReadOnly') : undefined
  return <DeploymentFields setup={setup} draft={draft} editable={!!editable} readOnlyHint={readOnlyHint} showAccounts={showAccounts} />
}

/** The organization host persists the original machine limits under their own CAS revision. */
function MachineDeploymentPage({ setup, accounts }: { setup: SetupView; accounts?: boolean | undefined }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET deployment'), [call, restarts])
  return data ? <MachineDeploymentForm setup={setup} view={data} reload={reload} error={error} accounts={accounts} /> : <LoadState error={error} loading />
}
function MachineDeploymentForm({ setup, view, reload, error, accounts }: {
  setup: SetupView; view: ApiResponse<'GET deployment'>; reload: () => Promise<void>; error: Error | undefined; accounts?: boolean | undefined
}) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const draft = useDraft({ key: `dsh-superagent/draft/${state!.masterId}/deployment`, saved: limitsOf(view.values), revision: view.revision,
    reload, save: async (value, revision) => {
      const values = Object.fromEntries(MACHINE_LIMITS.flatMap(key => value[key].trim() ? [[key, Number(value[key])]] : []))
      const result = await call('PUT deployment', { body: { revision, values } })
      notify(t('saved'))
      return { revision: result.revision }
    } })
  return <>{error && <LoadState error={error} loading={false} />}<DeploymentFields setup={setup} draft={draft}
    editable={view.writable} readOnlyHint={view.writable ? t('deploymentNextUse') : t('deploymentReadOnly')} defaults={view.defaults} showAccounts={accounts} /></>
}
function DeploymentFields({ setup, draft, editable, readOnlyHint, showAccounts, defaults }: {
  setup: SetupView; draft: ReturnType<typeof useDraft<Limits>>; editable: boolean; readOnlyHint: string | undefined
  showAccounts?: boolean | undefined; defaults?: ApiResponse<'GET deployment'>['defaults']
}) {
  const { t } = usePanel()
  const accounts = setup.accounts
  const limit = (key: typeof MACHINE_LIMITS[number], label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={draft.value[key]} disabled={!editable}
      placeholder={defaults ? String(defaults[key]) : undefined}
      onChange={event => draft.edit({ ...draft.value, [key]: event.target.value })} />
  </Field>
  const feishu = accounts?.feishu ? accounts.feishu.name || accounts.feishu.botId
    : setup.feishuProblem ? setupText(t, setup.feishuProblem) : t('deploymentFeishuNone')
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <Hint>{t('deploymentIntro')}</Hint>
      {setup.problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
      </div>}
      {showAccounts && <Section title={t('deploymentDerived')} hint={t('deploymentDerivedHint')}>
        <KeyValues rows={[[t('deploymentRepository'), accounts?.repository ?? '—'],
          [t('deploymentAgent'), accounts ? `@${accounts.agent}` : '—'], [t('deploymentFeishu'), feishu]]} />
        <Hint>{t('deploymentAccountsWhere')}</Hint>
      </Section>}
      <Section title={t('deploymentMachine')}>
        {readOnlyHint && <Hint>{readOnlyHint}</Hint>}
        <div className="dt-field">
          <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
          <span className="dt-mono">{setup.machine.stateDir}</span>
        </div>
      </Section>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
      </Section>
    </Fields>
    {editable && <SaveBar {...draft} onDiscard={draft.discard} />}
  </form>
}

/** Plugin Manager config page; includes derived repository and accounts because Source settings live in the main panel. */
function PluginPage({ form }: { form: DeploymentForm }) {
  const { t } = usePanel()
  const { state, error } = usePanelData()
  return <div className="dt-embedded">
    {state ? <DeploymentPage setup={state.setup} form={form} accounts />
      : error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>}
  </div>
}
/** DSH Plugin Manager config view entry; renders nothing in `summary` mode because DSH displays the package description. */
export function PluginConfig({ t, view, form }: { t: T; view: 'page' | 'summary'; form: DeploymentForm }) {
  return view === 'page' ? <PanelProvider t={t} interval={10_000}><PluginPage form={form} /></PanelProvider> : null
}
