/** Exact server-side legacy configuration archives; copying never applies old text to a complete prompt. */
import type { OriginalConfigurationMigration, OriginalPromptFieldMigration } from '../process-runtime/original-config.ts'
import { usePoll } from './api.ts'
import { Button } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { Hint, KeyValues, LoadState, Section } from './widgets.tsx'

export function ConfigurationMigrations() {
  const { t, call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error } = usePoll(() => call('GET configuration-migrations'), [call, restarts])
  return <section className="dt-form dt-configuration-migrations" aria-label={t('configurationMigrations')}>
    <Section title={t('configurationMigrations')}><Hint>{t('configurationMigrationsHint')}</Hint>
      {error && <LoadState loading={false} error={error} />}
      {!data && !error && <LoadState loading />}
      {data?.items.length === 0 && <Hint>{t('configurationMigrationsNone')}</Hint>}
      {data?.items.map(migration => <Migration key={migration.id} migration={migration} />)}
    </Section>
  </section>
}

function CopyText({ text }: { text: string }) {
  const { t, notify } = usePanel()
  const copy = useAction(async () => {
    if (!navigator.clipboard?.writeText) throw new Error(t('migrationCopyUnavailable'))
    await navigator.clipboard.writeText(text)
    notify(t('copied'))
  })
  return <Button variant="outline" size="sm" disabled={copy.busy} onClick={() => { void copy.run() }}>{t('migrationCopyExact')}</Button>
}

function FieldArchive({ field, text }: { field: OriginalPromptFieldMigration; text: string }) {
  const { t } = usePanel()
  return <details className="dt-migration-field" open={field.status === 'pending'} data-migration-field={field.key}>
    <summary>{t(`legacyPromptField.${field.key}`)} · {t(`migrationStatus.${field.status}`)}</summary>
    <div className="dt-form"><Hint>{t(`migrationReason.${field.reason}`)}</Hint>
      <pre className="dt-pre dt-migration-text">{text}</pre><CopyText text={text} /></div>
  </details>
}

function Migration({ migration }: { migration: OriginalConfigurationMigration }) {
  const { t } = usePanel()
  const baseline = migration.legacyDefaults
  return <details className="dt-migration-record" open={migration.status === 'pending'} data-migration-id={migration.id}>
    <summary>{migration.recordedAt} · {t(migration.status === 'pending' ? 'migrationPending' : 'migrationRecorded')}</summary>
    <div className="dt-form">
      <KeyValues rows={[[t('migrationIdentity'), migration.instanceId], [t('migrationArchiveId'), migration.id],
        [t('migrationRecordedAt'), migration.recordedAt], [t('migrationOriginalPromptRevision'), String(migration.original.promptRevision)],
        [t('migrationOriginalSettingsRevision'), String(migration.original.settingsRevision)],
        [t('migrationAppliedRevision'), String(migration.appliedPromptRevision)], [t('migrationSha256'), migration.sha256]]} />
      <Section title={t('migrationSource')}><pre className="dt-pre">{JSON.stringify(migration.source, null, 2)}</pre></Section>
      {!baseline && <Hint>{t('migrationNoVerifiedBaseline')}</Hint>}
      {migration.fields.map(field => <FieldArchive key={field.key} field={field} text={migration.legacyEngine.prompts[field.key]} />)}
      {baseline && <details><summary>{t('migrationBaseline')}</summary><div className="dt-form">
        <pre className="dt-pre">{JSON.stringify(baseline.source, null, 2)}</pre>
        {migration.fields.map(field => <Section key={field.key} title={t(`legacyPromptField.${field.key}`)}>
          <pre className="dt-pre dt-migration-text">{baseline.engine.prompts[field.key]}</pre><CopyText text={baseline.engine.prompts[field.key]} />
        </Section>)}</div></details>}
      <div className="dt-actions"><CopyText text={JSON.stringify(migration, null, 2)} /><Hint>{t('migrationWholeRecord')}</Hint></div>
    </div>
  </details>
}
