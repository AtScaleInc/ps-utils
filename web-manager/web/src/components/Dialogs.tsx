import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Host, type ModelRow } from '../api'
import { useUi } from '../store'
import { BranchSelect, errMsg } from './ui'

export function AskDialog() {
  const { ask, setAsk } = useUi()
  if (!ask) return null
  const color = ask.tone === 'prod' ? 'var(--prod)' : 'var(--danger)'
  return (
    <div className="scrim" onClick={() => setAsk(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow" style={{ color }}>{ask.eyebrow}</span>
        <span className="display">{ask.tone === 'prod' ? <>This change lands in <em>production</em>.</> : ask.title}</span>
        <span className="note">{ask.note}</span>
        {ask.items && (
          <div className="list">
            {ask.items.map((i) => (
              <div key={i.name}>
                <span className="mono" style={{ fontSize: 11.5 }}>{i.name}</span>
                {i.pill && <span className="pill" style={{ background: i.pill.bg, color: i.pill.fg }}>{i.pill.label}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn lg ghost" onClick={() => setAsk(null)}>Cancel</button>
          <button type="button" className="btn lg solid" style={{ background: color }} onClick={() => { ask.go(); setAsk(null) }}>{ask.label}</button>
        </div>
      </div>
    </div>
  )
}

export function LinkModelDialog({ host }: { host: Host }) {
  const { setLinkOpen, flash } = useUi()
  const qc = useQueryClient()
  const repos = useQuery({ queryKey: ['gitRepos'], queryFn: api.gitRepos, staleTime: 60_000 })
  const onHost = useQuery({ queryKey: ['models', host.id], queryFn: () => api.models(host.id) })
  const [repoUrl, setRepoUrl] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [model, setModel] = useState('')

  const list = repos.data?.repos ?? []
  const repo = list.find((r) => r.url === repoUrl) ?? list[0]
  const br = branch ?? repo?.defaultBranch ?? 'main'
  const repoModels = useQuery({
    queryKey: ['gitRepoModels', repo?.url, br],
    queryFn: () => api.gitRepoModels(repo!.url, br),
    enabled: !!repo && !repo.models,
  })
  const taken = new Set((onHost.data?.models ?? []).map((m) => m.name))
  const opts = (repo?.models ?? repoModels.data?.models ?? []).filter((m) => !taken.has(m))
  const picked = opts.includes(model) ? model : opts[0] ?? ''

  const link = useMutation({
    mutationFn: () => api.link(host.id, { repoUrl: repo!.url, branch: br, model: picked }),
    onSuccess: () => {
      flash(`${picked} linked from ${repo!.fullName.split('/').pop()}@${br}`)
      setLinkOpen(false)
    },
    onError: (e) => flash(errMsg(e), 'err'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['models', host.id] }),
  })

  const loadingModels = repoModels.isFetching
  const error = repos.error ?? repoModels.error

  return (
    <div className="scrim" onClick={() => setLinkOpen(false)}>
      <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow" style={{ color: 'var(--dev)' }}>Link model · {host.label}</span>
        <span className="display">Link a model from <em>Git</em>.</span>
        <span className="note">Linking registers the SML repository on this host. Deploy it afterwards from the model list.</span>
        <label className="field">
          <span className="label">Git repository</span>
          <select className="select" style={{ height: 34, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} value={repo?.url ?? ''}
            onChange={(e) => { setRepoUrl(e.target.value); setBranch(null); setModel('') }} disabled={!list.length}>
            {repos.isLoading && <option>Loading repositories with catalog.yml…</option>}
            {repos.isSuccess && !list.length && <option>No repositories with catalog.yml</option>}
            {list.map((r) => <option key={r.url} value={r.url}>{r.fullName}</option>)}
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 10 }}>
          <label className="field">
            <span className="label">Branch</span>
            {repo ? <BranchSelect hostId={host.id} repoUrl={repo.url} value={br} onChange={(b) => { setBranch(b); setModel('') }} />
              : <input className="input" style={{ height: 34 }} value={br} onChange={(e) => setBranch(e.target.value)} />}
          </label>
          <label className="field">
            <span className="label">Model</span>
            <select className="select" style={{ height: 34 }} value={picked} onChange={(e) => setModel(e.target.value)} disabled={!opts.length}>
              {loadingModels && <option>Reading repo…</option>}
              {opts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        </div>
        {error && <span className="err-text">{errMsg(error)}</span>}
        {repo && !loadingModels && !error && !opts.length && (
          <span className="hint" style={{ color: 'var(--warn)', fontSize: 10 }}>Every model in this repo is already linked here</span>
        )}
        <div className="actions">
          <button type="button" className="btn lg ghost" onClick={() => setLinkOpen(false)}>Cancel</button>
          <button type="button" className="btn lg primary" disabled={!picked || link.isPending} onClick={() => link.mutate()}>
            {link.isPending ? 'Linking…' : 'Link model'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Toast() {
  const toast = useUi((s) => s.toast)
  if (!toast) return null
  const bg = toast.tone === 'err' ? 'var(--danger)' : toast.tone === 'warn' ? '#B8740F' : 'var(--qa)'
  return <div className="toast" style={{ background: bg }}>{toast.msg}</div>
}

/** Deploy the selected models' catalogs, each from a branch of your choice
 * (defaults to the branch it's linked / deployed from). */
export function DeployDialog({ host, rows, busy, onClose, onDeploy }: {
  host: Host; rows: ModelRow[]; busy: boolean; onClose: () => void; onDeploy: (items: { key: string; branch: string }[]) => void
}) {
  const groups = Object.values(rows.reduce<Record<string, { repoUrl: string; branch: string; rows: ModelRow[] }>>((acc, r) => {
    const g = (acc[r.repoUrl] ??= { repoUrl: r.repoUrl, branch: r.branch, rows: [] })
    g.rows.push(r)
    return acc
  }, {}))
  const [branch, setBranch] = useState<Record<string, string>>({})
  const pick = (g: (typeof groups)[number]) => branch[g.repoUrl] ?? g.branch
  const go = () => onDeploy(groups.flatMap((g) => g.rows.map((r) => ({ key: r.key, branch: pick(g) }))))
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow" style={{ color: 'var(--dev)' }}>Deploy · {host.label}</span>
        <span className="display">Deploy from <em>Git</em>.</span>
        <span className="note">AtScale deploys a whole catalog from the head of a branch. Pick the branch for each repo; a branch other than the one deployed now lands as its own catalog.</span>
        <div className="list">
          {groups.map((g) => (
            <div key={g.repoUrl} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono ellipsis" style={{ fontSize: 11.5 }} title={g.repoUrl}>{g.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</span>
                <span className="hint">{g.rows.map((r) => r.name).join(', ')}</span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="label">Branch</span>
                <BranchSelect compact hostId={host.id} repoUrl={g.repoUrl} value={pick(g)} onChange={(b) => setBranch({ ...branch, [g.repoUrl]: b })} />
                {pick(g) !== g.branch && <span className="hint" style={{ color: 'var(--warn)' }}>was {g.branch}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn lg ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn lg primary" disabled={busy || !groups.length} onClick={go}>{busy ? 'Deploying…' : 'Deploy'}</button>
        </div>
      </div>
    </div>
  )
}
