import { Fragment, useState } from 'react'
import { envOf, fmtDate } from '../components/ui'
import type { EnvId } from '../api'
import type { CompareResult, ModelDiff, ModelDiffSection, Variance, Verdict } from './api'

export const VERDICT: Record<Verdict, [string, string, string]> = {
  identical: ['Identical', 'var(--qa)', '#fff'],
  differs: ['Differs', 'var(--warn)', '#161616'],
  missing: ['Missing', 'var(--off)', 'var(--ink-soft)'],
  failedBaseline: ['Failed on baseline', 'var(--danger)', '#fff'],
  failedCandidate: ['Failed on candidate', 'var(--danger)', '#fff'],
  failedBoth: ['Failed on both', 'var(--danger)', '#fff'],
}

export function Pill({ label, bg, fg, title }: { label: string; bg: string; fg: string; title?: string }) {
  return <span className="pill" title={title} style={{ background: bg, color: fg }}>{label}</span>
}

export function VerdictPill({ v }: { v: Verdict }) {
  const [label, bg, fg] = VERDICT[v]
  return <Pill label={label} bg={bg} fg={fg} />
}

export const fmtPct = (p: number | null | undefined, digits = 1) =>
  p === null || p === undefined ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(digits)}%`
const fmtNum = (v: string | number | null | undefined) => {
  if (v === null || v === undefined || v === '') return '∅'
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v)
}

/** Env-coloured host label: "QA · qa-host-2". */
export function HostTag({ env, label }: { env?: string; label?: string }) {
  const e = envOf((env ?? 'dev') as EnvId)
  return <span className="mono"><span className="sq" style={{ background: e.color, marginRight: 6 }} />{e.label} · {label}</span>
}

/** Big pass/fail banner a tester reads first. */
export function VerdictBanner({ pass, title, detail }: { pass: boolean; title: string; detail: string }) {
  return (
    <div className={`verdict ${pass ? 'pass' : 'fail'}`}>
      <span className="verdict-mark">{pass ? '✓' : '✕'}</span>
      <div><div className="verdict-title">{title}</div><div className="verdict-detail">{detail}</div></div>
    </div>
  )
}

// -- model diff -------------------------------------------------------------------------------

type ModelRow = { name: string; state: 'same' | 'changed' | 'onlyA' | 'onlyB'; fields?: { field: string; a: unknown; b: unknown }[] }

function sectionRows(s: ModelDiffSection, all?: string[]): ModelRow[] {
  const changed = new Map(s.changed.map((c) => [c.name, c.fields]))
  const rows: ModelRow[] = [
    ...s.onlyA.map((name) => ({ name, state: 'onlyA' as const })),
    ...s.onlyB.map((name) => ({ name, state: 'onlyB' as const })),
    ...s.changed.map((c) => ({ name: c.name, state: 'changed' as const, fields: c.fields })),
  ]
  for (const name of all ?? []) if (!changed.has(name) && !s.onlyA.includes(name) && !s.onlyB.includes(name)) rows.push({ name, state: 'same' })
  return rows
}

const MODEL_STATE: Record<ModelRow['state'], [string, string, string]> = {
  onlyA: ['Only in baseline', 'var(--danger)', '#fff'],
  onlyB: ['Only in candidate', 'var(--dev)', '#fff'],
  changed: ['Changed', 'var(--warn)', '#161616'],
  same: ['Same', 'var(--off)', 'var(--ink-soft)'],
}

/** Metrics + levels, differences first; "Show matching" lists the rest. */
export function ModelDiffView({ diff, names }: { diff: ModelDiff; names?: { metrics: string[]; levels: string[] } }) {
  const [showSame, setShowSame] = useState(false)
  const sections = [
    { key: 'metrics' as const, label: 'Metrics', s: diff.metrics },
    { key: 'levels' as const, label: 'Levels (dimension | hierarchy | level)', s: diff.levels },
  ]
  return (
    <div className="model-diff">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hint">
          Metrics {diff.metrics.countA} → {diff.metrics.countB} · Levels {diff.levels.countA} → {diff.levels.countB}
        </span>
        {names && <label className="test-opt"><input type="checkbox" checked={showSame} onChange={() => setShowSame((v) => !v)} />Show matching objects</label>}
      </div>
      {sections.map(({ key, label, s }) => {
        const rows = sectionRows(s, showSame ? names?.[key] : undefined)
        const nDiff = s.onlyA.length + s.onlyB.length + s.changed.length
        return (
          <div key={key} className="table" style={{ marginTop: 10 }}>
            <div className="tr th grid-md"><span>{label}</span><span>{nDiff ? `${nDiff} difference${nDiff === 1 ? '' : 's'}` : 'No differences'}</span><span>Baseline</span><span>Candidate</span></div>
            {rows.map((r) => {
              const [l, bg, fg] = MODEL_STATE[r.state]
              const fields = r.fields ?? []
              return (
                <div key={`${r.state}:${r.name}`} className="tr grid-md" style={{ height: 'auto', minHeight: 40, padding: '8px 18px', cursor: 'default' }}>
                  <span className="mono ellipsis" title={r.name}>{r.name}</span>
                  <span><Pill label={l} bg={bg} fg={fg} /></span>
                  <span className="mono muted">{r.state === 'onlyB' ? '—' : fields.map((f) => <div key={f.field}>{f.field}: <b style={{ color: 'var(--ink)' }}>{String(f.a ?? '∅')}</b></div>)}{r.state === 'onlyA' && 'present'}{r.state === 'same' && 'same'}</span>
                  <span className="mono muted">{r.state === 'onlyA' ? '—' : fields.map((f) => <div key={f.field}>{f.field}: <b style={{ color: 'var(--warn)' }}>{String(f.b ?? '∅')}</b></div>)}{r.state === 'onlyB' && 'present'}{r.state === 'same' && 'same'}</span>
                </div>
              )
            })}
            {!rows.length && <div className="empty">Identical</div>}
          </div>
        )
      })}
    </div>
  )
}

// -- result variance --------------------------------------------------------------------------

export function VarianceView({ v }: { v: Variance }) {
  if (v.status === 'missing') return <div className="hint" style={{ padding: 8 }}>No stored result data on one side ({v.rowsA} vs {v.rowsB} rows).</div>
  return (
    <div className="variance">
      <div className="hint">
        {v.rowsA} baseline rows · {v.rowsB} candidate rows · {v.matchedRows} matched
        {v.diffRows ? ` · ${v.diffRows} with different values` : ''}
        {v.schemaDiffers ? ' · columns differ' : ''}
      </div>
      {v.schemaDiffers && (
        <div className="mono muted" style={{ marginTop: 6 }}>Baseline measures: {v.measuresA?.join(', ')}<br />Candidate measures: {v.measuresB?.join(', ')}</div>
      )}
      {!!v.diffs?.length && (
        <div className="table" style={{ marginTop: 8 }}>
          <div className="tr th grid-var"><span>Member / key</span><span>Measure</span><span>Baseline</span><span>Candidate</span><span>Δ</span><span>Δ %</span></div>
          {v.diffs.map((d, i) => (
            <div key={i} className="tr grid-var" style={{ height: 34, cursor: 'default' }}>
              <span className="mono ellipsis" title={d.label.join(' / ')}>{d.label.join(' / ') || '(total)'}</span>
              <span className="mono ellipsis">{d.measure}</span>
              <span className="mono num">{fmtNum(d.a)}</span>
              <span className="mono num" style={{ color: 'var(--warn)' }}>{fmtNum(d.b)}</span>
              <span className="mono num">{d.delta === null ? '≠' : fmtNum(d.delta)}</span>
              <span className="mono num" style={{ color: 'var(--warn)' }}>{fmtPct(d.pct, 3)}</span>
            </div>
          ))}
          {(v.diffRows ?? 0) > (v.diffs?.length ?? 0) && <div className="empty">First {v.diffs.length} differences shown</div>}
        </div>
      )}
      {!!v.onlyACount && <OnlyList label={`Only in baseline (${v.onlyACount})`} rows={v.onlyA ?? []} color="var(--danger)" />}
      {!!v.onlyBCount && <OnlyList label={`Only in candidate (${v.onlyBCount})`} rows={v.onlyB ?? []} color="var(--dev)" />}
    </div>
  )
}

function OnlyList({ label, rows, color }: { label: string; rows: string[][]; color: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      <span className="eyebrow" style={{ color }}>{label}</span>
      <div className="mono muted only-list">{rows.map((r, i) => <span key={i}>{r.join(' / ') || '(total)'}</span>)}</div>
    </div>
  )
}

// -- full comparison --------------------------------------------------------------------------

type QFilter = 'problems' | 'all'

/** Verdict, model check, then per-query results with variance on demand. */
export function ComparisonView({ c, onRecompare }: { c: CompareResult; onRecompare?: () => void }) {
  const [filter, setFilter] = useState<QFilter>('problems')
  const [open, setOpen] = useState<string | null>(null)
  const [showModel, setShowModel] = useState(false)
  const n = (v: Verdict) => c.counts[v] ?? 0
  const failed = n('failedBaseline') + n('failedCandidate') + n('failedBoth')
  const problems = c.queries.filter((q) => q.verdict !== 'identical')
  const list = filter === 'problems' ? problems : c.queries
  const modelOk = c.model?.identical
  const title = c.verdict === 'pass'
    ? `${c.candidate.label} matches ${c.baseline.label}`
    : `${c.candidate.label} does not match ${c.baseline.label}`
  const detail = [
    c.model ? (modelOk ? 'Model identical' : 'Model differs') : 'No model snapshot',
    `${n('identical')}/${c.total} queries identical`,
    n('differs') ? `${n('differs')} differ` : '',
    failed ? `${failed} failed` : '',
    n('missing') ? `${n('missing')} not run on both` : '',
    c.time.pct !== null ? `total time ${fmtPct(c.time.pct)}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="comparison">
      <VerdictBanner pass={c.verdict === 'pass'} title={title} detail={detail} />
      <div className="cmp-sides">
        {(['baseline', 'candidate'] as const).map((k) => (
          <div key={k} className="cmp-side">
            <span className="eyebrow">{k === 'baseline' ? 'Baseline' : 'Candidate'}</span>
            <HostTag env={c[k].env} label={c[k].label} />
            <span className="mono muted ellipsis">{c[k].cube} — {c[k].catalog}</span>
            <span className="mono muted">Run {c[k].runId} · {fmtDate(c[k].startedAt, true)}</span>
          </div>
        ))}
      </div>

      <div className="cmp-checks">
        <button type="button" className={`cmp-check ${modelOk ? 'ok' : 'bad'}`} onClick={() => setShowModel((v) => !v)} disabled={!c.model}>
          <span className="eyebrow">Model (DMV)</span>
          <span className="cmp-check-v">{!c.model ? 'Not captured' : modelOk ? 'Identical' : `${c.model.metrics.onlyA.length + c.model.metrics.onlyB.length + c.model.metrics.changed.length + c.model.levels.onlyA.length + c.model.levels.onlyB.length + c.model.levels.changed.length} differences`}</span>
          <span className="hint">{c.model ? `${c.model.metrics.countA} metrics · ${c.model.levels.countA} levels · ${showModel ? 'hide' : 'details'}` : ''}</span>
        </button>
        <div className={`cmp-check ${n('identical') === c.total ? 'ok' : 'bad'}`}>
          <span className="eyebrow">Results</span>
          <span className="cmp-check-v">{n('identical')}/{c.total} identical</span>
          <span className="hint">{[n('differs') && `${n('differs')} differ`, failed && `${failed} failed`, n('missing') && `${n('missing')} missing`].filter(Boolean).join(' · ') || 'Every value matches'}</span>
        </div>
        <div className={`cmp-check ${c.time.pct !== null && c.time.pct > 20 ? 'warn' : 'ok'}`}>
          <span className="eyebrow">Response time</span>
          <span className="cmp-check-v">{fmtPct(c.time.pct)}</span>
          <span className="hint">{(c.time.baselineMs / 1000).toFixed(1)} s → {(c.time.candidateMs / 1000).toFixed(1)} s over matched queries</span>
        </div>
      </div>
      {showModel && c.model && <ModelDiffView diff={c.model} />}

      <div className="toolbar" style={{ margin: '14px 0 8px' }}>
        <span className="label">Queries</span>
        <div className="seg">
          {([['problems', `Problems · ${problems.length}`], ['all', `All · ${c.queries.length}`]] as const).map(([k, label]) => (
            <button key={k} type="button" className={filter === k ? 'on' : ''} style={{ background: filter === k ? 'var(--dev)' : 'transparent' }} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <span className="hint">Tolerance {c.tolerance <= 1e-9 ? 'exact' : `${c.tolerance * 100}%`}</span>
        {onRecompare && <button type="button" className="btn xs ghost" style={{ marginLeft: 'auto' }} onClick={onRecompare}>Recompare</button>}
      </div>
      <div className="table">
        <div className="tr th grid-cmp"><span>Query</span><span>Lang</span><span>Baseline</span><span>Candidate</span><span>Time Δ</span><span>Max value Δ</span><span>Verdict</span></div>
        {list.map((q) => {
          const key = `${q.name}|${q.protocol}`
          const unit = q.protocol === 'mdx' ? 'cells' : 'rows'
          const cell = (o: typeof q.a) => !o ? <span className="hint">not run</span>
            : o.status === 'FAILED' ? <span className="mono" style={{ color: 'var(--danger)' }} title={o.error}>Failed</span>
            : <span className="mono">{o.rowCount} {unit} · {o.durationMs} ms</span>
          return (
            <Fragment key={key}>
              <div className={`tr grid-cmp ${open === key ? 'sel' : ''}`} style={{ height: 42 }} onClick={() => setOpen(open === key ? null : key)}>
                <span className="ellipsis" style={{ fontSize: 13 }} title={q.name}>{q.name}</span>
                <span className="mono muted">{q.protocol.toUpperCase()}</span>
                {cell(q.a)}
                {cell(q.b)}
                <span className="mono" style={{ color: (q.timePct ?? 0) > 20 ? 'var(--warn)' : undefined }}>{fmtPct(q.timePct)}</span>
                <span className="mono" style={{ color: q.variance?.maxPct ? 'var(--warn)' : undefined }}>{q.verdict === 'differs' ? (q.variance?.maxPct === null ? '≠' : fmtPct(q.variance?.maxPct, 3)) : '—'}</span>
                <VerdictPill v={q.verdict} />
              </div>
              {open === key && (
                <div className="test-qtext" style={{ display: 'block' }}>
                  {q.a?.error && <div><span className="eyebrow" style={{ color: 'var(--danger)' }}>Baseline error</span><pre>{q.a.error}</pre></div>}
                  {q.b?.error && <div><span className="eyebrow" style={{ color: 'var(--danger)' }}>Candidate error</span><pre>{q.b.error}</pre></div>}
                  {q.variance ? <VarianceView v={q.variance} /> : !q.a?.error && !q.b?.error && <span className="hint">Ran on one side only</span>}
                </div>
              )}
            </Fragment>
          )
        })}
        {!list.length && <div className="empty">{filter === 'problems' ? 'No problems - every query is identical' : 'No queries'}</div>}
      </div>
    </div>
  )
}

/** Diffs → CSV a tester can attach to a ticket. */
export function comparisonCsv(c: CompareResult): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [['query', 'protocol', 'verdict', 'member', 'measure', 'baseline', 'candidate', 'delta', 'delta_pct', 'baseline_ms', 'candidate_ms', 'error'].join(',')]
  for (const q of c.queries) {
    const base = [q.name, q.protocol, q.verdict]
    const tail = [q.a?.durationMs ?? '', q.b?.durationMs ?? '', q.a?.error || q.b?.error || '']
    const diffs = q.variance?.diffs ?? []
    if (!diffs.length) lines.push([...base, '', '', '', '', '', '', ...tail].map(esc).join(','))
    for (const d of diffs) lines.push([...base, d.label.join(' / '), d.measure, d.a, d.b, d.delta, d.pct, ...tail].map(esc).join(','))
  }
  return lines.join('\n') + '\n'
}

export function download(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
