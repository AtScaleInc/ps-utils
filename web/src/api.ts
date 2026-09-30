export type EnvId = 'dev' | 'qa' | 'prod'
export type ConnStatus = 'connected' | 'untested' | 'failed' | 'testing' | 'missing'

export interface Host {
  id: string
  env: EnvId
  label: string
  hostname: string
  username: string
  hasPassword: boolean
  hasToken: boolean
  insecure: boolean
  status: ConnStatus
  lastChecked: string | null
  error?: string | null
}

export interface GitProfile {
  username: string
  email: string
  hasToken: boolean
  status: ConnStatus
  lastChecked: string | null
  error?: string | null
}

export interface ModelRow {
  key: string
  name: string
  catalog: string
  /** Short Git commit the deployment was built from. */
  version: string | null
  commit: string | null
  commitDate: string | null
  /** True when read from publishedAt instead of recorded at deploy time. */
  versionInferred: boolean
  updated: string | null
  status: 'Deployed' | 'Linked' | 'Error'
  catalogId: string | null
  modelId: string | null
  repoId: string
  repoUrl: string
  branch: string
}

export interface AggModel {
  catalogId: string
  modelId: string
  name: string
  catalog: string
}

export interface AggRow {
  id: string
  instanceId: string | null
  name: string
  model: string
  type: 'SYSTEM' | 'USER'
  size: string
  lastBuild: string | null
  status: 'Built' | 'Stale' | 'Building' | 'Inactive' | 'Invalid' | 'Error'
  statusNote?: string | null
  active: boolean
  exportable?: boolean
}

export type DiffState = 'new' | 'upd' | 'same' | 'older' | 'diverged' | 'unknown' | 'uda' | 'miss' | 'dup' | 'repl' | 'noexp' | 'srcoff'
export interface Diff {
  state: DiffState
  label: string
  stageable: boolean
  reason: string | null
  targetId?: string
}

export interface ModelDiffResponse { rows: (ModelRow & { diff: Diff })[]; target: ModelRow[]; sameHost?: boolean; cachedAt?: number | null }
export interface AggDiffResponse {
  rows: (AggRow & { diff: Diff })[]
  target: (AggRow & { duplicate: boolean })[]
  sourceModels: string[]
  targetModels: string[]
  modelMap?: Record<string, string>
  sameHost?: boolean
  cachedAt?: number | null
}

export interface Job<T = unknown> {
  id: string
  kind: string
  status: 'running' | 'done' | 'failed'
  result: T | null
  error: string | null
}

export interface GitRepo { url: string; fullName: string; defaultBranch: string; models?: string[] }
export interface Branch { name: string; sha: string | null }
export interface CacheEntry { path: string; key: string[]; loadedAt: string; expiresAt: string; fresh: boolean; items: number | null; bytes: number }
export type PromoteMode = 'deploy' | 'link'

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.error ?? `Request failed (${status})`))
    this.status = status
    this.body = body
  }
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
  if (!res.ok) throw new ApiError(res.status, data)
  return data as T
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString()
/** `refresh` bypasses the API's 2 h cache and reloads from AtScale. */
const r = (refresh?: boolean) => (refresh ? 'refresh=1' : '')
const withQ = (path: string, ...parts: string[]) => {
  const qs = parts.filter(Boolean).join('&')
  return qs ? `${path}?${qs}` : path
}
type Cached = { cachedAt: number | null }

export async function waitForJob<T>(job: Job<T>): Promise<T> {
  let j = job
  while (j.status === 'running') {
    await new Promise((r) => setTimeout(r, 600))
    j = await req<Job<T>>('GET', `/jobs/${job.id}`)
  }
  if (j.status === 'failed') throw new Error(j.error ?? 'Job failed')
  return j.result as T
}

export const api = {
  hosts: () => req<{ hosts: Host[]; fake: boolean }>('GET', '/hosts'),
  addHost: (env: EnvId) => req<Host>('POST', '/hosts', { env }),
  patchHost: (id: string, patch: Partial<Host> & { password?: string; apiToken?: string }) =>
    req<Host>('PATCH', `/hosts/${id}`, patch),
  deleteHost: (id: string) => req('DELETE', `/hosts/${id}`),
  testHost: (id: string) => req<Host>('POST', `/hosts/${id}/test`),

  git: () => req<GitProfile>('GET', '/git'),
  putGit: (patch: { username?: string; email?: string; token?: string }) => req<GitProfile>('PUT', '/git', patch),
  testGit: () => req<GitProfile>('POST', '/git/test'),
  gitRepos: () => req<{ repos: GitRepo[] }>('GET', '/git/repos'),
  gitRepoModels: (url: string, branch: string) => req<{ models: string[] }>('GET', `/git/repos/models?${q({ url, branch })}`),
  demoReset: () => req('POST', '/demo/reset'),
  cache: () => req<{ dir: string; ttlSeconds: number; entries: CacheEntry[] }>('GET', '/cache'),
  clearCache: () => req('DELETE', '/cache'),

  models: (hostId: string, refresh?: boolean) => req<{ models: ModelRow[] } & Cached>('GET', withQ(`/hosts/${hostId}/models`, r(refresh))),
  link: (hostId: string, body: { repoUrl: string; branch: string; model: string }) =>
    req('POST', `/hosts/${hostId}/models/link`, body),
  deploy: (hostId: string, models: { key: string; branch?: string }[]) =>
    req<Job<{ results: { key: string; ok: boolean; branch?: string; commit?: string; error?: string }[] }>>('POST', `/hosts/${hostId}/models/deploy`, { models }),
  undeploy: (hostId: string, models: string[]) =>
    req<{ removed: string[]; catalogs: string[]; warnings: string[] }>('POST', `/hosts/${hostId}/models/undeploy`, { models }),
  unlink: (hostId: string, models: string[]) =>
    req<{ removed: string[]; catalogs: string[]; warnings: string[] }>('POST', `/hosts/${hostId}/models/unlink`, { models }),
  branches: (hostId: string, url: string, refresh?: boolean) => req<{ branches: Branch[] } & Cached>('GET', withQ(`/hosts/${hostId}/branches`, q({ url }), r(refresh))),

  aggModels: (hostId: string, refresh?: boolean) => req<{ models: AggModel[] } & Cached>('GET', withQ(`/hosts/${hostId}/aggregate-models`, r(refresh))),
  aggs: (hostId: string, m: AggModel, refresh?: boolean) =>
    req<{ aggregates: AggRow[] } & Cached>('GET', withQ(`/hosts/${hostId}/aggregates`, q({ catalogId: m.catalogId, modelId: m.modelId }), r(refresh))),
  setActive: (hostId: string, m: AggModel, ids: string[], active: boolean) =>
    req<{ results: { id: string; ok: boolean; error?: string }[] }>(
      'POST', `/hosts/${hostId}/aggregates/${active ? 'reactivate' : 'deactivate'}`,
      { catalogId: m.catalogId, modelId: m.modelId, aggregates: ids }),
  build: (hostId: string, m: AggModel, mode: 'full' | 'incremental') =>
    req<Job>('POST', `/hosts/${hostId}/aggregates/build`, { catalogId: m.catalogId, modelId: m.modelId, mode }),

  diffModels: (src: string, tgt: string, refresh?: boolean) =>
    req<ModelDiffResponse>('POST', '/promote/diff', { section: 'models', sourceHostId: src, targetHostId: tgt, refresh: !!refresh }),
  /** modelMap: target-model override {source model: target model}; models match by name without it. */
  diffAggs: (src: string, tgt: string, model: string, refresh?: boolean, modelMap?: Record<string, string>) =>
    req<AggDiffResponse>('POST', '/promote/diff', { section: 'aggs', sourceHostId: src, targetHostId: tgt, model: model || null, refresh: !!refresh, modelMap }),
  promoteModels: (src: string, tgt: string, models: { name: string; branch: string; mode: PromoteMode; replaceOld: boolean }[]) =>
    req<Job<{ results: { name: string; ok: boolean; mode?: PromoteMode; branch?: string; commit?: string; replaced?: string[]; error?: string }[] }>>('POST', '/promote/models',
      { sourceHostId: src, targetHostId: tgt, models }),
  promoteAggs: (src: string, tgt: string, aggregates: string[], modelMap?: Record<string, string>) =>
    req<Job<{ promoted: string[]; skipped: { name: string; reason: string }[]; connections?: Record<string, number> }>>('POST', '/promote/aggregates',
      { sourceHostId: src, targetHostId: tgt, aggregates, modelMap }),
}
