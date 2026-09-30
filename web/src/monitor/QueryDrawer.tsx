import { useQuery } from '@tanstack/react-query'
import { errMsg } from '../components/ui'
import { monitorApi } from './api'
import { fmtMs, fmtStamp } from './charts'
import { ClsPill, StatusText } from './shared'

const PHASES: { name: string; label: string; color: string }[] = [
  { name: 'Planning', label: 'Planning', color: '#9085e9' },
  { name: 'Outbound', label: 'Warehouse / aggregate', color: '#3987e5' },
  { name: 'Result Processing', label: 'Result processing', color: '#199e70' },
]

/** One query: timeline, what answered it (aggregates with system / user type), text. */
export function QueryDrawer({ hostId, queryId, onClose }: { hostId: string; queryId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['monitorQuery', hostId, queryId], queryFn: () => monitorApi.query(hostId, queryId) })
  const d = q.data?.query
  const errors = q.data?.errors ?? {}
  const total = d ? Math.max(d.durationMs, 1) : 1
  const phaseMs = (name: string) => d?.events.find((e) => e.name === name)?.duration ?? 0
  const outbound = d?.events.find((e) => e.name === 'Outbound')
  return (
    <aside className="mon-drawer">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow">Query</span>
        <button type="button" className="linkbtn" onClick={onClose}>Close ✕</button>
      </div>
      {!d && <div className="empty">{q.isError ? errMsg(q.error) : 'Loading…'}</div>}
      {d && (
        <>
          <div className="mon-title">{d.modelName || '—'}</div>
          <div className="mono muted" style={{ wordBreak: 'break-all' }}>{d.queryId}</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <ClsPill cls={d.cls} /><StatusText q={d} />
            <span className="mono">{d.status === 'running' ? 'running' : fmtMs(d.durationMs)}</span>
            <span className="hint">{d.queryType}</span>
          </div>
          <dl className="kv">
            <dt>Started</dt><dd className="mono">{fmtStamp(d.startMs)}</dd>
            <dt>User</dt><dd>{d.queryType === 'System' ? 'System' : `${d.user}${d.userId && d.userId !== d.user ? ` (${d.userId})` : ''}`}</dd>
            <dt>Catalog</dt><dd>{d.catalogName || '—'}</dd>
            <dt>Dialect</dt><dd className="mono">{d.dialect || '—'}</dd>
          </dl>
          {d.failedMessage && <div className="notice err" style={{ margin: 0 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Failed</span>{d.failedMessage}</div>}

          <span className="eyebrow">Timeline</span>
          <div className="timeline">
            <div className="tl-bar">
              {PHASES.map((p) => {
                const v = phaseMs(p.name)
                return v ? <span key={p.name} style={{ flexGrow: v, background: p.color }} title={`${p.label}: ${fmtMs(v)}`} /> : null
              })}
              <span style={{ flexGrow: Math.max(total - PHASES.reduce((a, p) => a + phaseMs(p.name), 0), 0), background: 'var(--off)' }} />
            </div>
            {PHASES.map((p) => (
              <div key={p.name} className="tl-row">
                <span className="viz-key" style={{ background: p.color }} /><span>{p.label}</span>
                <span className="num mono">{fmtMs(phaseMs(p.name))}</span>
              </div>
            ))}
            {(outbound?.subqueries ?? []).map((s) => (
              <div key={s.subqueryId} className="tl-row sub"><span /><span>{s.name}</span><span className="num mono">{fmtMs(s.duration)}</span></div>
            ))}
          </div>

          <span className="eyebrow">Aggregates used</span>
          {errors.aggregates && <span className="err-text">{errors.aggregates}</span>}
          {d.aggDefs && d.aggDefs.length > 0 ? (
            <div className="chips col">
              {d.aggDefs.map((a) => (
                <div key={a.id} className="agg-used">
                  <span className="ellipsis" title={a.table ?? undefined}>{a.name || a.id}</span>
                  <span className="pill" style={{ background: a.type === 'system_defined' ? 'var(--off)' : 'rgba(42,165,199,.18)', color: a.type === 'system_defined' ? 'var(--ink-soft)' : 'var(--dev)' }}>
                    {a.type === 'system_defined' ? 'System' : 'User'}{a.subType ? ` · ${a.subType.replace('_defined', '').replace('_', ' ')}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : !errors.aggregates && <span className="muted" style={{ fontSize: 12.5 }}>{d.aggTables.length ? d.aggTables.join(', ') : 'None'}</span>}

          {(d.attributes.length > 0 || d.measures.length > 0) && (
            <>
              <span className="eyebrow">Fields</span>
              <div className="chips">
                {d.measures.map((m) => <span key={`m${m}`} className="chip m">{m}</span>)}
                {d.attributes.map((a) => <span key={`a${a}`} className="chip">{a}</span>)}
              </div>
            </>
          )}

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="eyebrow">Query text</span>
            {d.text && <button type="button" className="btn xs" onClick={() => navigator.clipboard?.writeText(d.text ?? '')}>Copy</button>}
          </div>
          {errors.text ? <span className="err-text">{errors.text}</span> : <pre className="mon-text">{d.text || '—'}</pre>}
        </>
      )}
    </aside>
  )
}
