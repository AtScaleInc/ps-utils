import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { errMsg, useHosts } from '../components/ui'
import { useUi } from '../store'
import { monitorApi } from './api'
import { fmtN, fmtStamp } from './charts'

/** Settings > Cache & Database: Monitor's query history (workspace/monitor.db) and cleaning it up. */
export function MonitorStoreCard() {
  const { flash } = useUi()
  const qc = useQueryClient()
  const hosts = useHosts().data?.hosts ?? []
  const label = (id: string) => hosts.find((h) => h.id === id)?.label ?? id
  const info = useQuery({ queryKey: ['monitorStore'], queryFn: monitorApi.storeInfo, staleTime: 0 })
  const [older, setOlder] = useState('30')
  const [hostId, setHostId] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  // Blank = any age: with a host / model picked that clears all of it.
  const days = older === '' ? null : Number(older)
  const body = { olderThanDays: days, hostId: hostId || null, model: model || null }
  const everything = days === null && !hostId && !model
  const preview = useQuery({
    queryKey: ['monitorCleanupPreview', days, hostId, model],
    queryFn: () => monitorApi.cleanup({ ...body, dryRun: true }), staleTime: 0,
  })
  const n = preview.data?.count ?? 0
  const hostRow = (info.data?.hosts ?? []).find((h) => h.hostId === hostId)
  const models = hostRow ? hostRow.models.map((m) => m.model) : [...new Set((info.data?.hosts ?? []).flatMap((h) => h.models.map((m) => m.model)))].sort()
  const scope = [hostId && label(hostId), model, days !== null && `older than ${days} days`].filter(Boolean).join(' · ') || 'everything'

  async function run() {
    const warn = everything ? 'This deletes ALL stored query history on every host. ' : ''
    if (!window.confirm(`${warn}Delete ${fmtN(n)} stored quer${n === 1 ? 'y' : 'ies'} (${scope})? This can't be undone - a poll can pull them again while AtScale still keeps them.`)) return
    setBusy(true)
    try {
      const r = await monitorApi.cleanup(body)
      flash(`Deleted ${fmtN(r.count)} stored quer${r.count === 1 ? 'y' : 'ies'}`)
      qc.invalidateQueries({ queryKey: ['monitor'] })
      qc.invalidateQueries({ queryKey: ['monitorStatus'] })
      info.refetch()
      preview.refetch()
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  async function compact() {
    setBusy(true)
    try {
      const r = await monitorApi.compact()
      flash(`Compacted · ${(r.freedBytes / 1024 / 1024).toFixed(1)} MB freed`)
      info.refetch()
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  const d = info.data
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`
  return (
    <div className="card" style={{ gap: 12, padding: '16px 20px' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="eyebrow" style={{ color: 'var(--prod)' }}>Database · query history (Monitor)</span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Queries polled from each host in <span className="mono" style={{ color: 'var(--ink)' }}>{d?.path ?? 'workspace/monitor.db'}</span>, one row per query id.
            {d && ` Kept automatically: none older than ${d.maxAgeDays} days.`}
          </span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="hint">{d ? `${fmtN(d.queries)} queries · ${mb(d.bytes)}` : '…'}</span>
          <button type="button" className="btn ghost" disabled={busy} title="Give space freed by deleted queries back to the disk" onClick={compact}>Compact</button>
        </div>
      </div>
      <div className="table">
        <div className="tr th grid-mdb"><span>Host / model</span><span>Queries</span><span>Oldest</span><span>Newest</span><span /></div>
        {(d?.hosts ?? []).map((h) => (
          <Fragment key={h.hostId}>
            <div className={`tr grid-mdb ${hostId === h.hostId && !model ? 'sel' : ''}`} style={{ height: 38, cursor: 'pointer' }}
              onClick={() => { setHostId(hostId === h.hostId ? '' : h.hostId); setModel('') }} title="Show its models">
              <span className="name ellipsis" style={{ fontWeight: 500 }}>{hostId === h.hostId ? '▾' : '▸'} {label(h.hostId)}</span>
              <span className="mono">{fmtN(h.queries)}</span>
              <span className="mono muted">{fmtStamp(h.oldestMs)}</span>
              <span className="mono muted">{fmtStamp(h.newestMs)}</span>
              <button type="button" className="btn xs ghost" onClick={(e) => { e.stopPropagation(); setHostId(h.hostId); setModel(''); setOlder('') }}>Select all</button>
            </div>
            {hostId === h.hostId && h.models.map((m) => (
              <div key={m.model} className={`tr grid-mdb ${model === m.model ? 'sel' : ''}`} style={{ height: 34, cursor: 'default' }}>
                <span className="ellipsis" style={{ paddingLeft: 22 }}>{m.model || '(no model)'}</span>
                <span className="mono">{fmtN(m.queries)}</span>
                <span className="mono muted">{fmtStamp(m.oldestMs)}</span>
                <span className="mono muted">{fmtStamp(m.newestMs)}</span>
                <button type="button" className="btn xs ghost" onClick={() => { setModel(m.model); setOlder('') }}>Select all</button>
              </div>
            ))}
          </Fragment>
        ))}
        {!d?.hosts?.length && <div className="empty">{info.isLoading ? 'Loading…' : 'No query history stored'}</div>}
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <span className="label">Delete queries</span>
        <label className="test-opt" title="Leave blank for any age">older than <input className="input" style={{ width: 60 }} value={older} placeholder="any" onChange={(e) => setOlder(e.target.value.replace(/\D/g, ''))} /> days</label>
        <select className="select" value={hostId} onChange={(e) => { setHostId(e.target.value); setModel('') }}>
          <option value="">All hosts</option>
          {(d?.hosts ?? []).map((h) => <option key={h.hostId} value={h.hostId}>{label(h.hostId)}</option>)}
        </select>
        <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">All models</option>
          {models.map((m) => <option key={m} value={m}>{m || '(no model)'}</option>)}
        </select>
        <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} disabled={!n || busy} onClick={run}
          title={everything ? 'No rule picked: deletes every stored query' : undefined}>
          {busy ? 'Deleting…' : n ? `Delete ${fmtN(n)} quer${n === 1 ? 'y' : 'ies'}${everything ? ' (all)' : ''}` : 'Nothing matches'}
        </button>
      </div>
    </div>
  )
}
