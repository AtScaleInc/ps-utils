import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  discoveryApi,
  fetchSchemas,
  fetchSources,
  fetchTablesColumns,
  parseDdl,
  type DdlSchema,
  type DiscoveryTableRef,
  type JoinCheck,
  type TableProfile,
} from '../client'
import { MODEL_NAME_HINT, slugifyModelName } from '../lib/naming'
import {
  applyJoinChecks,
  joinCheckKey,
  planModel,
  type DimPlan,
  type ModelPlan,
  type Profiles,
  type WizardColumn,
  type WizardTable,
} from '../lib/wizardInference'
import { useModelStore } from '../modelStore'
import { PickList, type PickOption } from './PickList'

interface Props {
  hostId: string
  /** Plan from a DDL file's CREATE TABLEs (Import & convert › Database DDL)
   *  instead of the source's table listing. The data source + schema are still
   *  picked: they are where the datasets read, and where profiling runs. */
  fromDdl?: boolean
  onClose: () => void
  /** Runs the app's existing generate -> validate -> SmlViewerModal -> Deploy
   *  pipeline (BuildView's handleGenerate) - the wizard never deploys on its
   *  own, it just hands off to that same, already-battle-tested path. */
  onGenerate: () => void
  /** Switches the app back to the Develop section so the user lands on the
   *  populated canvas either way (full success or partial/insufficient). */
  onDone: () => void
}

type Step = 'setup' | 'fact' | 'time' | 'dims' | 'profile' | 'review'

const STEPS: { id: Step; title: string; help: string }[] = [
  { id: 'setup', title: 'Model & source', help: "Name the model and pick where its tables live. A model reads one warehouse database and one schema." },
  { id: 'fact', title: 'Fact table', help: 'The one table holding the rows this model measures - sales, orders, events.' },
  { id: 'time', title: 'Time dimension', help: 'The calendar / date table, if there is one. The wizard builds Year → Quarter → Month → Day from it.' },
  { id: 'dims', title: 'Dimensions', help: 'Every other table that describes the fact rows - product, customer, geography. Pick none (and no time dimension) to model the fact table on its own: its columns become degenerate dimensions.' },
  { id: 'profile', title: 'Profile data', help: "Plan from the data, not only the names: each table's Discovery profile (unique keys, distinct counts, NULLs) decides the joins, levels and metrics, and every join is checked for orphans and fan-out." },
  { id: 'review', title: 'Review', help: 'What the wizard will put on the canvas. Click a metric to leave it out.' },
]

const DDL_SETUP_HELP = 'Choose the DDL file, name the model, and pick the data source and schema its tables live in. Declared primary and foreign keys decide the joins.'

const FACT_RE = /^(fct|fact|f_)|_(fact|fct)$|fact/i
const TIME_RE = /date|time|calendar|period|day/i
const DIM_RE = /^(dim|d_|lkp|lookup|ref)|_dim$/i

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const fmtN = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

type ProfState =
  | { state: 'checking' }
  | { state: 'missing' }
  | { state: 'absent' }
  | { state: 'running'; since: number }
  | { state: 'ready'; profile: TableProfile }
  | { state: 'error'; error: string }

/** Dimension tables whose name matches one of the fact's key columns
 *  (customerkey -> dimcustomer) - the same match as Discovery's join suggestions. */
function suggestDims(factCols: WizardColumn[], tables: string[], exclude: Set<string>): string[] {
  const bare = (n: string) => n.toLowerCase().replace(/^(dim|dimension|d|lkp|lookup|ref)_?/, '').replace(/[^a-z0-9]/g, '')
  const out = new Set<string>()
  for (const c of factCols) {
    if (!/(key|id|_sk|code)$/i.test(c.name)) continue
    const stem = bare(c.name.replace(/_?(key|id|sk|code)$/i, ''))
    if (stem.length < 3) continue
    for (const t of tables) {
      if (exclude.has(t)) continue
      const name = bare(t)
      if (name === stem || name.startsWith(stem) || name.endsWith(stem)) out.add(t)
    }
  }
  return [...out]
}

export function WizardModal({ hostId, fromDdl = false, onClose, onGenerate, onDone }: Props) {
  const store = useModelStore()
  const [step, setStep] = useState<Step>('setup')
  const [error, setError] = useState<string | null>(null)

  const [modelName, setModelName] = useState('')
  const [sourceId, setSourceId] = useState<string | null>(store.sourceId)
  const [schema, setSchema] = useState<string | null>(null)
  const [clearCanvas, setClearCanvas] = useState(true)
  const [fact, setFact] = useState<string | null>(null)
  const [time, setTime] = useState<string | null>(null) // table name, or 'none'
  const [dims, setDims] = useState<string[]>([])
  const [columns, setColumns] = useState<Record<string, WizardColumn[]>>({})
  const [useProfiles, setUseProfiles] = useState(true)
  const [profiles, setProfiles] = useState<Record<string, ProfState>>({})
  const [checks, setChecks] = useState<Record<string, JoinCheck | undefined>>({})
  const [checkNote, setCheckNote] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [metricOff, setMetricOff] = useState<Set<string>>(new Set())
  // -- DDL mode: the tables come from the file, not the source's listing.
  const [ddl, setDdl] = useState<DdlSchema | null>(null)
  const [ddlFilter, setDdlFilter] = useState<string | null>(null) // a DDL schema, or null = every table
  const [parsing, setParsing] = useState(false)
  const ddlInput = useRef<HTMLInputElement>(null)

  // -- sources, schemas, tables -------------------------------------------------
  const sources = useQuery({ queryKey: ['wizard-sources', hostId], queryFn: fetchSources, staleTime: 2 * 3600e3 })
  const source = sources.data?.find((s) => s.id === sourceId) ?? null
  // Schema names come at once; tables are listed per schema in the background.
  const schemas = useQuery({
    queryKey: ['wizard-schemas', hostId, sourceId],
    queryFn: () => fetchSchemas(sourceId!),
    enabled: !!sourceId,
    staleTime: 2 * 3600e3,
    refetchInterval: (q) => (q.state.data?.some((s) => s.loading) ? 2000 : false),
  })
  const schemaEntry = schemas.data?.find((s) => s.name === schema) ?? null
  // DDL tables with columns (a view's DDL carries none), in the picked DDL schema.
  const ddlTables = useMemo(
    () => (ddl?.tables ?? []).filter((t) => t.columns.length && (!ddlFilter || (t.schema ?? '').toLowerCase() === ddlFilter.toLowerCase())),
    [ddl, ddlFilter],
  )
  const tables = useMemo(
    () => (fromDdl ? ddlTables.map((t) => t.name) : (schemaEntry?.tables ?? []).map((t) => t.name)).sort((a, b) => a.localeCompare(b)),
    [fromDdl, ddlTables, schemaEntry],
  )
  /** The source's own spelling of a DDL table (DIM_DATE for dim_date), or null
   *  while the schema is listing / when it isn't there. Live mode: itself. */
  const liveTables = useMemo(() => new Map((schemaEntry?.tables ?? []).map((t) => [t.name.toLowerCase(), t.name])), [schemaEntry])
  const liveName = (t: string): string | null => (fromDdl ? liveTables.get(t.toLowerCase()) ?? null : t)
  const onSource = (t: string) => liveName(t) ?? t
  const ddlColumns = useMemo(() => {
    const out: Record<string, WizardColumn[]> = {}
    for (const t of ddlTables) out[`${schema}.${t.name}`] = t.columns.map((c) => ({ name: c.name, type: c.type, primaryKey: c.primaryKey }))
    return out
  }, [ddlTables, schema])
  const colMap = fromDdl ? ddlColumns : columns

  // A store source that no longer exists on this host isn't preselected.
  useEffect(() => {
    if (sources.data && sourceId && !sources.data.some((s) => s.id === sourceId)) setSourceId(null)
  }, [sources.data, sourceId])
  // The only schema, or the canvas's schema, is preselected.
  useEffect(() => {
    if (schema || !schemas.data?.length) return
    const canvasSchema = store.nodes[0]?.schema
    const ddlMatch = ddl && schemas.data.find((s) => ddl.schemas.some((d) => d.toLowerCase() === s.name.toLowerCase()))
    if (ddlMatch) setSchema(ddlMatch.name)
    else if (schemas.data.length === 1) setSchema(schemas.data[0].name)
    else if (canvasSchema && schemas.data.some((s) => s.name === canvasSchema)) setSchema(canvasSchema)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas.data, schema, ddl])

  const ref = (table: string): DiscoveryTableRef => ({ source: sourceId!, schema: schema!, table: onSource(table), dialect: source?.dialect })
  const key = (table: string) => `${schema}.${table}`
  const timeTable = time && time !== 'none' ? time : null
  const picked = [fact, timeTable, ...dims].filter((t): t is string => !!t)

  async function loadColumns(names: string[]) {
    if (fromDdl) return colMap
    const missing = names.filter((t) => !columns[key(t)])
    if (!sourceId || !schema || !missing.length) return columns
    const got = await fetchTablesColumns(sourceId, missing.map((table) => ({ schema, table })))
    const next = { ...columns, ...got }
    setColumns(next)
    return next
  }

  // Fact columns drive the dimension suggestions.
  useEffect(() => {
    if (fact) loadColumns([fact]).catch((e) => setError(errMsg(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fact])

  // -- options ------------------------------------------------------------------
  const tableCount = (t: string) => {
    const cols = colMap[key(t)] ?? schemaEntry?.tables.find((x) => x.name === t)?.columns
    return cols ? `${cols.length} cols` : undefined
  }
  const factOptions: PickOption[] = useMemo(() => {
    const looks = tables.filter((t) => FACT_RE.test(t))
    return [
      ...looks.map((t) => ({ value: t, label: t, group: 'Named like a fact table', hint: tableCount(t) })),
      ...tables.filter((t) => !FACT_RE.test(t)).map((t) => ({ value: t, label: t, group: looks.length ? 'Other tables' : undefined, hint: tableCount(t) })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, colMap])
  const timeOptions: PickOption[] = useMemo(() => {
    const rest = tables.filter((t) => t !== fact)
    const looks = rest.filter((t) => TIME_RE.test(t))
    return [
      { value: 'none', label: 'No time dimension', keywords: 'none skip' },
      ...looks.map((t) => ({ value: t, label: t, group: 'Named like a calendar', hint: tableCount(t) })),
      ...rest.filter((t) => !TIME_RE.test(t)).map((t) => ({ value: t, label: t, group: 'Other tables', hint: tableCount(t) })),
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, fact, colMap])
  const suggested = useMemo(
    () => (fact && colMap[key(fact)] ? suggestDims(colMap[key(fact)], tables, new Set([fact, timeTable ?? ''])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fact, timeTable, colMap, tables],
  )
  const dimOptions: PickOption[] = useMemo(() => {
    const rest = tables.filter((t) => t !== fact && t !== timeTable)
    const sug = new Set(suggested)
    const group = (t: string) => (sug.has(t) ? 'Suggested - matches a fact key' : DIM_RE.test(t) ? 'Named like a dimension' : 'Other tables')
    const rank = (t: string) => (sug.has(t) ? 0 : DIM_RE.test(t) ? 1 : 2)
    return rest
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((t) => ({ value: t, label: t, group: group(t), hint: tableCount(t) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, fact, timeTable, suggested, colMap])

  // -- profiling ----------------------------------------------------------------
  async function enterProfile() {
    const cols = await loadColumns(picked)
    void cols
    // A DDL table the schema doesn't have can't be profiled - planned from its DDL.
    const absent = (t: string) => fromDdl && !!schemaEntry && !schemaEntry.loading && !liveName(t)
    setProfiles((p) => ({ ...p, ...Object.fromEntries(picked.filter(absent).map((t) => [key(t), { state: 'absent' } as ProfState])) }))
    const todo = picked.filter((t) => !absent(t) && (!profiles[key(t)] || ['error', 'absent'].includes(profiles[key(t)].state)))
    setProfiles((p) => ({ ...p, ...Object.fromEntries(todo.map((t) => [key(t), { state: 'checking' } as ProfState])) }))
    await Promise.all(
      todo.map(async (t) => {
        try {
          const prof = await discoveryApi.cachedProfile(ref(t))
          setProfiles((p) => ({ ...p, [key(t)]: prof ? { state: 'ready', profile: prof } : { state: 'missing' } }))
        } catch (e) {
          setProfiles((p) => ({ ...p, [key(t)]: { state: 'error', error: errMsg(e) } }))
        }
      }),
    )
  }

  const profileFacts: Profiles = useMemo(() => {
    if (!useProfiles) return {}
    const out: Profiles = {}
    for (const [k, v] of Object.entries(profiles)) if (v.state === 'ready') out[k] = v.profile
    return out
  }, [profiles, useProfiles])

  const wizardTable = (t: string): WizardTable => ({
    schema: schema!, table: t, columns: colMap[key(t)] ?? [],
    foreignKeys: ddlTables.find((x) => x.name === t)?.foreignKeys,
  })
  const colsReady = picked.every((t) => colMap[key(t)])
  const basePlan: ModelPlan | null = useMemo(
    () => (fact && colsReady ? planModel(wizardTable(fact), timeTable ? wizardTable(timeTable) : null, dims.map(wizardTable), profileFacts) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fact, timeTable, dims, colMap, profileFacts, colsReady],
  )
  const plan = basePlan && useProfiles ? applyJoinChecks(basePlan, checks) : basePlan

  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false // StrictMode / fast refresh run the cleanup, then this again
    return () => void (cancelled.current = true)
  }, [])

  /** Profiles the tables that have none (one at a time - each scans the whole
   *  table), then checks every planned join. Both are kept by the API. */
  async function runProfiles(names: string[]) {
    setRunning(true)
    setError(null)
    try {
      for (const t of names) {
        if (cancelled.current) return
        setProfiles((p) => ({ ...p, [key(t)]: { state: 'running', since: Date.now() } }))
        try {
          const prof = await discoveryApi.profile(ref(t))
          setProfiles((p) => ({ ...p, [key(t)]: { state: 'ready', profile: prof } }))
        } catch (e) {
          setProfiles((p) => ({ ...p, [key(t)]: { state: 'error', error: errMsg(e) } }))
        }
      }
    } finally {
      setRunning(false)
    }
  }

  // Joins are checked as soon as the plan (from the profiles at hand) has them.
  const pendingChecks = useMemo(() => {
    if (!basePlan || !useProfiles) return []
    const onHost = (t: string) => !fromDdl || !!liveName(t)
    if (!onHost(basePlan.fact.table)) return []
    return [...(basePlan.timeDim ? [basePlan.timeDim] : []), ...basePlan.dims]
      .filter((d) => d.join && onHost(d.table) && !(joinCheckKey(basePlan.fact, d) in checks))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePlan, checks, useProfiles, liveTables])
  const checking = useRef(false)
  useEffect(() => {
    if (step !== 'profile' || running || checking.current || !pendingChecks.length || !basePlan) return
    checking.current = true
    ;(async () => {
      for (const [i, d] of pendingChecks.entries()) {
        if (cancelled.current) break
        setCheckNote(`Checking join ${i + 1} of ${pendingChecks.length}: ${d.join!.factColumn} → ${d.table}`)
        const k = joinCheckKey(basePlan.fact, d)
        try {
          const r = await discoveryApi.joinCheck(ref(basePlan.fact.table), {
            column: d.join!.factColumn, toSchema: d.schema, toTable: onSource(d.table), toColumn: d.join!.dimColumn,
          })
          setChecks((c) => ({ ...c, [k]: r }))
        } catch {
          setChecks((c) => ({ ...c, [k]: undefined })) // tried; Review shows it unchecked
        }
      }
      setCheckNote(null)
      checking.current = false
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, running, pendingChecks])

  async function readDdl(f: File) {
    setError(null)
    setParsing(true)
    try {
      const got = await parseDdl(await f.text(), f.name)
      setDdl(got)
      setDdlFilter(got.schemas.length > 1 ? got.schemas[0] : null)
      setFact(null)
      setTime(null)
      setDims([])
      setProfiles({})
      setChecks({})
      if (!modelName) setModelName(slugifyModelName(f.name.replace(/\.[^.]+$/, '')))
      // A live schema the DDL names is picked for you (once the schemas load).
      if (schema && !got.schemas.some((d) => d.toLowerCase() === schema.toLowerCase())) setSchema(null)
    } catch (e) {
      setDdl(null)
      setError(errMsg(e))
    } finally {
      setParsing(false)
    }
  }
  const ddlFound = fromDdl && schemaEntry && !schemaEntry.loading ? tables.filter((t) => liveName(t)).length : null

  // -- navigation ---------------------------------------------------------------
  const idx = STEPS.findIndex((s) => s.id === step)
  const [loading, setLoading] = useState(false)
  const canNext =
    (step === 'setup' && !!modelName.trim() && !!sourceId && !!schema && !!schemaEntry &&
      (fromDdl ? tables.length > 0 : !schemaEntry.loading)) ||
    (step === 'fact' && !!fact) ||
    (step === 'time' && !!time) ||
    step === 'dims' ||
    (step === 'profile' && !running && !!plan)

  async function go(to: Step) {
    setError(null)
    const toIdx = STEPS.findIndex((s) => s.id === to)
    if (toIdx > idx && !canNext) return
    if (to === 'profile' || to === 'review') {
      setLoading(true)
      try {
        if (to === 'profile') await enterProfile()
        else await loadColumns(picked)
      } catch (e) {
        setError(errMsg(e))
        return
      } finally {
        setLoading(false)
      }
    }
    setStep(to)
  }

  // Changing an earlier pick drops the later ones that depended on it.
  function pickSource(id: string) {
    if (id === sourceId) return
    setSourceId(id)
    setSchema(null)
    resetTables()
  }
  function pickSchema(s: string) {
    if (s === schema) return
    setSchema(s)
    resetTables()
  }
  function resetTables() {
    setProfiles({})
    setChecks({})
    if (fromDdl) return // the tables come from the DDL - the picks stand
    setFact(null)
    setTime(null)
    setDims([])
    setColumns({})
    setProfiles({})
    setChecks({})
  }

  // -- materialize --------------------------------------------------------------
  function materializeDim(factId: string, d: DimPlan) {
    const dimId = store.addNode(d.schema, onSource(d.table), 0, 0, colMap[key(d.table)] ?? [])
    // addNode only guesses a role from the table name - set it explicitly, or
    // a picked table like "datecustom" lands role: null and fails generation.
    store.setNodeRole(dimId, 'dimension')
    if (d.isTime) store.setNodeIsTime(dimId, true)
    if (!d.join) return
    store.addJoin({ node: factId, column: d.join.factColumn }, { node: dimId, column: d.join.dimColumn })
    // addJoin marks the join column as L1 but knows nothing of time units.
    const l1 = d.levels[0]
    if (l1?.timeUnit) store.setColumnConfig(`${dimId}::${l1.column}`, { timeUnit: l1.timeUnit as never })
    for (const lvl of d.levels.slice(1)) {
      const k = `${dimId}::${lvl.column}`
      store.setColumnDimRole(dimId, k, 'level')
      if (lvl.timeUnit) store.setColumnConfig(k, { timeUnit: lvl.timeUnit as never })
    }
    if (d.secondary) {
      const secKey = `${dimId}::${d.secondary.column}`
      store.setColumnDimRole(dimId, secKey, 'secondary')
      store.setColumnConfig(secKey, { attachToKey: `${dimId}::${l1.column}` })
    }
  }

  function materialize() {
    if (!plan || !source) return
    const s = useModelStore.getState()
    if (clearCanvas) s.reset()
    s.setModelName(modelName)
    s.setSourceId(source.id, { dialect: source.dialect, connectionId: source.connectionId, database: source.database })
    const factId = s.addNode(plan.fact.schema, onSource(plan.fact.table), 0, 0, plan.fact.columns)
    s.setNodeRole(factId, 'fact')
    if (plan.timeDim) materializeDim(factId, plan.timeDim)
    for (const d of plan.dims) materializeDim(factId, d)
    for (const m of plan.metrics) {
      if (metricOff.has(m.column)) continue
      s.setColumnConfig(`${factId}::${m.column}`, { measure: true, agg: 'SUM', display: titleCase(m.column), query: m.column })
    }
    for (const g of plan.degenerate) {
      s.setColumnConfig(`${factId}::${g.column}`, { degen: true, degenDisplay: titleCase(g.column), degenQuery: g.column })
    }
    useModelStore.getState().autoArrange()
  }

  function finish(deploy: boolean) {
    materialize()
    onDone()
    onClose()
    if (deploy) onGenerate()
  }

  // -- step summaries (the rail) ------------------------------------------------
  const summary: Record<Step, string | null> = {
    setup: modelName ? `${modelName}${schema ? ` · ${schema}` : ''}${fromDdl && ddl ? ` · ${ddl.fileName}` : ''}` : null,
    fact: fact,
    time: time === 'none' ? 'none' : time,
    dims: idx > 3 || dims.length ? (dims.length ? `${dims.length} table${dims.length === 1 ? '' : 's'}` : 'none') : null,
    profile: idx > 4 ? (useProfiles ? `${Object.keys(profileFacts).length} of ${picked.length} profiled` : 'names only') : null,
    review: null,
  }

  const cur = STEPS[idx]
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal wizard" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <nav className="wizard-rail">
          <div className="eyebrow">{fromDdl ? 'New model from DDL' : 'New model wizard'}</div>
          <ol>
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={`${s.id === step ? 'on' : ''} ${i < idx ? 'done' : ''}`}
                onClick={() => i < idx && !running && go(s.id)}
              >
                <span className="wizard-num">{i < idx ? '✓' : i + 1}</span>
                <span className="wizard-step">
                  <span>{s.title}</span>
                  {summary[s.id] && <span className="wizard-sum" title={summary[s.id]!}>{summary[s.id]}</span>}
                </span>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-ghost btn-sm wizard-cancel" onClick={onClose}>Cancel</button>
        </nav>

        <section className="wizard-main">
          <header className="wizard-head">
            <span className="eyebrow">Step {idx + 1} of {STEPS.length}</span>
            <span className="headline">{cur.title}</span>
            <span className="field-note">{fromDdl && step === 'setup' ? DDL_SETUP_HELP : cur.help}</span>
          </header>

          <div className="wizard-body">
            {error && <div className="login-error wizard-error">{error}</div>}

            {step === 'setup' && (
              <div className="wizard-form">
                {fromDdl && (
                  <div className="field">
                    DDL file
                    <input ref={ddlInput} type="file" accept=".sql,.ddl,.txt" style={{ display: 'none' }} data-testid="ddl-file"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) readDdl(f); e.target.value = '' }} />
                    <div className="wizard-run">
                      <button type="button" className="btn btn-primary btn-sm" disabled={parsing} onClick={() => ddlInput.current?.click()}>
                        {ddl ? 'Choose another file…' : 'Choose file…'}
                      </button>
                      {ddl ? <span className="mono">{ddl.fileName}</span> : <span className="field-note">SQL CREATE TABLE statements (.sql)</span>}
                    </div>
                    {parsing && <span className="field-note wizard-inline"><span className="spinner" /> Reading the DDL…</span>}
                    {ddl && (() => {
                      const all = ddl.tables.filter((t) => t.columns.length)
                      const views = ddl.tables.length - all.length
                      const fks = all.reduce((n, t) => n + t.foreignKeys.length, 0)
                      return (
                        <span className="field-note">
                          {all.length} table{all.length === 1 ? '' : 's'}, {fks} foreign key{fks === 1 ? '' : 's'}
                          {views > 0 && ` · ${views} view${views === 1 ? '' : 's'} left out (no columns in DDL)`}
                          {ddl.skipped > 0 && ` · ${ddl.skipped} other statement${ddl.skipped === 1 ? '' : 's'} ignored`}
                        </span>
                      )
                    })()}
                  </div>
                )}
                {fromDdl && ddl && ddl.schemas.length > 1 && (
                  <div className="field">
                    Schema in the DDL
                    <PickList
                      options={[
                        { value: '', label: 'Every table in the file' },
                        ...ddl.schemas.map((d) => ({ value: d, label: d, hint: `${ddl.tables.filter((t) => t.columns.length && t.schema === d).length} tables` })),
                      ]}
                      value={ddlFilter ?? ''}
                      onChange={(v) => setDdlFilter(v || null)}
                      placeholder="Pick a schema…"
                      searchPlaceholder="Search schemas"
                    />
                  </div>
                )}
                <label className="field">
                  Model name
                  <input autoFocus value={modelName} title={MODEL_NAME_HINT} placeholder="e.g. internet_sales"
                    onChange={(e) => setModelName(slugifyModelName(e.target.value))} />
                </label>
                <div className="field">
                  Data source
                  <PickList
                    options={(sources.data ?? []).map((s) => ({
                      value: s.id, label: s.database, group: s.connectionId, prefix: s.connectionId, hint: s.dialect ?? undefined,
                      keywords: `${s.label} ${s.connectionId}`,
                    }))}
                    value={sourceId}
                    onChange={pickSource}
                    placeholder="Pick a warehouse database…"
                    searchPlaceholder="Search warehouses and databases"
                    loading={sources.isLoading ? 'Loading data sources…' : undefined}
                    emptyNote="No usable data sources on this host."
                  />
                  {sources.error && <span className="login-error">{errMsg(sources.error)}</span>}
                </div>
                <div className="field">
                  Schema
                  <PickList
                    options={(schemas.data ?? []).map((s) => ({
                      value: s.name, label: s.name,
                      hint: s.loading ? 'listing…' : s.error ? 'failed' : `${s.tables.length.toLocaleString()} tables`,
                      disabled: !!s.error,
                    }))}
                    value={schema}
                    onChange={pickSchema}
                    disabled={!sourceId}
                    placeholder={sourceId ? 'Pick a schema…' : 'Pick a data source first'}
                    searchPlaceholder="Search schemas"
                    loading={schemas.isLoading ? 'Loading schemas…' : undefined}
                  />
                  {schemaEntry?.loading && (
                    <span className="field-note wizard-inline"><span className="spinner" /> Listing tables in {schema}… large schemas can take AtScale a few minutes.</span>
                  )}
                  {schemaEntry && !schemaEntry.loading && !fromDdl && (
                    <span className="field-note">{schemaEntry.tables.length.toLocaleString()} tables in {schema}.</span>
                  )}
                  {ddlFound != null && ddl && (
                    <span className={`field-note ${ddlFound < tables.length ? 'warn' : ''}`}>
                      {ddlFound === tables.length
                        ? `All ${tables.length} DDL tables are in ${schema}.`
                        : `${ddlFound} of ${tables.length} DDL tables are in ${schema}. The rest are planned from the DDL only, and can't be profiled until they exist there.`}
                    </span>
                  )}
                  {schemas.error && <span className="login-error">{errMsg(schemas.error)}</span>}
                </div>
                {store.nodes.length > 0 && (
                  <label className="checkbox-row wizard-clear">
                    <input type="checkbox" checked={clearCanvas} onChange={(e) => setClearCanvas(e.target.checked)} />
                    Clear the canvas first ({store.nodes.length} table{store.nodes.length === 1 ? '' : 's'} on it now{store.modelName ? ` - ${store.modelName}` : ''})
                  </label>
                )}
              </div>
            )}

            {step === 'fact' && (
              <div className="wizard-form">
                <div className="field">
                  Fact table
                  <PickList autoFocus options={factOptions} value={fact} onChange={(t) => {
                    setFact(t)
                    setDims((d) => d.filter((x) => x !== t))
                    if (time === t) setTime(null)
                  }} placeholder={`Pick one of ${tables.length.toLocaleString()} tables…`} searchPlaceholder="Search tables" />
                </div>
                {fact && <TablePeek cols={colMap[key(fact)]} />}
              </div>
            )}

            {step === 'time' && (
              <div className="wizard-form">
                <div className="field">
                  Time dimension
                  <PickList autoFocus options={timeOptions} value={time} onChange={(t) => {
                    setTime(t)
                    setDims((d) => d.filter((x) => x !== t))
                  }} placeholder="Pick a calendar table, or No time dimension…" searchPlaceholder="Search tables" />
                </div>
                {timeTable && <span className="field-note">Levels come from its columns named week / month / quarter / year; profiling confirms each one rolls up.</span>}
              </div>
            )}

            {step === 'dims' && (
              <div className="wizard-form">
                <div className="field">
                  Dimension tables
                  <PickList multi autoFocus options={dimOptions} value={dims} onChange={setDims}
                    placeholder="Pick any number of tables…" searchPlaceholder="Search tables" />
                </div>
                {suggested.length > 0 && (
                  <div className="wizard-suggest">
                    <span className="section-label">Suggested from {fact}'s key columns</span>
                    <div className="wizard-chips">
                      {suggested.map((t) => {
                        const on = dims.includes(t)
                        return (
                          <button key={t} type="button" className={`disc-run ${on ? 'on' : ''}`}
                            onClick={() => setDims((d) => (on ? d.filter((x) => x !== t) : [...d, t]))}>
                            {on ? '✓ ' : '+ '}{t}
                          </button>
                        )
                      })}
                      {suggested.some((t) => !dims.includes(t)) && (
                        <span className="link-btn" onClick={() => setDims((d) => [...new Set([...d, ...suggested])])}>add all</span>
                      )}
                    </div>
                  </div>
                )}
                {!dims.length && !timeTable && (
                  <span className="field-note">None picked: {fact} is modeled on its own, its non-metric columns become degenerate dimensions.</span>
                )}
              </div>
            )}

            {step === 'profile' && (
              <ProfileStep
                picked={picked}
                role={(t) => (t === fact ? 'Fact' : t === timeTable ? 'Time' : 'Dimension')}
                profiles={Object.fromEntries(picked.map((t) => [t, profiles[key(t)]]))}
                useProfiles={useProfiles}
                setUseProfiles={setUseProfiles}
                running={running}
                checkNote={checkNote}
                onRun={runProfiles}
              />
            )}

            {step === 'review' && plan && (
              <Review plan={plan} metricOff={metricOff} toggleMetric={(c) => setMetricOff((s) => {
                const n = new Set(s)
                if (n.has(c)) n.delete(c)
                else n.add(c)
                return n
              })} />
            )}
          </div>

          <footer className="wizard-foot">
            <button type="button" className="btn btn-ghost" onClick={() => go(STEPS[idx - 1].id)} disabled={idx === 0 || running || loading}>
              Back
            </button>
            {step === 'review' && plan ? (
              <div className="wizard-foot-r">
                <button type="button" className={`btn ${plan.insufficient.length ? 'btn-primary' : 'btn-ghost'}`} onClick={() => finish(false)}>
                  Add to canvas
                </button>
                {plan.insufficient.length === 0 && (
                  <button type="button" className="btn btn-primary" onClick={() => finish(true)}>Build &amp; Deploy</button>
                )}
              </div>
            ) : (
              <button type="button" className="btn btn-primary" onClick={() => go(STEPS[idx + 1].id)} disabled={!canNext || loading}>
                {loading ? 'Loading…' : step === 'profile' && checkNote ? 'Checking joins…' : 'Next'}
              </button>
            )}
          </footer>
        </section>
      </div>
    </div>
  )
}

function TablePeek({ cols }: { cols?: WizardColumn[] }) {
  if (!cols) return <span className="field-note wizard-inline"><span className="spinner" /> Loading columns…</span>
  return (
    <div className="wizard-peek">
      <span className="section-label">{cols.length} columns</span>
      <div className="wizard-peek-cols">
        {cols.map((c) => (
          <span key={c.name} className="wizard-col"><span>{c.name}</span><span className="muted">{c.type}</span></span>
        ))}
      </div>
    </div>
  )
}

function ProfileStep({ picked, role, profiles, useProfiles, setUseProfiles, running, checkNote, onRun }: {
  picked: string[]
  role: (t: string) => string
  profiles: Record<string, ProfState | undefined>
  useProfiles: boolean
  setUseProfiles: (v: boolean) => void
  running: boolean
  checkNote: string | null
  onRun: (tables: string[]) => void
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])
  const missing = picked.filter((t) => ['missing', 'error'].includes(profiles[t]?.state ?? ''))
  return (
    <div className="wizard-form">
      <div className="wizard-mode">
        <button type="button" className={useProfiles ? 'on' : ''} onClick={() => setUseProfiles(true)}>
          <b>Plan from data profiles</b>
          <span>Unique keys, distinct counts and NULLs decide joins, levels and metrics; joins are checked for orphans and fan-out. Recommended.</span>
        </button>
        <button type="button" className={!useProfiles ? 'on' : ''} disabled={running} onClick={() => setUseProfiles(false)}>
          <b>Names only</b>
          <span>No warehouse queries: joins by matching column names, metrics by numeric type.</span>
        </button>
      </div>

      {useProfiles && (
        <>
          <div className="wizard-profiles">
            {picked.map((t) => {
              const p = profiles[t]
              return (
                <div key={t} className="wizard-prof">
                  <span className={`wizard-role r-${role(t).toLowerCase()}`}>{role(t)}</span>
                  <span className="wizard-prof-name">{t}</span>
                  <span className="wizard-prof-state">
                    {!p || p.state === 'checking' ? <span className="muted">looking for a profile…</span>
                      : p.state === 'missing' ? <span className="warn">not profiled yet</span>
                      : p.state === 'absent' ? <span className="muted">not in this schema - planned from the DDL</span>
                      : p.state === 'running' ? <><span className="spinner" /> profiling… {Math.round((Date.now() - p.since) / 1000)}s</>
                      : p.state === 'error' ? <span className="login-error" title={p.error}>failed: {p.error}</span>
                      : <span className="ok">✓ {fmtN(p.profile.rowCount)} rows · profiled {ago(p.profile.profiledAt)}</span>}
                  </span>
                </div>
              )
            })}
          </div>
          {missing.length > 0 && (
            <div className="wizard-run">
              <button type="button" className="btn btn-primary btn-sm" disabled={running} onClick={() => onRun(missing)}>
                {running ? 'Profiling…' : `Profile ${missing.length} table${missing.length === 1 ? '' : 's'}`}
              </button>
              <span className="field-note">
                Each profile scans the whole table once and is kept (Build › Discovery shows it). Tables left unprofiled are planned from their names.
              </span>
            </div>
          )}
          {checkNote && <span className="field-note wizard-inline"><span className="spinner" /> {checkNote}</span>}
        </>
      )}
    </div>
  )
}

const BASIS: Record<string, string> = { fk: 'foreign key in the DDL', name: 'same column name', suffix: 'role-played key', values: 'value ranges match' }

function JoinBadge({ d }: { d: DimPlan }) {
  const c = d.join?.check
  if (!c) return <span className="wizard-badge muted" title="Not checked against the data">unchecked</span>
  if (c.orphanRows > 0) {
    return <span className="wizard-badge warn" title={`${fmtN(c.orphanKeys)} fact keys have no ${d.table} row`}>⚠ {c.orphanPct}% orphan rows</span>
  }
  return <span className="wizard-badge ok" title={`${fmtN(c.keys)} fact keys, ${fmtN(c.targetRows)} unique ${d.table} rows`}>✓ every key matches</span>
}

function Review({ plan, metricOff, toggleMetric }: { plan: ModelPlan; metricOff: Set<string>; toggleMetric: (c: string) => void }) {
  const dims = [...(plan.timeDim ? [plan.timeDim] : []), ...plan.dims]
  const on = plan.metrics.filter((m) => !metricOff.has(m.column)).length
  return (
    <div className="wizard-review">
      <div className="disc-tiles">
        <div className="disc-tile"><span className="section-label" style={{ margin: 0 }}>Fact</span><span className="disc-tile-v small">{plan.fact.table}</span></div>
        <div className="disc-tile"><span className="section-label" style={{ margin: 0 }}>Metrics</span><span className="disc-tile-v">{on}</span></div>
        <div className="disc-tile"><span className="section-label" style={{ margin: 0 }}>Dimensions</span>
          <span className="disc-tile-v">{plan.denormalized ? plan.degenerate.length : dims.length - plan.insufficient.length}</span>
          {plan.denormalized && <span className="field-note">degenerate</span>}
        </div>
        <div className={`disc-tile ${plan.profiled ? '' : 'warn'}`}><span className="section-label" style={{ margin: 0 }}>Planned from</span>
          <span className="disc-tile-v small">{plan.profiled ? 'data profiles' : 'names only'}</span></div>
      </div>

      <div className="wizard-card fact">
        <div className="wizard-card-h"><span className="wizard-role r-fact">Fact</span><b>{plan.fact.table}</b>
          <span className="muted">{on} of {plan.metrics.length} metrics · SUM</span></div>
        <div className="wizard-chips">
          {plan.metrics.map((m) => (
            <button key={m.column} type="button" title={m.why} className={`wizard-metric ${metricOff.has(m.column) ? 'off' : ''}`}
              onClick={() => toggleMetric(m.column)}>
              {metricOff.has(m.column) ? '' : '✓ '}{titleCase(m.column)}
            </button>
          ))}
          {!plan.metrics.length && <span className="field-note">No numeric measure columns found.</span>}
        </div>
        {plan.skipped.length > 0 && (
          <details className="wizard-skipped">
            <summary>{plan.skipped.length} column{plan.skipped.length === 1 ? '' : 's'} left out</summary>
            {plan.skipped.map((s) => <div key={s.column}><span className="mono">{s.column}</span> <span className="muted">- {s.why}</span></div>)}
          </details>
        )}
        {plan.denormalized && (
          <details className="wizard-skipped">
            <summary>{plan.degenerate.length} degenerate dimensions</summary>
            <span className="muted">{plan.degenerate.map((g) => titleCase(g.column)).join(', ')}</span>
          </details>
        )}
      </div>

      {dims.map((d) => (
        <div key={d.table} className={`wizard-card ${d.join ? '' : 'bad'}`}>
          <div className="wizard-card-h">
            <span className={`wizard-role r-${d.isTime ? 'time' : 'dimension'}`}>{d.isTime ? 'Time' : 'Dimension'}</span>
            <b>{d.table}</b>
            {d.join && <JoinBadge d={d} />}
          </div>
          {d.join ? (
            <>
              <div className="wizard-join mono">
                {plan.fact.table}.{d.join.factColumn} → {d.table}.{d.join.dimColumn}
                <span className="muted"> · {BASIS[d.join.basis]}</span>
              </div>
              <div className="wizard-levels">
                {[...d.levels].reverse().map((l, i) => (
                  <span key={l.column}>
                    {i > 0 && <span className="muted"> → </span>}
                    <span className="wizard-level">{titleCase(l.column)}{l.timeUnit ? <span className="muted"> ({l.timeUnit})</span> : null}</span>
                  </span>
                ))}
                {d.secondary && <span className="muted"> · attribute {titleCase(d.secondary.column)}</span>}
              </div>
            </>
          ) : (
            <div className="login-error">No join found - added to the canvas unjoined so you can draw the join by hand.</div>
          )}
          {d.notes.map((n) => <div key={n} className="field-note">ⓘ {n}</div>)}
        </div>
      ))}
    </div>
  )
}
