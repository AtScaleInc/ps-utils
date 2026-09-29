import { useEffect, useState } from 'react'
import { fetchSchemas, fetchSources, fetchTablesColumns, type SchemaEntry, type SourceSummary } from '../client'
import { MODEL_NAME_HINT, slugifyModelName } from '../lib/naming'
import { planModel, type DimPlan, type ModelPlan, type WizardTable } from '../lib/wizardInference'
import { useModelStore } from '../modelStore'

interface Props {
  onClose: () => void
  /** Runs the app's existing generate -> validate -> SmlViewerModal -> Deploy
   *  pipeline (App.tsx's handleGenerate) - the wizard never deploys on its
   *  own, it just hands off to that same, already-battle-tested path. */
  onGenerate: () => void
  /** Switches the app back to the Build tab so the user lands on the
   *  populated canvas either way (full success or partial/insufficient). */
  onDone: () => void
}

type Step = 'name' | 'source' | 'fact' | 'time' | 'dims' | 'review'

const STEPS: Step[] = ['name', 'source', 'fact', 'time', 'dims', 'review']

const STEP_TITLES: Record<Step, string> = {
  name: 'Name the model',
  source: 'Pick a data source',
  fact: 'Pick the fact table',
  time: 'Pick the time dimension',
  dims: 'Pick the other dimensions',
  review: 'Review',
}

const STEP_HELP: Record<Step, string> = {
  name: "Give this model a name. It's used for the workspace folder, the Git repo, and the AtScale project.",
  source: 'Choose the warehouse connection and database this model reads from.',
  fact: 'Pick the one table that holds the numeric facts (sales, orders, events, ...) this model measures.',
  time: 'Pick the calendar/date table, if this model has one - the wizard builds Year/Quarter/Month/Day automatically. Skip if there is none.',
  dims: 'Pick every other table that describes the fact rows (product, customer, geography, ...). Leave none selected (and skip the time dimension too) to treat the fact table as a single denormalized table - its own columns become degenerate dimensions instead.',
  review: 'Here is what the wizard could figure out from column names alone. Confirm to build it.',
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function WizardModal({ onClose, onGenerate, onDone }: Props) {
  const [step, setStep] = useState<Step>('name')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [modelName, setModelName] = useState('')
  const [sources, setSources] = useState<SourceSummary[]>([])
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [tables, setTables] = useState<WizardTable[]>([])
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const [factKey, setFactKey] = useState<string | null>(null)
  const [timeKey, setTimeKey] = useState<string | 'none' | null>(null)
  const [dimKeys, setDimKeys] = useState<Set<string>>(new Set())

  const storeModelName = useModelStore((s) => s.setModelName)
  const storeSourceId = useModelStore((s) => s.setSourceId)
  const addNode = useModelStore((s) => s.addNode)
  const addJoin = useModelStore((s) => s.addJoin)
  const setColumnDimRole = useModelStore((s) => s.setColumnDimRole)
  const setColumnConfig = useModelStore((s) => s.setColumnConfig)
  const setNodeIsTime = useModelStore((s) => s.setNodeIsTime)
  const setNodeRole = useModelStore((s) => s.setNodeRole)

  const tableKey = (t: WizardTable) => `${t.schema}.${t.table}`
  const bySchemaThenTable = (a: WizardTable, b: WizardTable) =>
    a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table)
  const factTable = tables.find((t) => tableKey(t) === factKey) ?? null
  const timeTable = timeKey && timeKey !== 'none' ? tables.find((t) => tableKey(t) === timeKey) ?? null : null
  const otherDimTables = tables.filter((t) => dimKeys.has(tableKey(t)))

  // The schema tree has table names only; the picked tables' columns load on
  // the way to Review (loadPickedColumns), and the plan waits for them.
  const [colsLoaded, setColsLoaded] = useState<Set<string>>(new Set())
  const picked = [factTable, timeTable, ...otherDimTables].filter((t): t is WizardTable => !!t)
  const plan: ModelPlan | null =
    factTable && picked.every((t) => colsLoaded.has(tableKey(t))) ? planModel(factTable, timeTable, otherDimTables) : null

  async function loadPickedColumns() {
    const missing = picked.filter((t) => !colsLoaded.has(tableKey(t)))
    if (!sourceId || missing.length === 0) return
    const cols = await fetchTablesColumns(sourceId, missing.map((t) => ({ schema: t.schema, table: t.table })))
    setTables((all) => all.map((t) => (cols[tableKey(t)] ? { ...t, columns: cols[tableKey(t)] } : t)))
    setColsLoaded((prev) => new Set([...prev, ...Object.keys(cols)]))
  }

  function stepIndex(s: Step) {
    return STEPS.indexOf(s)
  }

  async function goNext() {
    setError(null)
    const idx = stepIndex(step)
    if (idx >= STEPS.length - 1) return
    if (STEPS[idx + 1] === 'review') {
      setBusy(true)
      try {
        await loadPickedColumns()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return
      } finally {
        setBusy(false)
      }
    }
    setStep(STEPS[idx + 1])
  }

  function goBack() {
    setError(null)
    const idx = stepIndex(step)
    if (idx > 0) setStep(STEPS[idx - 1])
  }

  async function handleSourceNext() {
    if (!sourceId) return
    setBusy(true)
    setError(null)
    try {
      // Tables are listed per schema in the background on the API; wait for all.
      let schemas = await fetchSchemas(sourceId)
      for (let i = 0; schemas.some((x) => x.loading) && i < 300; i++) {
        const left = schemas.filter((x) => x.loading).length
        setBusyNote(`Listing tables… ${left} schema${left === 1 ? '' : 's'} to go`)
        await new Promise((r) => setTimeout(r, 2000))
        schemas = await fetchSchemas(sourceId)
      }
      setBusyNote(null)
      const flattened: WizardTable[] = schemas.flatMap((s: SchemaEntry) =>
        s.tables.map((t) => ({ schema: s.name, table: t.name, columns: t.columns ?? [] })),
      )
      setTables(flattened)
      goNext()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      setBusyNote(null)
    }
  }

  useEffect(() => {
    if (step !== 'source' || sources.length > 0) return
    setBusy(true)
    fetchSources()
      .then(setSources)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  function toggleDim(key: string) {
    setDimKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function seedMetric(nodeId: string, column: string) {
    const key = `${nodeId}::${column}`
    setColumnConfig(key, { measure: true, agg: 'SUM', display: titleCase(column), query: column })
  }

  function seedDegenerate(nodeId: string, column: string) {
    const key = `${nodeId}::${column}`
    setColumnConfig(key, { degen: true, degenDisplay: titleCase(column), degenQuery: column })
  }

  function seedLevel(nodeId: string, column: string, timeUnit?: string) {
    const key = `${nodeId}::${column}`
    setColumnDimRole(nodeId, key, 'level')
    if (timeUnit) setColumnConfig(key, { timeUnit: timeUnit as never })
  }

  function materializeDim(factId: string, dimPlan: DimPlan): string {
    const table = tables.find((t) => t.schema === dimPlan.schema && t.table === dimPlan.table)!
    const dimId = addNode(table.schema, table.table, 0, 0, table.columns)
    // addNode only guesses a role from the table name (fct/fact.. -> fact,
    // dim.. -> dimension) - a wizard-picked table (e.g. a time table named
    // "datecustom" with no "dim" prefix) can easily miss that heuristic and
    // land role: null, which then fails generation entirely ("no role set -
    // unset roles cannot be exported") even though this table was
    // deliberately picked as a dimension. Set it explicitly instead of
    // relying on the name guess.
    setNodeRole(dimId, 'dimension')
    if (dimPlan.isTime) setNodeIsTime(dimId, true)
    if (dimPlan.join) {
      addJoin({ node: factId, column: dimPlan.join.factColumn }, { node: dimId, column: dimPlan.join.dimColumn })
      // addJoin already marks the join column as L1 (dimRole only) - it
      // doesn't know about time_unit, so a time dimension's L1 still needs
      // its own timeUnit written explicitly or validate_model rejects it
      // ("no time unit set") even though the level itself exists.
      const l1 = dimPlan.levels[0]
      if (l1?.timeUnit) {
        setColumnConfig(`${dimId}::${l1.column}`, { timeUnit: l1.timeUnit as never })
      }
      for (const lvl of dimPlan.levels.slice(1)) {
        seedLevel(dimId, lvl.column, lvl.timeUnit)
      }
      if (dimPlan.secondary) {
        const l1Key = `${dimId}::${dimPlan.levels[0].column}`
        const secKey = `${dimId}::${dimPlan.secondary.column}`
        setColumnDimRole(dimId, secKey, 'secondary')
        setColumnConfig(secKey, { attachToKey: l1Key })
      }
    }
    return dimId
  }

  function materialize() {
    if (!plan) return
    storeModelName(modelName)
    const source = sources.find((s) => s.id === sourceId)
    if (source) {
      storeSourceId(source.id, { dialect: source.dialect, connectionId: source.connectionId, database: source.database })
    }
    const factId = addNode(plan.fact.schema, plan.fact.table, 0, 0, plan.fact.columns)
    // Same reasoning as materializeDim's setNodeRole - a fact table not
    // named fct*/fact* (this wizard lets you pick any table as the fact)
    // would otherwise land role: null and fail generation.
    setNodeRole(factId, 'fact')
    if (plan.timeDim) materializeDim(factId, plan.timeDim)
    for (const d of plan.dims) materializeDim(factId, d)
    for (const m of plan.metrics) seedMetric(factId, m.column)
    for (const g of plan.degenerate) seedDegenerate(factId, g.column)
  }

  function handleAddToCanvas() {
    materialize()
    onDone()
    onClose()
  }

  function handleBuildAndDeploy() {
    materialize()
    onDone()
    onClose()
    onGenerate()
  }

  const canNext =
    (step === 'name' && modelName.trim().length > 0) ||
    (step === 'source' && !!sourceId) ||
    (step === 'fact' && !!factKey) ||
    step === 'time' ||
    step === 'dims'

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="sml-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="sml-modal-header">
          <div>
            <div className="eyebrow">WIZARD · STEP {stepIndex(step) + 1} OF {STEPS.length}</div>
            <div className="identity-title">{STEP_TITLES[step]}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>

        <div style={{ padding: 20, minHeight: 280 }}>
          <div className="field-note" style={{ marginBottom: 16 }}>
            {STEP_HELP[step]}
          </div>

          {error && (
            <div className="login-error" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}

          {step === 'name' && (
            <label className="field">
              Model name
              <input
                autoFocus
                value={modelName}
                title={MODEL_NAME_HINT}
                onChange={(e) => setModelName(slugifyModelName(e.target.value))}
              />
            </label>
          )}

          {step === 'source' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sources.length === 0 && busy && <div className="field-note">Loading data sources…</div>}
              {sources.map((s) => (
                <button
                  key={s.id}
                  className={`btn btn-ghost ${sourceId === s.id ? 'wizard-pick-active' : ''}`}
                  style={{ justifyContent: 'flex-start' }}
                  onClick={() => setSourceId(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {step === 'fact' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
              {[...tables]
                .sort(bySchemaThenTable)
                .map((t) => (
                  <button
                    key={tableKey(t)}
                    className={`btn btn-ghost ${factKey === tableKey(t) ? 'wizard-pick-active' : ''}`}
                    style={{ display: 'flex', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setFactKey(tableKey(t))}
                  >
                    {t.schema}.{t.table}
                  </button>
                ))}
            </div>
          )}

          {step === 'time' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
              <button
                className={`btn btn-ghost ${timeKey === 'none' ? 'wizard-pick-active' : ''}`}
                style={{ display: 'flex', justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => setTimeKey('none')}
              >
                No time dimension
              </button>
              {[...tables]
                .filter((t) => tableKey(t) !== factKey)
                .sort(bySchemaThenTable)
                .map((t) => (
                  <button
                    key={tableKey(t)}
                    className={`btn btn-ghost ${timeKey === tableKey(t) ? 'wizard-pick-active' : ''}`}
                    style={{ display: 'flex', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => setTimeKey(tableKey(t))}
                  >
                    {t.schema}.{t.table}
                  </button>
                ))}
            </div>
          )}

          {step === 'dims' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
              {tables
                .filter((t) => tableKey(t) !== factKey && tableKey(t) !== timeKey)
                .sort(bySchemaThenTable)
                .map((t) => {
                  const checked = dimKeys.has(tableKey(t))
                  return (
                    <label
                      key={tableKey(t)}
                      className={`field ${checked ? 'wizard-pick-active' : ''}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleDim(tableKey(t))} />
                      {t.schema}.{t.table}
                    </label>
                  )
                })}
            </div>
          )}

          {step === 'review' && plan && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <strong>{plan.fact.table}</strong>{' '}
                <span style={{ opacity: 0.6 }}>({plan.metrics.length} metrics)</span>
              </div>
              {plan.denormalized && (
                <div className="field-note">
                  No time dimension or other dimensions picked - the fact table is treated as a
                  single denormalized table. Its {plan.degenerate.length} other column(s) become
                  degenerate dimensions: {plan.degenerate.map((g) => titleCase(g.column)).join(', ')}.
                </div>
              )}
              {[...(plan.timeDim ? [plan.timeDim] : []), ...plan.dims].map((d) => (
                <div key={`${d.schema}.${d.table}`} style={{ paddingLeft: 16 }}>
                  {d.join ? (
                    <>
                      <strong>{d.table}</strong>{' '}
                      <span style={{ opacity: 0.6 }}>
                        joined on {d.join.factColumn} — {d.levels.map((l) => titleCase(l.column)).join(' → ')}
                        {d.secondary ? ` (+ ${titleCase(d.secondary.column)})` : ''}
                      </span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--as-error, #d33)' }}>{d.table} — no join column found</span>
                  )}
                </div>
              ))}
              {plan.insufficient.length > 0 && (
                <div className="field-note">
                  These tables don't have enough naming information to auto-join (no matching
                  column name found against the fact table): {plan.insufficient.join(', ')}. They'll
                  still be added to the canvas so you can wire the join up by hand.
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--as-hairline)' }}>
          <button className="btn btn-ghost" onClick={goBack} disabled={step === 'name' || busy}>
            Back
          </button>
          {step === 'review' ? (
            plan && plan.insufficient.length > 0 ? (
              <button className="btn btn-primary" onClick={handleAddToCanvas}>
                Add to Canvas
              </button>
            ) : (
              <button className="btn btn-primary" onClick={handleBuildAndDeploy}>
                Build &amp; Deploy
              </button>
            )
          ) : (
            <button
              className="btn btn-primary"
              onClick={step === 'source' ? handleSourceNext : goNext}
              disabled={!canNext || busy}
            >
              {busy ? busyNote ?? 'Loading…' : 'Next'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
