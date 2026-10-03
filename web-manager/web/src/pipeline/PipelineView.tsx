import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { EnvId } from '../api'
import { useUi } from '../store'
import { envOf, errMsg, fmtDate, plural } from '../components/ui'
import {
  pipelineApi, waitPipelineJob,
  type ApiToken, type Board, type BoardModel, type Cell, type Gate, type GateK, type Orchestrator, type PipelineRun, type Policy, type Score, type Setup, type Verdict,
} from './api'
import './pipeline.css'

/** Verdict chips (PIPELINE_BUILD.md §7): background, text, label. */
const VS: Record<string, [string, string, string]> = {
  pass: ['#12A594', '#FFFFFF', 'Passed'],
  fail: ['#FF3B35', '#FFFFFF', 'Failed'],
  error: ['#FF3B35', '#FFFFFF', 'Error'],
  running: ['#2AA5C7', '#FFFFFF', 'Running'],
  none: ['#333333', '#CFCFCF', 'Not tested'],
  live: ['#0E0E0E', '#F07B29', 'Live'],
  wait: ['#F5A623', '#161616', 'Awaiting'],
  muted: ['rgba(255,255,255,.08)', 'rgba(255,255,255,.56)', '—'],
}
const GATE: Record<GateK, string> = {
  blank: 'transparent', na: 'transparent', merge: '#F5A623', sync: 'rgba(255,255,255,.30)',
  wait: '#2AA5C7', block: '#FF3B35', open: '#12A594',
}
const ORCH: Record<Orchestrator, [string, string]> = {
  gha: ['GitHub Actions', 'Workflows call the Env Manager API with a bearer token. Prod approval is a GitHub Environment with required reviewers.'],
  jenkins: ['Jenkins', 'A Jenkinsfile calls the envmgr CLI. Prod approval is an input step; credentials come from the Jenkins credential store.'],
  builtin: ['Built-in gate', 'No CI. Env Manager blocks a promotion unless the last test of that commit passed; you approve and deploy from the Board.'],
}

function Chip({ k, label }: { k: string; label?: string }) {
  const [bg, fg, l] = VS[k] ?? VS.none
  return <span className="pl-chip" style={{ background: bg, color: fg }}>{label ?? l}</span>
}

export function PipelineView() {
  const { pipelineSection, setPipelineSection } = useUi()
  const board = useQuery({ queryKey: ['pipeline', 'board'], queryFn: () => pipelineApi.board() })
  const orch = board.data?.orchestrator ?? 'gha'
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)
  const label = { board: 'Board', runs: 'Runs', setup: 'CI setup' }[pipelineSection]

  return (
    <div className="pl-col">
      <div className="pl-bar">
        <span className="eyebrow">Pipeline · {label}</span>
        <div className="row">
          <button type="button" className="pl-orch" onClick={() => setPipelineSection('setup')} title="CI setup">
            <span className="label">Orchestrator</span>
            <span className="v">{ORCH[orch][0]}</span>
          </button>
          {pipelineSection !== 'setup' && (
            <button type="button" className="btn ghost" disabled={refreshing} onClick={async () => {
              setRefreshing(true)
              try {
                await qc.fetchQuery({ queryKey: ['pipeline', 'board'], queryFn: () => pipelineApi.board(true), staleTime: 0 })
                await qc.invalidateQueries({ queryKey: ['pipeline', 'runs'] })
              } finally {
                setRefreshing(false)
              }
            }}>{refreshing ? 'Refreshing…' : '↻ Refresh'}</button>
          )}
        </div>
      </div>
      {pipelineSection === 'board' && <BoardSection q={board} />}
      {pipelineSection === 'runs' && <RunsSection />}
      {pipelineSection === 'setup' && <SetupSection />}
    </div>
  )
}

// -- Board ------------------------------------------------------------------------------------

/** The stage whose commit the panel acts on: the source of the first gate
 * that has something to do, else the furthest stage that runs the model. */
function focusEnv(b: Board, m: BoardModel): EnvId | null {
  const i = m.gates.findIndex((g) => ['open', 'block', 'wait', 'merge'].includes(g.k))
  if (i >= 0 && m.cells[i]) return b.stages[i].env
  for (let j = m.cells.length - 1; j >= 0; j--) if (m.cells[j]) return b.stages[j].env
  return null
}

function BoardSection({ q }: { q: ReturnType<typeof useQuery<Board>> }) {
  const { pipelinePick, setPipelinePick, flash } = useUi()
  const b = q.data
  const anyRunning = !!b?.models.some((m) => m.cells.some((c) => c?.test.verdict === 'running'))
  const qc = useQueryClient()
  // Poll while a test runs: the gate flips from Testing… to its verdict.
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ['pipeline'] }), 2500)
    return () => clearInterval(t)
  }, [anyRunning, qc])

  if (q.isLoading) return <div className="empty">Reading every host of this business unit…</div>
  if (q.isError) return <div className="notice err" style={{ margin: 24 }}><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(q.error)}</div>
  if (!b) return null
  if (b.stages.length < 2) {
    return (
      <div className="nohost">
        <span className="display" style={{ fontSize: 34 }}>A pipeline needs <em>two</em> groups.</span>
        <span className="muted" style={{ fontSize: 13 }}>
          Stages are this business unit's groups that have hosts - Dev → Prod, or Dev → Test → QA → Prod.
          {b.stages.length ? ` Only ${b.stages[0].label} has hosts.` : ' No group has hosts yet.'} Add hosts in Settings.
        </span>
      </div>
    )
  }
  const n = b.stages.length
  const cols = ['minmax(0,1.15fr)', ...b.stages.flatMap((_, i) => (i < n - 1 ? ['minmax(0,1fr)', '128px'] : ['minmax(0,1fr)']))].join(' ')
  const sel = b.models.find((m) => m.name === pipelinePick?.model) ?? b.models[0]
  const env = sel && (pipelinePick?.model === sel.name && pipelinePick.env ? pipelinePick.env : focusEnv(b, sel))
  const errs = Object.entries(b.hostErrors)

  return (
    <>
      {errs.length > 0 && (
        <div className="notice err" style={{ margin: '14px 24px 0' }}>
          <span className="eyebrow" style={{ color: 'var(--danger)' }}>Unreachable</span>
          {errs.map(([h, e]) => `${h}: ${e}`).join(' · ')}
        </div>
      )}
      <div className="pl-board-wrap">
        <div className="pl-board" style={{ minWidth: 260 + n * 230 }}>
          <div className="pl-row pl-head" style={{ gridTemplateColumns: cols }}>
            <span style={{ paddingLeft: 18 }}>Model</span>
            {b.stages.map((s, i) => [
              <span key={s.env} className="stg"><span className="sq" style={{ background: envOf(s.env).color }} />{s.label} · {s.trigger}</span>,
              i < n - 1 ? <span key={`g${i}`} style={{ textAlign: 'center' }}>{b.gates[i].kind === 'merge' ? 'Merge' : b.gates[i].final ? 'Approve' : 'Gate'}</span> : null,
            ])}
          </div>
          {b.models.map((m) => (
            <div key={m.name} className={`pl-row ${m === sel ? 'on' : ''}`} style={{ gridTemplateColumns: cols }}
              onClick={() => setPipelinePick({ model: m.name, env: null })}>
              <div className="pl-model"><span className="n">{m.name}</span><span className="c">{m.catalog ?? '—'}</span></div>
              {b.stages.map((s, i) => [
                <BoardCell key={s.env} cell={m.cells[i]} last={i === n - 1} picked={m === sel && env === s.env}
                  onPick={(e) => { e.stopPropagation(); setPipelinePick({ model: m.name, env: s.env }) }} />,
                i < n - 1 ? <GateCell key={`g${i}`} g={m.gates[i]} /> : null,
              ])}
            </div>
          ))}
          {!b.models.length && <div className="empty">No model is deployed on this business unit's hosts yet</div>}
        </div>
      </div>
      {sel && env && <CommitPath b={b} m={sel} env={env} onDone={(msg, ok) => flash(msg, ok ? 'ok' : 'err')} />}
    </>
  )
}

function BoardCell({ cell, last, picked, onPick }: { cell: Cell | null; last: boolean; picked: boolean; onPick: (e: React.MouseEvent) => void }) {
  if (!cell) return <div className="pl-cell"><span className="none">Not deployed</span></div>
  const k = last ? (cell.error ? 'fail' : 'live') : cell.test.verdict
  return (
    <div className={`pl-cell ${picked ? 'pick' : ''}`} onClick={onPick} title="Act on this stage's commit">
      <span className="ver"><span>{shortSha(cell)}</span><span className="muted">{cell.branch && cell.branch !== 'main' ? cell.branch : ''}</span></span>
      <span className="meta">
        <Chip k={k} label={last && cell.error ? 'Host error' : last && cell.test.verdict === 'running' ? 'Testing' : undefined} />
        <span className="host">{cell.hostLabel} · {fmtDate(cell.updated)}</span>
      </span>
      {cell.drift.length > 0 && <span className="drift" title={cell.drift.join(', ')}>≠ {cell.drift.join(', ')}</span>}
    </div>
  )
}

const shortSha = (c: Cell) => (c.commit && /^[0-9a-f]{12,}$/i.test(c.commit) ? c.commit.slice(0, 7) : c.version)

function GateCell({ g }: { g: Gate }) {
  const color = GATE[g.k]
  return (
    <div className="pl-gate" title={g.why?.length ? `A deploy takes the whole catalog: ${g.why.join('; ')}` : undefined}>
      <span className="arrow"><span className="l" style={{ background: color }} /><span className="h" style={{ borderLeftColor: color }} /></span>
      <span className="lbl" style={{ color: g.k === 'sync' ? 'var(--muted)' : color }}>{g.label}</span>
      <span className="sub">{g.sub}</span>
    </div>
  )
}

function CommitPath({ b, m, env, onDone }: { b: Board; m: BoardModel; env: EnvId; onDone: (msg: string, ok: boolean) => void }) {
  const { setAsk, setView, setSection, setSrc, setTgt, setPModel, setTestRunId, setTestSection } = useUi()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [liveOn, setLiveOn] = useState<string | null>(null) // model just promoted into the last stage
  const n = b.stages.length
  const i = Math.max(0, b.stages.findIndex((s) => s.env === env))
  const stage = b.stages[i]
  const cell = m.cells[i]
  const next = i < n - 1 ? b.stages[i + 1] : null
  const gate = i < n - 1 ? m.gates[i] : null
  const gkind = i < n - 1 ? b.gates[i] : null
  const last = b.stages[n - 1]
  const prodCell = m.cells[n - 1]
  const preCell = m.cells[n - 2]

  async function run(key: string, start: () => Promise<{ jobId: string }>, after?: (ok: boolean) => void) {
    setBusy(key)
    try {
      const { jobId } = await start()
      qc.invalidateQueries({ queryKey: ['pipeline'] })
      const j = await waitPipelineJob(jobId, () => qc.invalidateQueries({ queryKey: ['pipeline', 'board'] }))
      onDone(j.summary ?? (j.verdict ?? 'done'), j.verdict === 'pass')
      after?.(j.verdict === 'pass')
    } catch (e) {
      onDone(errMsg(e), false)
    } finally {
      setBusy(null)
      qc.invalidateQueries({ queryKey: ['pipeline'] })
    }
  }

  const testing = cell?.test.verdict === 'running' || busy === 'test'
  const canPromote = !!gate && !!gkind && (gkind.kind === 'merge' ? gate.k === 'merge' : gate.k === 'open')
  const promoteLabel = !next || !gate ? 'Promote'
    : gkind?.kind === 'merge' ? (gate.k === 'merge' ? `Deploy ${next.label}'s branch head to ${next.label}` : `${next.label} in sync`)
    : gate.k === 'open' ? `${gate.approval ? 'Approve · deploy' : 'Deploy'} ${cell ? shortSha(cell) : ''} to ${next.label}`
    : gate.k === 'sync' ? `${next.label} in sync` : gate.k === 'wait' ? 'Waiting on test' : `Promote to ${next.label} blocked`

  const promote = () => {
    if (!canPromote || !next || !cell) return
    const final = next.env === last.env
    setAsk({
      eyebrow: `${gate?.approval ? 'Approve · ' : ''}${next.label} deploy`,
      title: gkind?.kind === 'merge' ? `Deploy ${next.label}'s branch head.` : `Deploy ${shortSha(cell)} to ${next.label}.`,
      note: gkind?.kind === 'merge'
        ? `${m.name}: ${next.label} redeploys the head of the branch it runs, on ${next.hosts.map((h) => h.label).join(', ')}.`
        : `${m.name} ${shortSha(cell)} passed on ${stage.label}. The same commit deploys to ${next.hosts.map((h) => h.label).join(', ')} - `
          + `if its branch has moved since, the deploy is refused.${final ? ' System aggregates are not in Git: move them as a separate step.' : ''}`,
      label: `Deploy to ${next.label}`,
      tone: next.env === 'prod' ? 'prod' : undefined,
      go: () => {
        run('promote', () => pipelineApi.promote(next.env, m.name), (ok) => { if (ok && final) setLiveOn(m.name) })
      },
    })
  }

  const rollback = () => {
    if (!cell) return
    setAsk({
      eyebrow: `Rollback · ${stage.label}`,
      title: `Redeploy ${m.name}'s previous commit.`,
      note: `${m.name} on ${stage.label} goes back to the commit it ran before ${shortSha(cell)}, on every host that runs it. `
        + 'A model version is its Git commit - nothing is rebuilt, and aggregates are left as they are.',
      label: 'Rollback',
      tone: 'danger',
      go: () => { run('rollback', () => pipelineApi.rollback(stage.env, m.name)) },
    })
  }

  const moveAggs = () => {
    if (!preCell || !prodCell) return
    setView('promote')
    setSection('aggs')
    setSrc({ env: b.stages[n - 2].env, hostId: preCell.hostId })
    setTgt({ env: last.env, hostId: prodCell.hostId })
    setPModel(m.name)
  }

  const t: Score | undefined = cell?.test
  const facts: [string, string][] = !cell ? [['Status', `Not deployed on ${stage.label}`]]
    : !t || t.verdict === 'none' ? [['Status', 'No test for this commit yet']]
    : t.verdict === 'running' ? [['Status', 'Job running · polling'], ['Run', t.runRef ?? '—']]
    : t.error && !t.queries ? [['Status', t.error]]
    : [
      ['Matched', `${t.matched ?? 0}/${t.queries ?? 0}`],
      ['Max variance', `${t.unbounded ? '∞' : `${t.maxVariance ?? 0}%`} · limit ${t.limit}%`],
      ['Model diff', `${t.intended ?? 0} intended · ${t.unintended ?? 0} unintended${t.unclassified ? ' (Git diff unavailable)' : ''}`],
      ['Run', `${t.runRef ?? '—'} · ${fmtDate(t.at, true)}`],
    ]
  const base = t?.baseline
  const vs = base?.kind === 'stage' ? `vs ${base.label} ${base.version ?? ''}` : base?.kind === 'previous' ? `vs previous ${base.version ?? ''}` : base?.kind === 'none' ? 'no baseline yet' : ''
  const tColor = !t || t.verdict === 'none' ? 'var(--muted)' : VS[t.verdict]?.[0]
  const live = liveOn === m.name

  // Stage track: validate, one card per stage, rollback (handoff 01 … 06, stretched to the BU's stages).
  type Track = { n: string; name: string; trig: string; k: string; label?: string; run: string }
  const track: Track[] = [
    { n: '01', name: 'Commit', trig: 'push · validate', k: m.cells[0] ? 'pass' : 'none', label: m.cells[0] ? 'Validated in CI' : 'No commit', run: 'sml-cli' },
    ...b.stages.map((s, j): Track => {
      const c = m.cells[j]
      const g = j > 0 ? m.gates[j - 1] : null
      const base = { n: String(j + 2).padStart(2, '0'), name: s.label, trig: `${s.trigger} → ${s.label}`, run: c?.test.runRef ?? c?.hostLabel ?? '' }
      if (!c) return { ...base, k: 'none', label: g?.k === 'open' ? 'Ready to promote' : `Not on ${s.label}` }
      if (j === n - 1) return { ...base, k: c.error ? 'fail' : 'live', label: c.error ? `Error · ${c.error}` : 'Live' }
      if (g?.k === 'merge') return { ...base, k: 'wait', label: 'Pending merge' }
      return { ...base, k: c.test.verdict }
    }),
    { n: String(n + 2).padStart(2, '0'), name: 'Rollback', trig: 'manual · redeploy commit', k: 'muted', label: prodCell ? 'Previous commit' : '—', run: '' },
  ]
  const bar = (k: string) => (['none', 'muted', 'live'].includes(k) ? 'var(--hair)' : VS[k]?.[0])

  return (
    <section className="pl-path">
      <div className="pl-path-head">
        <div className="col" style={{ gap: 8, flex: '0 1 auto' }}>
          <span className="eyebrow" style={{ color: 'var(--dev)' }}>Commit path · {m.catalog ?? '—'} · acting on {stage.label}</span>
          <span className="display">{m.name}</span>
        </div>
        <div className="pl-actions">
          <button type="button" className="btn lg ghost" disabled={!cell || testing || !!busy} onClick={() => run('test', () => pipelineApi.test(stage.env, m.name))}
            title={`Generate queries from ${m.name} on ${stage.label}, run them there and on the baseline, compare`}>
            {testing ? 'Testing…' : `Run test on ${stage.label}`}
          </button>
          <button type="button" className="btn lg ghost" disabled={!cell || !!busy} onClick={rollback}>
            {busy === 'rollback' ? 'Rolling back…' : `Rollback ${stage.label}`}
          </button>
          {next && (
            <button type="button" className="btn lg solid" disabled={!canPromote || !!busy} onClick={promote}
              style={{ background: canPromote ? envOf(next.env).color : undefined }}>
              {busy === 'promote' ? 'Deploying…' : promoteLabel}
            </button>
          )}
        </div>
      </div>

      {gate?.why?.length ? (
        <div className="notice" style={{ margin: 0, borderTopColor: 'var(--danger)' }}>
          <span className="eyebrow" style={{ color: 'var(--danger)' }}>Same catalog</span>
          <span style={{ fontSize: 12.5 }}>
            A deploy takes {m.repoUrl?.split('/').pop() ?? 'the repo'}'s whole catalog, so these hold {m.name} on {stage.label}: {gate.why.join(' · ')}
          </span>
        </div>
      ) : null}

      <div className="pl-track" style={{ gridTemplateColumns: `repeat(${track.length}, minmax(0, 1fr))` }}>
        {track.map((s) => (
          <div key={s.n} className="pl-stage" style={{ borderTopColor: bar(s.k) }}>
            <span className="label">{s.n} — {s.name}</span>
            <span className="trig">{s.trig}</span>
            <Chip k={s.k} label={s.label} />
            <span className="run">{s.run}</span>
          </div>
        ))}
      </div>

      <div className="pl-facts">
        <span className="t" style={{ color: tColor }}>Test · {stage.label} {cell ? shortSha(cell) : ''} {vs}</span>
        {facts.map(([k, v]) => <span key={k} className="pl-fact"><span className="k">{k}</span><span className="v">{v}</span></span>)}
        {t?.validateRunId && t.verdict !== 'running' && (
          <button type="button" className="btn xs ghost" style={{ marginLeft: 'auto' }} title="Open the query run in Validate › Results"
            onClick={() => { setTestRunId(t.validateRunId!); setTestSection('results'); setView('test') }}>Queries ↗</button>
        )}
      </div>

      <div className={`pl-aggs ${live ? 'live' : ''}`}>
        <span className="label">Aggregates</span>
        <span className="note">
          {live ? `Commit is live on ${last.label}. System aggregates are runtime state, not Git - export them from ${b.stages[n - 2].label} and import to ${last.label} now.`
            : `System aggregates live on each host, not in Git. After a ${last.label} deploy, move them as their own step.`}
        </span>
        <button type="button" className="btn ghost" disabled={!preCell || !prodCell} onClick={moveAggs}>Move system aggregates →</button>
      </div>
    </section>
  )
}

// -- Runs -------------------------------------------------------------------------------------

function RunsSection() {
  const { setView, setTestRunId, setTestSection } = useUi()
  const q = useQuery({ queryKey: ['pipeline', 'runs'], queryFn: () => pipelineApi.runs() })
  const runs = q.data?.runs ?? []
  const running = runs.some((r) => r.status === 'running')
  const qc = useQueryClient()
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ['pipeline', 'runs'] }), 2500)
    return () => clearInterval(t)
  }, [running, qc])
  const dur = (s: number | null) => (s == null ? '—' : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`)

  return (
    <div className="scroll" style={{ paddingTop: 18 }}>
      {q.isError && <div className="notice err" style={{ margin: '0 0 12px' }}>{errMsg(q.error)}</div>}
      <div className="table">
        <div className="tr th grid-pl-runs">
          <span>Run</span><span>Stage</span><span>Model</span><span>Commit</span><span>Target</span><span>Verdict</span><span>Duration</span><span>Started</span>
        </div>
        {runs.map((r) => <RunRow key={r.id} r={r} dur={dur} onOpen={r.validateRunId ? () => { setTestRunId(r.validateRunId!); setTestSection('results'); setView('test') } : undefined} />)}
        {!runs.length && !q.isLoading && <div className="empty">No pipeline runs yet - CI reports them through the API, or run a step from the Board</div>}
      </div>
      <span className="hint" style={{ display: 'block', marginTop: 10 }}>Reported by CI through the Env Manager API · open a run for its logs, a test for its queries</span>
    </div>
  )
}

const ORCH_NAME: Record<string, string> = { gha: 'GitHub Actions', jenkins: 'Jenkins', builtin: 'Built-in gate', cli: 'envmgr CLI' }

function RunRow({ r, dur, onOpen }: { r: PipelineRun; dur: (s: number | null) => string; onOpen?: () => void }) {
  const v: Verdict = r.status === 'running' ? 'running' : (r.verdict ?? 'none')
  const env = r.env ? envOf(r.env) : null
  return (
    <div className="tr grid-pl-runs" style={{ cursor: onOpen ? 'pointer' : 'default' }} onClick={onOpen} title={r.error ?? undefined}>
      <span className="pl-run-ref">
        {r.url ? <a href={r.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="mono">{r.runRef} ↗</a> : <span className="mono">{r.runRef ?? '—'}</span>}
        <span className="o">{ORCH_NAME[r.orchestrator ?? ''] ?? r.orchestrator}</span>
      </span>
      <span className="ellipsis">{r.stage}</span>
      <span className="ellipsis">{r.model ?? '—'}</span>
      <span className="mono">{r.version ?? (r.commit ? r.commit.slice(0, 7) : '—')}</span>
      <span className="row" style={{ gap: 7 }}>{env && <span className="sq" style={{ background: env.color }} />}<span className="mono">{env?.label ?? '—'}</span></span>
      <span><Chip k={v} /></span>
      <span className="mono">{r.status === 'running' ? '…' : dur(r.durationS)}</span>
      <span className="mono muted">{fmtDate(r.startedAt, true)}</span>
    </div>
  )
}

// -- CI setup ---------------------------------------------------------------------------------

function SetupSection() {
  const { flash } = useUi()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['pipeline', 'setup'], queryFn: () => pipelineApi.setup() })
  const s = q.data
  const [tpl, setTpl] = useState<'gha' | 'jenkins'>('gha')
  useEffect(() => { if (s) setTpl(s.orchestrator === 'jenkins' ? 'jenkins' : 'gha') }, [s?.orchestrator]) // eslint-disable-line react-hooks/exhaustive-deps

  const put = useMutation({
    mutationFn: pipelineApi.putPolicy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pipeline'] }),
    onError: (e) => flash(errMsg(e), 'err'),
  })
  if (q.isError) return <div className="notice err" style={{ margin: 24 }}>{errMsg(q.error)}</div>
  if (!s) return <div className="empty">Loading…</div>

  const pol = s.policy
  const toggles: [keyof Policy, string, string][] = [
    ['requireTest', 'Require a passing test before a promotion', 'A promotion stays blocked until the commit passes on the stage before.'],
    ['approval', `Require manual approval for ${s.stages[s.stages.length - 1]?.label ?? 'Prod'}`,
      s.orchestrator === 'gha' ? 'Mapped to a GitHub Environment reviewer.' : s.orchestrator === 'jenkins' ? 'Mapped to a Jenkins input step.' : 'Approved here in Env Manager.'],
    ['intendedOnly', 'Model unchanged except intended edits', 'Any model change not declared in the commit\'s SML diff fails the test.'],
  ]
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.templates[tpl])
      flash(`${tpl === 'gha' ? 'GitHub Actions workflow' : 'Jenkinsfile'} copied`)
    } catch {
      flash('Copy failed - select the text instead', 'err')
    }
  }

  return (
    <div className="pl-setup">
      <div className="pl-hero">
        <span className="eyebrow" style={{ color: 'var(--prod)' }}>CI integration</span>
        <span className="display">Your CI runs the <em>pipeline</em>.</span>
        <span className="t">
          Env Manager exposes deploy, test and aggregate promotion as API calls and an <span className="mono">envmgr</span> CLI.
          GitHub Actions or Jenkins orchestrates, approves and audits. This business unit's stages:{' '}
          <b>{s.stages.map((x) => x.label).join(' → ') || 'none yet'}</b>.
        </span>
      </div>
      <div className="pl-grid">
        <div className="pl-stack">
          <div className="pl-card">
            <span className="eyebrow">Orchestrator</span>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              {(Object.keys(ORCH) as Orchestrator[]).map((k) => (
                <button key={k} type="button" className={s.orchestrator === k ? 'on' : ''} style={{ background: s.orchestrator === k ? 'var(--dev)' : undefined }}
                  onClick={() => put.mutate({ orchestrator: k })}>{ORCH[k][0]}</button>
              ))}
            </div>
            <span className="note">{ORCH[s.orchestrator][1]}</span>
          </div>

          <div className="pl-card">
            <span className="eyebrow">Gate policy</span>
            {toggles.map(([k, label, note]) => (
              <button key={k} type="button" className="pl-toggle" onClick={() => put.mutate({ policy: { [k]: !pol[k] } })}>
                <span className="lt"><b>{label}</b><span>{note}</span></span>
                <span className={`pl-switch ${pol[k] ? 'on' : ''}`}><i /></span>
              </button>
            ))}
            <div className="pl-toggle" style={{ cursor: 'default' }}>
              <span className="lt"><b>Result variance threshold</b><span>Environments point at different warehouses - values won't match exactly.</span></span>
              <VarianceInput value={pol.variance} onSave={(v) => put.mutate({ policy: { variance: v } })} />
            </div>
          </div>

          <Identities setup={s} onPattern={(p) => put.mutate({ serviceAccountPattern: p })} />
        </div>

        <div className="pl-stack">
          <div className="pl-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="eyebrow hl">Pipeline template</span>
              <div className="row" style={{ gap: 8 }}>
                <div className="seg">
                  {(['gha', 'jenkins'] as const).map((k) => (
                    <button key={k} type="button" className={tpl === k ? 'on' : ''} style={{ background: tpl === k ? 'var(--dev)' : undefined }}
                      onClick={() => setTpl(k)}>{k === 'gha' ? 'GitHub Actions' : 'Jenkinsfile'}</button>
                  ))}
                </div>
                <button type="button" className="btn ghost" onClick={copy}>Copy</button>
              </div>
            </div>
            <span className="note">
              Generated for {s.stages.map((x) => x.label).join(' → ')}. {tpl === 'gha'
                ? <>Set the repository variable <span className="mono">ENVMGR_URL</span> to <span className="mono">{s.url}</span> and the secret <span className="mono">ENVMGR_TOKEN</span> to an API token below.</>
                : <>Store an API token below as the Jenkins credential <span className="mono">envmgr-token</span>.</>}
            </span>
            <pre className="pl-pre">{s.templates[tpl]}</pre>
            <span className="label">envmgr CLI · exit code = verdict (0 pass · 1 fail · 2 error)</span>
            <div className="pl-cli">
              <span><span className="p">$ </span>curl -fsSL {s.url}/api/pipeline/cli -o envmgr && chmod +x envmgr</span>
              {s.cli.map((c) => <span key={c}><span className="p">$ </span>{c}</span>)}
            </div>
          </div>
          <Tokens />
        </div>
      </div>
    </div>
  )
}

function VarianceInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const n = parseFloat(v)
    if (!Number.isNaN(n) && n >= 0 && n !== value) onSave(n)
    else setV(String(value))
  }
  return (
    <span className="pl-num">
      <input className="input" type="number" step="0.5" min="0" value={v} onChange={(e) => setV(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
      <span className="mono muted">%</span>
    </span>
  )
}

function Identities({ setup, onPattern }: { setup: Setup; onPattern: (p: string) => void }) {
  const [pat, setPat] = useState(setup.serviceAccountPattern)
  useEffect(() => setPat(setup.serviceAccountPattern), [setup.serviceAccountPattern])
  return (
    <div className="pl-card">
      <span className="eyebrow">Deploy identities</span>
      <span className="note">
        Deploy signs in to Design Center with a Keycloak username and password, so each host needs one - a service account,
        not a person. SSO-only accounts can't deploy.
      </span>
      <div>
        {setup.identities.map((h) => (
          <div key={h.hostId} className="pl-ident">
            <span className="sq" style={{ background: envOf(h.env).color }} />
            <span className="ellipsis">{h.label}</span>
            <span className="mono ellipsis">{h.username || '—'}{h.username && !h.hasPassword ? ' · no password' : ''}</span>
            {h.serviceAccount
              ? <Chip k="pass" label="Service account" />
              : <Chip k="wait" label="Check · may be SSO" />}
          </div>
        ))}
      </div>
      <label className="row" style={{ gap: 8 }}>
        <span className="label" style={{ whiteSpace: 'nowrap' }}>Service account pattern</span>
        <input className="input" style={{ flex: 1 }} value={pat} onChange={(e) => setPat(e.target.value)}
          onBlur={() => { if (pat !== setup.serviceAccountPattern) onPattern(pat) }} title="A regular expression a service account's username matches" />
      </label>
    </div>
  )
}

function Tokens() {
  const { flash, setAsk } = useUi()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['pipeline', 'tokens'], queryFn: () => pipelineApi.tokens() })
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<string[]>(['deploy', 'test', 'promote'])
  const [fresh, setFresh] = useState<string | null>(null)
  const scopes = q.data?.scopes ?? ['deploy', 'test', 'promote', 'monitor']

  const create = useMutation({
    mutationFn: () => pipelineApi.createToken(name, scope),
    onSuccess: (t) => {
      setFresh(t.token)
      setOpen(false)
      setName('')
      qc.invalidateQueries({ queryKey: ['pipeline', 'tokens'] })
    },
    onError: (e) => flash(errMsg(e), 'err'),
  })
  const revoke = (t: ApiToken) => setAsk({
    eyebrow: 'Revoke API token', title: `Revoke ${t.name}.`, label: 'Revoke', tone: 'danger',
    note: 'CI jobs using this token start failing with 401 at their next call. This can\'t be undone - generate a new token instead.',
    go: async () => {
      try {
        await pipelineApi.revokeToken(t.id)
        flash(`${t.name} revoked`)
      } catch (e) {
        flash(errMsg(e), 'err')
      }
      qc.invalidateQueries({ queryKey: ['pipeline', 'tokens'] })
    },
  })
  const tokens = useMemo(() => q.data?.tokens ?? [], [q.data])

  return (
    <div className="pl-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="col" style={{ gap: 4 }}>
          <span className="eyebrow">API tokens</span>
          <span className="note">Bearer tokens for CI runners, for this business unit only. Shown once - store it as a pipeline secret.</span>
        </div>
        <button type="button" className="btn ghost" onClick={() => setOpen((o) => !o)}>+ Generate token</button>
      </div>
      {open && (
        <div className="col" style={{ gap: 10, padding: '10px 0', borderTop: '1px solid var(--row-line)' }}>
          <input className="input" placeholder="Name, e.g. github-actions-corp" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <div className="pl-scopes">
            {scopes.map((sc) => (
              <label key={sc}>
                <input type="checkbox" checked={scope.includes(sc)} onChange={(e) => setScope((cur) => e.target.checked ? [...cur, sc] : cur.filter((x) => x !== sc))} />
                {sc}
              </label>
            ))}
            <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} disabled={!name.trim() || !scope.length || create.isPending}
              onClick={() => create.mutate()}>{create.isPending ? 'Generating…' : 'Generate'}</button>
          </div>
        </div>
      )}
      {fresh && (
        <div className="pl-newtok">
          <span className="label" style={{ color: 'var(--qa)' }}>Copy now</span>
          <span className="mono">{fresh}</span>
          <button type="button" className="btn xs ghost" onClick={async () => {
            try { await navigator.clipboard.writeText(fresh); flash('Token copied') } catch { flash('Copy failed - select the text instead', 'err') }
          }}>Copy</button>
          <button type="button" className="btn xs ghost" onClick={() => setFresh(null)}>Done</button>
        </div>
      )}
      <div>
        {tokens.map((t) => (
          <div key={t.id} className="pl-tok">
            <span className="col" style={{ gap: 2, minWidth: 0 }}><span className="ellipsis" style={{ fontWeight: 600 }}>{t.name}</span><span className="mono muted">{t.prefix}</span></span>
            <span className="mono">{t.scope.join(' · ')}</span>
            <span className="mono muted">{t.lastUsed ? `Used ${fmtDate(t.lastUsed, true)}` : 'Never used'}</span>
            <button type="button" className="btn xs danger" onClick={() => revoke(t)}>Revoke</button>
          </div>
        ))}
        {!tokens.length && <div className="hint" style={{ padding: '8px 0' }}>No tokens yet</div>}
      </div>
      <span className="hint">{plural(tokens.length, 'token')}</span>
    </div>
  )
}
