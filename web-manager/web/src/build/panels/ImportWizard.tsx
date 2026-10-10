import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ENVS, useHosts } from '../../components/ui'
import {
  ConversionFailure,
  connectImport,
  convertImport,
  deployPreflight,
  fetchSchemas,
  fetchSources,
  importSmlFiles,
  inspectImport,
  publishImport,
  saveImport,
  type ImportConnected,
  type ImportConversion,
  type ImportInspection,
  type ImportKind,
  type ImportPublishResult,
} from '../client'
import { IMPORT_KINDS } from '../lib/importKinds'
import { MODEL_NAME_HINT, slugifyModelName } from '../lib/naming'
import { useModelStore } from '../modelStore'
import { PickList } from './PickList'

interface Props {
  hostId: string
  kind: ImportKind
  /** Back to the source cards (Build › Import & convert). */
  onClose: () => void
  /** Switches the app to Develop, where the converted model opens read-only. */
  onDone: () => void
}

type Step = 'file' | 'names' | 'convert' | 'connect' | 'validate' | 'finish'
type Action = 'save' | 'link' | 'deploy'

const ACTIONS: { id: Action; title: string; help: string }[] = [
  { id: 'save', title: 'Save', help: 'Write the SML to this workspace only. Nothing is pushed.' },
  { id: 'link', title: 'Link', help: 'Push to Git and register each model on the hosts you pick - deploy it later from Manage.' },
  { id: 'deploy', title: 'Deploy', help: 'Push to Git and deploy the catalog on the hosts you pick.' },
]

const COUNTS: [string, string][] = [
  ['datasets', 'Datasets'], ['dimensions', 'Dimensions'], ['metrics', 'Metrics'], ['calculations', 'Calculations'], ['models', 'Models'],
]

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
type Mapping = Record<string, { database: string; schema: string }>

export function ImportWizard({ hostId, kind, onClose, onDone }: Props) {
  const spec = IMPORT_KINDS[kind]
  const STEPS: { id: Step; title: string; help: string }[] = [
    { id: 'file', title: 'Export file', help: `The ${spec.file}. It is converted by the ps-utils ${spec.operation} operation - no warehouse access needed.` },
    { id: 'names', title: 'Repository & models', help: `Name the SML repository (its Git repo and working copy) and each model - one per cube in the export.${kind === 'tabular' ? ' DAX is translated to SQL at conversion, so pick the warehouse here.' : ''}` },
    { id: 'convert', title: 'Convert', help: 'Runs the conversion. The report lists everything it renamed, truncated or left out.' },
    { id: 'connect', title: 'Connect', help: 'Point the converted connections at a data source on this host: pick the data source, then the schema its tables are in.' },
    { id: 'validate', title: 'Validate', help: 'The SML with its connections remapped, checked by sml-cli.' },
    { id: 'finish', title: 'Save, link or deploy', help: 'Keep the repo in this workspace, or push it to Git and link or deploy it on hosts. It then opens in Develop, read-only.' },
  ]
  const [step, setStep] = useState<Step>('file')
  const [error, setError] = useState<string | null>(null)
  const [errorLog, setErrorLog] = useState<string | null>(null)

  // -- file ----------------------------------------------------------------------
  const [fileName, setFileName] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [info, setInfo] = useState<ImportInspection | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // -- names ---------------------------------------------------------------------
  const [repoName, setRepoName] = useState('')
  const [catalogName, setCatalogName] = useState('')
  const [modelNames, setModelNames] = useState<Record<string, string>>({})
  const [modelMode, setModelMode] = useState<'new' | 'existing'>('new')
  const [warehouse, setWarehouse] = useState<string | null>(null)

  // -- convert -------------------------------------------------------------------
  const [converting, setConverting] = useState(false)
  const [converted, setConverted] = useState<ImportConversion | null>(null)
  const [convertedKey, setConvertedKey] = useState<string | null>(null)

  // -- connect -------------------------------------------------------------------
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [schema, setSchema] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const sources = useQuery({ queryKey: ['wizard-sources', hostId], queryFn: fetchSources, staleTime: 2 * 3600e3 })
  const source = sources.data?.find((s) => s.id === sourceId) ?? null
  const schemas = useQuery({
    queryKey: ['wizard-schemas', hostId, sourceId],
    queryFn: () => fetchSchemas(sourceId!),
    enabled: !!sourceId,
    staleTime: 2 * 3600e3,
  })
  const schemaNames = useMemo(() => (schemas.data ?? []).map((s) => s.name), [schemas.data])

  // -- validate / finish ---------------------------------------------------------
  const [connecting, setConnecting] = useState(false)
  const [result, setResult] = useState<ImportConnected | null>(null)
  const [connectedKey, setConnectedKey] = useState<string | null>(null)
  const [action, setAction] = useState<Action>('save')
  const [replace, setReplace] = useState(false)
  const [running, setRunning] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [published, setPublished] = useState<ImportPublishResult | null>(null)
  const [opening, setOpening] = useState(false)

  const hosts = useHosts().data?.hosts ?? []
  const [picked, setPicked] = useState<string[]>([hostId])
  const [missing, setMissing] = useState<Record<string, string>>({})

  const idx = STEPS.findIndex((s) => s.id === step)
  const fail = (e: unknown) => {
    setError(errMsg(e))
    setErrorLog(e instanceof ConversionFailure ? e.log : null)
  }

  async function readFile(f: File) {
    setError(null)
    setErrorLog(null)
    setInfo(null)
    setConverted(null)
    setResult(null)
    setInspecting(true)
    try {
      const body = await f.text()
      setFileName(f.name)
      setText(body)
      const got = await inspectImport(kind, body, f.name)
      setInfo(got)
      setRepoName(slugifyModelName(got.project))
      setCatalogName(got.caption ?? got.project)
      setModelNames(Object.fromEntries(got.models.map((m) => [m.name, m.name])))
      setWarehouse(got.warehouse ?? null)
    } catch (e) {
      fail(e)
    } finally {
      setInspecting(false)
    }
  }

  const names = Object.values(modelNames).map((n) => n.trim())
  const namesError = !repoName ? 'Enter a repository name.'
    : names.some((n) => !n) ? 'Every model needs a name.'
    : new Set(names).size < names.length ? 'Two models have the same name.'
    : kind === 'tabular' && !warehouse ? 'Pick the warehouse the DAX is translated for.' : null

  // Each step re-runs only when something it depends on changed.
  const convertKey = JSON.stringify({ fileName, len: text?.length, repoName, catalogName, modelMode, warehouse, modelNames })
  const connectKey = JSON.stringify({ convertedKey, sourceId, mapping })

  async function runConvert() {
    if (!text) return
    setConverting(true)
    setError(null)
    setErrorLog(null)
    setConverted(null)
    setResult(null)
    try {
      const got = await convertImport({
        kind, text, fileName, repoName, catalogName: catalogName.trim() || undefined, modelMode,
        warehouse: kind === 'tabular' ? warehouse ?? undefined : undefined, models: modelNames,
      })
      setConverted(got)
      setConvertedKey(convertKey)
      // The remap starts from what the conversion emitted.
      setMapping(Object.fromEntries(got.connections.map((c) => [c.name, { database: c.database ?? '', schema: c.schema ?? '' }])))
      setSourceId(null)
      setSchema(null)
    } catch (e) {
      fail(e)
    } finally {
      setConverting(false)
    }
  }

  async function runConnect() {
    if (!converted || !source) return
    setConnecting(true)
    setError(null)
    setErrorLog(null)
    setResult(null)
    setSaved(null)
    setPublished(null)
    try {
      setResult(await connectImport({ repoName, files: converted.files, asConnection: source.connectionId, connections: mapping }))
      setReplace(false)
      setConnectedKey(connectKey)
    } catch (e) {
      fail(e)
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    if (step === 'convert' && convertedKey !== convertKey && !converting) runConvert()
    if (step === 'validate' && connectedKey !== connectKey && !connecting) runConnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // -- connect: data source, then schema ------------------------------------------
  function pickSource(id: string) {
    const s = sources.data?.find((x) => x.id === id)
    setSourceId(id)
    setSchema(null)
    if (!s || !converted) return
    setMapping(Object.fromEntries(converted.connections.map((c) => [c.name, { database: s.database, schema: '' }])))
  }
  // Once the source's schemas are listed: the one schema every converted
  // connection names (case-insensitive), or the only schema, is preselected.
  useEffect(() => {
    if (!schemas.data || !converted || schema) return
    const wanted = [...new Set(converted.connections.map((c) => c.schema?.toLowerCase()).filter(Boolean))]
    const hit = wanted.length === 1 ? schemaNames.find((n) => n.toLowerCase() === wanted[0]) : undefined
    const pick = hit ?? (schemaNames.length === 1 ? schemaNames[0] : null)
    if (pick) pickSchema(pick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas.data, converted])
  /** The schema for every connection; a row can still override its own. */
  function pickSchema(name: string) {
    setSchema(name)
    setMapping((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, schema: name }])))
  }
  const schemaOk = (name: string) => !!name && (!schemas.data || schemaNames.includes(name))
  const connectReady = !!source && !!converted && schemas.isSuccess
    && converted.connections.every((c) => schemaOk(mapping[c.name]?.schema ?? ''))
  const warehouseMismatch = kind === 'tabular' && source && warehouse
    && !(source.dialect ?? '').toLowerCase().includes(warehouse.toLowerCase())

  // -- finish -------------------------------------------------------------------
  const hostKey = hosts.map((h) => h.id).join(',')
  useEffect(() => {
    if (step !== 'finish' || !source || !hostKey) return
    deployPreflight(source.connectionId, hostKey.split(','))
      .then((rows) => setMissing(Object.fromEntries(rows.filter((r) => !r.ok).map((r) => [r.hostId, r.error ?? `No '${source.connectionId}' connection`]))))
      .catch(() => setMissing({}))
  }, [step, source, hostKey])
  const targets = picked.filter((id) => !missing[id] && hosts.some((h) => h.id === id))
  const toggleHost = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  // A save or push this session already replaced the working copy - it's ours now.
  const needsReplace = !!result?.workspaceExists && !saved && !published
  async function runAction() {
    if (!result || !source) return
    setRunning(true)
    setError(null)
    setErrorLog(null)
    try {
      const doReplace = replace || !!saved || !!published
      if (action === 'save') {
        setSaved((await saveImport(repoName, result.files, doReplace)).path)
      } else {
        setPublished(await publishImport({
          repoName, catalogName: catalogName.trim() || undefined, files: result.files,
          models: result.models.map((m) => m.name), asConnection: source.connectionId,
          hostIds: targets, action, replace: doReplace,
        }))
      }
    } catch (e) {
      fail(e)
    } finally {
      setRunning(false)
    }
  }

  /** The converted model on the canvas, read-only (LoadedFrom.importedFrom). */
  async function openInDevelop() {
    if (!result || !source) return
    setOpening(true)
    setError(null)
    try {
      const parsed = await importSmlFiles(result.files.filter((f) => /\.ya?ml$/i.test(f.name) && !f.name.startsWith('context/')))
      const s = useModelStore.getState()
      s.reset()
      s.setModelName(repoName)
      s.setSourceId(source.id, { dialect: source.dialect, connectionId: source.connectionId, database: source.database })
      s.setSourceRepo(published ? { url: published.git.repoUrl, branch: published.git.branch } : null)
      s.loadModelData({
        nodes: parsed.nodes as never[],
        joins: parsed.joins as never[],
        cfg: parsed.cfg as never,
        calculations: (parsed.calculations ?? []) as never[],
        loadedFrom: { builtHere: false, unsupported: parsed.unsupported ?? [], importedFrom: fileName },
        shared: false,
      })
      useModelStore.getState().autoArrange()
      onDone()
    } catch (e) {
      fail(e)
      setOpening(false)
    }
  }

  const canNext = step === 'file' ? !!info && !inspecting
    : step === 'names' ? !namesError
    : step === 'convert' ? !!converted && !converting
    : step === 'connect' ? connectReady
    : step === 'validate' ? !!result && !connecting
    : false
  const busy = inspecting || converting || connecting || running || opening

  function go(to: Step) {
    setError(null)
    setErrorLog(null)
    setStep(to)
  }

  const summary: Record<Step, string | null> = {
    file: fileName || null,
    names: idx > 1 ? repoName : null,
    convert: idx > 2 && converted ? `${converted.counts.datasets ?? 0} datasets · ${converted.counts.models ?? 0} models` : null,
    connect: idx > 3 && source ? `${source.connectionId} · ${source.database}${schema ? `.${schema}` : ''}` : null,
    validate: idx > 4 && result ? (result.validation.passed ? 'valid' : 'validation failed') : null,
    finish: saved ? 'saved' : published ? (published.action === 'link' ? 'linked' : 'deployed') : null,
  }

  const cur = STEPS[idx]
  const failedHosts = published?.results.filter((r) => !r.ok) ?? []
  const schemaOptions = schemaNames.map((n) => ({ value: n, label: n }))

  return (
    <div className="sml-modal wizard wizard-page">
      <nav className="wizard-rail">
        <div className="eyebrow">{spec.label}</div>
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.id} className={`${s.id === step ? 'on' : ''} ${i < idx ? 'done' : ''}`} onClick={() => i < idx && !busy && go(s.id)}>
              <span className="wizard-num">{i < idx ? '✓' : i + 1}</span>
              <span className="wizard-step">
                <span>{s.title}</span>
                {summary[s.id] && <span className="wizard-sum" title={summary[s.id]!}>{summary[s.id]}</span>}
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-ghost btn-sm wizard-cancel" onClick={onClose} disabled={busy}>Change source</button>
      </nav>

      <section className="wizard-main">
        <header className="wizard-head">
          <span className="eyebrow">Step {idx + 1} of {STEPS.length}</span>
          <span className="headline">{cur.title}</span>
          <span className="field-note">{cur.help}</span>
        </header>

        <div className="wizard-body">
          {error && (
            <div className="login-error wizard-error">
              {error}
              {errorLog && <pre className="validation-output import-log">{errorLog}</pre>}
            </div>
          )}

          {step === 'file' && (
            <div className="wizard-form">
              <input ref={fileInput} type="file" accept={spec.accept} style={{ display: 'none' }} data-testid="import-file"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = '' }} />
              <div className="wizard-run">
                <button type="button" className="btn btn-primary btn-sm" disabled={inspecting} onClick={() => fileInput.current?.click()}>
                  {fileName ? 'Choose another file…' : 'Choose file…'}
                </button>
                {fileName ? <span className="mono">{fileName}</span> : <span className="field-note">{spec.file}</span>}
              </div>
              {inspecting && <span className="field-note wizard-inline"><span className="spinner" /> Reading the export…</span>}
              {info && (
                <div className="wizard-review">
                  <div className="disc-tiles">
                    <div className="disc-tile" title={info.project}><span className="section-label" style={{ margin: 0 }}>Project</span><span className="disc-tile-v small">{info.project}</span></div>
                    <div className="disc-tile"><span className="section-label" style={{ margin: 0 }}>Cubes</span><span className="disc-tile-v">{info.cubes.length}</span></div>
                    <div className="disc-tile"><span className="section-label" style={{ margin: 0 }}>Tables</span><span className="disc-tile-v">{info.datasets}</span>
                      {(info.counts.datasets ?? 0) !== info.datasets && <span className="field-note">{info.counts.datasets ?? 0} used by a cube</span>}</div>
                    {kind === 'tabular' && (
                      <div className="disc-tile"><span className="section-label" style={{ margin: 0 }}>Warehouse</span>
                        <span className="disc-tile-v small">{info.warehouse ?? 'not named'}</span></div>
                    )}
                  </div>
                  <div className="wizard-card fact">
                    <div className="wizard-card-h"><span className="wizard-role r-fact">Cubes</span><b>{info.caption ?? info.project}</b></div>
                    <div className="wizard-chips">
                      {info.cubes.map((c) => <span key={c.name} className="wizard-level">{c.name}{c.visible ? '' : ' (hidden)'}</span>)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'names' && info && (
            <div className="wizard-form">
              <label className="field">
                Repository name
                <input autoFocus value={repoName} title={MODEL_NAME_HINT} onChange={(e) => setRepoName(slugifyModelName(e.target.value))} />
                <span className="field-note">The Git repo and workspace/{repoName || '…'}. {MODEL_NAME_HINT}</span>
              </label>
              <label className="field">
                Catalog label
                <input value={catalogName} placeholder={info.project} onChange={(e) => setCatalogName(e.target.value)} />
                <span className="field-note">In the export: <span className="mono">{info.project}</span></span>
              </label>
              <div className="field">
                Models
                <div className="import-map">
                  {info.models.map((m, i) => (
                    <div key={m.name} className="import-map-row">
                      <span className="import-map-from"><span className="muted">cube</span> <span className="mono">{info.cubes[i]?.name ?? m.name}</span></span>
                      <span className="muted">→</span>
                      <input value={modelNames[m.name] ?? ''} onChange={(e) => setModelNames((n) => ({ ...n, [m.name]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>
              {kind === 'tabular' && (
                <div className="field">
                  Warehouse
                  <PickList
                    options={(info.warehouses ?? []).map((w) => ({ value: w, label: w, hint: w === info.warehouse ? 'named by the export' : undefined }))}
                    value={warehouse}
                    onChange={setWarehouse}
                    placeholder="Pick the warehouse the DAX is translated for…"
                    searchPlaceholder="Search warehouses"
                  />
                  <span className="field-note">
                    {info.warehouse ? `The export's data source is ${info.warehouse}.` : "The export's data source names no supported warehouse - pick the one the model will read."}
                  </span>
                </div>
              )}
              <div className="field">
                Name collisions
                <div className="wizard-mode">
                  <button type="button" className={modelMode === 'new' ? 'on' : ''} onClick={() => setModelMode('new')}>
                    <b>Rename</b><span>Give colliding objects unique query names. Right for a model nobody queries yet.</span>
                  </button>
                  <button type="button" className={modelMode === 'existing' ? 'on' : ''} onClick={() => setModelMode('existing')}>
                    <b>Keep names</b><span>Keep the names reports already use; a collision fails the conversion and is listed.</span>
                  </button>
                </div>
              </div>
              {namesError && <span className="field-note warn">{namesError}</span>}
            </div>
          )}

          {step === 'convert' && (
            <div className="wizard-form">
              {converting && <span className="field-note wizard-inline"><span className="spinner" /> Converting with {spec.operation}…</span>}
              {!converting && !converted && error && (
                <div className="wizard-run">
                  <button type="button" className="btn btn-primary btn-sm" onClick={runConvert}>Try again</button>
                  <span className="field-note">Go back to change the names or the collision mode.</span>
                </div>
              )}
              {converted && <ConversionReview converted={converted} />}
            </div>
          )}

          {step === 'connect' && converted && (
            <div className="wizard-form">
              <div className="field">
                Data source
                <PickList
                  autoFocus
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
                <span className="field-note">
                  The conversion connects through <span className="mono">{[...new Set(converted.connections.map((c) => c.asConnection ?? c.name))].join(', ')}</span>.
                </span>
                {warehouseMismatch && <span className="field-note warn">The DAX was translated for {warehouse}, but this source is {source?.dialect}. Go back to Repository &amp; models to change the warehouse.</span>}
              </div>
              <div className="field">
                Schema
                <PickList
                  options={schemaOptions}
                  value={schema}
                  onChange={pickSchema}
                  disabled={!sourceId}
                  placeholder={sourceId ? 'Pick the schema the tables are in…' : 'Pick a data source first'}
                  searchPlaceholder="Search schemas"
                  loading={schemas.isLoading ? 'Loading schemas…' : undefined}
                  emptyNote="No schemas on this data source."
                />
                {schemas.error && <span className="login-error">{errMsg(schemas.error)}</span>}
                {converted.connections.length > 1 && <span className="field-note">Applies to every connection below; change a row to point it elsewhere.</span>}
              </div>
              {source && schemas.isSuccess && (
                <div className="field">
                  Connections
                  <div className="import-map">
                    {converted.connections.map((c) => {
                      const m = mapping[c.name] ?? { database: '', schema: '' }
                      return (
                        <div key={c.name} className="import-map-conn">
                          <div className="import-map-from">
                            <span className="mono">{c.name}</span>
                            <span className="muted"> · was {[c.database, c.schema].filter(Boolean).join('.') || 'no database / schema'} · {c.datasets} dataset{c.datasets === 1 ? '' : 's'}</span>
                          </div>
                          <div className="import-map-row two">
                            <label className="field">
                              Database
                              <input value={m.database} onChange={(e) => setMapping((x) => ({ ...x, [c.name]: { ...m, database: e.target.value } }))} />
                            </label>
                            <div className="field">
                              Schema
                              <PickList
                                options={schemaOptions}
                                value={m.schema || null}
                                onChange={(v) => setMapping((x) => ({ ...x, [c.name]: { ...m, schema: v } }))}
                                placeholder="Pick a schema…"
                                searchPlaceholder="Search schemas"
                              />
                            </div>
                          </div>
                          {!schemaOk(m.schema) && <span className="field-note warn">Pick the schema on {source.database} that holds these tables.</span>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'validate' && (
            <div className="wizard-form">
              {connecting && <span className="field-note wizard-inline"><span className="spinner" /> Remapping the connections and validating with sml-cli…</span>}
              {!connecting && !result && error && (
                <div className="wizard-run"><button type="button" className="btn btn-primary btn-sm" onClick={runConnect}>Try again</button></div>
              )}
              {result && (
                <div className="wizard-review">
                  <div className={`validation-banner ${result.validation.passed ? 'validation-pass' : 'validation-fail'}`}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{result.validation.passed ? 'Validation passed (sml-cli)' : 'Validation failed (sml-cli)'}</div>
                    <pre className="validation-output import-log">{result.validation.output}</pre>
                  </div>
                  <div className="wizard-card fact">
                    <div className="wizard-card-h"><span className="wizard-role r-fact">Connections</span><span className="muted">every one reads {source?.connectionId}</span></div>
                    {result.connections.map((c) => (
                      <div key={c.name} className="mono field-note">{c.name} → {[c.database, c.schema].filter(Boolean).join('.') || '(source default)'} · {c.datasets} datasets</div>
                    ))}
                  </div>
                  {!result.validation.passed && (
                    <span className="field-note">You can still save or link it and fix it; a deploy will likely be rejected.</span>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 'finish' && result && (
            <div className="wizard-form">
              <div className="wizard-mode import-actions">
                {ACTIONS.map((a) => (
                  <button key={a.id} type="button" className={action === a.id ? 'on' : ''} disabled={running} onClick={() => setAction(a.id)}>
                    <b>{a.title}</b><span>{a.help}</span>
                  </button>
                ))}
              </div>
              {action !== 'save' && (
                <div className="field">
                  {action === 'link' ? 'Link on' : 'Deploy to'}
                  <div className="import-hosts">
                    {ENVS.map((e) => {
                      const inEnv = hosts.filter((h) => h.env === e.id)
                      if (!inEnv.length) return null
                      return (
                        <div key={e.id} className="deploy-env">
                          <span className="deploy-env-label" style={{ color: e.color }}>{e.label}</span>
                          {inEnv.map((h) => {
                            const why = missing[h.id]
                            return (
                              <label key={h.id} className={`deploy-host ${why ? 'deploy-host-off' : ''}`} title={why ?? h.hostname}>
                                <input type="checkbox" checked={picked.includes(h.id) && !why} disabled={!!why || running} onChange={() => toggleHost(h.id)} />
                                {h.label}
                              </label>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              {needsReplace && (
                <label className="checkbox-row">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                  Replace workspace/{repoName} - it already holds SML, which this import overwrites
                </label>
              )}
              {!result.validation.passed && action === 'deploy' && (
                <span className="field-note warn">sml-cli validation failed - AtScale will likely reject the deploy. Save or link it and fix it first.</span>
              )}
              <div className="wizard-run">
                <button type="button" className="btn btn-primary btn-sm" onClick={runAction}
                  disabled={running || (needsReplace && !replace) || (action !== 'save' && !targets.length)}>
                  {running ? (action === 'save' ? 'Saving…' : action === 'link' ? 'Pushing and linking…' : 'Pushing and deploying…')
                    : action === 'save' ? `Save to workspace/${repoName}`
                    : `${action === 'link' ? 'Link on' : 'Deploy to'} ${targets.length} host${targets.length === 1 ? '' : 's'}`}
                </button>
              </div>
              {saved && <div className="validation-banner validation-pass"><b>Saved</b> <span className="mono">{saved}</span></div>}
              {published && (
                <div className={`validation-banner ${failedHosts.length ? 'validation-fail' : 'validation-pass'}`}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    {failedHosts.length
                      ? `${published.action === 'link' ? 'Linked on' : 'Deployed to'} ${published.results.length - failedHosts.length} of ${published.results.length} hosts`
                      : published.action === 'link' ? 'Pushed and linked - deploy it from Manage' : 'Pushed and deployed'}
                  </div>
                  <div className="field-note" style={{ marginBottom: 6 }}>
                    {published.git.repoUrl} @ {published.git.branch} ({published.git.commit.slice(0, 7)})
                  </div>
                  {published.results.map((r) => (
                    <div key={r.hostId} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                      <span style={{ color: r.ok ? '#3bd44a' : '#ff3b35' }}>{r.ok ? '✓' : '✕'}</span>
                      <span>{r.label}</span>
                      {r.error && <span style={{ color: 'var(--as-muted)' }}>{r.error}</span>}
                      {r.warnings?.map((w) => <span key={w} style={{ color: '#f5a623' }}>{w}</span>)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="wizard-foot">
          <button type="button" className="btn btn-ghost" onClick={() => go(STEPS[idx - 1].id)} disabled={idx === 0 || busy}>
            Back
          </button>
          {step === 'finish' ? (
            <button type="button" className="btn btn-primary" onClick={openInDevelop} disabled={busy}
              title="Loads the converted model on the canvas, read-only">
              {opening ? 'Opening…' : saved || published ? 'Open in Develop' : 'Open in Develop without saving'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => go(STEPS[idx + 1].id)} disabled={!canNext || busy}>
              {inspecting ? 'Reading…' : converting ? 'Converting…' : connecting ? 'Validating…' : 'Next'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

/** What the conversion produced: counts, the CLI's own report (README.md /
 *  CONVERSION_REPORT.md - omissions, renames) and its log. */
function ConversionReview({ converted }: { converted: ImportConversion }) {
  return (
    <div className="wizard-review">
      <div className="validation-banner validation-pass">
        <b>Converted</b> - {converted.files.length} files
        <div className="field-note" title={converted.converter.path}>
          by {converted.converter.label}{converted.converter.version ? ` ${converted.converter.version}` : ''}
          {converted.converter.builtAt ? `, built ${new Date(converted.converter.builtAt).toLocaleString()}` : ''}
        </div>
      </div>
      <div className="disc-tiles">
        {COUNTS.map(([k, label]) => (
          <div key={k} className="disc-tile"><span className="section-label" style={{ margin: 0 }}>{label}</span><span className="disc-tile-v">{converted.counts[k] ?? 0}</span></div>
        ))}
      </div>
      <div className="wizard-card fact">
        <div className="wizard-card-h"><span className="wizard-role r-fact">Models</span><span className="muted">{converted.models.length}</span></div>
        <div className="wizard-chips">
          {converted.models.map((m) => <span key={m.name} className="wizard-level">{m.name}</span>)}
        </div>
        <div className="wizard-levels">
          {converted.connections.map((c) => (
            <div key={c.name} className="mono field-note">connection {c.name}{c.database || c.schema ? ` · ${[c.database, c.schema].filter(Boolean).join('.')}` : ''} · {c.datasets} datasets</div>
          ))}
        </div>
      </div>
      {converted.report && (
        <details className="wizard-skipped">
          <summary>Conversion report - what it renamed, truncated or left out</summary>
          <pre className="validation-output import-log">{converted.report}</pre>
        </details>
      )}
      <details className="wizard-skipped">
        <summary>Conversion log</summary>
        <pre className="validation-output import-log">{converted.log}</pre>
      </details>
    </div>
  )
}
