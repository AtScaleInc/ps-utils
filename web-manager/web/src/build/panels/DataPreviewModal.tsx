import { useEffect, useMemo, useState } from 'react'
import { runDataPreview, type DataPreviewCheck, type DataPreviewMode, type DataPreviewRows } from '../client'
import { buildRequest, joinTree, previewItems, type PreviewItem } from '../lib/dataPreview'
import { useModelStore } from '../modelStore'
import { PickList } from './PickList'

const MODES: { id: DataPreviewMode; title: string; note: string }[] = [
  { id: 'rows', title: 'Rows', note: 'Joined rows as they are - metrics unaggregated.' },
  { id: 'aggregate', title: 'Aggregated', note: 'Metrics with their aggregation, grouped by the attributes.' },
  { id: 'check', title: 'Check joins', note: 'Counts every row: fan-out and unmatched keys per join.' },
]

const fmtN = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

/** Develop > Preview data: the canvas's joins, metrics and attributes run as
 *  plain SQL on the warehouse (api/discovery/data_preview.py), so a wrong join
 *  or metric shows up before anything is generated or deployed. 10 rows - the
 *  engine's query/sample limit. Same frame as the Wizard. */
export function DataPreviewModal({ onClose }: { onClose: () => void }) {
  const nodes = useModelStore((s) => s.nodes)
  const joins = useModelStore((s) => s.joins)
  const cfg = useModelStore((s) => s.cfg)
  const sourceId = useModelStore((s) => s.sourceId)
  const dialect = useModelStore((s) => s.sourceMeta?.dialect ?? null)
  const sourceLabel = useModelStore((s) => (s.sourceMeta ? `${s.sourceMeta.connectionId} · ${s.sourceMeta.database}` : null))
  const calcCount = useModelStore((s) => s.calculations.length)

  // Facts first: a preview normally starts where the metrics live.
  const roots = useMemo(
    () => [...nodes.filter((n) => n.role === 'fact'), ...nodes.filter((n) => n.role === 'dimension')],
    [nodes],
  )
  const [rootId, setRootId] = useState<string | null>(roots[0]?.id ?? null)
  const root = roots.find((n) => n.id === rootId) ?? null
  const tree = useMemo(() => (root ? joinTree(root, nodes, joins) : []), [root, nodes, joins])
  const items = useMemo(() => previewItems(tree, cfg), [tree, cfg])
  const [picked, setPicked] = useState<Set<string>>(() => new Set())

  const [mode, setMode] = useState<DataPreviewMode>('rows')
  const [result, setResult] = useState<{ data: DataPreviewRows | DataPreviewCheck; headers: ReturnType<typeof buildRequest>['headers'] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const chosen = items.filter((i) => picked.has(i.id))
  const metrics = items.filter((i) => i.kind === 'metric' || i.kind === 'degenerate')
  const byInstance = tree.slice(1).map((inst) => ({ inst, items: items.filter((i) => i.instance === inst.id) }))

  async function run(m: DataPreviewMode = mode, cols: PreviewItem[] = chosen) {
    if (!sourceId) return setError('Pick a data source on the left of the canvas first.')
    if (m !== 'check' && !cols.length) return setError('Pick at least one metric or attribute.')
    const req = buildRequest(tree, cols, m === 'check' && !cols.length)
    if (m === 'check' && req.tables.length < 2) return setError('Nothing to check - pick attributes from a joined dimension.')
    setBusy(true)
    setError(null)
    try {
      const data = await runDataPreview({ source: sourceId, dialect, mode: m, tables: req.tables, columns: req.columns })
      setResult({ data, headers: req.headers })
    } catch (e) {
      setResult(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // Nothing picked and nothing run on open or per base table: every picked
  // column is another join / scan, so the user chooses what to query.
  useEffect(() => {
    setPicked(new Set())
    setResult(null)
    setError(null)
  }, [rootId])
  // Drop picks whose column left the canvas (a level unmarked, a join removed).
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id))
    setPicked((prev) => (([...prev].every((id) => ids.has(id))) ? prev : new Set([...prev].filter((id) => ids.has(id)))))
  }, [items])

  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal wizard" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <nav className="wizard-rail dp-rail">
          <div className="eyebrow">Preview data</div>
          <div className="field">
            Start from
            <PickList
              options={roots.map((n) => ({ value: n.id, label: (n.role === 'fact' ? n.factName : n.dimName) || n.table,
                group: n.role === 'fact' ? 'Facts' : 'Dimensions', hint: n.table }))}
              value={rootId}
              onChange={setRootId}
              placeholder="Pick a table…"
            />
          </div>

          <div className="dp-pick">
            {metrics.length > 0 && (
              <PickGroup title="Metrics" items={metrics} picked={picked} toggle={toggle} />
            )}
            {byInstance.map(({ inst, items: its }) => its.length > 0 && (
              <PickGroup key={inst.id} title={inst.label} sub={inst.on ? `${inst.on[0]} = ${inst.node.table}.${inst.on[1]}` : undefined}
                items={its} picked={picked} toggle={toggle} />
            ))}
            {root && !items.length && (
              <div className="field-note">Nothing to show yet - mark measures on the fact and levels on its dimensions.</div>
            )}
            {calcCount > 0 && (
              <div className="field-note">Calculations are MDX - they run in AtScale after deploy, not here.</div>
            )}
          </div>
          <button type="button" className="btn btn-ghost btn-sm wizard-cancel" onClick={onClose}>Close</button>
        </nav>

        <section className="wizard-main">
          <header className="wizard-head">
            <span className="eyebrow">First 10 rows · straight from the warehouse{sourceLabel ? ` · ${sourceLabel}` : ''}</span>
            <span className="headline">{root ? ((root.role === 'fact' ? root.factName : root.dimName) || root.table) : 'Nothing on the canvas'}</span>
            <span className="field-note">
              Tables join the way the canvas says (LEFT JOIN from {root?.table ?? 'the base table'}), so a key with no
              match shows as NULL instead of disappearing. 10 rows is AtScale's limit for this query - use Check joins for totals.
            </span>
            <div className="dp-modes">
              <div className="preview-mode">
                {MODES.map((m) => (
                  <button key={m.id} type="button" className={mode === m.id ? 'on' : ''} title={m.note} onClick={() => setMode(m.id)}>{m.title}</button>
                ))}
              </div>
              <span className="field-note">{MODES.find((m) => m.id === mode)?.note}</span>
              <button type="button" className="btn btn-primary" disabled={busy || !root || (mode !== 'check' && !chosen.length)}
                title={mode !== 'check' && !chosen.length ? 'Pick at least one metric or attribute' : undefined} onClick={() => run()}>
                {busy ? 'Running…' : 'Run'}
              </button>
            </div>
          </header>

          <div className="wizard-body">
            {error && (
              <div className="login-error wizard-error">
                {error}
                {/^Invalid data source/.test(error) && (
                  <div className="field-note" style={{ marginTop: 6 }}>
                    The Data Source panel left of the canvas decides where Preview data runs - switch it back, then Run again.
                  </div>
                )}
              </div>
            )}
            {busy && !result && <span className="field-note wizard-inline"><span className="spinner" /> Querying the warehouse…</span>}
            {!busy && !result && !error && root && items.length > 0 && (
              <span className="field-note wizard-inline">
                Pick the metrics and attributes to look at on the left, then Run. Fewer columns means fewer joins - and a faster preview.
              </span>
            )}
            {result?.data.mode === 'check' && <CheckView data={result.data} />}
            {result && result.data.mode !== 'check' && <RowsView data={result.data} headers={result.headers} />}
            {result && (
              <details className="dp-sql">
                <summary>SQL sent to AtScale · {fmtN(result.data.elapsedMs)} ms</summary>
                <pre>{result.data.sql}</pre>
              </details>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function PickGroup({ title, sub, items, picked, toggle }: {
  title: string
  sub?: string
  items: PreviewItem[]
  picked: Set<string>
  toggle: (ids: string[], on: boolean) => void
}) {
  const ids = items.map((i) => i.id)
  const all = ids.every((id) => picked.has(id))
  return (
    <div className="dp-group">
      <label className="dp-group-head" title={sub}>
        <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} />
        <span className="ellipsis">{title}</span>
      </label>
      {sub && <div className="dp-group-sub mono ellipsis" title={sub}>{sub}</div>}
      {items.map((i) => (
        <label key={i.id} className={`dp-item ${i.kind}`}>
          <input type="checkbox" checked={picked.has(i.id)} onChange={(e) => toggle([i.id], e.target.checked)} />
          <span className="ellipsis" title={i.column}>{i.label}</span>
          {i.kind === 'metric' && <span className="dp-agg">{i.agg}</span>}
        </label>
      ))}
    </div>
  )
}

function RowsView({ data, headers }: { data: DataPreviewRows; headers: ReturnType<typeof buildRequest>['headers'] }) {
  // A dimension column NULL on every sampled row usually means its join matched nothing.
  const allNull = headers.map((h, i) => h.kind !== 'metric' && data.rows.length > 0 && data.rows.every((r) => r[i] == null))
  return (
    <>
      <div className="field-note" style={{ marginBottom: 10 }}>
        {data.rows.length ? `${data.rows.length} row${data.rows.length === 1 ? '' : 's'}` : 'No rows came back.'}
        {allNull.some(Boolean) && <span className="dp-warn"> · ⚠ {allNull.filter(Boolean).length} column(s) NULL on every row - check that join</span>}
      </div>
      <div className="dp-table-wrap">
        <table className="preview-table dp-table">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} className={`${h.kind}${allNull[i] ? ' null' : ''}`}>
                  <span>{h.label}</span>
                  <span className="dp-sub">{data.mode === 'rows' && h.kind === 'metric' ? h.sub.split(' · ')[1] : h.sub}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, ri) => (
              <tr key={ri}>
                {headers.map((h, i) => (
                  <td key={i} className={h.kind === 'metric' ? 'num' : ''}>
                    {r[i] == null ? <span className="dp-null">NULL</span> : r[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function CheckView({ data }: { data: DataPreviewCheck }) {
  const root = data.rootRows ?? 0
  return (
    <div className="dp-check">
      <div className={`dp-check-row ${data.fanOut ? 'bad' : 'ok'}`}>
        <div><b>{fmtN(data.rootRows)}</b> base rows → <b>{fmtN(data.joinedRows)}</b> after the joins</div>
        <span>{data.fanOut
          ? `⚠ fan-out: ${fmtN((data.joinedRows ?? 0) - root)} extra rows - a join key isn't unique on the dimension side, every metric would be inflated.`
          : '✓ no fan-out - every metric keeps its grain.'}</span>
      </div>
      {data.joins.map((j) => {
        const miss = j.matched == null ? null : (data.joinedRows ?? 0) - j.matched
        const pct = miss != null && data.joinedRows ? (100 * miss) / data.joinedRows : 0
        return (
          <div key={j.alias} className={`dp-check-row ${miss ? 'warn' : 'ok'}`}>
            <span className="mono">{j.on.map(([a, b]) => `${a} → ${j.table}.${b}`).join(', ')}</span>
            <span>{miss
              ? `⚠ ${fmtN(miss)} rows (${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%) find no ${j.table} row - they'd land on an empty member.`
              : `✓ every row finds a ${j.table} row.`}</span>
          </div>
        )
      })}
    </div>
  )
}
