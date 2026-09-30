import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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
  const [busy, setBusy] = useState(false)
  const days = older === '' ? null : Number(older)
  const preview = useQuery({
    queryKey: ['monitorCleanupPreview', days, hostId],
    queryFn: () => monitorApi.cleanup({ olderThanDays: days!, hostId: hostId || null, dryRun: true }), enabled: days !== null, staleTime: 0,
  })
  const n = preview.data?.count ?? 0

  async function run() {
    if (days === null || !window.confirm(`Delete ${fmtN(n)} stored quer${n === 1 ? 'y' : 'ies'}? This can't be undone (a poll can pull them again while AtScale still keeps them).`)) return
    setBusy(true)
    try {
      const r = await monitorApi.cleanup({ olderThanDays: days, hostId: hostId || null })
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
        <div className="tr th grid-mdb"><span>Host</span><span>Queries</span><span>Oldest</span><span>Newest</span></div>
        {(d?.hosts ?? []).map((h) => (
          <div key={h.hostId} className={`tr grid-mdb ${hostId === h.hostId ? 'sel' : ''}`} style={{ height: 38, cursor: 'default' }}>
            <span className="name ellipsis" style={{ fontWeight: 500 }}>{label(h.hostId)}</span>
            <span className="mono">{fmtN(h.queries)}</span>
            <span className="mono muted">{fmtStamp(h.oldestMs)}</span>
            <span className="mono muted">{fmtStamp(h.newestMs)}</span>
          </div>
        ))}
        {!d?.hosts?.length && <div className="empty">{info.isLoading ? 'Loading…' : 'No query history stored'}</div>}
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <span className="label">Delete queries</span>
        <label className="test-opt">older than <input className="input" style={{ width: 60 }} value={older} placeholder="days" onChange={(e) => setOlder(e.target.value.replace(/\D/g, ''))} /> days</label>
        <select className="select" value={hostId} onChange={(e) => setHostId(e.target.value)}>
          <option value="">All hosts</option>
          {(d?.hosts ?? []).map((h) => <option key={h.hostId} value={h.hostId}>{label(h.hostId)}</option>)}
        </select>
        <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} disabled={days === null || !n || busy} onClick={run}>
          {busy ? 'Deleting…' : days === null ? 'Enter days' : n ? `Delete ${fmtN(n)} quer${n === 1 ? 'y' : 'ies'}` : 'Nothing matches'}
        </button>
      </div>
    </div>
  )
}
