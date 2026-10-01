import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CompareSection, ModelCompareSection } from './Compare'
import { ResultsSection } from './Results'
import { ENVS, EnvSegment, HostSelect, RefreshButton, errMsg, plural, useHosts } from '../components/ui'
import { resolveHost, useUi } from '../store'
import { testApi, type CubeRef, type Protocol, type TestOptions, type TestQuery, type TestTarget } from './api'
import { TEST_FRESH_MS, loadedAt, refreshTest, reloadIfOld, useTestCubes } from './shared'

export const cubeKey = (c: CubeRef) => `${c.catalog}|${c.cube}`

/** Test: ps-utils "Testing / Query Processing" - generate-queries-from-model
 * builds the queries from a deployed model, execute-atscale-query-harness runs
 * them on every picked host. */
export function TestView() {
  const { testSection } = useUi()
  if (testSection === 'results') return <ResultsSection />
  if (testSection === 'compare') return <CompareSection />
  if (testSection === 'model') return <ModelCompareSection />
  return <div className="col test-col"><RunSetup /></div>
}

function RunSetup() {
  const { test, setTest } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const host = resolveHost(hosts, test)
  const qc = useQueryClient()

  const cubesQ = useTestCubes(host?.id)
  const cubes = cubesQ.data?.cubes ?? []
  const [modelKey, setModelKey] = useState('')
  const ref = cubes.find((c) => cubeKey(c) === modelKey) ?? cubes[0] ?? null

  // Every host's cubes, to show where the picked model exists.
  const allCubes = useQueries({
    queries: hosts.map((h) => ({ queryKey: ['testCubes', h.id], queryFn: () => testApi.cubes(h.id), staleTime: TEST_FRESH_MS })),
  })
  /** The picked model on another host: same catalog + cube, else the one
   * catalog holding a cube of that name (a catalog deployed from another
   * branch is named <catalog>_<branch>). undefined = still loading. */
  const matchOn = (hostId: string): CubeRef | null | undefined => {
    const i = hosts.findIndex((h) => h.id === hostId)
    const d = allCubes[i]
    if (!ref || !d || d.isLoading) return undefined
    const list = d.data?.cubes ?? []
    const exact = list.find((c) => cubeKey(c) === cubeKey(ref))
    if (exact) return exact
    const byCube = list.filter((c) => c.cube === ref.cube)
    return byCube.length === 1 ? byCube[0] : null
  }
  const hasModel = (hostId: string): boolean | null => {
    const m = matchOn(hostId)
    return m === undefined ? null : !!m
  }

  const [targets, setTargets] = useState<string[]>([])
  useEffect(() => { if (host && !targets.length) setTargets([host.id]) }, [host, targets.length])
  const runnable = targets.filter((id) => hasModel(id) === true)

  return (
    <RunBuilder
      genHostId={host?.id ?? null}
      model={ref}
      targets={runnable.map((hostId) => ({ hostId, ...matchOn(hostId)! }))}
      barLeft={(
        <>
          <EnvSegment value={test.env} onPick={(e) => { setTest({ env: e, hostId: null }); setTargets([]) }} />
          <HostSelect hosts={hosts} env={test.env} value={host?.id ?? null} onChange={(id) => { setTest({ env: test.env, hostId: id }); setTargets([]) }} />
          <select className="select" style={{ minWidth: 260 }} value={ref ? cubeKey(ref) : ''} onChange={(e) => setModelKey(e.target.value)}
            onMouseDown={reloadIfOld(cubesQ)} onFocus={reloadIfOld(cubesQ)} disabled={!cubes.length && !cubesQ.isFetching}>
            {!cubes.length && <option value="">{cubesQ.isLoading ? 'Loading models…' : cubesQ.isError ? 'Could not list models' : 'No deployed models'}</option>}
            {cubes.map((c) => <option key={cubeKey(c)} value={cubeKey(c)}>{c.cube} — {c.catalog}</option>)}
          </select>
        </>
      )}
      barRight={<RefreshButton cachedAt={loadedAt(cubesQ.dataUpdatedAt)} cachedFor="30 s" onRefresh={() => refreshTest(qc)} />}
      error={cubesQ.isError ? errMsg(cubesQ.error) : null}
      runOn={(
        <div className="test-hosts">
          {ENVS.map((e) => {
            const inEnv = hosts.filter((h) => h.env === e.id)
            if (!inEnv.length) return null
            return (
              <div key={e.id} className="test-env">
                <span className="test-env-label" style={{ color: e.color }}>{e.label}</span>
                {inEnv.map((h) => {
                  const has = hasModel(h.id)
                  const off = has === false
                  return (
                    <label key={h.id} className={`test-host ${off ? 'off' : ''}`}
                      title={off ? `${ref?.cube ?? 'Model'} isn't deployed on ${h.label}` : h.hostname}>
                      <input type="checkbox" disabled={off} checked={targets.includes(h.id) && !off}
                        onChange={() => setTargets((t) => (t.includes(h.id) ? t.filter((x) => x !== h.id) : [...t, h.id]))} />
                      {h.label}
                      <span className="hint">{has === null ? '…' : !has ? 'no model' : matchOn(h.id)!.catalog !== ref?.catalog ? matchOn(h.id)!.catalog : ''}</span>
                    </label>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    />
  )
}

/** Everything after "which model, on which hosts": the generated queries, the
 * run options and the Run button. Validate › Run picks a host then a model;
 * Catalog › Validate picks a model then the hosts it's deployed on - both end here.
 * `genHostId` + `model`: where the queries are generated from; `targets`:
 * every host (with its own catalog/cube) the run executes on. */
export function RunBuilder({ genHostId, model, targets, barLeft, barRight, runOn, error }: {
  genHostId: string | null
  model: CubeRef | null
  targets: TestTarget[]
  barLeft: ReactNode
  barRight?: ReactNode
  runOn: ReactNode
  error?: string | null
}) {
  const { setTestRunId, setTestSection, setView, flash } = useUi()
  const qc = useQueryClient()
  const genQ = useQuery({
    queryKey: ['testQueries', genHostId, model && cubeKey(model)],
    queryFn: () => testApi.generate(genHostId!, model!),
    enabled: !!genHostId && !!model,
  })
  const queries = useMemo(() => genQ.data?.queries ?? [], [genQ.data])
  const [picked, setPicked] = useState<Set<string> | null>(null) // null = all
  const [kind, setKind] = useState<'all' | 'total' | 'level'>('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [protocols, setProtocols] = useState<Protocol[]>(['mdx', 'sql'])
  const [concurrency, setConcurrency] = useState(2)
  const [opts, setOpts] = useState<TestOptions>({ useAggregates: true, generateAggregates: false, useQueryCache: false, useAggregateCache: true })
  const [annotate, setAnnotate] = useState(true)
  const [starting, setStarting] = useState(false)

  useEffect(() => { setPicked(null); setOpen(null) }, [genQ.data])
  const isPicked = (q: TestQuery) => (picked ? picked.has(q.id) : true)
  const visible = queries.filter((q) => (kind === 'all' || q.kind === kind) && q.name.toLowerCase().includes(search.toLowerCase()))
  const chosen = queries.filter(isPicked)
  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p ?? queries.map((q) => q.id))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const setVisible = (on: boolean) => setPicked((p) => {
    const next = new Set(p ?? queries.map((q) => q.id))
    for (const q of visible) {
      if (on) next.add(q.id)
      else next.delete(q.id)
    }
    return next
  })
  const allVisibleOn = visible.length > 0 && visible.every(isPicked)
  const nRuns = chosen.length * protocols.length * targets.length

  async function start() {
    if (!model) return
    setStarting(true)
    try {
      const run = await testApi.start({
        targets,
        queries: chosen, protocols, concurrency, options: opts, annotate,
      })
      qc.invalidateQueries({ queryKey: ['testRuns'] })
      setTestRunId(run.runId)
      setTestSection('results')
      setView('test')
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <div className="bar">
        <div className="row">
          {barLeft}
        </div>
        <div className="row">
          {barRight}
          <span className="hint">{genQ.isFetching ? 'Reading model…' : queries.length ? `${queries.length} ${queries.length === 1 ? 'query' : 'queries'} generated` : ''}</span>
          <button type="button" className="btn primary lg" disabled={!nRuns || starting} onClick={start}>
            {starting ? 'Starting…' : nRuns ? `Run ${nRuns} on ${plural(targets.length, 'host')}` : 'Run'}
          </button>
        </div>
      </div>

      {error && <div className="notice err" style={{ marginTop: 12 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{error}</div>}
      {genQ.isError && <div className="notice err" style={{ marginTop: 12 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(genQ.error)}</div>}

      <div className="test-setup">
        <div className="test-block">
          <span className="eyebrow">Run on</span>
          {runOn}
        </div>
        <div className="test-block">
          <span className="eyebrow">Options</span>
          <div className="test-opts">
            {(['mdx', 'sql'] as Protocol[]).map((p) => (
              <label key={p} className="test-opt">
                <input type="checkbox" checked={protocols.includes(p)}
                  onChange={() => setProtocols((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]))} />
                {p === 'mdx' ? 'MDX (XMLA)' : 'SQL'}
              </label>
            ))}
            <label className="test-opt">Workers per host
              <select className="select sm" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
                {[1, 2, 4, 8].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {([
              ['useAggregates', 'Use aggregates'],
              ['useAggregateCache', 'Aggregate cache'],
              ['useQueryCache', 'Query cache'],
              ['generateAggregates', 'Generate aggregates'],
            ] as [keyof TestOptions, string][]).map(([k, label]) => (
              <label key={k} className="test-opt">
                <input type="checkbox" checked={opts[k]} onChange={() => setOpts((o) => ({ ...o, [k]: !o[k] }))} />{label}
              </label>
            ))}
            <label className="test-opt" title="Prepends /* {run_id, run_query_uuid, original_text_hash} */ so AtScale's query log can be matched to this run">
              <input type="checkbox" checked={annotate} onChange={() => setAnnotate((a) => !a)} />Annotate queries
            </label>
          </div>
        </div>
      </div>

      <div className="toolbar" style={{ marginTop: 4 }}>
        <span className="label">Queries</span>
        <div className="seg">
          {([['all', 'All'], ['total', 'Metric totals'], ['level', 'Level breakdowns']] as const).map(([k, label]) => (
            <button key={k} type="button" className={kind === k ? 'on' : ''} style={{ background: kind === k ? 'var(--dev)' : 'transparent' }}
              onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <input className="input search" placeholder="Search queries" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="hint" style={{ marginLeft: 'auto' }}>{chosen.length} of {queries.length} selected</span>
      </div>

      <div className="test-queries">
        <div className="table">
          <div className="tr th grid-tq">
            <input type="checkbox" checked={allVisibleOn} onChange={() => setVisible(!allVisibleOn)} disabled={!visible.length} />
            <span>Query</span><span>Type</span><span />
          </div>
          {visible.map((q) => (
            <Fragment key={q.id}>
              <div className={`tr grid-tq ${open === q.id ? 'sel' : ''}`} onClick={() => setOpen(open === q.id ? null : q.id)}>
                <input type="checkbox" checked={isPicked(q)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(q.id)} />
                <span className="name ellipsis" style={{ fontWeight: 500 }}>{q.name}</span>
                <span className="pill" style={{ background: q.kind === 'total' ? 'var(--off)' : 'rgba(42,165,199,.18)', color: q.kind === 'total' ? 'var(--ink-soft)' : 'var(--dev)' }}>
                  {q.kind === 'total' ? 'Total' : 'Level'}
                </span>
                <span className="hint">{open === q.id ? 'Hide' : 'Show'}</span>
              </div>
              {open === q.id && (
                <div className="test-qtext">
                  <div><span className="eyebrow">MDX</span><pre>{q.mdx}</pre></div>
                  <div><span className="eyebrow">SQL</span><pre>{q.sql}</pre></div>
                </div>
              )}
            </Fragment>
          ))}
          {!visible.length && <div className="empty">{genQ.isFetching ? 'Reading model…' : model ? 'No queries match' : 'Pick a deployed model'}</div>}
        </div>
      </div>
    </>
  )
}
