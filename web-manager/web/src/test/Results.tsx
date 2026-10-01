import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { envOf, errMsg, fmtDate } from '../components/ui'
import type { EnvId } from '../api'
import { useUi } from '../store'
import { testApi, type Protocol, type TestResult, type TestRun } from './api'
import { HostTag, Pill, VerdictBanner, fmtPct } from './shared'

export function runStatus(r: TestRun): [string, string, string] {
  if (r.status === 'running') return [`Running ${r.total ? Math.round((r.done / r.total) * 100) : 0}%`, 'var(--dev)', '#fff']
  if (r.status === 'failed') return ['Error', 'var(--danger)', '#fff']
  if (r.failed) return [`${r.failed} failed`, 'var(--danger)', '#fff']
  return ['All ran', 'var(--qa)', '#fff']
}

/** Runs grouped by model (newest model activity first), each group newest first. */
export function useRunGroups() {
  const q = useQuery({ queryKey: ['testRuns'], queryFn: testApi.runs, staleTime: 0,
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === 'running') ? 2000 : false) })
  const groups = useMemo(() => {
    const m = new Map<string, TestRun[]>()
    for (const r of q.data?.runs ?? []) {
      const k = r.model ?? '(unknown model)'
      m.set(k, [...(m.get(k) ?? []), r])
    }
    return [...m.entries()]
  }, [q.data])
  return { ...q, groups }
}

export function ResultsSection() {
  const { testRunId, setTestRunId, flash } = useUi()
  const qc = useQueryClient()
  const { groups, isLoading } = useRunGroups()
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  useEffect(() => { if (!testRunId && groups[0]?.[1][0]) setTestRunId(groups[0][1][0].runId) }, [groups, testRunId, setTestRunId])

  async function remove(id: string) {
    if (!window.confirm(`Delete run ${id} and its stored results?`)) return
    try {
      await testApi.remove(id)
      if (testRunId === id) setTestRunId(null)
      qc.invalidateQueries({ queryKey: ['testRuns'] })
    } catch (e) {
      flash(errMsg(e), 'err')
    }
  }

  return (
    <div className="results-split">
      <aside className="run-list">
        <div className="run-list-head"><span className="eyebrow">Runs by model</span><span className="hint">Clean up in Settings</span></div>
        {groups.map(([model, runs]) => (
          <div key={model} className="run-group">
            <button type="button" className="run-group-head" onClick={() => setClosed((c) => ({ ...c, [model]: !c[model] }))}>
              <span className="mono">{closed[model] ? '▸' : '▾'}</span>
              <span className="name ellipsis">{model}</span>
              <span className="hint">{runs.length}</span>
            </button>
            {!closed[model] && runs.map((r) => {
              const [label, bg, fg] = runStatus(r)
              return (
                <div key={r.runId} className={`run-item ${testRunId === r.runId ? 'on' : ''}`} onClick={() => setTestRunId(r.runId)}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span className="mono">{fmtDate(r.startedAt, true)}</span>
                    <Pill label={label} bg={bg} fg={fg} />
                  </div>
                  <div className="run-item-hosts">
                    {r.targets.map((t) => (
                      <span key={t.hostId} className="mono"><span className="sq" style={{ background: envOf((t.env ?? 'dev') as EnvId).color }} />{t.label ?? t.hostId}</span>
                    ))}
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span className="hint">{r.total} queries · {r.protocols.map((p) => p.toUpperCase()).join('+')}</span>
                    <button type="button" className="linkbtn" disabled={r.status === 'running'} onClick={(e) => { e.stopPropagation(); remove(r.runId) }}>Delete</button>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
        {!groups.length && <div className="empty">{isLoading ? 'Loading…' : 'No runs yet - start one from Run'}</div>}
      </aside>
      <div className="run-detail">{testRunId ? <RunDetail key={testRunId} runId={testRunId} /> : <div className="empty">Pick a run</div>}</div>
    </div>
  )
}

function RunDetail({ runId }: { runId: string }) {
  const { setTestSection, setTestCompare } = useUi()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['testRun', runId], queryFn: () => testApi.run(runId), staleTime: 0,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  })
  const run = q.data
  useEffect(() => { if (run && run.status !== 'running') qc.invalidateQueries({ queryKey: ['testRuns'] }) }, [run?.status, qc, run])
  const [baseline, setBaseline] = useState<string | null>(null)
  const baseId = baseline ?? run?.targets[0]?.hostId ?? null
  const others = run?.targets.filter((t) => t.hostId !== baseId) ?? []
  const checks = useQueries({
    queries: others.map((t) => ({
      queryKey: ['testCompare', runId, baseId, runId, t.hostId, 1e-9],
      queryFn: () => testApi.compare({ runId, hostId: baseId! }, { runId, hostId: t.hostId }, 1e-9),
      enabled: !!run && run.status !== 'running' && !!baseId,
    })),
  })
  const [open, setOpen] = useState<string | null>(null)
  const [onlyFailed, setOnlyFailed] = useState(false)

  if (q.isError) return <div className="notice err"><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(q.error)}</div>
  if (!run) return <div className="empty">Loading run…</div>

  const results = run.results ?? []
  const hostIds = run.targets.map((t) => t.hostId)
  const rows = new Map<string, { id: string; name: string; protocol: Protocol; byHost: Record<string, TestResult> }>()
  for (const qd of run.queries ?? []) for (const p of run.protocols) rows.set(`${qd.id}|${p}`, { id: qd.id, name: qd.name, protocol: p, byHost: {} })
  for (const r of results) {
    const row = rows.get(`${r.queryId}|${r.protocol}`)
    if (row) row.byHost[r.hostId] = r
  }
  const list = [...rows.entries()].filter(([, r]) => !onlyFailed || Object.values(r.byHost).some((x) => x.status === 'FAILED'))
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0
  const [sLabel, sBg, sFg] = runStatus(run)
  const allPass = checks.length > 0 && checks.every((c) => c.data?.verdict === 'pass')
  const checksDone = checks.every((c) => c.data || c.isError)

  return (
    <div className="run-detail-inner">
      <div className="run-head">
        <div>
          <span className="eyebrow">{run.catalog}</span>
          <div className="run-title">{run.model}</div>
          <span className="hint">Run {run.runId} · {fmtDate(run.startedAt, true)} · {run.protocols.map((p) => p.toUpperCase()).join(' + ')} · {run.done}/{run.total} executed</span>
        </div>
        <div className="row">
          <Pill label={sLabel} bg={sBg} fg={sFg} />
          <a className="btn ghost" style={{ display: 'flex', alignItems: 'center' }} href={testApi.csvUrl(run.runId)}>Results CSV</a>
        </div>
      </div>
      {run.status === 'running' && <div className="test-progress"><span style={{ width: `${pct}%` }} /></div>}
      {run.error && <div className="notice err" style={{ margin: '12px 0' }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{run.error}</div>}

      {run.targets.length > 1 && (
        <section className="promo">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="eyebrow">Promotion check · against baseline</span>
            <label className="test-opt">Baseline
              <select className="select sm" value={baseId ?? ''} onChange={(e) => setBaseline(e.target.value)}>
                {run.targets.map((t) => <option key={t.hostId} value={t.hostId}>{t.label ?? t.hostId}</option>)}
              </select>
            </label>
          </div>
          {run.status !== 'running' && checksDone && (
            <VerdictBanner pass={allPass}
              title={allPass ? `Every host matches ${run.targets.find((t) => t.hostId === baseId)?.label}` : 'Hosts differ from the baseline'}
              detail={allPass ? 'Model (DMV) and every query result are identical - safe to promote' : 'Open a comparison below to see what differs'} />
          )}
          <div className="promo-cards">
            {others.map((t, i) => {
              const c = checks[i]
              const d = c.data
              const n = (k: string) => (d?.counts as Record<string, number> | undefined)?.[k] ?? 0
              const failed = n('failedBaseline') + n('failedCandidate') + n('failedBoth')
              return (
                <div key={t.hostId} className={`promo-card ${d ? (d.verdict === 'pass' ? 'ok' : 'bad') : ''}`}>
                  <HostTag env={t.env} label={t.label} />
                  {run.status === 'running' ? <span className="hint">Waiting for the run…</span>
                    : c.isError ? <span className="mono" style={{ color: 'var(--danger)' }}>{errMsg(c.error)}</span>
                    : !d ? <span className="hint">Comparing…</span> : (
                      <>
                        <span className="promo-verdict">{d.verdict === 'pass' ? '✓ Matches baseline' : '✕ Differs from baseline'}</span>
                        <span className="mono">Model: <b style={{ color: d.model?.identical ? 'var(--qa)' : 'var(--warn)' }}>{d.model ? (d.model.identical ? 'identical' : 'differs') : 'n/a'}</b></span>
                        <span className="mono">Results: <b style={{ color: n('identical') === d.total ? 'var(--qa)' : 'var(--warn)' }}>{n('identical')}/{d.total} identical</b>{n('differs') ? ` · ${n('differs')} differ` : ''}{failed ? ` · ${failed} failed` : ''}</span>
                        <span className="mono muted">Time {fmtPct(d.time.pct)}</span>
                        <button type="button" className="btn xs info" style={{ alignSelf: 'flex-start' }} onClick={() => {
                          setTestCompare({ baseline: { runId, hostId: baseId! }, candidate: { runId, hostId: t.hostId } })
                          setTestSection('compare')
                        }}>Open comparison</button>
                      </>
                    )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <div className="test-summary" style={{ margin: '14px 0' }}>
        {run.targets.map((t) => {
          const mine = results.filter((r) => r.hostId === t.hostId)
          const ok = mine.filter((r) => r.status === 'SUCCEEDED')
          const avg = ok.length ? Math.round(ok.reduce((a, r) => a + r.durationMs, 0) / ok.length) : 0
          const max = ok.length ? Math.max(...ok.map((r) => r.durationMs)) : 0
          const env = envOf((t.env ?? 'dev') as EnvId)
          return (
            <div key={t.hostId} className="test-card" style={{ borderTopColor: env.color }}>
              <HostTag env={t.env} label={t.label} />
              <span className="mono muted ellipsis">{t.cube} — {t.catalog}</span>
              <span className="mono">
                <span style={{ color: 'var(--qa)' }}>{ok.length} ok</span>
                {mine.length - ok.length > 0 && <span style={{ color: 'var(--danger)' }}> · {mine.length - ok.length} failed</span>}
                <span className="muted"> · avg {avg} ms · max {max} ms</span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="toolbar" style={{ margin: '0 0 8px' }}>
        <span className="label">Executions</span>
        <label className="test-opt"><input type="checkbox" checked={onlyFailed} onChange={() => setOnlyFailed((v) => !v)} />Failed only</label>
        <span className="hint" style={{ marginLeft: 'auto' }}>MDX counts cells, SQL counts rows</span>
      </div>
      <div className="table">
        <div className="tr th" style={{ gridTemplateColumns: gridCols(hostIds.length) }}>
          <span>Query</span><span>Lang</span>
          {run.targets.map((t) => <span key={t.hostId} className="ellipsis">{t.label ?? t.hostId}</span>)}
        </div>
        {list.map(([key, row]) => (
          <Fragment key={key}>
            <div className={`tr ${open === key ? 'sel' : ''}`} style={{ gridTemplateColumns: gridCols(hostIds.length), height: 40 }} onClick={() => setOpen(open === key ? null : key)}>
              <span className="ellipsis" style={{ fontSize: 13 }} title={row.name}>{row.name}</span>
              <span className="mono muted">{row.protocol.toUpperCase()}</span>
              {hostIds.map((h) => {
                const r = row.byHost[h]
                if (!r) return <span key={h} className="hint">{run.status === 'running' ? '…' : '—'}</span>
                return (
                  <span key={h} className="mono" title={r.error || undefined} style={{ color: r.status === 'FAILED' ? 'var(--danger)' : undefined }}>
                    {r.status === 'FAILED' ? 'Failed' : `${r.rowCount} · ${r.durationMs} ms`}
                  </span>
                )
              })}
            </div>
            {open === key && (
              <div className="test-qtext">
                {hostIds.map((h) => row.byHost[h]).filter((r) => r?.error).map((r) => (
                  <div key={r.hostId}><span className="eyebrow" style={{ color: 'var(--danger)' }}>{r.host} error</span><pre>{r.error}</pre></div>
                ))}
                <div><span className="eyebrow">{row.protocol.toUpperCase()}</span><pre>{(run.queries ?? []).find((qq) => qq.id === row.id)?.[row.protocol]}</pre></div>
                {run.model && <QueryHistory model={run.model} name={row.name} protocol={row.protocol} current={run.runId} />}
              </div>
            )}
          </Fragment>
        ))}
        {!list.length && <div className="empty">{onlyFailed ? 'No failures' : 'No executions yet'}</div>}
      </div>
    </div>
  )
}

const gridCols = (nHosts: number) => `minmax(0, 2.4fr) 48px repeat(${nHosts}, minmax(120px, 1fr))`

/** One query across past runs of the model: did its time, size or result change? */
function QueryHistory({ model, name, protocol, current }: { model: string; name: string; protocol: Protocol; current: string }) {
  const q = useQuery({ queryKey: ['testHistory', model, name, protocol], queryFn: () => testApi.history(model, name, protocol), staleTime: 0 })
  const rows = q.data?.history ?? []
  const firstSum = new Map<string, string>()
  for (const r of [...rows].reverse()) if (r.checksum && !firstSum.has(r.hostId)) firstSum.set(r.hostId, r.checksum)
  return (
    <div style={{ gridColumn: '1 / -1' }}>
      <span className="eyebrow">History · this query in the last {rows.length} executions</span>
      <div className="table" style={{ marginTop: 6 }}>
        <div className="tr th grid-hist"><span>Run</span><span>Host</span><span>Status</span><span>Time</span><span>Size</span><span>Result</span></div>
        {rows.map((r) => (
          <div key={`${r.runId}|${r.hostId}`} className={`tr grid-hist ${r.runId === current ? 'sel' : ''}`} style={{ height: 30, cursor: 'default' }}>
            <span className="mono">{fmtDate(r.startedAt, true)}</span>
            <HostTag env={r.env} label={r.host} />
            <span className="mono" style={{ color: r.status === 'FAILED' ? 'var(--danger)' : 'var(--qa)' }} title={r.error || undefined}>{r.status === 'FAILED' ? 'Failed' : 'OK'}</span>
            <span className="mono">{r.durationMs} ms</span>
            <span className="mono">{r.rowCount}</span>
            <span className="mono" title={r.checksum}>{!r.checksum ? '—' : r.checksum === firstSum.get(r.hostId) ? 'same as first run' : <span style={{ color: 'var(--warn)' }}>changed</span>}</span>
          </div>
        ))}
        {!rows.length && <div className="empty">{q.isLoading ? 'Loading…' : 'No history'}</div>}
      </div>
    </div>
  )
}
