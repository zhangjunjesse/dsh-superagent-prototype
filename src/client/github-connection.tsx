/** GitHub account connection and the separately saved, non-secret receiving preferences. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GithubConnectionInput, GithubConnectionView } from '../app/github-connection.ts'
import type { SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, Input, SegmentedControl, StateDot, Switch, Tag, type DotState } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { Field, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { errorText, localized } from './text.ts'
import { ActionLink, CheckSetupButton, Hint, SetupMessage } from './widgets.tsx'

const working = (view: GithubConnectionView | undefined) => view?.job?.status === 'checking' || view?.job?.status === 'saving'

/** Drops reads that began before a mutation, and resumes polling after reconnecting or returning to this page. */
function useConnection() {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const [view, setView] = useState<GithubConnectionView>()
  const [error, setError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [requesting, setRequesting] = useState(false)
  const generation = useRef(0), mounted = useRef(true), mutating = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1 } }, [])
  const refresh = useCallback(async () => {
    if (mutating.current) return
    const from = generation.current
    try {
      const next = await call('GET github/connection')
      if (mounted.current && from === generation.current) { setView(next); setError(undefined) }
    } catch (failure) {
      if (mounted.current && from === generation.current) setError(errorText(failure))
    }
  }, [call])
  const active = working(view)
  useEffect(() => {
    if (requesting) return
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await refresh()
      if (alive) timer = setTimeout(() => { void poll() }, (active ? 1000 : 5000) * (document.hidden ? 6 : 1))
    }
    void poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [refresh, active, requesting, restarts])
  const mutate = async (action: () => Promise<GithubConnectionView>) => {
    if (mutating.current) return
    mutating.current = true; generation.current += 1; setRequesting(true); setError(undefined); setActionError(undefined)
    try { const next = await action(); if (mounted.current) setView(next) }
    catch (failure) { if (mounted.current) setActionError(errorText(failure)) }
    finally {
      mutating.current = false; generation.current += 1
      if (mounted.current) setRequesting(false)
    }
  }
  return { view, error: actionError ?? error, requesting, refresh: () => { setActionError(undefined); return refresh() },
    connect: (body: GithubConnectionInput) => mutate(() => call('POST github/connection', { body })),
    cancel: (id: string) => mutate(() => call('POST github/connection/cancel', { body: { id } })) }
}

type ConnectionStatusName = NonNullable<GithubConnectionView['job']>['status'] | 'loading' | 'saved' | 'notConnected'
function connectionMark(view: GithubConnectionView | undefined): { state: DotState; status: ConnectionStatusName } {
  if (!view) return { state: 'ongoing', status: 'loading' }
  const saved = view.connection.configured ? view.connection.login ? 'connected' : 'saved' : 'notConnected'
  const status = view.job?.status === 'connected' ? saved : view.job?.status ?? saved
  const state = status === 'connected' ? 'done' : status === 'checking' || status === 'saving' ? 'ongoing'
    : status === 'failed' ? 'error' : status === 'cancelled' || status === 'interrupted' ? 'warning' : 'idle'
  return { state, status }
}

function ConnectionStatus({ source, view, error, refresh }: {
  source: SourceView; view: GithubConnectionView | undefined; error: string | undefined; refresh: () => Promise<void>
}) {
  const { t } = usePanel()
  const { setup } = usePanelData()
  const mark = connectionMark(view)
  const connection = view?.connection
  const ready = !!connection?.login && setup?.accounts?.agent === connection.login
    && setup.accounts.repository === connection.repository && !setup.problem
  const job = view?.job
  const detail = job?.errorCode === 'cli-missing' && view?.cli ? t('githubConnectionCliRetry')
    : job?.errorCode ? t(`githubConnectionError.${job.errorCode}`) : undefined
  return <div className="dt-github-status" data-state={error && !view ? 'error' : mark.state} aria-live="polite">
    <div className="dt-github-status-title"><StateDot state={error && !view ? 'error' : mark.state} />
      <strong>{t(error && !view ? 'githubConnectionStatus.unavailable' : `githubConnectionStatus.${mark.status}`)}</strong>
      {connection?.managed && <Tag tone="quiet">{t('githubConnectionProtected')}</Tag>}
    </div>
    {connection?.repository && <div className="dt-github-current">
      <span className="dt-github-repository"><Icon name="pull" size={15} />{connection.repository}</span>
      <span><Icon name="user" size={15} />{connection.login ? `@${connection.login}` : t('githubConnectionAccountUnchecked')}</span>
    </div>}
    {!connection?.configured && !job && <Hint>{t('githubConnectionIntro')}</Hint>}
    {detail && <p className={job?.status === 'failed' ? 'dt-error' : 'dt-hint'} role={job?.status === 'failed' ? 'alert' : undefined}>{detail}</p>}
    {error && <div className="dt-github-api-error"><p className="dt-error" role="alert">{error}</p>
      <Button variant="outline" size="sm" onClick={() => { void refresh() }}>{t('githubConnectionRetry')}</Button></div>}
    {view && !view.available && <p className="dt-error" role="alert">{t('githubConnectionError.source-unavailable')}</p>}
    {connection?.configured && <p className="dt-github-readiness" data-ready={ready || undefined}>
      <StateDot state={ready ? 'done' : 'idle'} />{t(ready ? 'githubConnectionDeploymentReady' : 'githubConnectionDeploymentPending')}
    </p>}
    {source.problem && source.problem.code !== 'repositoryUnset' && <div className="dt-github-setup">
      <p className="dt-error"><SetupMessage problem={source.problem} lead /></p><CheckSetupButton />
    </div>}
  </div>
}

/** Erases the native field even when switching methods removes it before the parent connection form unmounts. */
function TokenInput({ id, value, onChange }: { id?: string; value: string; onChange: (value: string) => void }) {
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const input = field.current
    return () => { if (input) { input.value = ''; input.removeAttribute('value') } }
  }, [])
  return <span className="dt-input"><input ref={field} id={id} type="password" autoComplete="off" spellCheck={false}
    autoCapitalize="none" value={value} required placeholder="ghp_…" onChange={event => onChange(event.target.value)} /></span>
}

function ConnectionMethod({ method, setMethod, token, setToken, cli, setCli, view, source, disabled }: {
  method: GithubConnectionInput['method']; setMethod: (method: GithubConnectionInput['method']) => void
  token: string; setToken: (token: string) => void; cli: string; setCli: (cli: string) => void
  view: GithubConnectionView | undefined; source: SourceView; disabled: boolean
}) {
  const { t } = usePanel()
  const [advanced, setAdvanced] = useState(false)
  return <>
    <div className="dt-field"><span className="dt-field-head">{t('githubConnectionMethod')}</span>
      <SegmentedControl label={t('githubConnectionMethod')} value={method} disabled={disabled}
        options={view && !view.tokenSupported ? [{ value: 'existing', label: t('githubConnectionExisting') }]
          : [{ value: 'token', label: t('githubConnectionToken') }, { value: 'existing', label: t('githubConnectionExisting') }]}
        onChange={next => { setToken(''); setMethod(next) }} />
    </div>
    {method === 'token' ? <div className="dt-github-auth">
      <Field label={t('githubConnectionTokenLabel')} note={t('githubConnectionTokenHint')}>
        <TokenInput value={token} onChange={setToken} />
      </Field>
      <ActionLink href="https://github.com/settings/tokens/new?scopes=repo&description=Superagent">{t('githubConnectionCreateToken')}</ActionLink>
    </div> : <div className="dt-github-auth">
      <Hint>{t('githubConnectionExistingHint')}</Hint>
    </div>}
    {view && (!view.connection.configured || method === 'token' && !view.cli)
      && <p className="dt-hint">{view.cli ? t('githubConnectionCliFound', { cli: view.cli }) : t('githubConnectionCliMissing')}</p>}
    <DisclosureRow icon={<Icon name="settings" />} title={t('githubConnectionAdvanced')} open={advanced}
      onToggle={() => setAdvanced(!advanced)}>
      <div className="dt-disclosure-body"><Field label={t('githubConnectionCliLabel')} note={t('githubConnectionCliHint')}>
        <Input spellCheck={false} autoComplete="off" value={cli}
          placeholder={String(source.value.config.cli || view?.cli || 'gh')} onChange={event => setCli(event.target.value)} />
      </Field></div>
    </DisclosureRow>
  </>
}

function GithubConnection({ source }: { source: SourceView }) {
  const { t, restart } = usePanel()
  const { running, reload: reloadState } = usePanelData()
  const { reload } = useSettings()
  const connection = useConnection(), { view } = connection
  const [repository, setRepository] = useState(String(source.value.config.repository ?? ''))
  const [repositoryEdited, setRepositoryEdited] = useState(false)
  const [method, setMethod] = useState<GithubConnectionInput['method']>(source.value.config.repository && source.value.config.cli
    ? 'existing' : 'token')
  // Credentials deliberately bypass useBlockDraft: they never enter browser storage or a settings/history payload.
  const [token, setToken] = useState(''), [cli, setCli] = useState('')
  const completed = useRef(''), activeJob = useRef(''), startedHere = useRef(false)
  useEffect(() => {
    if (!repositoryEdited) setRepository(String(source.value.config.repository ?? ''))
  }, [source.value.config.repository, repositoryEdited])
  useEffect(() => { if (view && !view.tokenSupported) { setMethod('existing'); setToken('') } }, [view?.tokenSupported])
  const job = view?.job
  useEffect(() => {
    if (!job) return
    if (working(view)) { activeJob.current = job.id; return }
    if (completed.current === `${job.id}:${job.status}`) return
    completed.current = `${job.id}:${job.status}`
    if (job.status === 'connected') {
      setRepositoryEdited(false); setCli('')
      if (job.restarting && (activeJob.current === job.id || startedHere.current)) restart()
    }
    activeJob.current = ''; startedHere.current = false
    void Promise.allSettled([reload(), reloadState()])
  }, [job?.id, job?.status, job?.restarting, reload, reloadState, restart])
  const busy = connection.requesting || working(view)
  const canConnect = view?.available && !busy && repository.trim() && (method === 'existing' || token.trim())
  return <section className="dt-github-connection" aria-label={t('githubConnectionHeading')}>
    <ConnectionStatus source={source} view={view} error={connection.error} refresh={connection.refresh} />
    <form className="dt-github-connect-form" autoComplete="off" onSubmit={event => {
      event.preventDefault()
      if (!canConnect) return
      const input: GithubConnectionInput = { revision: source.revision, repository: repository.trim(), method,
        ...method === 'token' ? { token } : {}, ...cli.trim() ? { cli: cli.trim() } : {} }
      setToken(''); startedHere.current = true
      void connection.connect(input)
    }}>
      <Fields disabled={busy || !view?.available}>
        <Field label={t('githubConnectionRepository')} note={t('githubConnectionRepositoryHint')}>
          <Input autoComplete="off" spellCheck={false} value={repository} required placeholder="https://github.com/owner/repository"
            onChange={event => { setRepositoryEdited(true); setRepository(event.target.value) }} />
        </Field>
        <ConnectionMethod method={method} setMethod={setMethod} token={token} setToken={setToken} cli={cli} setCli={setCli}
          view={view} source={source} disabled={busy || !view?.available} />
      </Fields>
      <div className="dt-github-connect-actions">
        <p className="dt-hint">{busy ? t(job?.status === 'saving' ? 'githubConnectionSavingHint' : 'githubConnectionCheckingHint')
          : running > 0 ? t('githubConnectionRestartImpact', { count: running }) : t('githubConnectionSaveHint')}</p>
        <div className="dt-actions">
          {working(view) && <Button variant="outline" disabled={connection.requesting || job?.status === 'saving'}
            onClick={() => { if (job) void connection.cancel(job.id) }}>{t('cancel')}</Button>}
          <Button type="submit" variant="primary" disabled={!canConnect} aria-busy={busy} icon={<Icon name={busy ? 'running' : 'shield'} />}
            className={busy ? 'dt-btn-busy' : undefined}>{t(busy ? job?.status === 'saving' ? 'githubConnectionSaving'
              : 'githubConnectionChecking' : view?.connection.configured ? 'githubConnectionUpdate' : 'githubConnectionConnect')}</Button>
        </div>
      </div>
    </form>
  </section>
}

const receivingConfig = (config: Record<string, unknown>) => Object.fromEntries(Object.entries(config)
  .filter(([key]) => key !== 'repository' && key !== 'cli'))

export function GithubSourceCard({ source }: { source: SourceView }) {
  const { t } = usePanel()
  const [advanced, setAdvanced] = useState(false)
  const saved = { enabled: source.value.enabled, config: receivingConfig(source.value.config) }
  // Merge only receiving changes into the latest saved connection; a pending draft cannot restore an old account or repository.
  const draft = useBlockDraft(`source:${source.id}`, saved, source.revision, next => ({ ...next,
    config: { ...source.value.config, ...receivingConfig(next.config) } }))
  const fields = source.fields.filter(field => field.key !== 'repository' && field.key !== 'cli')
  const field = (spec: typeof fields[number]) => <SourceField key={spec.key} field={spec} value={draft.value.config[spec.key]}
    saved={saved.config[spec.key]} fact={source.facts[spec.key]} labels={source.labels}
    onChange={next => draft.edit({ ...draft.value, config: { ...draft.value.config, [spec.key]: next } })} />
  return <div id={`dt-source-${source.id}`} className="dt-card dt-github-card">
    <div className="dt-card-head"><div className="dt-row-main"><div className="dt-row-title">
      <span className="dt-card-title">{localized(t, source.title)}</span></div><Hint>{t('githubConnectionCardHint')}</Hint></div>
      <span className="dt-github-brand"><Icon name="pull" size={22} /></span></div>
    <GithubConnection source={source} />
    <form className="dt-github-receiving" aria-label={t('githubReceivingHeading')} onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-github-receiving-head"><div><h3>{t('githubReceivingHeading')}</h3><Hint>{t('githubReceivingHint')}</Hint></div>
          <Switch checked={draft.value.enabled} label={t('githubReceivingEnable')}
            onChange={enabled => draft.edit({ ...draft.value, enabled })} /></div>
        <div className="dt-github-receiving-options">{fields.filter(spec => !spec.advanced).map(field)}</div>
        {fields.some(spec => spec.advanced) && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advanced}
          onToggle={() => setAdvanced(!advanced)}><div className="dt-disclosure-body">{fields.filter(spec => spec.advanced).map(field)}</div>
        </DisclosureRow>}
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  </div>
}
