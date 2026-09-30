import { useEffect, useState } from 'react'
import {
  fetchAttachedRepos,
  fetchSources,
  fetchWorkspaceModels,
  generateSml,
  importSmlGit,
  importSmlPath,
  saveSml,
  SmlValidationFailure,
  unlinkAttachedRepo,
  type AttachedRepo,
  type ImportedModel,
  type WorkspaceModel,
} from '../client'
import { MODEL_NAME_HINT, slugifyModelName } from '../lib/naming'
import { readOnlyReason, useModelStore } from '../modelStore'

interface Props {
  onClose: () => void
}

type Tab = 'save' | 'load'

/** Saving IS generating SML and writing it to disk; loading IS importing SML
 *  from a directory or a Git repo. There is no separate proprietary state
 *  format - two parsers (a Python one here and a browser one) for the same
 *  concept would just drift out of sync with each other.
 *
 *  Save always writes to workspace/<slugified-model-name>/ on the API
 *  server - the same directory Deploy stages into - so there's one working
 *  copy per model instead of the user having to type/remember a path. Load
 *  offers pickers over what already exists there (and over repos already
 *  attached to AtScale) instead of requiring a path/URL to be typed by hand;
 *  an "advanced" fallback still allows an arbitrary path/URL when needed. */
export function ManageModelModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('save')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  // Which workspace-model/repo button is currently being loaded - lets that
  // specific button highlight + show "Retrieving…" instead of the whole list
  // just going generically disabled with no indication of which one was clicked.
  const [loadingKey, setLoadingKey] = useState<string | null>(null)

  const [workspaceModels, setWorkspaceModels] = useState<WorkspaceModel[]>([])
  const [attachedRepos, setAttachedRepos] = useState<AttachedRepo[]>([])
  const [showAdvancedLoad, setShowAdvancedLoad] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [gitRepoUrl, setGitRepoUrl] = useState('')
  const [gitBranch, setGitBranch] = useState('main')

  const modelName = useModelStore((s) => s.modelName)
  const setModelName = useModelStore((s) => s.setModelName)
  const setSourceRepo = useModelStore((s) => s.setSourceRepo)
  const sourceMeta = useModelStore((s) => s.sourceMeta)
  const nodes = useModelStore((s) => s.nodes)
  const joins = useModelStore((s) => s.joins)
  const cfg = useModelStore((s) => s.cfg)
  const calculations = useModelStore((s) => s.calculations)
  const loadModelData = useModelStore((s) => s.loadModelData)
  const setSourceId = useModelStore((s) => s.setSourceId)
  const readOnly = useModelStore(readOnlyReason)

  useEffect(() => {
    if (tab !== 'load') return
    fetchWorkspaceModels().then(setWorkspaceModels).catch(() => setWorkspaceModels([]))
    fetchAttachedRepos().then(setAttachedRepos).catch(() => setAttachedRepos([]))
  }, [tab])

  // The imported SML names its connection by AtScale's `as_connection` value,
  // not by the registered source's connectionId, and its database can be a
  // placeholder (real sample repos ship with "<YOUR DATABASE>") - so try to
  // match it against this session's actual registered sources first, and
  // only fall back to the guessed values (dialect included) if nothing matches.
  async function applyImportedSource(source: ImportedModel['source']) {
    if (!source) return
    const sources = await fetchSources().catch(() => [])
    const match = sources.find(
      (s) =>
        source.connectionId &&
        s.connectionId.toLowerCase() === source.connectionId.toLowerCase() &&
        (!source.database || s.database.toLowerCase() === source.database.toLowerCase()),
    )
    setSourceId(match?.id ?? null, {
      dialect: match?.dialect ?? source.dialect,
      connectionId: match?.connectionId ?? source.connectionId ?? '',
      database: match?.database ?? source.database ?? '',
    })
  }

  async function handleSave() {
    if (readOnly) {
      setError(readOnly)
      return
    }
    if (!sourceMeta) {
      setError('Select a data source before saving.')
      return
    }
    const schema = nodes[0]?.schema
    if (!schema) {
      setError('Add at least one table to the canvas before saving.')
      return
    }
    if (!modelName.trim()) {
      setError('Enter a model name before saving.')
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const { files } = await generateSml({
        modelName,
        connectionName: `con_${sourceMeta.database}_${schema}`,
        asConnection: sourceMeta.connectionId,
        database: sourceMeta.database,
        schema,
        dialect: sourceMeta.dialect,
        nodes,
        joins,
        cfg,
        calculations,
      })
      const result = await saveSml(modelName, files)
      setStatus(`Saved ${result.count} files to ${result.path}`)
    } catch (err) {
      if (err instanceof SmlValidationFailure) {
        setError(err.errors.join('\n'))
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleLoadWorkspaceModel(model: WorkspaceModel) {
    setBusy(true)
    setLoadingKey(`ws:${model.path}`)
    setError(null)
    try {
      const result = await importSmlPath(model.path)
      await applyImportedSource(result.source)
      // Workspace directory names are already slugified (they're written by
      // /sml/save via model_workspace_dir) - safe to use verbatim here.
      setModelName(model.name)
      // If this workspace dir is a real git clone (previously pulled from
      // AtScale), carry its remote forward so Deploy commits + pushes to the
      // same history instead of trying to create a brand new repo.
      setSourceRepo(model.gitRepoUrl ? { url: model.gitRepoUrl, branch: model.gitBranch ?? 'main' } : null)
      loadModelData({
        nodes: result.nodes as never[],
        joins: result.joins as never[],
        cfg: result.cfg as never,
        calculations: result.calculations as never[],
        loadedFrom: { builtHere: !!result.builtHere, unsupported: result.unsupported ?? [] },
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setLoadingKey(null)
    }
  }

  async function handleLoadRepo(repo: AttachedRepo) {
    setBusy(true)
    setLoadingKey(`repo:${repo.repoId}`)
    setError(null)
    try {
      // Passing modelName clones straight into this model's workspace
      // directory (instead of an anonymous cache dir) so a later Deploy
      // commits on top of real history and fast-forward-pushes cleanly.
      const result = await importSmlGit({ repoUrl: repo.url, branch: repo.branch, modelName: repo.name })
      await applyImportedSource(result.source)
      // AtScale's own repo display name is allowed to contain spaces (it's
      // not a Git identifier) - the "-/_ only" rule is enforced only when the
      // user types a *new* name in the UI, not on a name already on record.
      setModelName(repo.name)
      setSourceRepo({ url: repo.url, branch: repo.branch })
      loadModelData({
        nodes: result.nodes as never[],
        joins: result.joins as never[],
        cfg: result.cfg as never,
        calculations: result.calculations as never[],
        loadedFrom: { builtHere: !!result.builtHere, unsupported: result.unsupported ?? [] },
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setLoadingKey(null)
    }
  }

  /** Removes a now-broken "attached" entry (e.g. its GitHub repo was deleted
   *  outside the wizard) from AtScale's own repo-attachment record - doesn't
   *  touch anything already deployed, just lets the Load tab's list recover
   *  instead of showing a dead entry forever. */
  async function handleUnlinkRepo(repo: AttachedRepo) {
    if (!window.confirm(`Unlink "${repo.name}" from AtScale? This only removes AtScale's repo attachment record, not anything already deployed.`)) {
      return
    }
    setBusy(true)
    setLoadingKey(`unlink:${repo.repoId}`)
    setError(null)
    try {
      await unlinkAttachedRepo(repo.repoId)
      setAttachedRepos((prev) => prev.filter((r) => r.repoId !== repo.repoId))
      setStatus(`Unlinked "${repo.name}".`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setLoadingKey(null)
    }
  }

  // The path field is read directly by the API server (which runs on the
  // same machine as the SML repo, unlike the browser) - no file picker needed.
  async function handleImportPath() {
    if (!importPath.trim()) {
      setError('Enter a directory to load the SML from.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await importSmlPath(importPath.trim())
      await applyImportedSource(result.source)
      setSourceRepo(null)
      loadModelData({
        nodes: result.nodes as never[],
        joins: result.joins as never[],
        cfg: result.cfg as never,
        calculations: result.calculations as never[],
        loadedFrom: { builtHere: !!result.builtHere, unsupported: result.unsupported ?? [] },
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleImportGit() {
    setBusy(true)
    setError(null)
    try {
      const result = await importSmlGit({ repoUrl: gitRepoUrl.trim() || undefined, branch: gitBranch.trim() })
      await applyImportedSource(result.source)
      setSourceRepo(gitRepoUrl.trim() ? { url: gitRepoUrl.trim(), branch: gitBranch.trim() } : null)
      loadModelData({
        nodes: result.nodes as never[],
        joins: result.joins as never[],
        cfg: result.cfg as never,
        calculations: result.calculations as never[],
        loadedFrom: { builtHere: !!result.builtHere, unsupported: result.unsupported ?? [] },
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resolvedSavePath = `workspace/${slugifyModelName(modelName) || '…'}`

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="sml-modal-header">
          <div className="identity-title">Save / Load Model</div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--as-hairline)' }}>
          {(['save', 'load'] as Tab[]).map((t) => (
            <div
              key={t}
              className={`sml-file-tab ${tab === t ? 'sml-file-tab-active' : ''}`}
              style={{ flex: 1, textAlign: 'center', textTransform: 'uppercase' }}
              onClick={() => setTab(t)}
            >
              {t}
            </div>
          ))}
        </div>

        <div style={{ padding: 20 }}>
          {error && (
            <div className="login-error" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}
          {status && (
            <div className="field-note" style={{ marginBottom: 12 }}>
              {status}
            </div>
          )}

          {tab === 'save' && (
            <div>
              <div className="field-note" style={{ marginBottom: 12 }}>
                Generates the SML for the current model and writes it to this model's
                workspace directory on the machine running the API server.
              </div>
              <label className="field">
                Model name
                <input
                  value={modelName}
                  onChange={(e) => setModelName(slugifyModelName(e.target.value))}
                  title={MODEL_NAME_HINT}
                />
              </label>
              <div className="field-note" style={{ marginTop: -8, marginBottom: 12 }}>
                {MODEL_NAME_HINT}
              </div>
              <label className="field">
                Save to
                <input className="mono-input" value={resolvedSavePath} readOnly />
              </label>
              {readOnly && <div className="login-error" style={{ marginBottom: 12 }}>{readOnly}</div>}
              <button className="btn btn-primary" disabled={busy || !!readOnly} title={readOnly ?? undefined} onClick={handleSave}>
                {busy ? 'Saving…' : 'Generate & save'}
              </button>
            </div>
          )}

          {tab === 'load' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <div className="section-label" style={{ marginBottom: 8 }}>
                  Saved in this workspace
                </div>
                {workspaceModels.length === 0 && (
                  <div className="field-note">No models saved under workspace/ yet.</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {workspaceModels.map((m) => {
                    const key = `ws:${m.path}`
                    const isLoading = loadingKey === key
                    return (
                      <button
                        key={m.path}
                        className={`btn btn-ghost ${isLoading ? 'btn-loading' : ''}`}
                        style={{ justifyContent: 'flex-start' }}
                        disabled={busy}
                        onClick={() => handleLoadWorkspaceModel(m)}
                      >
                        {isLoading ? `Retrieving ${m.name}…` : m.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <div className="section-label" style={{ marginBottom: 8 }}>
                  Attached on this host
                </div>
                {attachedRepos.length === 0 && (
                  <div className="field-note">No Git repos currently attached in AtScale.</div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {attachedRepos.map((r) => {
                    const key = `repo:${r.repoId}`
                    const isLoading = loadingKey === key
                    const isUnlinking = loadingKey === `unlink:${r.repoId}`
                    return (
                      <div key={r.repoId} style={{ display: 'flex', gap: 4 }}>
                        <button
                          className={`btn btn-ghost ${isLoading ? 'btn-loading' : ''}`}
                          style={{ justifyContent: 'flex-start', flex: 1 }}
                          disabled={busy}
                          onClick={() => handleLoadRepo(r)}
                          title={r.url}
                        >
                          {isLoading ? (
                            `Retrieving ${r.name}…`
                          ) : (
                            <>
                              {r.name}
                              {r.projects.length > 0 && (
                                <span style={{ opacity: 0.6 }}>
                                  {' '}
                                  — {r.projects.map((p) => p.name).join(', ')}
                                </span>
                              )}
                            </>
                          )}
                        </button>
                        <button
                          className="btn btn-ghost"
                          disabled={busy}
                          onClick={() => handleUnlinkRepo(r)}
                          title="Unlink this repo from AtScale (e.g. its Git repo was deleted elsewhere)"
                        >
                          {isUnlinking ? '…' : '✕'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div>
                <div
                  className="section-label"
                  style={{ marginBottom: 8, cursor: 'pointer' }}
                  onClick={() => setShowAdvancedLoad((v) => !v)}
                >
                  {showAdvancedLoad ? '▾' : '▸'} Advanced: load from a specific path or URL
                </div>
                {showAdvancedLoad && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <div>
                      <label className="field">
                        Path (on the machine running the API server)
                        <input
                          className="mono-input"
                          placeholder="/path/to/sml-repo"
                          value={importPath}
                          onChange={(e) => setImportPath(e.target.value)}
                        />
                      </label>
                      <button className="btn btn-primary" disabled={busy} onClick={handleImportPath}>
                        {busy ? 'Loading…' : 'Load from path'}
                      </button>
                    </div>

                    <div>
                      <label className="field">
                        Repo URL
                        <input
                          className="mono-input"
                          placeholder="https://github.com/org/repo.git"
                          value={gitRepoUrl}
                          onChange={(e) => setGitRepoUrl(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        Branch
                        <input value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} />
                      </label>
                      <button className="btn btn-primary" disabled={busy} onClick={handleImportGit}>
                        {busy ? 'Pulling…' : 'Pull and load'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
