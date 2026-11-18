/** Existing organization Worker authorization, alongside the original executor configuration. */
import { useEffect, useId, useRef, useState } from 'react'
import type { WorkerCapabilityApplication, WorkerCapabilitiesView } from '../app/api.ts'
import { ApiError, usePoll } from './api.ts'
import { Button, Modal } from './controls.tsx'
import { SaveBar, useDraft } from './draft.tsx'
import { Fields } from './settings-kit.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

export function WorkerCapabilities() {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET worker-capabilities'), [call, restarts])
  return data ? <CapabilitiesForm view={data} reload={reload} error={error} /> : <LoadState error={error} loading />
}
function CapabilitiesForm({ view, reload, error }: {
  view: WorkerCapabilitiesView; reload: () => Promise<void>; error: Error | undefined
}) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const operation = useCapabilityApplication(view, reload)
  const locked = !!view.application && ['waiting', 'applying', 'failed'].includes(view.application.state)
  const draft = useDraft({ key: `dsh-superagent/draft/${state!.masterId}/worker-capabilities`,
    saved: { tools: view.tools, skills: view.skills }, revision: view.revision, reload, save: async (value, revision) => {
      const result = await call('PUT worker-capabilities', { body: { revision, ...value } })
      notify(t(result.application?.state === 'waiting' ? 'workerCapabilitiesWaiting'
        : result.application?.state === 'failed' ? 'workerCapabilitiesFailed' : result.application?.state === 'applying'
        ? 'workerCapabilitiesApplying' : 'workerCapabilitiesApplied'))
      return { revision: result.revision }
    } })
  const catalog = view.catalog
  const tools = [...catalog.tools.filter(item => item.available || draft.value.tools.includes(item.name))]
  for (const name of draft.value.tools) if (!tools.some(item => item.name === name)) tools.push({ name, label: name, group: '', available: false })
  const skills = [...catalog.skills.map(item => ({ ...item, available: true }))]
  for (const name of draft.value.skills) if (!skills.some(item => item.name === name)) skills.push({ name, description: '', available: false })
  const choose = (field: 'tools' | 'skills', name: string, enabled: boolean) => draft.edit({ ...draft.value,
    [field]: enabled ? [...draft.value[field], name] : draft.value[field].filter(item => item !== name) })
  const groups = [...new Set(tools.map(tool => tool.group))]
  return <form className="dt-form dt-worker-capabilities" onSubmit={event => {
    event.preventDefault(); if (!locked && !operation.busy) void draft.submit()
  }}>
    <ApplicationStatus view={view} operation={operation} disabled={draft.dirty || draft.busy} />
    <Fields disabled={draft.busy || locked || operation.busy}>
      <Section title={t('workerCapabilities')}>
        <Hint>{t('workerCapabilitiesHint')}</Hint>
        {error && <LoadState error={error} loading={false} />}
        {!catalog.complete && <p className="dt-error" role="alert">{catalog.error || t('capabilityCatalogIncomplete')}</p>}
        <Section title={t('workerTools')}>
          {!tools.length && <Hint>{t('noWorkerTools')}</Hint>}
          {groups.map(group => <fieldset className="dt-capability-group" key={group}>{group && <legend>{group}</legend>}
            {tools.filter(tool => tool.group === group).map(tool => <label key={tool.name} className="dt-capability-option">
            <input type="checkbox" checked={draft.value.tools.includes(tool.name)} disabled={locked || operation.busy || !tool.available && !draft.value.tools.includes(tool.name)}
              onChange={event => choose('tools', tool.name, event.target.checked)} />
            <span><strong>{tool.label}</strong><small>{tool.name}</small>{!tool.available && <small>{t('capabilityUnavailable')}</small>}</span>
            </label>)}</fieldset>)}
        </Section>
        <Section title={t('workerSkills')}>
          {!skills.length && <Hint>{t('noInstalledSkills')}</Hint>}
          {skills.map(skill => <label key={skill.name} className="dt-capability-option">
            <input type="checkbox" checked={draft.value.skills.includes(skill.name)} disabled={locked || operation.busy || !skill.available && !draft.value.skills.includes(skill.name)}
              onChange={event => choose('skills', skill.name, event.target.checked)} />
            <span><strong>{skill.name}</strong>{skill.description && <small>{skill.description}</small>}
              {!skill.available && <small>{t('capabilityUnavailable')}</small>}</span>
          </label>)}
        </Section>
        <AutomaticTools view={view} />
      </Section>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} saveDisabled={locked || operation.busy}
      onSave={() => { if (!locked && !operation.busy) void draft.submit() }} />
    <ApplicationConfirmation operation={operation} />
  </form>
}

const different = (view: WorkerCapabilitiesView) => (['tools', 'skills'] as const).some(field =>
  view[field].length !== view.applied[field].length || view[field].some(name => !view.applied[field].includes(name)))

/** Keep the destructive action bound to a fresh, explicitly reviewed server snapshot; conflicts never replay it. */
function useCapabilityApplication(view: WorkerCapabilitiesView, reload: () => Promise<void>) {
  const { t, call, trackDraft } = usePanel(), activityId = useId()
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const [confirmation, setConfirmation] = useState<WorkerCapabilitiesView>()
  const running = useRef(false)
  useEffect(() => {
    trackDraft(activityId, { dirty: false, busy, discard: () => {} })
    return () => trackDraft(activityId, undefined)
  }, [trackDraft, activityId, busy])
  const run = async (task: () => Promise<void>) => {
    if (running.current) return
    running.current = true; setBusy(true); setError(undefined)
    try { await task() } catch (failure) {
      setConfirmation(undefined)
      setError(failure instanceof ApiError && failure.status === 409 ? t('workerCapabilitiesStale') : errorText(failure))
      await reload()
    } finally { running.current = false; setBusy(false) }
  }
  const action = (kind: 'cancel' | 'retry' | 'apply-now', snapshot = view) => run(async () => {
    if (!snapshot.application) return
    await call('POST worker-capabilities/application', { body: { revision: snapshot.revision,
      applicationId: snapshot.application.id, action: kind,
      ...kind === 'apply-now' ? { confirmation: snapshot.application.confirmation } : {} } })
    setConfirmation(undefined)
    await reload()
  })
  const prepare = () => run(async () => {
    const fresh = await call('GET worker-capabilities'), application = fresh.application
    if (fresh.revision !== view.revision || application?.id !== view.application?.id) {
      setError(t('workerCapabilitiesStale')); await reload(); return
    }
    if (!application?.canApplyNow || !application.confirmation) {
      setError(t('workerCapabilitiesCannotApply')); await reload(); return
    }
    setConfirmation(fresh)
  })
  return { busy, error, confirmation, prepare, cancel: () => action('cancel'), retry: () => action('retry'),
    confirm: () => confirmation ? action('apply-now', confirmation) : Promise.resolve(),
    close: () => { if (!running.current) setConfirmation(undefined) } }
}
type CapabilityOperation = ReturnType<typeof useCapabilityApplication>

/** Saved intent and actual authorization remain distinct while organizations are waiting or recovering. */
function ApplicationStatus({ view, operation, disabled }: { view: WorkerCapabilitiesView; operation: CapabilityOperation; disabled: boolean }) {
  const { t } = usePanel()
  const application = view.application, state = application?.state
  const pending = state === 'waiting' || state === 'applying' || state === 'failed'
  const title = state === 'waiting' ? 'workerCapabilitiesWaiting' : state === 'applying' ? 'workerCapabilitiesApplying'
    : state === 'failed' ? different(view) ? 'workerCapabilitiesFailed' : 'workerCapabilitiesRecoveryFailed'
    : state === 'cancelled' ? 'workerCapabilitiesCancelled' : 'workerCapabilitiesApplied'
  return <section className="dt-capability-application" data-capability-application={state ?? 'applied'} aria-label={t('workerCapabilitiesApplication')}>
    <p className="dt-capability-status" role="status">{t(title)}</p>
    {state === 'waiting' && different(view) && <Hint>{t('workerCapabilitiesKeepApplied')}</Hint>}
    {pending && application?.canCancel && <Hint>{t('workerCapabilitiesCancelToEdit')}</Hint>}
    {application?.error && <p className="dt-error" role="alert">{application.error}</p>}
    <CapabilityValues value={view.applied} />
    {pending && application && <AffectedWork application={application} />}
    {operation.error && <p className="dt-error" role="alert">{operation.error}</p>}
    {pending && application && <div className="dt-actions">
      {application.canCancel && <Button variant="outline" size="sm" disabled={disabled || operation.busy}
        onClick={() => { void operation.cancel() }}>{t('workerCapabilitiesCancel')}</Button>}
      {application.canRetry && <Button variant="outline" size="sm" disabled={disabled || operation.busy}
        onClick={() => { void operation.retry() }}>{t('workerCapabilitiesRetry')}</Button>}
      {application.canApplyNow && <Button variant="outline" size="sm" disabled={disabled || operation.busy}
        onClick={() => { void operation.prepare() }}>{t('workerCapabilitiesApplyNow')}</Button>}
    </div>}
  </section>
}

/** Display the exact configured tool and skill names without conflating them with automatic management tools. */
function CapabilityValues({ value, target = false }: { value: { tools: string[]; skills: string[] }; target?: boolean }) {
  const { t } = usePanel()
  return <dl className="dt-effective-tools" data-applied-capabilities={!target || undefined}>
    {(['tools', 'skills'] as const).map(field => <div key={field}>
      <dt>{t(target ? field === 'tools' ? 'workerCapabilitiesTargetTools' : 'workerCapabilitiesTargetSkills'
        : field === 'tools' ? 'workerCapabilitiesAppliedTools' : 'workerCapabilitiesAppliedSkills')}</dt>
      <dd className="dt-mono">{value[field].length ? value[field].join(', ') : t('workerCapabilitiesNoSelection')}</dd>
    </div>)}
  </dl>
}

/** Organization and activity identities are provided by the server, including incomplete-snapshot errors. */
function AffectedWork({ application }: { application: WorkerCapabilityApplication }) {
  const { t } = usePanel()
  const kinds: Record<string, string> = { ticket: t('workerCapabilitiesWorkTicket'), evaluation: t('workerCapabilitiesWorkEvaluation'),
    conversation: t('workerCapabilitiesWorkConversation'), worker: t('workerCapabilitiesWorkWorker'), other: t('workerCapabilitiesWorkOther') }
  return <div className="dt-capability-affected">
    <p className="dt-hint">{t('workerCapabilitiesAffected')}</p>
    {!application.affected.length && <Hint>{t('workerCapabilitiesNoAffectedWork')}</Hint>}
    {application.affected.map(organization => <div className="dt-capability-organization" key={organization.instanceId}>
      <strong>{organization.name}</strong> <small className="dt-mono">{organization.instanceId}</small>
      <p className="dt-hint">{t(organization.running ? 'workerCapabilitiesOrganizationRunning' : 'workerCapabilitiesOrganizationStopped')}
        {t('listSeparator')}{t(organization.busy ? 'workerCapabilitiesOrganizationBusy' : 'workerCapabilitiesOrganizationIdle')}</p>
      {organization.error && <p className="dt-error" role="alert">{organization.error}</p>}
      {!!organization.work.length && <ul>{organization.work.map(work => <li key={`${work.kind}/${work.id}`}>
        <strong>{work.title}</strong> <small>{kinds[work.kind] ?? work.kind}{work.status ? ` · ${work.status}` : ''}</small>
        <span className="dt-mono">{work.id}</span>
      </li>)}</ul>}
      {!organization.work.length && !organization.error && <Hint>{t('workerCapabilitiesNoAffectedWork')}</Hint>}
    </div>)}
  </div>
}

function ApplicationConfirmation({ operation }: { operation: CapabilityOperation }) {
  const { t } = usePanel()
  const snapshot = operation.confirmation
  return <Modal open={!!snapshot} onClose={operation.close} title={t('workerCapabilitiesApplyNow')}
    closeLabel={t('close')} description={t('workerCapabilitiesConfirmInterruption')} className="dt-capability-confirmation"
    footer={<><Button disabled={operation.busy} onClick={operation.close}>{t('cancel')}</Button>
      <Button variant="primary" disabled={operation.busy} data-confirm-capability-application
        onClick={() => { void operation.confirm() }}>{t('workerCapabilitiesConfirmApply')}</Button></>}>
    {snapshot?.application && <><CapabilityValues value={snapshot} target /><AffectedWork application={snapshot.application} /></>}
  </Modal>
}
/** Read-only projection of the server's saved authorization, distinct from the checkbox draft. */
function AutomaticTools({ view }: { view: WorkerCapabilitiesView }) {
  const { t } = usePanel()
  return <Section title={t('workerAutomaticTools')}>
    <Hint>{t('workerAutomaticToolsHint')}</Hint>
    <dl className="dt-effective-tools">{view.effective.tools.filter(tool => tool.source === 'automatic').map(tool =>
      <div key={tool.name} data-automatic-tool={tool.name}><dt className="dt-mono">{tool.name}</dt>
        <dd><p>{t(`workerToolBoundary.${tool.constraint}`)}</p>
          {!!tool.requires.length && <small>{t('workerToolRequires', { tools: tool.requires.join(', ') })}</small>}</dd></div>)}</dl>
  </Section>
}
