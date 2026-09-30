// Monitor tab API: a host's AtScale query history (GET /wapi/p/queries), stored and
// reported on by api/routes/monitor.py.
import { waitForJob, type Job } from '../api'
import type { MonitorFilters, MonitorRange } from '../store'

export type QueryClass = 'cache' | 'agg' | 'raw'
export type QueryStatus = 'successful' | 'failed' | 'running'

export interface MonitorQuery {
  queryId: string
  startMs: number
  durationMs: number
  status: QueryStatus
  queryType: 'User' | 'System'
  userId: string
  user: string
  catalogId: string
  catalogName: string
  modelId: string
  modelName: string
  dialect: string
  cls: QueryClass
  optimization: string[]
  aggregates: string[]
  aggTables: string[]
  attributes: string[]
  measures: string[]
  planningMs: number | null
  outboundMs: number | null
  processingMs: number | null
  subqueries: number
  failedMessage: string
}

export interface QueryEvent {
  name: string
  startTime: number | null
  duration: number
  subqueries: { name: string; subqueryId: string; startTime: number | null; duration: number }[]
}

export interface QueryDetail extends MonitorQuery {
  events: QueryEvent[]
  text: string | null
  aggDefs: { id: string; name: string; type: string; subType: string; table: string | null }[] | null
}

export interface Latency { avg: number | null; p50: number | null; p95: number | null; max: number | null }
/** Successful queries of the hit-rate scope by class; rate = agg / (agg + raw). */
export interface Hits { agg: number; cache: number; raw: number; rate: number | null }
export interface Mix { count: number; cache: number; agg: number; raw: number; failed: number; p50: number | null; p95: number | null; avg: number | null; hits: Hits }

/** Aggregate hit rate = agg / (agg + raw); withCache = (agg + cache) / (agg + cache + raw). */
export function hitRate(h: Hits | undefined, withCache: boolean): { hits: number; outOf: number; rate: number | null } {
  if (!h) return { hits: 0, outOf: 0, rate: null }
  const hits = h.agg + (withCache ? h.cache : 0)
  const outOf = h.agg + h.raw + (withCache ? h.cache : 0)
  return { hits, outOf, rate: outOf ? hits / outOf : null }
}
export interface SeriesPoint { t: number; cache: number; agg: number; raw: number; failed: number; p95: number | null; hits: Hits }

export interface Lists { models: string[]; users: string[] }

export interface Overview extends Lists {
  fromMs: number
  toMs: number
  bucketMs: number
  totals: Mix & Latency & { running: number; servedPct: number | null; users: number; models: number }
  byClass: Record<QueryClass, Latency>
  byType: Record<'User' | 'System', Mix>
  /** Which queries hit rate is measured on. */
  hitScope: 'User' | 'System'
  series: SeriesPoint[]
  byModel: (Mix & { name: string })[]
  byUser: (Mix & { name: string })[]
}

export interface Hotspots extends Lists {
  slowest: MonitorQuery[]
  warehouseModels: { name: string; count: number; raw: number; rawPct: number; rawP95: number | null; p95: number | null; hits: Hits }[]
  pairs: { attribute: string | null; measure: string | null; count: number; raw: number; avgMs: number }[]
  failures: { message: string; count: number; lastMs: number; models: string[] }[]
}

export interface PollResult { fromMs: number; toMs: number | null; fetched: number; added: number; pages: number; truncated: boolean }

export interface MonitorStatus {
  stored: number
  oldestMs: number | null
  newestMs: number | null
  lastPoll: (PollResult & { polledAt: number; error: string | null }) | null
  pollJob: string | null
  defaultDays: number
  maxPages: number
  pageSize: number
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? `${method} ${path} failed with ${res.status}`)
  return data as T
}

const PRESET_MS = { '1h': 3600e3, '24h': 86400e3, '2d': 2 * 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }

/** The range as epoch ms; a preset ends now (rounded to the minute so query keys stay stable). */
export function rangeMs(r: MonitorRange, now = Date.now()): { fromMs: number; toMs: number } {
  if (r.preset === 'custom') return { fromMs: r.fromMs, toMs: r.toMs }
  const toMs = Math.ceil(now / 60e3) * 60e3
  return { fromMs: toMs - PRESET_MS[r.preset], toMs }
}

export type ListParams = { cls?: QueryClass | ''; status?: QueryStatus | ''; q?: string; sort?: string; limit?: number; offset?: number }

function qs(range: { fromMs: number; toMs: number }, f: MonitorFilters, extra: Record<string, string | number | undefined> = {}) {
  const p = new URLSearchParams({ fromMs: String(range.fromMs), toMs: String(range.toMs) })
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v !== undefined && v !== '') p.set(k, String(v))
  return p.toString()
}

const h = (id: string) => `/hosts/${encodeURIComponent(id)}/monitor`

export const monitorApi = {
  status: (hostId: string) => req<MonitorStatus>('GET', `${h(hostId)}/status`),
  /** No range = everything since the last poll (or the default window on a new host). */
  poll: async (hostId: string, range?: { fromMs: number; toMs: number | null }) =>
    waitForJob(await req<Job<PollResult>>('POST', `${h(hostId)}/poll`, range ?? {})),
  overview: (hostId: string, range: { fromMs: number; toMs: number }, f: MonitorFilters) =>
    req<Overview>('GET', `${h(hostId)}/overview?${qs(range, f, { tz: -new Date().getTimezoneOffset() })}`),
  queries: (hostId: string, range: { fromMs: number; toMs: number }, f: MonitorFilters, p: ListParams) =>
    req<{ queries: MonitorQuery[]; total: number } & Lists>('GET', `${h(hostId)}/queries?${qs(range, f, p)}`),
  query: (hostId: string, queryId: string) =>
    req<{ query: QueryDetail; errors: Record<string, string> }>('GET', `${h(hostId)}/queries/${encodeURIComponent(queryId)}`),
  hotspots: (hostId: string, range: { fromMs: number; toMs: number }, f: MonitorFilters) =>
    req<Hotspots>('GET', `${h(hostId)}/hotspots?${qs(range, f)}`),
  storeInfo: () => req<{ path: string; bytes: number; queries: number; maxAgeDays: number; hosts: { hostId: string; queries: number; oldestMs: number; newestMs: number; models: { model: string; queries: number; oldestMs: number; newestMs: number }[] }[] }>('GET', '/monitor/store'),
  cleanup: (body: { olderThanDays?: number | null; hostId?: string | null; model?: string | null; dryRun?: boolean }) => req<{ count: number }>('POST', '/monitor/cleanup', body),
  compact: () => req<{ freedBytes: number }>('POST', '/monitor/compact'),
}
