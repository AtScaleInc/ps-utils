import { useEffect, useState } from 'react'
import { fetchSharedRepos, loadSharedRepo, type LoadedSharedRepo, type SharedRepo } from '../client'
import { localNodes, packagesOf, useModelStore } from '../modelStore'
import { PickList } from './PickList'

interface Props {
  hostId: string
  onClose: () => void
}

/** Build > Develop > Shared dims: pick a shared dimensions repo (tagged by
 *  Build, or a repo with no model), load its dimensions at the branch head and
 *  add the chosen ones to the canvas as read-only nodes. Generate then writes
 *  package.yml with that commit (api/smlgen/packages.py). */
export function SharedDimsModal({ hostId, onClose }: Props) {
  const [repos, setRepos] = useState<SharedRepo[] | null>(null)
  const [repoUrl, setRepoUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedSharedRepo | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nodes = useModelStore((s) => s.nodes)
  const addSharedDimensions = useModelStore((s) => s.addSharedDimensions)

  function loadRepos(refresh = false) {
    setRepos(null)
    setError(null)
    fetchSharedRepos(hostId, refresh).then(setRepos).catch((e) => { setRepos([]); setError(e.message) })
  }
  useEffect(() => loadRepos(), [hostId])

  const repo = repos?.find((r) => r.url === repoUrl) ?? null
  const onCanvas = new Set(nodes.filter((n) => n.package && repo && n.package.url === repo.url).map((n) => n.dimName))

  async function pickRepo(url: string) {
    setRepoUrl(url)
    setLoaded(null)
    setPicked([])
    const r = repos?.find((x) => x.url === url)
    if (!r) return
    setBusy(true)
    setError(null)
    try {
      const taken = packagesOf(useModelStore.getState()).filter((p) => p.url !== r.url).map((p) => p.name)
      const result = await loadSharedRepo({ repoUrl: r.url, branch: r.branch, taken })
      setLoaded(result)
      const present = new Set(useModelStore.getState().nodes.filter((n) => n.package?.url === r.url).map((n) => n.dimName))
      setPicked(result.nodes.map((n) => n.dimName!).filter((d) => !present.has(d)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function add() {
    if (!loaded) return
    const keep = new Set(loaded.nodes.filter((n) => picked.includes(n.dimName!)).map((n) => n.id))
    addSharedDimensions({
      nodes: loaded.nodes.filter((n) => keep.has(n.id)),
      joins: loaded.joins,
      cfg: loaded.cfg,
    }, loaded.package)
    onClose()
  }

  const sha = loaded?.package.version.replace('commit:', '').slice(0, 7)
  // Same rule as BuildView's buildPayload: the model's connection is con_<database>_<schema>.
  const sourceMeta = useModelStore((s) => s.sourceMeta)
  const schema = localNodes({ nodes })[0]?.schema
  const modelConnection = sourceMeta && schema ? `con_${sourceMeta.database}_${schema}` : null
  const clash = loaded?.connections.find((c) => c === modelConnection)

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="sml-modal-header">
          <div>
            <div className="eyebrow" style={{ color: 'var(--as-dimension)' }}>PACKAGE</div>
            <div className="identity-title">Shared dimensions</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => loadRepos(true)} disabled={!repos}>↻ Refresh</button>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        </div>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field-note">
            Repos published from Build as shared dimensions, or repos with no model. The dimensions join your
            canvas read-only; the model lists the repo in <code>package.yml</code> pinned to its latest commit.
          </div>
          {error && <div className="login-error" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
          <PickList
            autoFocus
            options={(repos ?? []).map((r) => ({
              value: r.url, label: r.name, prefix: r.fullName.includes('/') ? r.fullName.split('/')[0] : undefined,
              group: r.tagged ? 'Shared dimensions' : r.source === 'host' ? 'Attached on this host, no model' : 'No model',
              hint: r.branch, keywords: r.url,
            }))}
            value={repoUrl}
            onChange={pickRepo}
            placeholder="Pick a shared dimensions repo…"
            searchPlaceholder="Search repos"
            loading={repos === null ? 'Looking for shared dimension repos…' : undefined}
            emptyNote="No shared dimension repos found. Publish one: a canvas with dimensions and no fact → Deploy."
          />
          {busy && <div className="field-note">Reading {repo?.name} at the head of {repo?.branch}…</div>}
          {loaded && (
            <>
              <div className="field-note">
                <b>{loaded.package.name}</b> · {repo?.branch} @ <code>{sha}</code> — {loaded.commit.message}
              </div>
              <PickList
                multi
                options={loaded.nodes.map((n) => ({
                  value: n.dimName!, label: n.dimName!, hint: onCanvas.has(n.dimName) ? 'on canvas' : n.table,
                  disabled: onCanvas.has(n.dimName),
                }))}
                value={picked}
                onChange={setPicked}
                placeholder="Pick dimensions…"
                searchPlaceholder="Search dimensions"
              />
              {clash && (
                <div className="login-error">
                  This repo's connection is named <code>{clash}</code> - the same as this model's, so AtScale
                  rejects the deploy ("connection name is not unique"). Load the shared repo in Build and publish it
                  again: its connection is then named <code>{clash}_shared_dim</code>. Then pick it here again.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-primary" disabled={!picked.length && !onCanvas.size} onClick={add}>
                  {picked.length ? `Add ${picked.length} dimension${picked.length === 1 ? '' : 's'}` : 'Update to this commit'}
                </button>
                {onCanvas.size > 0 && (
                  <span className="field-note">Dimensions already on the canvas move to <code>{sha}</code>.</span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
