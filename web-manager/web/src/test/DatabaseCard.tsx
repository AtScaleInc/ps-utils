import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errMsg, fmtDate } from '../components/ui'
import { useUi } from '../store'
import { testApi } from './api'

/** Settings > Cache & Database: what Test keeps (workspace/tests.db) and cleaning it up. */
export function DatabaseCard() {
  const { flash, setTestRunId } = useUi()
  const qc = useQueryClient()
  const info = useQuery({ queryKey: ['testStore'], queryFn: testApi.storeInfo, staleTime: 0 })
  const runs = useQuery({ queryKey: ['testRuns'], queryFn: testApi.runs, staleTime: 0 })
  const models = [...new Set((runs.data?.runs ?? []).map((r) => r.model).filter((m): m is string => !!m))].sort()
  const [older, setOlder] = useState('30')
  const [keep, setKeep] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const body = { olderThanDays: older === '' ? null : Number(older), keepPerModel: keep === '' ? null : Number(keep), model: model || null }
  const valid = body.olderThanDays !== null || body.keepPerModel !== null
  const preview = useQuery({
    queryKey: ['testCleanupPreview', body.olderThanDays, body.keepPerModel, body.model],
    queryFn: () => testApi.cleanup({ ...body, dryRun: true }), enabled: valid, staleTime: 0,
  })
  const n = preview.data?.count ?? 0

  async function run() {
    if (!window.confirm(`Delete ${n} test run${n === 1 ? '' : 's'} and their stored results? This can't be undone.`)) return
    setBusy(true)
    try {
      const r = await testApi.cleanup(body)
      flash(`Deleted ${r.count} test run${r.count === 1 ? '' : 's'}`)
      setTestRunId(null)
      qc.invalidateQueries({ queryKey: ['testRuns'] })
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
      const r = await testApi.compact()
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
          <span className="eyebrow" style={{ color: 'var(--prod)' }}>Database · test history</span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Test runs, model snapshots and result rows in <span className="mono" style={{ color: 'var(--ink)' }}>{d?.path ?? 'workspace/tests.db'}</span>.
            {d && ` Kept automatically: newest ${d.keepPerModel} runs per model, none older than ${d.maxAgeDays} days; ${d.maxActive} runs can execute at once.`}
          </span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="hint">{d ? `${d.runs} runs · ${d.executions} executions · ${mb(d.bytes)}` : '…'}</span>
          <button type="button" className="btn ghost" disabled={busy} title="Give space freed by deleted runs back to the disk" onClick={compact}>Compact</button>
        </div>
      </div>
      <div className="table">
        <div className="tr th grid-db"><span>Model</span><span>Runs</span><span>Executions</span><span>Result data</span><span>Oldest run</span><span>Newest run</span><span /></div>
        {(d?.models ?? []).map((m) => (
          <div key={m.model ?? '∅'} className={`tr grid-db ${model === m.model ? 'sel' : ''}`} style={{ height: 38, cursor: 'default' }}>
            <span className="name ellipsis" style={{ fontWeight: 500 }}>{m.model ?? '(unknown)'}</span>
            <span className="mono">{m.runs}</span>
            <span className="mono">{m.executions}</span>
            <span className="mono">{mb(m.dataBytes)}</span>
            <span className="mono muted">{fmtDate(m.oldest, true)}</span>
            <span className="mono muted">{fmtDate(m.newest, true)}</span>
            <button type="button" className="btn xs ghost" onClick={() => { setModel(m.model ?? ''); setOlder(''); setKeep('0') }}>Select all</button>
          </div>
        ))}
        {!d?.models?.length && <div className="empty">{info.isLoading ? 'Loading…' : 'No test runs stored'}</div>}
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        <span className="label">Delete runs</span>
        <label className="test-opt">older than <input className="input" style={{ width: 60 }} value={older} placeholder="any" onChange={(e) => setOlder(e.target.value.replace(/\D/g, ''))} /> days</label>
        <label className="test-opt">and / or beyond the newest <input className="input" style={{ width: 60 }} value={keep} placeholder="all" onChange={(e) => setKeep(e.target.value.replace(/\D/g, ''))} /> per model</label>
        <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">All models</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button type="button" className="btn danger" style={{ marginLeft: 'auto' }} disabled={!valid || !n || busy} onClick={run}>
          {busy ? 'Deleting…' : !valid ? 'Pick a rule' : n ? `Delete ${n} run${n === 1 ? '' : 's'}` : 'Nothing matches'}
        </button>
      </div>
    </div>
  )
}
