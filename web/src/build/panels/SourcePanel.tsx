import { useEffect, useMemo, useState } from 'react'
import { fetchSchemas, fetchSourceList, fetchTableColumns, type SchemaEntry, type SourceSummary } from '../client'
import { useModelStore } from '../modelStore'
import { PickList } from './PickList'

/** Tables listed per schema before "show more" - big warehouses (1,000+ tables)
 *  stay responsive; search reaches every table. */
const PAGE = 100

const KNOWN_DIALECTS = ['postgresql', 'snowflake', 'databricks', 'bigquery', 'redshift']

/** With `discover`, a click picks the table to profile (Build > Discovery)
 *  instead of dragging it onto the canvas. The source stays shared with Develop. */
export interface DiscoverPick {
  selected: { schema: string; table: string } | null
  onSelect: (schema: string, table: SchemaEntry['tables'][number]) => void
}

export function SourcePanel({ discover }: { discover?: DiscoverPick } = {}) {
  const [sources, setSources] = useState<SourceSummary[]>([])
  const [schemas, setSchemas] = useState<SchemaEntry[]>([])
  const [loadingSchemas, setLoadingSchemas] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingConnection, setEditingConnection] = useState(false)

  const sourceId = useModelStore((s) => s.sourceId)
  const sourceMeta = useModelStore((s) => s.sourceMeta)
  const setSourceId = useModelStore((s) => s.setSourceId)
  const updateSourceMeta = useModelStore((s) => s.updateSourceMeta)
  const setSchemaForAllNodes = useModelStore((s) => s.setSchemaForAllNodes)
  const search = useModelStore((s) => s.search)
  const setSearch = useModelStore((s) => s.setSearch)
  const openSchemas = useModelStore((s) => s.openSchemas)
  const toggleSchema = useModelStore((s) => s.toggleSchema)
  const addNode = useModelStore((s) => s.addNode)
  const nodes = useModelStore((s) => s.nodes)
  // useMemo, not an inline selector - a selector returning `new Set(...)` gives
  // useSyncExternalStore a different reference every render and loops.
  const placedTables = useMemo(() => new Set(nodes.map((n) => `${n.schema}.${n.table}`)), [nodes])

  const [loadingSources, setLoadingSources] = useState(false)
  // null until this host's list arrives: the store's sourceId outlives a host
  // switch, and another host may not have that connection (404 on /schemas).
  const [hostSources, setHostSources] = useState<Set<string> | null>(null)
  const activeId = sourceId && hostSources?.has(sourceId) ? sourceId : null
  function loadSources(refresh = false) {
    setLoadingSources(true)
    setError(null)
    const tables = refresh && activeId
      ? fetchSchemas(activeId, search || undefined, true).then(setSchemas)
      : Promise.resolve()
    Promise.all([
      fetchSourceList(refresh).then((list) => {
        setSources(list)
        setHostSources(new Set(list.filter((s) => !s.error).map((s) => s.id)))
      }),
      tables,
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoadingSources(false))
  }
  useEffect(() => loadSources(), [])
  // A source picked on another host: drop the pick, keep sourceMeta (the
  // model's own connection, which deploy preflight checks per host).
  useEffect(() => {
    if (hostSources && sourceId && !hostSources.has(sourceId)) setSourceId(null, sourceMeta)
  }, [hostSources, sourceId, sourceMeta, setSourceId])
  // A warehouse AtScale couldn't list (suspended, unreachable) - shown, not hidden.
  const failed = sources.filter((s) => s.error)

  // Schema names come back at once; each schema's tables are listed in the
  // background on the API (a Snowflake schema can take minutes), so poll while
  // any is still loading.
  const [pollTick, setPollTick] = useState(0)
  const pending = schemas.filter((s) => s.loading).length
  useEffect(() => {
    if (!activeId) {
      setSchemas([])
      return
    }
    let stale = false
    if (pollTick === 0) setLoadingSchemas(true)
    setError(null)
    fetchSchemas(activeId, search || undefined)
      .then((s) => !stale && setSchemas(s))
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoadingSchemas(false))
    return () => {
      stale = true
    }
  }, [activeId, search, pollTick])
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => setPollTick((n) => n + 1), 2000)
    return () => clearTimeout(t)
  }, [pending, schemas])
  useEffect(() => setPollTick(0), [activeId, search])

  const selectedSource = sources.find((s) => s.id === sourceId)

  const [shown, setShown] = useState<Record<string, number>>({})

  // Columns aren't in the tree (names only): the canvas drop fetches them when
  // the payload has none (Canvas.tsx onDrop), keyed by the source here.
  function handleDragStart(e: React.DragEvent, schema: string, table: SchemaEntry['tables'][number]) {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(
      'application/x-sml-table',
      JSON.stringify({ schema, table: table.name, columns: table.columns, sourceId }),
    )
  }

  async function handleAdd(schema: string, table: SchemaEntry['tables'][number]) {
    if (!sourceId) return
    try {
      const columns = table.columns ?? (await fetchTableColumns(sourceId, schema, table.name))
      addNode(schema, table.name, 40 + Math.random() * 60, 40 + Math.random() * 60, columns)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="panel-left">
      <div className="section-label source-head">
        Data Source
        <span className="link-btn" title="Reload this host's warehouses, databases and tables from AtScale" onClick={() => !loadingSources && loadSources(true)}>
          {loadingSources ? 'loading…' : '↻ refresh'}
        </span>
      </div>
      <div className="source-pick">
        <PickList
          options={sources.filter((s) => !s.error).map((s) => ({
            value: s.id, label: s.database, group: s.connectionId, prefix: s.connectionId, hint: s.dialect ?? undefined,
            keywords: `${s.label} ${s.connectionId}`,
          }))}
          value={sourceId}
          onChange={(id) => {
            const src = sources.find((s) => s.id === id)
            setSourceId(id, src ? { dialect: src.dialect, connectionId: src.connectionId, database: src.database } : null)
          }}
          placeholder="Select a data source…"
          searchPlaceholder="Search warehouses and databases"
          loading={loadingSources && !sources.length ? 'Loading data sources…' : undefined}
        />
      </div>
      {failed.map((s) => (
        <div key={s.id} className="source-failed" title={s.error}>
          {s.label.replace(/ — unavailable$/, '')} couldn't be listed: {s.error}{' '}
          <span className="link-btn" onClick={() => !loadingSources && loadSources(true)}>retry</span>
        </div>
      ))}
      {selectedSource && !editingConnection && (
        <div className="source-meta">
          {selectedSource.dialect?.toUpperCase()} · {selectedSource.database}{' '}
          {!discover && (
            <span className="link-btn" onClick={() => setEditingConnection(true)}>
              Edit
            </span>
          )}
        </div>
      )}
      {!discover && !selectedSource && sourceMeta && !editingConnection && (
        <div className="source-meta">
          {sourceMeta.dialect?.toUpperCase() || 'UNKNOWN DIALECT'} · {sourceMeta.database} (from imported SML){' '}
          <span className="link-btn" onClick={() => setEditingConnection(true)}>
            Edit
          </span>
        </div>
      )}

      {/* Connection details as parsed/matched aren't always right - a wrong
          value in the SML's own connection file, or a bad guess when nothing
          matched a registered source, has to be fixable by hand rather than
          forcing a re-import. */}
      {!discover && sourceMeta && editingConnection && (
        <div className="source-meta-edit">
          <label className="field">
            Connection ID
            <input
              value={sourceMeta.connectionId}
              onChange={(e) => updateSourceMeta({ connectionId: e.target.value })}
            />
          </label>
          <label className="field">
            Database
            <input value={sourceMeta.database} onChange={(e) => updateSourceMeta({ database: e.target.value })} />
          </label>
          <label className="field">
            Dialect
            <select
              value={sourceMeta.dialect ?? ''}
              onChange={(e) => updateSourceMeta({ dialect: e.target.value || null })}
            >
              <option value="">(unknown)</option>
              {KNOWN_DIALECTS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Schema (applies to every table on the canvas)
            <input value={nodes[0]?.schema ?? ''} onChange={(e) => setSchemaForAllNodes(e.target.value)} />
          </label>
          <span className="link-btn" onClick={() => setEditingConnection(false)}>
            Done
          </span>
        </div>
      )}

      {sourceId && (
        <input
          className="source-search"
          placeholder="Search tables in every schema"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {error && <div className="login-error">{error}</div>}
      {loadingSchemas && <div style={{ color: 'var(--as-muted)' }}>Loading…</div>}
      {pending > 0 && !loadingSchemas && (
        <div className="table-more" style={{ paddingLeft: 0 }}>
          Listing tables in {pending} schema{pending === 1 ? '' : 's'}…{search ? ' search covers the schemas loaded so far' : ''}
        </div>
      )}

      {schemas.map((schema) => (
        <div key={schema.name}>
          <div className="schema-row" onClick={() => toggleSchema(schema.name)}>
            <span className="schema-glyph">
              <span />
              <span />
              <span />
            </span>
            {schema.name} <span className="schema-meta">(Schema)</span>
            <span className="schema-count">{schema.loading ? '…' : schema.error ? '!' : schema.tables.length}</span>
          </div>
          {openSchemas[schema.name] && schema.loading && (
            <div className="table-more">Listing tables… (large schemas can take AtScale a few minutes)</div>
          )}
          {openSchemas[schema.name] && schema.error && (
            <div className="source-failed schema-failed" title={schema.error}>
              Tables couldn't be listed: {schema.error}{' '}
              <span className="link-btn" onClick={() => !loadingSources && loadSources(true)}>retry</span>
            </div>
          )}
          {openSchemas[schema.name] &&
            schema.tables.slice(0, search ? undefined : shown[schema.name] ?? PAGE).map((t) => {
              const isFact = /^(fct|fact)/i.test(t.name)
              const placed = placedTables.has(`${schema.name}.${t.name}`)
              if (discover) {
                const on = discover.selected?.schema === schema.name && discover.selected.table === t.name
                return (
                  <div
                    key={t.name}
                    className={`table-row pick ${on ? 'on' : ''}`}
                    title={placed ? 'Already on the Develop canvas' : undefined}
                    onClick={() => discover.onSelect(schema.name, t)}
                  >
                    <span
                      className="table-swatch"
                      style={{ background: isFact ? 'var(--as-fact)' : 'var(--as-dimension)' }}
                    />
                    <span className="table-name">{t.name}</span>
                    <span className="table-cols">{placed ? '● ' : ''}{t.columns ? `${t.columns.length} cols` : ''}</span>
                  </div>
                )
              }
              return (
                <div
                  key={t.name}
                  className="table-row"
                  style={placed ? { opacity: 0.5 } : undefined}
                  draggable
                  onDragStart={(e) => handleDragStart(e, schema.name, t)}
                  onDoubleClick={() => handleAdd(schema.name, t)}
                >
                  <span
                    className="table-swatch"
                    style={{ background: isFact ? 'var(--as-fact)' : 'var(--as-dimension)' }}
                  />
                  <span className="table-name">{t.name}</span>
                  <span className="table-cols">{t.columns ? `${t.columns.length} cols` : ''}</span>
                </div>
              )
            })}
          {openSchemas[schema.name] && !search && schema.tables.length > (shown[schema.name] ?? PAGE) && (
            <div className="table-more">
              {(shown[schema.name] ?? PAGE).toLocaleString()} of {schema.tables.length.toLocaleString()} ·{' '}
              <span className="link-btn" onClick={() => setShown((m) => ({ ...m, [schema.name]: (m[schema.name] ?? PAGE) + PAGE }))}>
                show {Math.min(PAGE, schema.tables.length - (shown[schema.name] ?? PAGE))} more
              </span>{' '}
              · <span className="link-btn" onClick={() => setShown((m) => ({ ...m, [schema.name]: schema.tables.length }))}>all</span>
              <span className="field-note"> - or search</span>
            </div>
          )}
        </div>
      ))}
    </aside>
  )
}
