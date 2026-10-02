import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EnvSegment, HostSelect, errMsg, plural, useHosts } from '../components/ui'
import { resolveHost, useUi, type MonitorRange } from '../store'
import { hitRate, monitorApi, rangeMs, type Hits, type MonitorStatus, type QueryClass } from './api'
import { Donut, LineChart, MixBars, StackedBars, fmtMs, fmtN, fmtStamp, pct } from './charts'
import { QueryDrawer } from './QueryDrawer'
import { AUTO_POLL_MS, CLS, CLS_KEYS, ClsPill, HIT_COLOR, P95_COLOR, StatusText, TYPE_COLOR, fmtRate } from './shared'
import './monitor.css'

const PRESETS: { id: Exclude<MonitorRange['preset'], 'custom'>; label: string }[] = [
  { id: '1h', label: '1h' }, { id: '24h', label: '24h' }, { id: '2d', label: '2d' }, { id: '7d', label: '7d' }, { id: '30d', label: '30d' },
]

const toLocal = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3)
  return d.toISOString().slice(0, 16)
}
const fromLocal = (v: string) => new Date(v).getTime()

function ago(ms: number, now: number) {
  const m = Math.max(0, Math.floor((now - ms) / 60e3))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m ago`
  return `${Math.floor(m / 1440)}d ago`
}

/** Monitor: a host's AtScale query history (/wapi/p/queries), pulled into
 * workspace/monitor.db on demand or every 5 minutes, and reported on. */
export function MonitorView() {
  const { monitor, setMonitor, monitorSection, monitorRange, setMonitorRange, monitorFilters: f, setMonitorFilters,
    monitorAuto, setMonitorAuto, flash } = useUi()
  const hosts = useHosts().data?.hosts ?? []
  const host = resolveHost(hosts, monitor)
  const qc = useQueryClient()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30e3); return () => clearInterval(t) }, [])
  const range = useMemo(() => rangeMs(monitorRange, now), [monitorRange, now])

  const statusQ = useQuery({ queryKey: ['monitorStatus', host?.id], queryFn: () => monitorApi.status(host!.id), enabled: !!host })
  const st = statusQ.data
  const [polling, setPolling] = useState<'poll' | 'range' | null>(null)
  const busy = useRef(false)
  const [bundling, setBundling] = useState(false)

  async function downloadBundle() {
    if (!host) return
    setBundling(true)
    try {
      const { blob, filename } = await monitorApi.psBundle(host.id)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      flash(errMsg(e), 'err')
    } finally {
      setBundling(false)
    }
  }

  async function poll(kind: 'poll' | 'range', quiet = false) {
    if (!host || busy.current) return
    busy.current = true
    setPolling(kind)
    try {
      const r = await monitorApi.poll(host.id, kind === 'range' ? range : undefined)
      qc.invalidateQueries({ queryKey: ['monitor', host.id] })
      qc.invalidateQueries({ queryKey: ['monitorStatus', host.id] })
      if (r.truncated) flash(`Pulled ${fmtN(r.fetched)} queries - stopped at the page cap, the oldest part of the window is missing`, 'warn')
      else if (!quiet) flash(`${fmtN(r.added)} new ${r.added === 1 ? 'query' : 'queries'} from ${host.label}`)
    } catch (e) {
      flash(errMsg(e), 'err')
      qc.invalidateQueries({ queryKey: ['monitorStatus', host.id] })
    } finally {
      busy.current = false
      setPolling(null)
    }
  }

  // A host never polled: pull the default window once, so the tab isn't empty.
  const firstPolled = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (host && st && !st.lastPoll && !st.pollJob && !firstPolled.current.has(host.id)) {
      firstPolled.current.add(host.id)
      poll('poll', true)
    }
  }, [host?.id, st]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-poll: every 5 minutes while the tab is open and the box is ticked.
  const [lastAuto, setLastAuto] = useState(Date.now())
  useEffect(() => {
    if (!monitorAuto || !host) return
    const mark = () => { const t0 = Date.now(); setLastAuto(t0); setNow(t0) }
    mark()
    const t = setInterval(() => { mark(); poll('poll', true) }, AUTO_POLL_MS)
    return () => clearInterval(t)
  }, [monitorAuto, host?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const nextIn = Math.max(0, Math.ceil((lastAuto + AUTO_POLL_MS - now) / 60e3))

  const lists = useQuery({
    queryKey: ['monitor', host?.id, 'lists', range.fromMs, range.toMs],
    queryFn: () => monitorApi.overview(host!.id, range, { model: '', user: '', queryType: '' }),
    enabled: !!host, placeholderData: keepPreviousData,
  })

  if (!host) return <div className="nohost"><div className="flag" /><span className="display" style={{ fontSize: 28 }}>No hosts in this business unit</span><span className="muted">Add one in Settings › Hosts &amp; Git.</span></div>

  return (
    <div className="col monitor">
      <div className="bar">
        <div className="row">
          <EnvSegment value={monitor.env} onPick={(e) => setMonitor({ env: e, hostId: null })} />
          <HostSelect hosts={hosts} env={monitor.env} value={host.id} onChange={(id) => setMonitor({ env: monitor.env, hostId: id })} />
        </div>
        <div className="row">
          <PollStatus st={st} now={now} polling={polling} error={statusQ.error} />
          <label className="test-opt" title="Pull new queries every 5 minutes while this tab is open">
            <input type="checkbox" checked={monitorAuto} onChange={(e) => setMonitorAuto(e.target.checked)} />
            Auto-poll every 5 min{monitorAuto && <span className="hint" style={{ marginLeft: 4 }}>next in {nextIn}m</span>}
          </label>
          <button type="button" className="btn primary" disabled={!!polling} onClick={() => poll('poll')}
            title="Pull the queries AtScale ran since the last poll">
            {polling === 'poll' ? 'Polling…' : 'Poll now'}
          </button>
          <button type="button" className="btn" disabled={bundling} onClick={downloadBundle}
            title="Download a support bundle without logs: settings, system info, hosts, metadata, plus each deployed model's SML and aggregates">
            {bundling ? 'Collecting…' : 'PS bundle'}
          </button>
        </div>
      </div>

      <div className="toolbar mon-filters">
        <span className="label">Range</span>
        <div className="seg">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={monitorRange.preset === p.id ? 'on' : ''}
              style={{ background: monitorRange.preset === p.id ? 'var(--dev)' : 'transparent' }} onClick={() => setMonitorRange({ preset: p.id })}>{p.label}</button>
          ))}
          <button type="button" className={monitorRange.preset === 'custom' ? 'on' : ''}
            style={{ background: monitorRange.preset === 'custom' ? 'var(--dev)' : 'transparent' }}
            onClick={() => setMonitorRange({ preset: 'custom', fromMs: range.fromMs, toMs: range.toMs })}>Custom</button>
        </div>
        {monitorRange.preset === 'custom' && (
          <>
            <input type="datetime-local" className="input dt" value={toLocal(monitorRange.fromMs)} max={toLocal(monitorRange.toMs)}
              onChange={(e) => e.target.value && setMonitorRange({ ...monitorRange, fromMs: fromLocal(e.target.value) })} />
            <span className="muted">→</span>
            <input type="datetime-local" className="input dt" value={toLocal(monitorRange.toMs)} min={toLocal(monitorRange.fromMs)}
              onChange={(e) => e.target.value && setMonitorRange({ ...monitorRange, toMs: fromLocal(e.target.value) })} />
          </>
        )}
        <button type="button" className="btn xs info" disabled={!!polling} onClick={() => poll('range')}
          title="Backfill: pull every query AtScale kept for this range (stored queries are refreshed, not duplicated)">
          {polling === 'range' ? 'Pulling…' : 'Pull this range'}
        </button>
        <span className="vsep" />
        <span className="label">Type</span>
        <div className="seg">
          {(['', 'User', 'System'] as const).map((t) => (
            <button key={t || 'all'} type="button" className={f.queryType === t ? 'on' : ''}
              style={{ background: f.queryType === t ? 'var(--dev)' : 'transparent' }} onClick={() => setMonitorFilters({ queryType: t })}>{t || 'All'}</button>
          ))}
        </div>
        <select className="select mon-sel" value={f.model} onChange={(e) => setMonitorFilters({ model: e.target.value })}>
          <option value="">All models</option>
          {(lists.data?.models ?? []).map((m) => <option key={m} value={m}>{m === NONE ? '(no model)' : m}</option>)}
          {f.model && !(lists.data?.models ?? []).includes(f.model) && <option value={f.model}>{filterLabel(f.model)}</option>}
        </select>
        <select className="select mon-sel" value={f.user} onChange={(e) => setMonitorFilters({ user: e.target.value })}>
          <option value="">All users</option>
          {(lists.data?.users ?? []).map((u) => <option key={u} value={u}>{u === NONE ? '(no user)' : u}</option>)}
          {f.user && !(lists.data?.users ?? []).includes(f.user) && <option value={f.user}>{filterLabel(f.user)}</option>}
        </select>
      </div>

      {st?.lastPoll?.error && <div className="notice err"><span className="eyebrow" style={{ color: 'var(--danger)' }}>Last poll failed</span>{st.lastPoll.error}</div>}

      <ActiveFilters />
      <div className="mon-scroll">
        {monitorSection === 'overview' && <OverviewSection hostId={host.id} range={range} />}
        {monitorSection === 'history' && <HistorySection hostId={host.id} range={range} />}
        {monitorSection === 'hotspots' && <HotspotsSection hostId={host.id} range={range} />}
      </div>
    </div>
  )
}

const NONE = '(none)'
const filterLabel = (v: string) => (v === NONE ? '(no model / user)' : v)

/** Model / user / type filters apply to every Monitor section - say so, with one way out. */
function ActiveFilters() {
  const { monitorFilters: f, setMonitorFilters } = useUi()
  const on = ([['Model', f.model === NONE ? 'no model' : f.model], ['User', f.user === NONE ? 'no user' : f.user], ['Type', f.queryType]] as const)
    .filter(([, v]) => v)
  if (!on.length) return null
  return (
    <div className="mon-active">
      <span className="label">Filtered by</span>
      {on.map(([k, v]) => <span key={k} className="chip">{k}: <b>{v}</b></span>)}
      <span className="hint">applies to Overview, History and Hotspots</span>
      <button type="button" className="btn xs info" onClick={() => setMonitorFilters({ model: '', user: '', queryType: '' })}>Clear filters</button>
    </div>
  )
}

/** Empty result: filters (tab-wide or this list's own) are the usual reason, the stored range the other. */
function NoMatch({ what, local, onClearLocal }: { what: string; local?: boolean; onClearLocal?: () => void }) {
  const { monitorFilters: f, setMonitorFilters } = useUi()
  const filtered = !!(f.model || f.user || f.queryType)
  return (
    <div className="empty mon-nomatch">
      <span>{what}{filtered || local ? ' with these filters' : ' stored for this range - Poll now, or Pull this range to backfill it'}.</span>
      {local && onClearLocal && <button type="button" className="btn xs" onClick={onClearLocal}>Clear list filters</button>}
      {filtered && <button type="button" className="btn xs info" onClick={() => setMonitorFilters({ model: '', user: '', queryType: '' })}>Clear filters</button>}
    </div>
  )
}

function PollStatus({ st, now, polling, error }: { st?: MonitorStatus; now: number; polling: string | null; error: unknown }) {
  if (error) return <span className="err-text">{errMsg(error)}</span>
  if (!st) return <span className="hint">…</span>
  const lp = st.lastPoll
  return (
    <span className="hint" title={st.oldestMs ? `Stored: ${fmtStamp(st.oldestMs)} → ${fmtStamp(st.newestMs!)}` : undefined}>
      {fmtN(st.stored)} stored
      {lp && <> · polled {ago(lp.polledAt, now)} · +{fmtN(lp.added)}</>}
      {lp?.truncated && <span style={{ color: 'var(--warn)' }}> · hit page cap</span>}
      {polling && <span style={{ color: 'var(--dev)' }}> · pulling…</span>}
    </span>
  )
}

function Kpi({ label, value, sub, tone, title }: { label: string; value: string; sub?: string; tone?: string; title?: string }) {
  return (
    <div className="kpi" style={tone ? { borderTopColor: tone } : undefined} title={title}>
      <span className="eyebrow">{label}</span>
      <span className="kpi-v">{value}</span>
      {sub && <span className="hint">{sub}</span>}
    </div>
  )
}

function Loading({ q }: { q: { isLoading: boolean; isError: boolean; error: unknown } }) {
  if (q.isError) return <div className="notice err"><span className="eyebrow" style={{ color: 'var(--danger)' }}>Error</span>{errMsg(q.error)}</div>
  return q.isLoading ? <div className="empty">Loading…</div> : null
}

function OverviewSection({ hostId, range }: { hostId: string; range: { fromMs: number; toMs: number } }) {
  const { monitorFilters: f, setMonitorFilters } = useUi()
  const q = useQuery({
    queryKey: ['monitor', hostId, 'overview', range.fromMs, range.toMs, f],
    queryFn: () => monitorApi.overview(hostId, range, f), placeholderData: keepPreviousData,
  })
  const o = q.data
  if (!o) return <Loading q={q} />
  const t = o.totals
  const finished = t.count - t.running
  const agg = hitRate(t.hits, false)
  const withCache = hitRate(t.hits, true)
  const scope = `successful ${o.hitScope.toLowerCase()} queries`
  return (
    <div className="mon-grid">
      <div className="kpis">
        <Kpi label="Queries" value={fmtN(t.count)} sub={`${plural(t.users, 'user')} · ${plural(t.models, 'model')}`} />
        <Kpi label="Aggregate hit rate" value={fmtRate(agg.rate)} sub={`${fmtN(agg.hits)} of ${fmtN(agg.outOf)}`} tone={HIT_COLOR.agg}
          title={`agg ÷ (agg + no agg): aggregate hits ÷ queries that reached aggregate selection (cache hits left out), over ${scope}`} />
        <Kpi label="Hit rate incl. cache" value={fmtRate(withCache.rate)} sub={`${fmtN(withCache.hits)} of ${fmtN(withCache.outOf)}`} tone={HIT_COLOR.cache}
          title={`(agg + cache) ÷ (agg + cache + no agg), over ${scope} - how much never reached the warehouse raw`} />
        <Kpi label="No aggregate" value={fmtN(t.raw)} sub={`${pct(t.raw, t.count)} of queries`} tone={CLS.raw.color} />
        <Kpi label="p50 latency" value={fmtMs(t.p50)} sub={`avg ${fmtMs(t.avg)}`} />
        <Kpi label="p95 latency" value={fmtMs(t.p95)} sub={`max ${fmtMs(t.max)}`} />
        <Kpi label="Failed" value={fmtN(t.failed)} sub={`${pct(t.failed, finished)} of finished`} tone={t.failed ? 'var(--danger)' : undefined} />
        <Kpi label="Running" value={fmtN(t.running)} sub="at last poll" />
      </div>

      <div className="mon-row three">
        <Donut title="How queries were answered" center={fmtN(t.count)} sub="queries"
          slices={(['agg', 'cache', 'raw'] as QueryClass[]).map((k) => ({ key: k, label: CLS[k].label, value: t[k], color: CLS[k].color }))}
          footer={<HitLines hits={t.hits} scope={scope} />} />
        <Donut title="User vs system" center={fmtN(o.byType.User.count + o.byType.System.count)} sub="queries"
          slices={(['User', 'System'] as const).map((k) => ({ key: k, label: k, value: o.byType[k].count, color: TYPE_COLOR[k] }))} />
        <div className="viz">
          <span className="eyebrow">Latency by how it was answered</span>
          <div className="lat">
            <div className="lat-row th"><span /><span className="num">p50</span><span className="num">p95</span><span className="num">avg</span></div>
            {(['cache', 'agg', 'raw'] as QueryClass[]).map((k) => (
              <div key={k} className="lat-row">
                <span><span className="viz-key" style={{ background: CLS[k].color, marginRight: 8 }} />{CLS[k].label}</span>
                <span className="num mono">{fmtMs(o.byClass[k].p50)}</span>
                <span className="num mono">{fmtMs(o.byClass[k].p95)}</span>
                <span className="num mono">{fmtMs(o.byClass[k].avg)}</span>
              </div>
            ))}
            {(['User', 'System'] as const).map((k, i) => (
              <div key={k} className={`lat-row ${i === 0 ? 'split' : ''}`}>
                <span><span className="viz-key" style={{ background: TYPE_COLOR[k], marginRight: 8 }} />{k}</span>
                <span className="num mono">{fmtMs(o.byType[k].p50)}</span>
                <span className="num mono">{fmtMs(o.byType[k].p95)}</span>
                <span className="num mono">{fmtMs(o.byType[k].avg)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <StackedBars title={`Queries per ${fmtBucket(o.bucketMs)}`} points={o.series} keys={CLS_KEYS} bucketMs={o.bucketMs} />
      <div className="mon-row two">
        <LineChart title={`Hit rate per ${fmtBucket(o.bucketMs)} · ${scope}`} bucketMs={o.bucketMs} times={o.series.map((s) => s.t)}
          max={1} fmt={fmtRate}
          series={[
            { key: 'agg', label: 'Aggregate hit rate', color: HIT_COLOR.agg, values: o.series.map((s) => hitRate(s.hits, false).rate) },
            { key: 'cache', label: 'Incl. cache', color: HIT_COLOR.cache, values: o.series.map((s) => hitRate(s.hits, true).rate) },
          ]}
          note={(i) => {
            const a = hitRate(o.series[i].hits, false)
            const c = hitRate(o.series[i].hits, true)
            return [`${fmtN(a.hits)} of ${fmtN(a.outOf)} agg · ${fmtN(c.hits)} of ${fmtN(c.outOf)} incl. cache`]
          }} />
        <LineChart title={`p95 latency per ${fmtBucket(o.bucketMs)}`} bucketMs={o.bucketMs} times={o.series.map((s) => s.t)}
          series={[{ key: 'p95', label: 'p95 latency', color: P95_COLOR, values: o.series.map((s) => s.p95) }]} />
      </div>

      <div className="mon-row two">
        <MixBars title="Top models" rows={o.byModel} keys={CLS_KEYS} onPick={(m) => setMonitorFilters({ model: m })} extra={HIT_COL} />
        <MixBars title="Top users" rows={o.byUser} keys={CLS_KEYS} onPick={(u) => setMonitorFilters({ user: u })} extra={HIT_COL} />
      </div>
      {!t.count && <NoMatch what="No queries" />}
    </div>
  )
}

/** Both hit rates with their counts - under the answered-by donut. */
function HitLines({ hits, scope }: { hits: Hits; scope: string }) {
  const a = hitRate(hits, false)
  const c = hitRate(hits, true)
  return (
    <div className="hit-lines" title={`Over ${scope}`}>
      <div><span className="viz-key" style={{ background: HIT_COLOR.agg }} /><span>Aggregate hit rate</span><b>{fmtRate(a.rate)}</b>
        <span className="mono muted">{fmtN(a.hits)} agg hits of {fmtN(a.outOf)}</span></div>
      <div><span className="viz-key" style={{ background: HIT_COLOR.cache }} /><span>Hit rate incl. cache</span><b>{fmtRate(c.rate)}</b>
        <span className="mono muted">{fmtN(c.hits)} of {fmtN(c.outOf)}</span></div>
    </div>
  )
}

/** Hit-rate column for the Top models / users bars. */
const HIT_COL = {
  label: 'Hit',
  value: (r: { hits: Hits }) => fmtRate(hitRate(r.hits, false).rate),
  title: (r: { hits: Hits }) => {
    const a = hitRate(r.hits, false)
    const c = hitRate(r.hits, true)
    return `${fmtRate(a.rate)} (${a.hits} of ${a.outOf}) · incl. cache ${fmtRate(c.rate)} (${c.hits} of ${c.outOf})`
  },
}

const fmtBucket = (ms: number) => (ms >= 86400e3 ? 'day' : ms >= 3600e3 ? `${ms / 3600e3} h`.replace('1 h', 'hour') : `${ms / 60e3} min`)

function HistorySection({ hostId, range }: { hostId: string; range: { fromMs: number; toMs: number } }) {
  const { monitorFilters: f } = useUi()
  const [cls, setCls] = useState<QueryClass | ''>('')
  const [status, setStatus] = useState<'' | 'successful' | 'failed' | 'running'>('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('-startMs')
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const limit = 100
  useEffect(() => { const t = setTimeout(() => setQ(search), 300); return () => clearTimeout(t) }, [search])
  useEffect(() => setOffset(0), [cls, status, q, sort, f, range.fromMs, range.toMs, hostId])

  const list = useQuery({
    queryKey: ['monitor', hostId, 'queries', range.fromMs, range.toMs, f, cls, status, q, sort, offset],
    queryFn: () => monitorApi.queries(hostId, range, f, { cls, status, q, sort, limit, offset }), placeholderData: keepPreviousData,
  })
  const rows = list.data?.queries ?? []
  const total = list.data?.total ?? 0
  const sortBy = (k: string) => setSort(sort === `-${k}` ? k : `-${k}`)
  const arrow = (k: string) => (sort === `-${k}` ? ' ↓' : sort === k ? ' ↑' : '')

  return (
    <div className="mon-split">
      <div className="mon-list">
        <div className="toolbar" style={{ margin: '0 0 12px' }}>
          <div className="seg">
            {([['', 'All'], ['agg', CLS.agg.label], ['cache', CLS.cache.label], ['raw', CLS.raw.label]] as [QueryClass | '', string][]).map(([k, label]) => (
              <button key={k || 'all'} type="button" className={cls === k ? 'on' : ''} style={{ background: cls === k ? 'var(--dev)' : 'transparent' }} onClick={() => setCls(k)}>{label}</button>
            ))}
          </div>
          <select className="select sm" style={{ minWidth: 130 }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">Any status</option><option value="successful">Successful</option><option value="failed">Failed</option><option value="running">Running</option>
          </select>
          <input className="input search" placeholder="Query id, user, model, text" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="hint" style={{ marginLeft: 'auto' }}>
            {total ? `${fmtN(offset + 1)}–${fmtN(Math.min(offset + limit, total))} of ${fmtN(total)}` : ''}
          </span>
          <button type="button" className="btn xs" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - limit))}>Prev</button>
          <button type="button" className="btn xs" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>
        <div className="table">
          <div className="tr th grid-mq">
            <button type="button" className="th-btn" onClick={() => sortBy('startMs')}>Started{arrow('startMs')}</button>
            <span>Model</span><span>User</span><span>Answered by</span><span>Status</span>
            <button type="button" className="th-btn num" onClick={() => sortBy('durationMs')}>Duration{arrow('durationMs')}</button>
            <button type="button" className="th-btn num" onClick={() => sortBy('subqueries')}>Subq{arrow('subqueries')}</button>
          </div>
          {rows.map((r) => (
            <div key={r.queryId} className={`tr grid-mq ${open === r.queryId ? 'sel' : ''}`} onClick={() => setOpen(open === r.queryId ? null : r.queryId)}>
              <span className="mono">{fmtStamp(r.startMs)}</span>
              <span className="ellipsis" title={r.catalogName}>{r.modelName || '—'}</span>
              <span className="ellipsis">{r.queryType === 'System' ? <span className="muted">System</span> : r.user || r.userId}</span>
              <ClsPill cls={r.cls} />
              <StatusText q={r} />
              <span className="num mono">{r.status === 'running' ? '…' : fmtMs(r.durationMs)}</span>
              <span className="num mono">{r.subqueries}</span>
            </div>
          ))}
          {!rows.length && (list.isLoading ? <div className="empty">Loading…</div> : list.isError ? <div className="empty">{errMsg(list.error)}</div>
            : <NoMatch what="No queries match" local={!!(cls || status || q)} onClearLocal={() => { setCls(''); setStatus(''); setSearch('') }} />)}
        </div>
      </div>
      {open && <QueryDrawer hostId={hostId} queryId={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function HotspotsSection({ hostId, range }: { hostId: string; range: { fromMs: number; toMs: number } }) {
  const { monitorFilters: f, setMonitorFilters, setMonitorSection } = useUi()
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['monitor', hostId, 'hotspots', range.fromMs, range.toMs, f],
    queryFn: () => monitorApi.hotspots(hostId, range, f), placeholderData: keepPreviousData,
  })
  const h = q.data
  if (!h) return <Loading q={q} />
  return (
    <div className="mon-split">
      <div className="mon-list mon-grid">
        <div className="mon-row two">
          <div className="viz">
            <span className="eyebrow">Models leaning on the warehouse</span>
            <div className="table flat">
              <div className="tr th grid-hm"><span>Model</span><span className="num">Queries</span><span className="num">No aggregate</span><span className="num" title="agg ÷ (agg + no agg)">Hit rate</span><span className="num" title="(agg + cache) ÷ all">+ cache</span><span className="num">p95 no-agg</span></div>
              {h.warehouseModels.map((m) => (
                <div key={m.name} className="tr grid-hm" onClick={() => { setMonitorFilters({ model: m.name }); setMonitorSection('history') }} title="Show its queries">
                  <span className="ellipsis">{m.name}</span><span className="num mono">{fmtN(m.count)}</span>
                  <span className="num mono" style={{ color: m.rawPct > 40 ? CLS.raw.color : undefined }}>{fmtN(m.raw)} · {m.rawPct.toFixed(0)}%</span>
                  <span className="num mono">{fmtRate(hitRate(m.hits, false).rate)}</span>
                  <span className="num mono">{fmtRate(hitRate(m.hits, true).rate)}</span>
                  <span className="num mono">{fmtMs(m.rawP95)}</span>
                </div>
              ))}
              {!h.warehouseModels.length && <div className="empty">No queries</div>}
            </div>
          </div>
          <div className="viz">
            <span className="eyebrow">Aggregate candidates · attribute × measure pairs that miss aggregates</span>
            <div className="table flat">
              <div className="tr th grid-hp"><span>Attribute</span><span>Measure</span><span className="num">Queries</span><span className="num">No agg</span><span className="num">Avg</span></div>
              {h.pairs.map((p) => (
                <div key={`${p.attribute}|${p.measure}`} className="tr grid-hp" style={{ cursor: 'default' }}>
                  <span className="ellipsis">{p.attribute ?? <span className="muted">(none)</span>}</span>
                  <span className="ellipsis">{p.measure ?? <span className="muted">(none)</span>}</span>
                  <span className="num mono">{fmtN(p.count)}</span>
                  <span className="num mono" style={{ color: p.raw ? CLS.raw.color : undefined }}>{fmtN(p.raw)}</span>
                  <span className="num mono">{fmtMs(p.avgMs)}</span>
                </div>
              ))}
              {!h.pairs.length && <div className="empty">No queries</div>}
            </div>
          </div>
        </div>
        <div className="viz">
          <span className="eyebrow">Slowest queries</span>
          <div className="table flat">
            <div className="tr th grid-mq"><span>Started</span><span>Model</span><span>User</span><span>Answered by</span><span>Status</span><span className="num">Duration</span><span className="num">Subq</span></div>
            {h.slowest.map((r) => (
              <div key={r.queryId} className={`tr grid-mq ${open === r.queryId ? 'sel' : ''}`} onClick={() => setOpen(open === r.queryId ? null : r.queryId)}>
                <span className="mono">{fmtStamp(r.startMs)}</span><span className="ellipsis">{r.modelName}</span>
                <span className="ellipsis">{r.queryType === 'System' ? <span className="muted">System</span> : r.user}</span>
                <ClsPill cls={r.cls} /><StatusText q={r} />
                <span className="num mono">{fmtMs(r.durationMs)}</span><span className="num mono">{r.subqueries}</span>
              </div>
            ))}
            {!h.slowest.length && <div className="empty">No finished queries</div>}
          </div>
        </div>
        <div className="viz">
          <span className="eyebrow">Repeated failures</span>
          <div className="table flat">
            <div className="tr th grid-hf"><span>Message</span><span className="num">Count</span><span>Models</span><span>Last</span></div>
            {h.failures.map((x) => (
              <div key={x.message} className="tr grid-hf" style={{ cursor: 'default' }}>
                <span className="ellipsis err-text" title={x.message}>{x.message}</span><span className="num mono">{fmtN(x.count)}</span>
                <span className="ellipsis">{x.models.join(', ')}</span><span className="mono">{fmtStamp(x.lastMs)}</span>
              </div>
            ))}
            {!h.failures.length && <div className="empty">No failures in this range</div>}
          </div>
        </div>
      </div>
      {open && <QueryDrawer hostId={hostId} queryId={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
