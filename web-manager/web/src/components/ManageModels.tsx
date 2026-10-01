import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, waitForJob, type Host } from '../api'
import { useUi } from '../store'
import { DeployDialog } from './Dialogs'
import { HostHero } from './ManageView'
import { Checkbox, StatusPill, errMsg, fmtDate, plural, useGit } from './ui'

export function ManageModels({ host }: { host: Host }) {
  const { manage, setManage, flash, setAsk, setLinkOpen, setView } = useUi()
  const qc = useQueryClient()
  const [deployOpen, setDeployOpen] = useState(false)
  const git = useGit()
  const models = useQuery({ queryKey: ['models', host.id], queryFn: () => api.models(host.id) })

  const q = manage.q.trim().toLowerCase()
  const rows = (models.data?.models ?? []).filter(
    (m) => !q || m.name.toLowerCase().includes(q) || (m.catalog || '').toLowerCase().includes(q),
  )
  const sel = manage.sel.filter((k) => rows.some((r) => r.key === k))
  const n = sel.length
  const allOn = rows.length > 0 && n === rows.length
  const toggle = (k: string) => setManage({ sel: sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k] })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['models', host.id] })
    qc.invalidateQueries({ queryKey: ['aggModels', host.id] })
    qc.invalidateQueries({ queryKey: ['diff'] })
  }

  const deploy = useMutation({
    mutationFn: async (items: { key: string; branch: string }[]) => waitForJob(await api.deploy(host.id, items)),
    onSuccess: (res) => {
      const failed = res.results.filter((r) => !r.ok)
      const heads = [...new Set(res.results.filter((r) => r.ok).map((r) => `${r.branch}${r.commit ? ` ${r.commit.slice(0, 7)}` : ''}`))]
      if (failed.length) flash(`${failed.length} failed: ${failed.map((f) => f.error).join(' · ')}`, 'err')
      else flash(`${plural(res.results.length, 'model')} deployed to ${host.label} · ${heads.join(', ')}`)
      setManage({ sel: [] })
      setDeployOpen(false)
    },
    onError: (e) => flash(errMsg(e), 'err'),
    onSettled: refresh,
  })

  const done = (verb: string) => (res: { removed: string[]; catalogs: string[]; warnings: string[] }) => {
    const what = res.catalogs.length ? plural(res.catalogs.length, 'catalog') : plural(res.removed.length, 'model')
    if (res.warnings.length) flash(`${what} ${verb} · ${res.warnings.join(' · ')}`, 'warn')
    else flash(`${what} ${verb} on ${host.label}`)
    setManage({ sel: [] })
  }
  const undeploy = useMutation({ mutationFn: (keys: string[]) => api.undeploy(host.id, keys), onSuccess: done('undeployed'), onError: (e) => flash(errMsg(e), 'err'), onSettled: refresh })
  const unlink = useMutation({ mutationFn: (keys: string[]) => api.unlink(host.id, keys), onSuccess: done('unlinked'), onError: (e) => flash(errMsg(e), 'err'), onSettled: refresh })

  // Deploy / undeploy act on a whole catalog, so name every model that moves with the selection.
  const affected = (pred: (r: (typeof rows)[number]) => boolean) => {
    const picked = rows.filter((r) => sel.includes(r.key))
    const scope = new Set(picked.map((r) => r.catalogId ?? r.repoId))
    return (models.data?.models ?? []).filter((r) => scope.has(r.catalogId ?? r.repoId) && pred(r)).map((r) => r.name)
  }
  const selDeployed = rows.some((r) => sel.includes(r.key) && r.status !== 'Linked')

  const askUndeploy = () => {
    const names = affected((r) => r.status !== 'Linked')
    setAsk({
      eyebrow: `Undeploy · ${host.label}`,
      title: `Undeploy ${plural(names.length, 'model')}.`,
      note: `${names.join(', ')} will be undeployed from ${host.label}, with their aggregates. AtScale undeploys whole catalogs. The repo link stays, so you can deploy again.`,
      label: 'Undeploy',
      tone: 'danger',
      go: () => undeploy.mutate(sel),
    })
  }
  const askUnlink = () => {
    const names = affected(() => true)
    setAsk({
      eyebrow: `Unlink · ${host.label}`,
      title: `Unlink ${plural(names.length, 'model')}.`,
      note: `${names.join(', ')} will be removed from ${host.label}: the catalog is undeployed (its aggregates go too) and the repo is detached. The SML in Git is untouched.`,
      label: 'Unlink',
      tone: 'danger',
      go: () => unlink.mutate(sel),
    })
  }

  const busy = deploy.isPending || unlink.isPending || undeploy.isPending
  const gitHint = !git.ready ? 'Git profile missing — set it in Settings' : ''

  return (
    <div className="col">
      <HostHero host={host} count={plural(rows.length, 'model')}>
        <button type="button" className="btn primary lg" disabled={!git.ready} title={gitHint} onClick={() => setLinkOpen(true)}>+ Link model</button>
      </HostHero>

      <div className="toolbar">
        <span className="sel" style={{ color: n ? 'var(--dev)' : 'var(--muted)' }}>{n ? `${n} selected` : 'None selected'}</span>
        <button type="button" className="btn solid" style={{ background: 'var(--dev)' }} disabled={!n || busy || !git.ready}
          onClick={() => setDeployOpen(true)}>{deploy.isPending ? 'Deploying…' : 'Deploy…'}</button>
        <button type="button" className="btn danger" disabled={!selDeployed || busy} onClick={askUndeploy}>{undeploy.isPending ? 'Undeploying…' : 'Undeploy'}</button>
        <button type="button" className="btn danger" disabled={!n || busy} onClick={askUnlink}>{unlink.isPending ? 'Unlinking…' : 'Unlink'}</button>
        {!git.ready && (
          <button type="button" className="hint" style={{ background: 'none', border: 0, color: 'var(--warn)', cursor: 'pointer' }} onClick={() => setView('settings')}>
            {gitHint} →
          </button>
        )}
        <span className="hint" style={{ marginLeft: 'auto' }}>Click rows to select</span>
      </div>

      <div className="scroll">
        {models.isError ? (
          <div className="notice err"><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(models.error)}</div>
        ) : (
          <div className="table">
            <div className="tr th grid-models">
              <Checkbox state={allOn ? 'on' : n ? 'some' : 'off'} onClick={() => setManage({ sel: allOn ? [] : rows.map((r) => r.key) })} />
              <span>Model</span><span>Catalog</span><span>Commit · branch</span><span>Updated</span><span>Status</span>
            </div>
            {rows.map((r) => {
              const on = sel.includes(r.key)
              return (
                <div key={r.key} className={`tr grid-models ${on ? 'sel' : ''}`} onClick={() => toggle(r.key)}>
                  <Checkbox state={on ? 'on' : 'off'} />
                  <span className="name ellipsis">{r.name}</span>
                  <span className="mono muted ellipsis" title={r.repoUrl}>{r.catalog}</span>
                  <span className="mono ellipsis" title={r.commit ? `${r.commit}${r.commitDate ? ` · ${r.commitDate}` : ''}${r.versionInferred ? ' · inferred from publish time' : ''}` : 'No Git version known'}>
                    {r.version ?? '—'}{r.versionInferred && <span className="muted">~</span>} <span className="muted">{r.branch}</span>
                  </span>
                  <span className="mono muted">{fmtDate(r.updated)}</span>
                  <StatusPill status={r.status} />
                </div>
              )
            })}
            {models.isLoading && <div className="empty">Loading…</div>}
            {models.isSuccess && !rows.length && <div className="empty">Nothing matches on this host</div>}
          </div>
        )}
      </div>
      {deployOpen && (
        <DeployDialog host={host} rows={rows.filter((r) => sel.includes(r.key))} busy={deploy.isPending}
          onClose={() => setDeployOpen(false)} onDeploy={(items) => deploy.mutate(items)} />
      )}
    </div>
  )
}
