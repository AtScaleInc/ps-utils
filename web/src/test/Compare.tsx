import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { EnvSegment, HostSelect, RefreshButton, errMsg, fmtDate, useHosts } from '../components/ui'
import type { EnvId } from '../api'
import { resolveHost, useUi, type RunSide } from '../store'
import { testApi, type CubeRef, type TestRun } from './api'
import { useRunGroups } from './Results'
import { ComparisonView, ModelDiffView, VerdictBanner, comparisonCsv, download, loadedAt, refreshTest, reloadIfOld, useTestCubes } from './shared'

const TOLERANCES: [number, string][] = [[1e-9, 'Exact'], [1e-6, '0.0001%'], [1e-4, '0.01%'], [1e-2, '1%']]

/** Baseline vs candidate results: any two (run, host) pairs - Dev vs QA in one
 * run, or the same host before / after a redeploy. */
export function CompareSection() {
  const { testCompare, setTestCompare } = useUi()
  const runsQ = useRunGroups()
  const { groups } = runsQ
  const runs = groups.flatMap(([, rs]) => rs)
  const qc = useQueryClient()
  const [tolerance, setTolerance] = useState(1e-9)

  // Default: the newest multi-host run, first host vs second.
  useEffect(() => {
    if (testCompare.baseline || !runs.length) return
    const multi = runs.find((r) => r.targets.length > 1 && r.status === 'done') ?? runs[0]
    setTestCompare({
      baseline: { runId: multi.runId, hostId: multi.targets[0].hostId },
      candidate: { runId: multi.runId, hostId: (multi.targets[1] ?? multi.targets[0]).hostId },
    })
  }, [runs, testCompare.baseline, setTestCompare])

  const { baseline, candidate } = testCompare
  const ready = !!baseline && !!candidate
  const q = useQuery({
    queryKey: ['testCompare', baseline?.runId, baseline?.hostId, candidate?.runId, candidate?.hostId, tolerance],
    queryFn: () => testApi.compare(baseline!, candidate!, tolerance),
    enabled: ready, staleTime: 0,
  })

  return (
    <div className="col test-col">
      <div className="bar">
        <div className="row"><span className="eyebrow">Compare results</span><span className="hint">Values matched per member and measure</span></div>
        <RefreshButton cachedAt={loadedAt(runsQ.dataUpdatedAt)} cachedFor="30 s" onRefresh={() => refreshTest(qc)} />
      </div>
      <div className="cmp-pickers">
        <RunSidePicker label="Baseline" hint="What's known good - usually the lower env" groups={groups} value={baseline} onChange={(v) => setTestCompare({ baseline: v })} onOpen={reloadIfOld(runsQ)} />
        <span className="cmp-vs">vs</span>
        <RunSidePicker label="Candidate" hint="What you want to promote / verify" groups={groups} value={candidate} onChange={(v) => setTestCompare({ candidate: v })} onOpen={reloadIfOld(runsQ)} />
        <div className="cmp-picker" style={{ flex: '0 0 auto' }}>
          <span className="eyebrow">Tolerance</span>
          <select className="select" value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
            {TOLERANCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className="btn ghost" disabled={!q.data} onClick={() => q.data && download(`compare_${q.data.baseline.label}_${q.data.candidate.label}.csv`, comparisonCsv(q.data))}>Export CSV</button>
        </div>
      </div>
      <div style={{ margin: '0 24px 24px' }}>
        {!ready && <div className="empty">{runs.length ? 'Pick a baseline and a candidate' : 'No runs yet - start one from Run'}</div>}
        {q.isFetching && !q.data && <div className="empty">Comparing…</div>}
        {q.isError && <div className="notice err" style={{ margin: 0 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(q.error)}</div>}
        {q.data && <ComparisonView c={q.data} onRecompare={() => q.refetch()} />}
      </div>
    </div>
  )
}

function RunSidePicker({ label, hint, groups, value, onChange, onOpen }: {
  label: string; hint: string; groups: [string, TestRun[]][]; value: RunSide | null; onChange: (v: RunSide) => void
  /** Opening a picker reloads the run list when it's old (a run finished elsewhere). */
  onOpen: () => void
}) {
  const runs = groups.flatMap(([, rs]) => rs)
  const run = runs.find((r) => r.runId === value?.runId)
  const model = run?.model ?? groups[0]?.[0] ?? ''
  const modelRuns = groups.find(([m]) => m === model)?.[1] ?? []
  return (
    <div className="cmp-picker">
      <span className="eyebrow">{label}</span>
      <span className="hint">{hint}</span>
      <select className="select" value={model} onMouseDown={onOpen} onFocus={onOpen} onChange={(e) => {
        const r = groups.find(([m]) => m === e.target.value)?.[1][0]
        if (r) onChange({ runId: r.runId, hostId: r.targets[0].hostId })
      }}>
        {groups.map(([m, rs]) => <option key={m} value={m}>{m} · {rs.length} run{rs.length === 1 ? '' : 's'}</option>)}
      </select>
      <select className="select" value={value?.runId ?? ''} onMouseDown={onOpen} onFocus={onOpen} onChange={(e) => {
        const r = modelRuns.find((x) => x.runId === e.target.value)
        if (r) onChange({ runId: r.runId, hostId: r.targets.find((t) => t.hostId === value?.hostId)?.hostId ?? r.targets[0].hostId })
      }}>
        {modelRuns.map((r) => <option key={r.runId} value={r.runId}>{fmtDate(r.startedAt, true)} · {r.targets.map((t) => t.label ?? t.hostId).join(', ')}</option>)}
      </select>
      <select className="select" value={value?.hostId ?? ''} onChange={(e) => run && onChange({ runId: run.runId, hostId: e.target.value })}>
        {(run?.targets ?? []).map((t) => <option key={t.hostId} value={t.hostId}>{t.label ?? t.hostId} ({t.env})</option>)}
      </select>
    </div>
  )
}

// -- model compare --------------------------------------------------------------------------

type Side = { env: EnvId; hostId: string | null; key: string }
const cubeKey = (c: CubeRef) => `${c.catalog}|${c.cube}`

/** Live DMV diff of two deployed models (ps-utils extract-model-from-atscale). */
export function ModelCompareSection() {
  const hosts = useHosts().data?.hosts ?? []
  const [a, setA] = useState<Side>({ env: 'dev', hostId: null, key: '' })
  const [b, setB] = useState<Side>({ env: 'qa', hostId: null, key: '' })
  const ha = resolveHost(hosts, a)
  const hb = resolveHost(hosts, b)
  const ca = useTestCubes(ha?.id)
  const cb = useTestCubes(hb?.id)
  const qc = useQueryClient()
  const refA = ca.data?.cubes.find((c) => cubeKey(c) === a.key) ?? ca.data?.cubes[0]
  // Candidate defaults to the baseline's cube name when the host has it.
  const refB = cb.data?.cubes.find((c) => cubeKey(c) === b.key) ?? cb.data?.cubes.find((c) => c.cube === refA?.cube) ?? cb.data?.cubes[0]
  const m = useMutation({ mutationFn: () => testApi.modelCompare({ hostId: ha!.id, ...refA! }, { hostId: hb!.id, ...refB! }) })

  const names = m.data && {
    metrics: [...new Set([...Object.keys(m.data.baseline.snapshot.metrics), ...Object.keys(m.data.candidate.snapshot.metrics)])].sort(),
    levels: [...new Set([...Object.keys(m.data.baseline.snapshot.levels), ...Object.keys(m.data.candidate.snapshot.levels)])].sort(),
  }
  const d = m.data?.diff
  const nDiff = d ? d.metrics.onlyA.length + d.metrics.onlyB.length + d.metrics.changed.length + d.levels.onlyA.length + d.levels.onlyB.length + d.levels.changed.length : 0

  const picker = (label: string, side: Side, set: (s: Side) => void, host: typeof ha, q: typeof ca, ref: CubeRef | undefined) => {
    const cubes = q.data?.cubes
    return (
    <div className="cmp-picker">
      <span className="eyebrow">{label}</span>
      <div className="row"><EnvSegment value={side.env} onPick={(e) => set({ env: e, hostId: null, key: '' })} /></div>
      <HostSelect hosts={hosts} env={side.env} value={host?.id ?? null} onChange={(id) => set({ ...side, hostId: id, key: '' })} />
      <select className="select" value={ref ? cubeKey(ref) : ''} disabled={!cubes?.length && !q.isFetching}
        onMouseDown={reloadIfOld(q)} onFocus={reloadIfOld(q)} onChange={(e) => set({ ...side, key: e.target.value })}>
        {!cubes?.length && <option value="">{q.isFetching ? 'Loading models…' : q.isError ? 'Could not list models' : 'No deployed models'}</option>}
        {cubes?.map((c) => <option key={cubeKey(c)} value={cubeKey(c)}>{c.cube} — {c.catalog}</option>)}
      </select>
    </div>
    )
  }

  return (
    <div className="col test-col">
      <div className="bar">
        <div className="row"><span className="eyebrow">Compare model</span><span className="hint">Metrics and levels from the DMV (MDSCHEMA_MEASURES / MDSCHEMA_LEVELS), live</span></div>
        <RefreshButton cachedAt={loadedAt(ca.dataUpdatedAt, cb.dataUpdatedAt)} cachedFor="30 s" onRefresh={() => refreshTest(qc)} />
      </div>
      <div className="cmp-pickers">
        {picker('Baseline', a, setA, ha, ca, refA)}
        <span className="cmp-vs">vs</span>
        {picker('Candidate', b, setB, hb, cb, refB)}
        <div className="cmp-picker" style={{ flex: '0 0 auto', justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary lg" disabled={!refA || !refB || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? 'Reading both models…' : 'Compare'}
          </button>
        </div>
      </div>
      <div style={{ margin: '0 24px 24px' }}>
        {m.isError && <div className="notice err" style={{ margin: 0 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(m.error)}</div>}
        {d && names && (
          <>
            <VerdictBanner pass={d.identical}
              title={d.identical ? 'Models are identical' : `${nDiff} difference${nDiff === 1 ? '' : 's'} between the models`}
              detail={`${hb?.label} ${refB?.cube} vs ${ha?.label} ${refA?.cube} · ${d.metrics.same + d.metrics.changed.length} shared metrics · ${d.levels.same + d.levels.changed.length} shared levels`} />
            <ModelDiffView diff={d} names={names} />
          </>
        )}
        {!d && !m.isPending && !m.isError && <div className="empty">Pick two deployed models and compare</div>}
      </div>
    </div>
  )
}
