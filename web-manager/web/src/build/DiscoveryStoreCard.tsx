import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errMsg, fmtDate } from '../components/ui'
import { useUi } from '../store'
import { discoveryApi } from './client'

/** Settings > Cache & Database: what Build > Discovery keeps
 *  (workspace/discovery.db) and cleaning it up - same shape as test/DatabaseCard. */
export function DiscoveryStoreCard() {
  const { flash } = useUi()
  const qc = useQueryClient()
  const info = useQuery({ queryKey: ['discoveryStore'], queryFn: discoveryApi.storeInfo, staleTime: 0 })
  const [older, setOlder] = useState('30')
  const [keep, setKeep] = useState('')
  const [hostId, setHostId] = useState('')
  const [busy, setBusy] = useState(false)
  const body = { olderThanDays: older === '' ? null : Number(older), keepPerTable: keep === '' ? null : Number(keep), hostId: hostId || null }
  const valid = body.olderThanDays !== null || body.keepPerTable !== null
  const preview = useQuery({
    queryKey: ['discoveryCleanupPreview', body.olderThanDays, body.keepPerTable, body.hostId, info.data?.profiles],
    queryFn: () => discoveryApi.cleanup({ ...body, dryRun: true }), enabled: valid, staleTime: 0,
  })
  const n = preview.data?.count ?? 0
  const d = info.data
  const hosts = [...new Set((d?.tables ?? []).map((t) => t.hostId))].sort()
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`

  async function run() {
    if (!window.confirm(`Delete ${n} profile run${n === 1 ? '' : 's'}? A table left with no runs is profiled again on its next visit. This can't be undone.`)) return
    setBusy(true)
    try {
      const r = await discoveryApi.cleanup(body)
      flash(`Deleted ${r.count} profile run${r.count === 1 ? '' : 's'}`)
      qc.removeQueries({ queryKey: ['discovery'] })
      info.refetch()
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  async function compact() {
    setBusy(true)
    try {
      const r = await discoveryApi.compact()
      flash(`Compacted · ${mb(r.freedBytes)} freed`)
      info.refetch()
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ gap: 12, padding: '16px 20px' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="eyebrow" style={{ color: 'var(--prod)' }}>Database · discovery profiles</span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Build › Discovery profiles, sample rows, top values and join checks in <span className="mono" style={{ color: 'var(--ink)' }}>{d?.path ?? 'workspace/discovery.db'}</span>.
            {d && ` Served from here until Re-profile; kept automatically: newest ${d.keepPerTable} runs per table.`}
          </span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="hint">{d ? `${d.tables.length} tables · ${d.profiles} runs · ${mb(d.bytes)}` : '…'}</span>
          <button type="button" className="btn ghost" disabled={busy} title="Give space freed by deleted runs back to the disk" onClick={compact}>Compact</button>
        </div>
      </div>
      <div className="table">
        <div className="tr th grid-disc"><span>Table</span><span>Host</span><span>Runs</span><span>Stored</span><span>Last profiled</span><span /></div>
        {(d?.tables ?? []).map((t) => (
          <div key={`${t.hostId}|${t.connectionId}|${t.database}|${t.schema}|${t.table}`}
            className={`tr grid-disc ${hostId === t.hostId ? 'sel' : ''}`} style={{ height: 38, cursor: 'default' }}>
            <span className="name ellipsis" style={{ fontWeight: 500 }} title={`${t.connectionId} · ${t.database}`}>{t.schema}.{t.table}</span>
            <span className="mono muted ellipsis">{t.hostId}</span>
            <span className="mono">{t.runs}</span>
            <span className="mono">{mb(t.bytes)}</span>
            <span className="mono muted">{fmtDate(t.newest, true)}</span>
            <button type="button" className="btn xs ghost" title="Pick every run of this host"
              onClick={() => { setHostId(t.hostId); setOlder(''); setKeep('0') }}>Select host</button>
          </div>
        ))}
        {!d?.tables.length && <div className="empty">{info.isLoading ? 'Loading…' : 'No tables profiled yet'}</div>}
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <span className="label">Delete profile runs</span>
        <label className="test-opt">older than <input className="input" style={{ width: 60 }} value={older} placeholder="any" onChange={(e) => setOlder(e.target.value.replace(/\D/g, ''))} /> days</label>
        <label className="test-opt">and / or beyond the newest <input className="input" style={{ width: 60 }} value={keep} placeholder="all" onChange={(e) => setKeep(e.target.value.replace(/\D/g, ''))} /> per table</label>
        <select className="select" value={hostId} onChange={(e) => setHostId(e.target.value)}>
          <option value="">All hosts</option>
          {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} disabled={!valid || !n || busy} onClick={run}>
          {busy ? 'Deleting…' : !valid ? 'Pick a rule' : n ? `Delete ${n} run${n === 1 ? '' : 's'}` : 'Nothing matches'}
        </button>
      </div>
    </div>
  )
}
