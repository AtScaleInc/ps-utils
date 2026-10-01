// Test tab API: ps-utils generate-queries-from-model + execute-atscale-query-harness,
// served by api/routes/testing.py.

import { withBu } from '../bu'

export interface CubeRef { catalog: string; cube: string }

export interface TestQuery {
  id: string
  name: string
  kind: 'total' | 'level'
  dimension?: string
  mdx: string
  sql: string
  hash: string
}

export type Protocol = 'mdx' | 'sql'

export interface TestOptions {
  useAggregates: boolean
  generateAggregates: boolean
  useQueryCache: boolean
  useAggregateCache: boolean
}

export interface TestTarget { hostId: string; label?: string; env?: string; catalog: string; cube: string }

export interface TestResult {
  runId: string
  hostId: string
  host: string
  env: string
  queryId: string
  queryName: string
  protocol: Protocol
  status: 'SUCCEEDED' | 'FAILED'
  durationMs: number
  rowCount: number
  checksum: string
  error: string
  originalText: string
}

export interface ModelDiffSection {
  onlyA: string[]
  onlyB: string[]
  changed: { name: string; fields: { field: string; a: unknown; b: unknown }[] }[]
  same: number
  countA: number
  countB: number
}
export interface ModelDiff { identical: boolean; metrics: ModelDiffSection; levels: ModelDiffSection }
export type ModelSnapshot = { metrics: Record<string, Record<string, unknown>>; levels: Record<string, Record<string, unknown>>; error?: string }

export interface Variance {
  status: 'identical' | 'differs' | 'missing'
  rowsA: number
  rowsB: number
  matchedRows?: number
  onlyA?: string[][]
  onlyB?: string[][]
  onlyACount?: number
  onlyBCount?: number
  diffRows?: number
  diffs?: { label: string[]; measure: string; a: string | null; b: string | null; delta: number | null; pct: number | null }[]
  maxPct?: number | null
  measuresA?: string[]
  measuresB?: string[]
  schemaDiffers?: boolean
}

export type Verdict = 'identical' | 'differs' | 'missing' | 'failedBaseline' | 'failedCandidate' | 'failedBoth'

export interface SideRef { runId: string; startedAt: string; hostId: string; label?: string; env?: string; catalog: string; cube: string }
type Outcome = { status: 'SUCCEEDED' | 'FAILED'; durationMs: number; rowCount: number; error: string }

export interface CompareResult {
  baseline: SideRef
  candidate: SideRef
  tolerance: number
  verdict: 'pass' | 'fail'
  model: ModelDiff | null
  counts: Partial<Record<Verdict, number>>
  total: number
  time: { baselineMs: number; candidateMs: number; pct: number | null }
  queries: { name: string; protocol: Protocol; a: Outcome | null; b: Outcome | null; verdict: Verdict; variance?: Variance; timePct?: number | null }[]
}

export interface TestRun {
  runId: string
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt: string | null
  targets: TestTarget[]
  protocols: Protocol[]
  options: TestOptions
  concurrency: number
  total: number
  done: number
  failed: number
  error: string | null
  queries?: TestQuery[]
  results?: TestResult[]
  model?: string
  catalog?: string
  models?: Record<string, ModelSnapshot>
  modelCheck?: Record<string, ModelDiff>
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  // A 200 whose body isn't JSON (e.g. a NaN the API let through) must fail
  // loudly: returning {} left the caller rendering a half-empty object.
  const text = await res.text()
  let data: any = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    if (res.ok) throw new Error(`${method} ${path}: the API sent a response that isn't valid JSON`)
  }
  if (!res.ok) throw new Error(data?.error ?? `${method} ${path} failed with ${res.status}`)
  return data as T
}

export const testApi = {
  cubes: (hostId: string) => req<{ cubes: CubeRef[] }>('GET', `/hosts/${encodeURIComponent(hostId)}/test/cubes`),
  generate: (hostId: string, ref: CubeRef) =>
    req<{ metrics: { uniqueName: string; label: string }[]; levels: unknown[]; queries: TestQuery[] }>(
      'POST', '/test/generate', { hostId, ...ref }),
  start: (body: { targets: TestTarget[]; queries: TestQuery[]; protocols: Protocol[]; concurrency: number; options: TestOptions; annotate: boolean }) =>
    req<TestRun>('POST', '/test/runs', body),
  run: (runId: string) => req<TestRun>('GET', `/test/runs/${encodeURIComponent(runId)}`),
  runs: () => req<{ runs: TestRun[] }>('GET', '/test/runs'),
  remove: (runId: string) => req<{ ok: boolean }>('DELETE', `/test/runs/${encodeURIComponent(runId)}`),
  compare: (baseline: { runId: string; hostId: string }, candidate: { runId: string; hostId: string }, tolerance: number) =>
    req<CompareResult>('POST', '/test/compare', { baseline, candidate, tolerance }),
  modelCompare: (baseline: { hostId: string } & CubeRef, candidate: { hostId: string } & CubeRef) =>
    req<{ diff: ModelDiff; baseline: { snapshot: ModelSnapshot }; candidate: { snapshot: ModelSnapshot } }>('POST', '/test/model-compare', { baseline, candidate }),
  storeInfo: () => req<{
    path: string; runs: number; executions: number; bytes: number; keepPerModel: number; maxAgeDays: number; maxActive: number
    models: { model: string | null; runs: number; executions: number; dataBytes: number; oldest: string; newest: string }[]
  }>('GET', '/test/store'),
  compact: () => req<{ freedBytes: number }>('POST', '/test/compact'),
  cleanup: (body: { olderThanDays?: number | null; keepPerModel?: number | null; model?: string | null; dryRun?: boolean }) =>
    req<{ count: number; runs?: { runId: string; model: string; startedAt: string }[] }>('POST', '/test/cleanup', body),
  history: (model: string, query: string, protocol: Protocol) =>
    req<{ history: (TestResult & { startedAt: string })[] }>('GET', `/test/history?model=${encodeURIComponent(model)}&query=${encodeURIComponent(query)}&protocol=${protocol}`),
  csvUrl: (runId: string) => withBu(`/api/test/runs/${encodeURIComponent(runId)}.csv`),
}
