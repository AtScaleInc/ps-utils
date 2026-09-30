import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import {
  discoveryApi,
  fetchSchemas,
  fetchTableColumns,
  type DiscoveryTableRef,
  type JoinCheck,
  type ProfileColumn,
  type SchemaTable,
  type TableProfile,
} from '../client'
import { useModelStore } from '../modelStore'
import { SourcePanel } from './SourcePanel'

/** Build > Discovery: pick warehouse -> schema -> table (the same Source panel
 *  as Develop), then see what the table holds before modeling it: a profile
 *  (nulls, blanks, placeholders, distinct, ranges, formats, suggested roles),
 *  sample rows, AtScale's own statistics and join checks. Everything comes
 *  from api/routes/discovery.py, which keeps results in SQLite - a profile runs
 *  once per table and again only on Re-profile. */

type Tab = 'profile' | 'sample' | 'joins' | 'stats'

// The picked table survives switching to Develop and back.
const useDiscovery = create<{
  /** `hostId`: a table picked on one host means nothing on another. */
  picked: { hostId: string; schema: string; table: string; columns: SchemaTable['columns'] } | null
  tab: Tab
  pick: (p: { hostId: string; schema: string; table: string; columns: SchemaTable['columns'] } | null) => void
  setTab: (t: Tab) => void
}>((set) => ({
  picked: null,
  tab: 'profile',
  pick: (picked) => set({ picked }),
  setTab: (tab) => set({ tab }),
}))

const ROLE_LABEL: Record<ProfileColumn['role'], string> = {
  key: 'Key', join: 'Join key', measure: 'Measure', attribute: 'Attribute', time: 'Time',
  constant: 'Constant', empty: 'Empty', unknown: '—',
}

const fmtN = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${n < 0.1 && n > 0 ? '<0.1' : +n.toFixed(1)}%`)
const fmtAt = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')
const fmtVal = (v: unknown) => (v === null || v === undefined ? '(null)' : String(v))
const fmtAvg = (n: number | null) => (n == null ? '—' : Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : +n.toFixed(2))

export function DiscoveryTab({ hostId }: { hostId: string }) {
  const sourceId = useModelStore((s) => s.sourceId)
  const sourceMeta = useModelStore((s) => s.sourceMeta)
  const { picked: anyPicked, pick, tab, setTab } = useDiscovery()
  const picked = anyPicked?.hostId === hostId ? anyPicked : null
  const addNode = useModelStore((s) => s.addNode)
  const nodes = useModelStore((s) => s.nodes)

  // A table from another source (the user switched warehouse) no longer applies.
  const [pickedSource, setPickedSource] = useState(sourceId)
  useEffect(() => {
    if (sourceId !== pickedSource) {
      pick(null)
      setPickedSource(sourceId)
    }
  }, [sourceId, pickedSource, pick])

  const ref: DiscoveryTableRef | null =
    sourceId && picked ? { source: sourceId, schema: picked.schema, table: picked.table, dialect: sourceMeta?.dialect } : null
  const onCanvas = !!picked && nodes.some((n) => n.schema === picked.schema && n.table === picked.table)

  async function addToCanvas() {
    if (!picked || onCanvas || !sourceId) return
    const columns = picked.columns ?? (await fetchTableColumns(sourceId, picked.schema, picked.table).catch(() => undefined))
    addNode(picked.schema, picked.table, 40 + Math.random() * 60, 40 + Math.random() * 60, columns)
  }

  return (
    <div className="app-body">
      <SourcePanel
        discover={{
          selected: picked,
          onSelect: (schema, t) => pick({ hostId, schema, table: t.name, columns: t.columns }),
        }}
      />
      <main className="disc">
        {!sourceId ? (
          <Empty title="Pick a data source" note="Choose a warehouse and database on the left, then a table to profile." />
        ) : !ref ? (
          <Empty title="Pick a table" note="Open a schema on the left and click a table. Its profile runs once and is kept - Re-profile reads the warehouse again." />
        ) : (
          <TableView key={`${hostId}|${ref.source}|${ref.schema}.${ref.table}`} hostId={hostId} tref={ref}
            tab={tab} setTab={setTab} onCanvas={onCanvas} onAdd={addToCanvas} />
        )}
      </main>
    </div>
  )
}

function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="disc-empty">
      <span className="eyebrow">Discovery</span>
      <span className="headline">{title}</span>
      <span className="field-note">{note}</span>
    </div>
  )
}

function TableView({ hostId, tref, tab, setTab, onCanvas, onAdd }: {
  hostId: string
  tref: DiscoveryTableRef
  tab: Tab
  setTab: (t: Tab) => void
  onCanvas: boolean
  onAdd: () => void
}) {
  const qc = useQueryClient()
  const base = ['discovery', hostId, tref.source, tref.schema, tref.table]
  const [runId, setRunId] = useState<number | null>(null) // an older run being viewed
  const [reprofiling, setReprofiling] = useState(false)
  const info = useQuery({ queryKey: [...base, 'table'], queryFn: () => discoveryApi.table(tref) })
  const profile = useQuery({
    queryKey: [...base, 'profile', runId],
    queryFn: () => discoveryApi.profile(tref, runId != null ? { id: runId } : {}),
    retry: false,
  })

  async function reprofile() {
    setReprofiling(true)
    try {
      const p = await discoveryApi.profile(tref, { refresh: true })
      setRunId(null)
      qc.setQueryData([...base, 'profile', null], p)
      qc.removeQueries({ queryKey: [...base, 'top'] })
      qc.setQueryData([...base, 'table'], await discoveryApi.table(tref, true))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setReprofiling(false)
    }
  }

  const p = profile.data
  const latest = p?.history[0]
  const viewingOld = p && latest && p.id !== latest.id
  const findings = p ? p.columns.reduce((n, c) => n + c.flags.filter((f) => f.level === 'warn').length, 0) : 0
  const keys = p ? p.columns.filter((c) => c.role === 'key').map((c) => c.name) : []
  const busy = profile.isFetching || reprofiling
  // AtScale's statistics only show when this AtScale has them: older builds have
  // no /v1/datasources/{id}/statistics (404), and new ones may not have collected any yet.
  const hasStats = !!info.data?.statistics?.length
  const tabs: Tab[] = hasStats ? ['profile', 'sample', 'joins', 'stats'] : ['profile', 'sample', 'joins']
  const shown: Tab = tabs.includes(tab) ? tab : 'profile'

  return (
    <div className="disc-body">
      <header className="disc-head">
        <div className="disc-title">
          <span className="eyebrow">{tref.schema} · {info.data?.dialect ?? tref.dialect ?? 'warehouse'}</span>
          <span className="headline">{tref.table}</span>
          <span className="field-note">
            {info.data ? `${info.data.columns.length} columns` : '…'}
            {p && ` · profiled ${fmtAt(p.profiledAt)} in ${(p.elapsedMs / 1000).toFixed(1)} s`}
            {viewingOld && ' · older run'}
          </span>
        </div>
        <div className="disc-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={reprofile}
            title="Run the profile on the warehouse again (scans the whole table) and keep it as a new run">
            {reprofiling ? 'Profiling…' : 'Re-profile'}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={onCanvas} onClick={onAdd}
            title={onCanvas ? 'Already on the Develop canvas' : 'Add this table to the Develop canvas'}>
            {onCanvas ? 'On canvas' : 'Add to canvas'}
          </button>
        </div>
      </header>

      {p && p.history.length > 1 && (
        <div className="disc-history">
          <span className="section-label" style={{ margin: 0 }}>Runs</span>
          {p.history.map((h) => (
            <button key={h.id} type="button" className={`disc-run ${h.id === p.id ? 'on' : ''}`}
              onClick={() => setRunId(h.id === latest?.id ? null : h.id)}>
              <span>{fmtAt(h.profiledAt)}</span>
              <span className="mono">{fmtN(h.rowCount)} rows</span>
            </button>
          ))}
        </div>
      )}

      {profile.isLoading || (reprofiling && !p) ? (
        <Profiling table={`${tref.schema}.${tref.table}`} />
      ) : profile.error ? (
        <div className="login-error">Profile failed: {(profile.error as Error).message}</div>
      ) : p ? (
        <>
          <Drift p={p} />
          <div className="disc-tiles">
            <Tile label="Rows" value={fmtN(p.rowCount)} />
            <Tile label="Columns" value={String(p.columns.length)} />
            <Tile label="Key candidates" value={keys.length ? keys.join(', ') : 'none'} small={keys.length > 0} />
            <Tile label="Duplicate rows" warn={!!p.duplicates?.extraRows}
              value={p.duplicates ? fmtN(p.duplicates.extraRows) : '—'}
              note={p.duplicates ? (p.duplicates.groups ? `in ${fmtN(p.duplicates.groups)} groups` : 'every row distinct') : p.duplicatesError ? 'check failed' : 'not checked'} />
            <Tile label="Findings" value={String(findings)} warn={findings > 0} note="columns worth a look" />
          </div>
        </>
      ) : null}

      <div className="preview-mode disc-tabs">
        {tabs.map((t) => (
          <button key={t} type="button" className={shown === t ? 'on' : ''} onClick={() => setTab(t)}>
            {{ profile: 'Profile', sample: 'Sample rows', joins: 'Joins', stats: 'AtScale statistics' }[t]}
          </button>
        ))}
      </div>

      <div className="disc-panel">
        {shown === 'profile' && p && <ProfileTable p={p} tref={tref} base={base} />}
        {shown === 'sample' && <Sample info={info.data} loading={info.isLoading} error={info.error as Error | null} />}
        {shown === 'joins' && <Joins tref={tref} p={p} />}
        {shown === 'stats' && <Stats info={info.data} />}
      </div>
    </div>
  )
}

function Profiling({ table }: { table: string }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="disc-profiling">
      <span className="spinner" />
      Profiling {table} on the warehouse — counting rows, NULLs, blanks and distinct values… {secs}s
      <span className="field-note">Runs once per table; the result is kept for next time.</span>
    </div>
  )
}

function Tile({ label, value, note, warn, small }: { label: string; value: string; note?: string; warn?: boolean; small?: boolean }) {
  return (
    <div className={`disc-tile ${warn ? 'warn' : ''}`}>
      <span className="section-label" style={{ margin: 0 }}>{label}</span>
      <span className={`disc-tile-v ${small ? 'small' : ''}`} title={value}>{value}</span>
      {note && <span className="field-note">{note}</span>}
    </div>
  )
}

function Drift({ p }: { p: TableProfile }) {
  const d = p.drift
  if (!d) return null
  const changed = d.added.length || d.removed.length || d.retyped.length || d.shifts.length || d.rowDelta
  return (
    <div className={`disc-drift ${changed ? 'changed' : ''}`}>
      <span className="section-label" style={{ margin: 0 }}>Since {fmtAt(d.since)}</span>
      {!changed && <span>No change in row count, columns or types.</span>}
      {!!d.rowDelta && (
        <span>Rows {d.rowDelta > 0 ? '+' : ''}{fmtN(d.rowDelta)} ({d.rowDeltaPct != null ? `${d.rowDeltaPct > 0 ? '+' : ''}${d.rowDeltaPct}%` : 'new'})</span>
      )}
      {d.added.length > 0 && <span>Added: <b>{d.added.join(', ')}</b></span>}
      {d.removed.length > 0 && <span className="bad">Dropped: <b>{d.removed.join(', ')}</b></span>}
      {d.retyped.map((r) => <span key={r.name} className="bad">{r.name}: {r.from} → {r.to}</span>)}
      {d.shifts.map((s) => (
        <span key={s.name + s.what}>{s.name}: {s.what === 'nullPct' ? `NULL ${fmtPct(s.from)} → ${fmtPct(s.to)}` : `distinct ${fmtN(s.from)} → ${fmtN(s.to)}`}</span>
      ))}
    </div>
  )
}

function ProfileTable({ p, tref, base }: { p: TableProfile; tref: DiscoveryTableRef; base: unknown[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const cols = onlyFlagged ? p.columns.filter((c) => c.flags.length) : p.columns
  return (
    <>
      <label className="checkbox-row disc-filter">
        <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
        Only columns with findings
      </label>
      <div className="preview-results disc-scroll">
        <table className="preview-table disc-table">
          <thead>
            <tr>
              <th>Column</th><th>Type</th><th>Suggested role</th><th>NULLs</th><th>Distinct</th>
              <th>Min</th><th>Max</th><th>Avg</th><th>Findings</th>
            </tr>
          </thead>
          <tbody>
            {cols.map((c) => (
              <ProfileRow key={c.name} c={c} rows={p.rowCount} open={open === c.name}
                onToggle={() => setOpen(open === c.name ? null : c.name)} tref={tref} base={base} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ProfileRow({ c, rows, open, onToggle, tref, base }: {
  c: ProfileColumn
  rows: number | null
  open: boolean
  onToggle: () => void
  tref: DiscoveryTableRef
  base: unknown[]
}) {
  const warn = c.flags.filter((f) => f.level === 'warn').length
  return (
    <>
      <tr className={`disc-row ${open ? 'open' : ''}`} onClick={onToggle}>
        <td className="disc-name"><span className="disc-caret">{open ? '▾' : '▸'}</span>{c.name}</td>
        <td className="muted">{c.type}{c.storedAs ? ` (${c.storedAs}s)` : ''}</td>
        <td><span className={`disc-role r-${c.role}`} title={c.roleWhy}>{ROLE_LABEL[c.role]}</span></td>
        <td>
          <span className="disc-bar" title={`${fmtN(c.nulls)} of ${fmtN(rows)}`}>
            <span style={{ width: `${Math.min(100, c.nullPct ?? 0)}%` }} />
          </span>
          {fmtPct(c.nullPct)}
        </td>
        <td>{fmtN(c.distinct)} <span className="muted">{c.distinctPct != null ? `· ${fmtPct(c.distinctPct)}` : ''}</span></td>
        <td className="disc-val" title={fmtVal(c.min)}>{c.min == null ? '—' : String(c.min)}</td>
        <td className="disc-val" title={fmtVal(c.max)}>{c.max == null ? '—' : String(c.max)}</td>
        <td>{fmtAvg(c.avg)}</td>
        <td>
          {warn > 0 && <span className="disc-flag warn">⚠ {warn}</span>}
          {c.flags.length - warn > 0 && <span className="disc-flag info">ⓘ {c.flags.length - warn}</span>}
          {c.error && <span className="disc-flag warn">error</span>}
        </td>
      </tr>
      {open && (
        <tr className="disc-detail">
          <td colSpan={9}>
            <ColumnDetail c={c} rows={rows} tref={tref} base={base} />
          </td>
        </tr>
      )}
    </>
  )
}

function ColumnDetail({ c, rows, tref, base }: { c: ProfileColumn; rows: number | null; tref: DiscoveryTableRef; base: unknown[] }) {
  const qc = useQueryClient()
  const top = useQuery({ queryKey: [...base, 'top', c.name], queryFn: () => discoveryApi.topValues(tref, c.name), retry: false })
  const max = Math.max(1, ...(top.data?.values ?? []).map((v) => v.count))
  const counts: [string, number | null | undefined][] = [
    ['Blank strings', c.blanks], ['Placeholder values', c.sentinels], ['Negative', c.negatives], ['Future dates', c.future],
  ]
  return (
    <div className="disc-detail-grid">
      <div className="disc-detail-col">
        <span className="section-label">Why “{ROLE_LABEL[c.role]}”</span>
        <span>{c.roleWhy}</span>
        {c.flags.length > 0 && (
          <>
            <span className="section-label" style={{ marginTop: 12 }}>Findings</span>
            {c.flags.map((f, i) => <span key={i} className={`disc-finding ${f.level}`}>{f.level === 'warn' ? '⚠' : 'ⓘ'} {f.text}</span>)}
          </>
        )}
        <span className="section-label" style={{ marginTop: 12 }}>Checks</span>
        <div className="disc-kv">
          <span>Non-NULL</span><span>{fmtN(c.nonNull)} of {fmtN(rows)}</span>
          {counts.filter(([, v]) => v != null).flatMap(([k, v]) => [<span key={`${k}-k`}>{k}</span>, <span key={`${k}-v`}>{fmtN(v)}</span>])}
        </div>
        {c.patterns && c.patterns.length > 0 && (
          <>
            <span className="section-label" style={{ marginTop: 12 }}>Formats in sample ({c.patterns.length > 1 ? 'top 3' : 'one'})</span>
            {c.patterns.map((pt) => <span key={pt.pattern} className="mono">{pt.pattern} <span className="muted">{pt.share}%</span></span>)}
          </>
        )}
      </div>
      <div className="disc-detail-col">
        <span className="section-label">
          Top values
          {top.data && (
            <span className="link-btn" style={{ marginLeft: 8 }}
              onClick={() => discoveryApi.topValues(tref, c.name, true).then((d) => qc.setQueryData([...base, 'top', c.name], d))}>
              refresh
            </span>
          )}
        </span>
        {top.isLoading && <span className="field-note">Counting…</span>}
        {top.error && <span className="login-error">{(top.error as Error).message}</span>}
        {top.data?.values.map((v, i) => (
          <div key={i} className="disc-top">
            <span className="disc-top-v" title={fmtVal(v.value)}>{fmtVal(v.value)}</span>
            <span className="disc-top-bar"><span style={{ width: `${(100 * v.count) / max}%` }} /></span>
            <span className="mono">{fmtN(v.count)}{rows ? <span className="muted"> · {fmtPct((100 * v.count) / rows)}</span> : null}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Sample({ info, loading, error }: {
  info?: { sample: { columns: string[]; rows: unknown[][]; source: string } | null; sampleError?: string; sampleAt?: string }
  loading: boolean
  error: Error | null
}) {
  if (loading) return <span className="field-note">Loading sample…</span>
  if (error) return <div className="login-error">{error.message}</div>
  if (!info?.sample) return <div className="login-error">Sample unavailable: {info?.sampleError}</div>
  const s = info.sample
  return (
    <>
      <span className="field-note disc-filter">
        {s.rows.length} rows · fetched {fmtAt(info.sampleAt)}
        {s.source === 'query/sample' && ' · this AtScale version returns at most 10 sample rows'}
      </span>
      <div className="preview-results disc-scroll">
        <table className="preview-table">
          <thead><tr>{s.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {s.rows.map((r, i) => (
              <tr key={i}>{r.map((v, j) => <td key={j} className={v == null ? 'muted' : ''}>{fmtVal(v)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Stats({ info }: { info?: { statistics: { type: string; columns: string[]; value: unknown; lastUpdated: string }[] | null; statisticsError?: string } }) {
  if (!info?.statistics) return null
  return (
    <div className="preview-results">
      <table className="preview-table">
        <thead><tr><th>Statistic</th><th>Columns</th><th>Value</th><th>Collected</th></tr></thead>
        <tbody>
          {info.statistics.map((s, i) => (
            <tr key={i}>
              <td>{s.type}</td><td>{s.columns.join(', ') || '(table)'}</td>
              <td>{typeof s.value === 'number' ? s.value.toLocaleString() : JSON.stringify(s.value)}</td>
              <td className="muted">{fmtAt(s.lastUpdated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Join check: for this table's key-like columns, suggest tables whose name
 *  matches the key (customerkey -> *customer*; the tree has table names only),
 *  and count orphans / fan-out. A target's columns load when it's picked. */
function Joins({ tref, p }: { tref: DiscoveryTableRef; p?: TableProfile }) {
  const schemas = useQuery({
    queryKey: ['schemas', tref.source], queryFn: () => fetchSchemas(tref.source), staleTime: 2 * 3600e3,
    refetchInterval: (q) => (q.state.data?.some((s) => s.loading) ? 2000 : false),
  })
  const all = useMemo(
    () => (schemas.data ?? []).flatMap((s) => s.tables.map((t) => ({ schema: s.name, table: t.name }))),
    [schemas.data],
  )
  const [column, setColumn] = useState('')
  const [target, setTarget] = useState('') // schema.table.column
  const [result, setResult] = useState<JoinCheck | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const targetTable = target.split('.').slice(0, 2).join('.')
  const [toSchema, toTable] = targetTable.split('.')
  const targetCols = useQuery({
    queryKey: ['columns', tref.source, targetTable],
    queryFn: () => fetchTableColumns(tref.source, toSchema, toTable),
    enabled: !!toTable,
    staleTime: 2 * 3600e3,
  })

  const candidates = useMemo(() => {
    const out: { column: string; table: string }[] = []
    const keyish = (p?.columns ?? []).filter((c) => c.role === 'join' || c.role === 'key' || /(_id|key|_sk|code)$/i.test(c.name))
    const bare = (n: string) => n.toLowerCase().replace(/^(dim|dimension|d|lkp|lookup|ref)_?/, '').replace(/[^a-z0-9]/g, '')
    for (const c of keyish) {
      const stem = bare(c.name.replace(/_?(key|id|sk|code)$/i, ''))
      if (stem.length < 3) continue
      for (const t of all) {
        if (t.schema === tref.schema && t.table === tref.table) continue
        const name = bare(t.table)
        if (name === stem || name.startsWith(stem) || name.endsWith(stem)) out.push({ column: c.name, table: `${t.schema}.${t.table}` })
        if (out.length >= 12) return out
      }
    }
    return out
  }, [p, all, tref])

  /** A suggestion names the table; its column is the same-named one there. */
  async function runSuggested(col: string, table: string) {
    const [s, t] = table.split('.')
    try {
      const cols = await fetchTableColumns(tref.source, s, t)
      const m = cols.find((c) => c.name.toLowerCase() === col.toLowerCase())
      if (!m) {
        setColumn(col)
        setTarget(`${table}.`)
        setResult(null)
        setErr(`${table} has no column named ${col} - pick its key column below.`)
        return
      }
      await run(col, `${table}.${m.name}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function run(col: string, tgt: string, refresh = false) {
    const [toSchema, toTable, toColumn] = tgt.split('.')
    setColumn(col)
    setTarget(tgt)
    setBusy(true)
    setErr(null)
    try {
      setResult(await discoveryApi.joinCheck(tref, { column: col, toSchema, toTable, toColumn, refresh }))
    } catch (e) {
      setResult(null)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="disc-joins">
      <span className="field-note">
        Before drawing a join on the canvas: do this table's keys all exist in the other table (orphans drop out of
        inner joins), and is the other side unique (if not, the join fans out and every metric double counts)?
      </span>
      {candidates.length > 0 && (
        <div className="disc-cands">
          <span className="section-label" style={{ margin: 0 }}>Suggested</span>
          {candidates.map((c) => (
            <button key={c.column + c.table} type="button"
              className={`disc-run ${column === c.column && targetTable === c.table ? 'on' : ''}`}
              disabled={busy} onClick={() => runSuggested(c.column, c.table)}>
              <span className="mono">{c.column} → {c.table.split('.')[1]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="disc-join-form">
        <select className="source-select" value={column} onChange={(e) => setColumn(e.target.value)}>
          <option value="">Column…</option>
          {(p?.columns ?? []).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <span className="muted">→</span>
        <select className="source-select" value={targetTable} onChange={(e) => setTarget(e.target.value ? `${e.target.value}.` : '')}>
          <option value="">Table…</option>
          {all.filter((t) => !(t.schema === tref.schema && t.table === tref.table)).map((t) => (
            <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>{t.schema}.{t.table}</option>
          ))}
        </select>
        <select className="source-select" value={target.split('.')[2] ?? ''} disabled={!targetTable || targetCols.isLoading}
          onChange={(e) => setTarget(`${targetTable}.${e.target.value}`)}>
          <option value="">Column…</option>
          {(targetCols.data ?? []).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !column || !target.split('.')[2]}
          onClick={() => run(column, target)}>
          {busy ? 'Checking…' : 'Check join'}
        </button>
      </div>
      {err && <div className="login-error">{err}</div>}
      {result && (
        <div className="disc-join-result">
          <div className="disc-tiles">
            <Tile label="Keys (non-NULL)" value={fmtN(result.keys)} note={`${fmtN(result.distinctKeys)} distinct`} />
            <Tile label="Orphan rows" value={fmtN(result.orphanRows)} warn={result.orphanRows > 0}
              note={result.orphanRows ? `${fmtPct(result.orphanPct)} · ${fmtN(result.orphanKeys)} keys missing in target` : 'every key matches'} />
            <Tile label="Target side" value={result.targetUnique ? 'Unique' : 'Not unique'} warn={!result.targetUnique}
              note={result.targetUnique ? `${fmtN(result.targetRows)} rows` : `${fmtN(result.targetRows - result.targetDistinct)} duplicate keys - join fans out`} />
          </div>
          {result.orphanSample.length > 0 && (
            <span className="field-note">Missing keys (sample): <span className="mono">{result.orphanSample.map(fmtVal).join(', ')}</span></span>
          )}
          <span className="field-note">
            {result.from} → {result.to} · checked {fmtAt(result.fetchedAt)}{' '}
            <span className="link-btn" onClick={() => run(column, target, true)}>re-check</span>
          </span>
        </div>
      )}
    </div>
  )
}
