import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, waitForJob, type AggModel, type AggRow, type Host } from '../api'
import { useUi } from '../store'
import { HostHero } from './ManageView'
import { Checkbox, StatusPill, errMsg, fmtDate, plural } from './ui'

export const modelKey = (m: AggModel) => `${m.catalogId}|${m.modelId}`

export function ManageAggregates({ host }: { host: Host }) {
  const { manage, setManage, flash } = useUi()
  const qc = useQueryClient()
  const models = useQuery({ queryKey: ['aggModels', host.id], queryFn: () => api.aggModels(host.id) })
  const list = models.data?.models ?? []
  const model = list.find((m) => modelKey(m) === manage.modelKey) ?? list[0] ?? null

  const aggs = useQuery({
    queryKey: ['aggs', host.id, model ? modelKey(model) : null],
    queryFn: () => api.aggs(host.id, model!),
    enabled: !!model,
    // Poll while a build is running: Building → Built.
    refetchInterval: (query) => (query.state.data?.aggregates.some((a) => a.status === 'Building') ? 1500 : false),
  })

  const q = manage.q.trim().toLowerCase()
  const rows = (aggs.data?.aggregates ?? []).filter((a) => !q || a.name.toLowerCase().includes(q))
  const sel = manage.sel.filter((id) => rows.some((r) => r.id === id))
  const n = sel.length
  const allOn = rows.length > 0 && n === rows.length
  const toggle = (id: string) => setManage({ sel: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['aggs', host.id] })
    qc.invalidateQueries({ queryKey: ['diff'] })
  }

  const setActive = useMutation({
    mutationFn: ({ ids, active }: { ids: string[]; active: boolean }) => api.setActive(host.id, model!, ids, active),
    onSuccess: (res, v) => {
      const failed = res.results.filter((r) => !r.ok)
      const verb = v.active ? 'reactivated' : 'deactivated'
      if (failed.length) flash(`${failed.length} not ${verb}: ${failed.map((f) => f.error).join(' · ')}`, 'err')
      else flash(v.ids.length === 1 ? `${rows.find((r) => r.id === v.ids[0])?.name ?? v.ids[0]} ${verb}` : `${plural(v.ids.length, 'aggregate')} ${verb}`)
      setManage({ sel: [] })
    },
    onError: (e) => flash(errMsg(e), 'err'),
    onSettled: refresh,
  })

  const build = useMutation({
    mutationFn: async (mode: 'full' | 'incremental') => waitForJob(await api.build(host.id, model!, mode)),
    onMutate: (mode) => {
      const n = rows.filter((a) => a.active).length
      flash(`${mode === 'full' ? 'Full' : 'Incremental'} build started · ${plural(n, 'aggregate')} · ${model?.name}`)
    },
    onError: (e) => flash(errMsg(e), 'err'),
    onSettled: refresh,
  })

  const activeCount = rows.filter((a) => a.active).length
  const canBuild = !!model && activeCount > 0 && !build.isPending
  const toggleRow = (e: React.MouseEvent, a: AggRow) => {
    e.stopPropagation()
    setActive.mutate({ ids: [a.id], active: !a.active })
  }
  const selRows = rows.filter((r) => sel.includes(r.id))

  return (
    <div className="col">
      <HostHero host={host} count={plural(rows.length, 'aggregate')} />
      <div className="toolbar">
        <span className="label">Deployed model</span>
        <select className="select sm" value={model ? modelKey(model) : ''} disabled={!list.length}
          onChange={(e) => setManage({ modelKey: e.target.value, sel: [] })}>
          {!list.length && <option value="">None deployed</option>}
          {list.map((m) => <option key={modelKey(m)} value={modelKey(m)}>{m.name}</option>)}
        </select>
        <button type="button" className="btn primary" disabled={!canBuild} onClick={() => build.mutate('full')}>Full build</button>
        <button type="button" className="btn info" disabled={!canBuild} onClick={() => build.mutate('incremental')}>Incremental build</button>
        <span className="hint">All active aggregates</span>
        <span className="vsep" />
        <span className="sel" style={{ color: n ? 'var(--dev)' : 'var(--muted)' }}>{n ? `${n} selected` : 'None selected'}</span>
        <button type="button" className="btn danger" disabled={!selRows.some((r) => r.active) || setActive.isPending}
          onClick={() => setActive.mutate({ ids: selRows.filter((r) => r.active).map((r) => r.id), active: false })}>Deactivate</button>
        <button type="button" className="btn ok" disabled={!selRows.some((r) => !r.active) || setActive.isPending}
          onClick={() => setActive.mutate({ ids: selRows.filter((r) => !r.active).map((r) => r.id), active: true })}>Reactivate</button>
      </div>

      <div className="scroll">
        {models.isError || aggs.isError ? (
          <div className="notice err"><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(models.error ?? aggs.error)}</div>
        ) : (
          <div className="table">
            <div className="tr th grid-aggs">
              <Checkbox state={allOn ? 'on' : n ? 'some' : 'off'} onClick={() => setManage({ sel: allOn ? [] : rows.map((r) => r.id) })} />
              <span>Aggregate</span><span>Type</span><span>Size</span><span>Last build</span><span>Status</span><span />
            </div>
            {rows.map((a) => {
              const on = sel.includes(a.id)
              return (
                <div key={a.id} className={`tr grid-aggs ${on ? 'sel' : ''}`} style={{ opacity: a.active ? 1 : 0.55 }} onClick={() => toggle(a.id)}>
                  <Checkbox state={on ? 'on' : 'off'} />
                  <span className="mono ellipsis" style={{ fontSize: 12, fontWeight: 500 }}>{a.name}</span>
                  <span className="pill" style={{ background: '#0E0E0E', color: 'var(--prod)' }}>{a.type}</span>
                  <span className="mono muted">{a.size}</span>
                  <span className="mono muted ellipsis">{fmtDate(a.lastBuild, true)}</span>
                  <StatusPill status={a.status} note={a.statusNote} />
                  <button type="button" className={`btn xs ${a.active ? 'danger' : 'ok'}`} style={{ justifySelf: 'end' }}
                    disabled={setActive.isPending} onClick={(e) => toggleRow(e, a)}>{a.active ? 'Deactivate' : 'Reactivate'}</button>
                </div>
              )
            })}
            {(models.isLoading || aggs.isLoading) && <div className="empty">Loading…</div>}
            {models.isSuccess && !model && <div className="empty">No deployed model on this host — deploy one first</div>}
            {aggs.isSuccess && !rows.length && <div className="empty">Nothing matches on this host</div>}
          </div>
        )}
      </div>
    </div>
  )
}
