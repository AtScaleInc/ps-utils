import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, waitForJob, type Diff, type Host } from '../api'
import { resolveHost, useUi } from '../store'
import { refreshHost } from './ManageView'
import { BranchSelect, DiffPill, EnvSegment, HostSelect, RefreshButton, diffColors, envOf, errMsg, fmtDate, plural, useGit, useHosts } from './ui'

interface SrcRow { key: string; name: string; sub: string; ver: string; diff: Diff; repoUrl?: string; branch?: string }
interface TgtRow { id: string; name: string; sub: string; ver: string; updated: string; dup: boolean; inactive: boolean; model?: string }

export function PromoteView() {
  const ui = useUi()
  const { section, src, tgt, setSrc, setTgt, staged, stage, unstage, clearStaged, flash, setAsk, pModel, setPModel, branchFor, setBranch, modeFor, setMode, replaceFor, setReplace } = ui
  const qc = useQueryClient()
  const git = useGit()
  const hosts = useHosts().data?.hosts ?? []
  const sh = resolveHost(hosts, src)
  const th = resolveHost(hosts, tgt)
  const same = !!sh && !!th && sh.id === th.id
  const isM = section === 'models'
  const [over, setOver] = useState(false)

  const enabled = !!sh && !!th && !same
  const mDiff = useQuery({
    queryKey: ['diff', 'models', sh?.id, th?.id], enabled: enabled && isM,
    queryFn: () => api.diffModels(sh!.id, th!.id),
  })
  const aDiff = useQuery({
    queryKey: ['diff', 'aggs', sh?.id, th?.id], enabled: enabled && !isM,
    queryFn: () => api.diffAggs(sh!.id, th!.id, ''),
  })
  const tgtAggModels = useQuery({ queryKey: ['aggModels', th?.id], enabled: !!th && !isM, queryFn: () => api.aggModels(th!.id) })
  const diffQ = isM ? mDiff : aDiff
  const refreshBoth = async () => {
    if (!sh || !th || same) return
    await Promise.all([refreshHost(qc, sh.id), refreshHost(qc, th.id)])
    await (isM
      ? qc.fetchQuery({ queryKey: ['diff', 'models', sh.id, th.id], queryFn: () => api.diffModels(sh.id, th.id, true), staleTime: 0 })
      : qc.fetchQuery({ queryKey: ['diff', 'aggs', sh.id, th.id], queryFn: () => api.diffAggs(sh.id, th.id, '', true), staleTime: 0 }))
  }

  const stagedNames = staged[section]
  let srcRows: SrcRow[] = []
  let tgtRows: TgtRow[] = []
  let pModelOpts: { name: string; count: number }[] = []
  let targetModels: string[] = []
  if (isM && mDiff.data) {
    srcRows = mDiff.data.rows.map((r) => ({ key: r.name, name: r.name, sub: r.catalog, ver: r.version ?? '—', diff: r.diff, repoUrl: r.repoUrl, branch: r.branch }))
    tgtRows = mDiff.data.target.map((t) => ({
      id: t.key, name: t.name, sub: `${t.catalog} · ${t.branch}`, ver: t.version ?? '—',
      updated: `Updated ${fmtDate(t.updated)}`, dup: false, inactive: false,
    }))
  } else if (!isM && aDiff.data) {
    const all = aDiff.data.rows
    pModelOpts = aDiff.data.sourceModels.map((m) => ({ name: m, count: all.filter((a) => a.model === m).length }))
    targetModels = aDiff.data.targetModels
    srcRows = all.filter((a) => !pModel || a.model === pModel)
      .map((a) => ({ key: a.id, name: a.name, sub: a.model, ver: a.type, diff: a.diff }))
    tgtRows = aDiff.data.target.filter((t) => !pModel || t.model === pModel).map((t) => ({
      id: t.id, name: t.name, sub: t.model, ver: t.type, updated: `Built ${fmtDate(t.lastBuild, true)}`,
      dup: t.duplicate, inactive: !t.active, model: t.model,
    }))
  }
  const allSrc: SrcRow[] = isM ? srcRows : (aDiff.data?.rows ?? []).map((a) => ({ key: a.id, name: a.name, sub: a.model, ver: a.type, diff: a.diff }))
  const validStaged = stagedNames.filter((k) => allSrc.some((r) => r.key === k))
  const stagedRows = validStaged.map((k) => allSrc.find((r) => r.key === k)!)
  // An in-sync model can still be promoted from a different branch.
  const canStage = (r: SrcRow) => (r.diff.stageable || (isM && r.diff.state === 'same')) && !validStaged.includes(r.key) && !!th && !same
  const branchOf = (r: SrcRow) => branchFor[r.name] ?? r.branch ?? 'main'
  const modeOf = (r: SrcRow) => modeFor[r.name] ?? 'deploy'
  const normUrl = (u?: string | null) => (u ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase()
  /** Target catalogs of the same repo running a different branch (they keep running unless replaced). */
  const otherBranchOnTarget = (r: SrcRow) => (mDiff.data?.target ?? []).filter((t) =>
    t.status !== 'Linked' && normUrl(t.repoUrl) === normUrl(r.repoUrl) && t.branch !== branchOf(r))
  const stageable = srcRows.filter(canStage)
  const nDup = tgtRows.filter((r) => r.dup).length
  const nSt = stagedRows.length
  const gitBlocked = isM && !git.ready
  const canPromote = nSt > 0 && !same && !!th && !gitBlocked
  const noun = isM ? 'model' : 'aggregate'

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['diff'] })
    if (th) {
      qc.invalidateQueries({ queryKey: ['models', th.id] })
      qc.invalidateQueries({ queryKey: ['aggModels', th.id] })
      qc.invalidateQueries({ queryKey: ['aggs', th.id] })
    }
  }

  const promote = useMutation({
    mutationFn: async () => {
      if (isM) {
        const res = await waitForJob(await api.promoteModels(sh!.id, th!.id, stagedRows.map((r) => ({
          name: r.name, branch: branchOf(r), mode: modeOf(r), replaceOld: modeOf(r) === 'deploy' && !!replaceFor[r.name] && otherBranchOnTarget(r).length > 0,
        }))))
        const failed = res.results.filter((r) => !r.ok)
        const okNames = res.results.filter((r) => r.ok).map((r) =>
          `${r.name}@${r.branch}${r.mode === 'link' ? ' (linked)' : r.commit ? ` ${r.commit.slice(0, 7)}` : ''}${r.replaced?.length ? ' · replaced old branch' : ''}`)
        return { ok: okNames.length, detail: okNames, problems: failed.map((f) => `${f.name}: ${f.error}`) }
      }
      const res = await waitForJob(await api.promoteAggs(sh!.id, th!.id, validStaged))
      return { ok: res.promoted.length, detail: [] as string[], problems: res.skipped.map((s) => `${s.name}: ${s.reason}`) }
    },
    onSuccess: ({ ok, detail, problems }) => {
      const what = `${plural(ok, noun)} promoted to ${th!.label}${detail.length ? ` · ${detail.join(', ')}` : ''}`
      if (problems.length) flash(`${what} · skipped ${problems.join(' · ')}`, ok ? 'warn' : 'err')
      else flash(what)
      clearStaged()
    },
    onError: (e) => flash(errMsg(e), 'err'),
    onSettled: refresh,
  })

  const deactivateOnTarget = useMutation({
    mutationFn: async (r: TgtRow) => {
      const m = tgtAggModels.data?.models.find((x) => x.name === r.model)
      if (!m) throw new Error(`Model ${r.model} not found on ${th!.label}`)
      const res = await api.setActive(th!.id, m, [r.id], false)
      const bad = res.results.find((x) => !x.ok)
      if (bad) throw new Error(bad.error)
      return r
    },
    onSuccess: (r) => flash(`${r.name} deactivated on ${th!.label} · can now be promoted`),
    onError: (e) => flash(errMsg(e), 'err'),
    onSettled: refresh,
  })

  const onPromote = () => {
    if (!canPromote) return
    if (th!.env === 'prod') {
      setAsk({
        eyebrow: 'Production promotion',
        title: 'This change lands in production.',
        note: `${plural(nSt, noun)} from ${sh!.label} will be deployed to ${th!.label}. Existing versions on the target are replaced.`,
        label: 'Promote to prod',
        tone: 'prod',
        items: stagedRows.map((r) => {
          const [bg, fg] = diffColors(r.diff.state)
          const how = modeOf(r) === 'link' ? 'link' : replaceFor[r.name] && otherBranchOnTarget(r).length ? 'deploy, replace old' : 'deploy'
          return { name: isM ? `${r.name} → ${branchOf(r)} (${how})` : r.name, pill: { label: r.diff.label, bg, fg } }
        }),
        go: () => promote.mutate(),
      })
    } else promote.mutate()
  }

  const onDropTarget = (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const d = e.dataTransfer.getData('text/plain')
    if (d.startsWith('src:') && th && !same) {
      const row = srcRows.find((r) => r.key === d.slice(4))
      if (row && canStage(row)) stage([row.key])
    }
  }
  const onDropSource = (e: React.DragEvent) => {
    e.preventDefault()
    const d = e.dataTransfer.getData('text/plain')
    if (d.startsWith('stg:')) unstage(d.slice(4))
  }

  const tModelOk = !!pModel && targetModels.includes(pModel)
  const srcEmptyMsg = !sh ? 'No host in this group — add one in Settings'
    : same ? 'Source and target are the same host — pick a different target'
    : !th ? 'No target host in this group'
    : diffQ.isLoading ? 'Loading…' : 'Nothing on this host'

  return (
    <div className="col">
      <section className="pane src" onDragOver={(e) => e.preventDefault()} onDrop={onDropSource}>
        <div className="bar">
          <div className="row" style={{ alignItems: 'baseline', gap: 14 }}>
            <span className="eyebrow">03 — Source · {isM ? 'Models' : 'Aggregates'}</span>
            <span className="hint">{same || !diffQ.data ? '' : `${isM ? srcRows.length : aDiff.data?.rows.length ?? 0} on host`}</span>
          </div>
          <div className="row">
            <EnvSegment value={src.env} onPick={(env) => setSrc({ env, hostId: null })} />
            <HostSelect hosts={hosts} env={src.env} value={sh?.id ?? null} onChange={(id) => setSrc({ env: src.env, hostId: id })} />
          </div>
        </div>
        {!isM && (
          <div className="toolbar" style={{ margin: '12px 24px 0' }}>
            <span className="label">Model</span>
            <select className="select sm" value={pModel} onChange={(e) => setPModel(e.target.value)}>
              <option value="">All models</option>
              {pModelOpts.map((m) => <option key={m.name} value={m.name}>{m.name} · {m.count}</option>)}
            </select>
            <button type="button" className="btn solid" style={{ background: 'var(--dev)' }} disabled={!stageable.length}
              onClick={() => { stage(stageable.map((r) => r.key)); flash(`${plural(stageable.length, 'aggregate')} staged${pModel ? ` · ${pModel}` : ''}`) }}>
              {stageable.length ? `Stage all ${stageable.length}${pModel ? ` for ${pModel}` : ''} ↓` : 'Nothing to stage'}
            </button>
            <span className="hint" style={{ marginLeft: 'auto' }}>System aggregates only · drag single rows down</span>
          </div>
        )}
        <div className="pane-scroll">
          {diffQ.isError && <div className="notice err" style={{ margin: 0 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(diffQ.error)}</div>}
          {!same && srcRows.map((r) => {
            const isSt = validStaged.includes(r.key)
            const can = canStage(r)
            return (
              <div key={r.key} className="prow" draggable={can} style={{ opacity: can ? 1 : 0.45, cursor: can ? 'grab' : 'default' }}
                onDragStart={(e) => { if (!can) { e.preventDefault(); return } e.dataTransfer.setData('text/plain', `src:${r.key}`); e.dataTransfer.effectAllowed = 'move' }}>
                <span className="grip">⠿</span>
                <span className="name ellipsis">{r.name}</span>
                <span className="mono muted ellipsis">{r.sub}{isM && r.branch ? ` · ${r.branch}` : ''}</span>
                <span className="mono">{r.ver}</span>
                <DiffPill state={r.diff.state} label={r.diff.label} />
                {can ? (
                  <button type="button" className="btn xs info" title={r.diff.state === 'same' ? 'Same commit on target - stage to promote a different branch' : undefined}
                    onClick={() => stage([r.key])}>{r.diff.state === 'same' ? 'Branch ↓' : 'Stage ↓'}</button>
                ) : (
                  <span className="hint">{isSt ? 'Staged' : r.diff.reason ?? '—'}</span>
                )}
              </div>
            )
          })}
          {(same || !srcRows.length) && !diffQ.isError && <div className="empty" style={{ padding: '20px 12px' }}>{srcEmptyMsg}</div>}
        </div>
      </section>

      <div className="divider">
        <span className="eyebrow" style={{ color: 'var(--prod)' }}>↓ Drag rows down to stage</span>
        <span className="line" />
        <span className="mono row" style={{ gap: 10 }}>
          <span className="sq" style={{ background: envOf(src.env).color }} />{sh?.label ?? 'no host'}
          <span className="muted">→</span>
          <span className="sq" style={{ background: envOf(tgt.env).color }} />{th?.label ?? 'no host'}
        </span>
        {enabled && <RefreshButton cachedAt={diffQ.data?.cachedAt} onRefresh={refreshBoth} />}
      </div>

      <section className="pane">
        <div className="bar">
          <div className="row">
            <span className="eyebrow" style={{ marginRight: 6 }}>04 — Target</span>
            <EnvSegment value={tgt.env} onPick={(env) => setTgt({ env, hostId: null })} />
            <HostSelect hosts={hosts} env={tgt.env} value={th?.id ?? null} onChange={(id) => setTgt({ env: tgt.env, hostId: id })} />
            {!isM && (
              <div className={`tmodel ${pModel && !tModelOk ? 'bad' : ''}`}>
                <span className="label">Target model</span>
                <span className="v" style={{ color: !pModel ? 'var(--ink)' : tModelOk ? 'var(--qa)' : 'var(--danger)' }}>{pModel || 'Matched per aggregate'}</span>
                <span className="hint">{!pModel ? `${targetModels.length} deployed` : tModelOk ? 'Auto-matched' : `Not deployed on ${th?.label ?? 'target'}`}</span>
              </div>
            )}
          </div>
          <div className="row" style={{ gap: 10 }}>
            {gitBlocked && <span className="hint" style={{ color: 'var(--warn)' }}>Git profile missing — set it in Settings</span>}
            <button type="button" className="btn lg ghost" onClick={clearStaged}>Clear</button>
            <button type="button" className="btn lg solid" disabled={!canPromote || promote.isPending}
              style={{ background: canPromote ? envOf(tgt.env).color : undefined }} onClick={onPromote}>
              {promote.isPending ? 'Promoting…' : nSt ? `Promote ${nSt} to ${th?.label ?? '—'}` : 'Promote'}
            </button>
          </div>
        </div>
        <div className="tgt-body" onDragOver={(e) => { e.preventDefault(); if (!over) setOver(true) }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }} onDrop={onDropTarget}>
          <div className={`drop ${over ? 'over' : ''}`}>
            {!nSt && (
              <div className="msg hint" style={{ fontSize: 10.5 }}>
                {!th ? 'No target host in this group' : same ? 'Pick a target different from the source' : `Drop ${noun}s here to stage them for ${th.label}`}
              </div>
            )}
            {stagedRows.map((r) => {
              const others = isM ? otherBranchOnTarget(r) : []
              return (
                <div key={r.key} className="staged-item">
                  <div className="prow staged" draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', `stg:${r.key}`); e.dataTransfer.effectAllowed = 'move' }}>
                    <span className="grip">⠿</span>
                    <span className="name ellipsis">{r.name}</span>
                    <span className="mono muted ellipsis">{r.sub}</span>
                    <span className="mono">{r.ver}</span>
                    <DiffPill state={r.diff.state} label={r.diff.label} />
                    <button type="button" title="Unstage" className="btn xs danger" style={{ width: 26, padding: 0 }} onClick={() => unstage(r.key)}>✕</button>
                  </div>
                  {isM && sh && r.repoUrl && (
                    <div className="staged-opts">
                      <span className="label">From branch</span>
                      <BranchSelect compact hostId={sh.id} repoUrl={r.repoUrl} value={branchOf(r)} onChange={(b) => setBranch(r.name, b)} />
                      <span className="label" style={{ marginLeft: 8 }}>On {th?.label}</span>
                      <select className="select" style={{ height: 26, fontSize: 11.5 }} value={modeOf(r)}
                        onChange={(e) => setMode(r.name, e.target.value as 'deploy' | 'link')}>
                        <option value="deploy">Link &amp; deploy</option>
                        <option value="link">Link only</option>
                      </select>
                      {modeOf(r) === 'deploy' && others.length > 0 && (
                        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--warn)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!replaceFor[r.name]} onChange={(e) => setReplace(r.name, e.target.checked)} />
                          Undeploy {[...new Set(others.map((o) => o.branch))].join(', ')} on {th?.label} afterwards
                        </label>
                      )}
                      {modeOf(r) === 'deploy' && others.length > 0 && !replaceFor[r.name] && (
                        <span className="hint">· deploys alongside as a separate catalog</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {nDup > 0 && (
            <div className="notice err" style={{ margin: 0 }}>
              <span className="eyebrow" style={{ color: 'var(--danger)' }}>Duplicates</span>
              <span>{plural(nDup, 'duplicate')} on target — skipped. Deactivate the old aggregate to promote a replacement (not advised: the aggregate already exists).</span>
            </div>
          )}

          <TargetList host={th} rows={same ? [] : tgtRows} scope={!isM && pModel ? ` · ${pModel}` : ''}
            onDeactivate={(r) => deactivateOnTarget.mutate(r)} busy={deactivateOnTarget.isPending} />
        </div>
      </section>
    </div>
  )
}

function TargetList({ host, rows, scope, onDeactivate, busy }: {
  host: Host | null; rows: TgtRow[]; scope: string; onDeactivate: (r: TgtRow) => void; busy: boolean
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="eyebrow" style={{ paddingBottom: 8 }}>Currently on {host?.label ?? 'no host'}{scope} · {rows.length}</span>
      {rows.map((r) => (
        <div key={r.id} className={`prow tgt ${r.dup ? 'dup' : ''}`}>
          <span />
          <span className="name ellipsis">{r.name}</span>
          <span className="mono muted ellipsis" style={{ fontSize: 10.5 }}>{r.sub}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-soft)' }}>{r.ver}</span>
          {r.dup ? (
            <span className="pill" style={{ background: 'var(--danger)', color: '#fff' }}>Duplicate</span>
          ) : (
            <span className="mono muted" style={{ fontSize: 10.5 }}>{r.updated}</span>
          )}
          {r.dup ? (
            <button type="button" className="btn xs danger" style={{ justifySelf: 'end', height: 24 }} disabled={busy} onClick={() => onDeactivate(r)}>Deactivate</button>
          ) : (
            <span className="hint" style={{ justifySelf: 'end' }}>{r.inactive ? 'Inactive' : ''}</span>
          )}
        </div>
      ))}
      {!rows.length && <div className="empty" style={{ padding: 12, borderTop: '1px solid var(--row-line)' }}>Empty</div>}
    </div>
  )
}
