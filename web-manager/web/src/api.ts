export type EnvId = 'dev' | 'test' | 'qa' | 'prod'
export type ConnStatus = 'connected' | 'untested' | 'failed' | 'testing' | 'missing'

export interface Host {
  id: string
  /** Business unit (BusinessUnit.id) the host belongs to. */
  bu: string
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

/** An isolated realm: its own Git profile and hosts in the four groups. */
export interface BusinessUnit {
  id: string
  label: string
  hosts: number
  groups: Record<EnvId, number>
  git: GitProfile
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

/** Manage › Analyze: api/analyze/model.py + routes/analyze.py. Every object carries
 * `props` (each documented SML property it sets) and `extra` (undocumented keys). */
export interface AuditNotes { description?: string | null; comments: string[] }
export interface Spec { props?: Record<string, unknown>; extra?: Record<string, unknown> }
export interface AuditAttr extends AuditNotes, Spec {
  name: string; label: string; kind: 'level' | 'secondary' | 'alias' | 'metrical'; level?: string | null
  dataset: string | null; keyColumns: string[]; nameColumn: string | null; sortColumn: string | null; column: string | null
  timeUnit: string | null; calculationMethod: string | null; uniqueKey: boolean; hidden: boolean; folder: string | null; format: string | null
  constraintTranslationRank: number | null
  sharedDegenerateColumns: { dataset: string; keyColumns: string[]; nameColumn: string | null; sortColumn: string | null; uniqueKey: boolean | null }[]
}
export interface AuditMetric extends AuditNotes, Spec {
  name: string; label: string; kind: 'metric' | 'calculation'; file: string | null
  calculationMethod?: string | null; additivity?: 'additive' | 'semi-additive' | 'non-additive'
  dataset?: string | null; column?: string | null; expression?: string | null
  mdxAggregation?: string | null; unrelatedDimensions?: string | null; quantiles?: boolean
  compression?: number | null; namedQuantiles?: string | null; customQuantiles?: number[] | null; timeFunctions?: string[]
  semiAdditive?: { position: string; relationships: string[]; degenerate: string[] } | null
  format: string | null; folder: string | null; hidden: boolean; queryName: string | null
}
export interface CalcMember extends AuditNotes, Spec {
  name: string; template: string | null; expression: string | null; format: string | null; useInputMetricFormat: boolean | null
  hidden: boolean; default: boolean
}
export interface CalcGroup extends AuditNotes, Spec {
  name: string; label: string | null; folder: string | null; precedence: number | null; hidden: boolean; members: CalcMember[]
}
export interface AuditDimension extends AuditNotes, Spec {
  name: string; label: string; type: string; degenerate: boolean; sharedDegenerate: boolean; file: string | null; datasets: string[]
  hierarchies: (AuditNotes & Spec & {
    name: string; label: string; folder: string | null; filterEmpty: string | null; defaultMember: string | null
    defaultMemberOnlyInQuery: boolean | null
    levels: (Spec & { name: string; label: string; hidden: boolean; timeUnit: string | null })[]
  })[]
  levelAttributes: AuditAttr[]; secondaryAttributes: AuditAttr[]; aliases: AuditAttr[]; metricalAttributes: AuditAttr[]
  parallelPeriods: { hierarchy: string; level: string; toLevel: string; keyColumns: string[] }[]
  calculationGroups: CalcGroup[]
}
export interface AuditDataset extends AuditNotes, Spec {
  name: string; label: string; role: string; connection: string | null; table: string | null; sql: string | null
  dialects: { dialect: string; sql: string }[]
  columns: (AuditNotes & Spec & { name: string; dataType: string | null; sql: string | null; dialects: string[]; map: Record<string, unknown> | null; parentColumn: string | null })[]
  calculatedColumns: number; mapColumns: number
  incremental: { column: string; gracePeriod: string } | null; immutable: boolean | null; qdsMaterialization: boolean | null
  alternate: { type: string | null; connection: string | null; table: string | null; sql: string | null } | null
  datasetProperties: { catalog: Record<string, unknown> | null; model: Record<string, unknown> | null; effective: Record<string, unknown> }
  file: string | null
}
export interface AuditJoin {
  kind: 'fact' | 'snowflake' | 'embedded' | 'security'; name: string | null; fromDataset: string | null; columns: string[]
  toDimension: string | null; toLevel: string | null; fromHierarchy: string | null; fromLevel: string | null
  rolePlay: string | null; m2m: boolean; constraintTranslation: { level: string; fromColumns: string[] } | null
  owner: string; ownerKind: 'model' | 'dimension'
}
export interface AuditFinding { level: 'error' | 'warn' | 'info'; text: string; items: string[]; group: string }
export interface BusCell { how: 'join' | 'degenerate' | 'embedded'; columns: string[]; level: string | null; rolePlay: string | null; relationship: string | null; path?: string[]; m2m?: boolean }
export interface ModelAudit {
  model: AuditNotes & Spec & { name: string; label: string; composite: boolean; members: string[]; file: string | null; includeDefaultDrillthrough: boolean | null; degenerateDimensions: string[] }
  catalog: (AuditNotes & Spec & { name: string; label: string; version: string | number | null; hiddenModels: string[]; aggressiveAggPromotion: boolean | null; buildSpeculativeAggs: boolean | null; datasetProperties: Record<string, Record<string, unknown>>; file: string | null }) | null
  package: { file: string; version: number | null; packages: { name: string; url: string; branch: string; version: string }[] } | null
  otherModels: string[]
  counts: Record<string, number>
  calculationMethods: Record<string, number>; formats: Record<string, number>; folders: Record<string, number>
  metrics: AuditMetric[]; dimensions: AuditDimension[]; datasets: AuditDataset[]; joins: AuditJoin[]
  connections: (AuditNotes & Spec & { name: string; label: string; asConnection: string | null; database: string | null; schema: string | null; datasets: string[]; file: string | null })[]
  rolePlays: { dimension: string; roles: { template: string; relationships: number }[] }[]
  timeIntelligence: {
    dimensions: { name: string; label: string; type: string; roles: string[]; hierarchies: { name: string; label: string; levels: { name: string; label: string; timeUnit: string | null }[] }[]; parallelPeriods: AuditDimension['parallelPeriods'] }[]
    calculationGroups: (CalcGroup & { dimension: string })[]
    calculations: { name: string; label: string; functions: string[]; expression: string | null }[]
    semiAdditive: { name: string; label: string; position: string; relationships: string[]; degenerate: string[] }[]
  }
  busMatrix: {
    dimensions: string[]; conformed: string[]
    facts: { dataset: string; metrics: string[]; cells: Record<string, BusCell[]>; unreached: string[] }[]
    metricReach: { metric: string; dataset: string; dimensions: string[]; unrelated: string[]; handling: string | null }[]
  }
  rowSecurity: (AuditNotes & Spec & { name: string; label: string; dataset: string | null; filterKey: string | null; idsColumn: string | null; idType: string | null; scope: string | null; useFilterKey: boolean | null; secureTotals: boolean | null; file: string | null })[]
  perspectives: (AuditNotes & { name: string; hiddenMetrics: string[]; hiddenDimensions: { name: string; hierarchies: { name: string; level: string | null; levels: string[] }[]; secondaryAttributes: string[]; relationshipsPath: string[] }[]; model: string })[]
  drillthroughs: (AuditNotes & { name: string; metrics: string[]; attributes: { name: string; dimension: string | null; relationshipsPath: string[] }[]; notes: string | null; model: string })[]
  aggregates: (AuditNotes & { name: string; label: string | null; caching: string | null; metrics: string[]; model: string
    attributes: { name: string | null; dimension: string | null; rowSecurity: string | null; partition: string | null; partitionRank: number | null; distribution: string | null; distributionRank: number | null; relationshipsPath: string[] }[] })[]
  partitions: { name: string; dimension: string; attribute: string; type: string; model: string }[]
  overrides: { name: string; queryName: string | null }[]
  datasetProperties: { catalog: Record<string, Record<string, unknown>>; model: Record<string, Record<string, unknown>> }
  unused: { type: string; name: string; file: string | null }[]
  undocumented: string[]
  propertyUsage: { kind: string; file: string; property: string; count: number; objects: number }[]
  findings: AuditFinding[]
  source: { repoUrl: string; ref: string; branch: string | null; commit: string | null; commitDate: string | null; versionInferred: boolean; status: string; catalog: string; updated: string | null; atCommit: boolean }
  deployed: {
    dmv?: { measures: number; levels: number; hierarchies: number; dimensions: number; aggregation: Record<string, number>; missingFromHost: string[]; notInSml: string[]; catalog: string; cube: string }
    dmvError?: string
    aggregates?: { total: number; system: number; user: number; active: number; byStatus: Record<string, number> }
    aggregatesError?: string
  } | null
}

/** Catalog: one model's copy on one host (api/routes/catalog.py). `atHead`:
 * deployed commit is its branch's head (null = unknown / not deployed). */
export interface CatalogDeployment {
  hostId: string
  env: EnvId
  label: string
  key: string
  status: ModelRow['status']
  catalog: string | null
  branch: string | null
  commit: string | null
  version: string | null
  commitDate: string | null
  versionInferred: boolean
  updated: string | null
  head: string | null
  atHead: boolean | null
}
export interface CatalogModel { name: string; inGit: boolean; deployments: CatalogDeployment[] }
export interface CatalogRepo { url: string; fullName: string; defaultBranch: string; source: 'git' | 'host'; models: CatalogModel[] }
export interface CatalogResponse {
  repos: CatalogRepo[]
  hosts: { id: string; env: EnvId; label: string; error: string | null }[]
  gitError: string | null
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

export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
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

/** A POST answered with a zip (the "Download CLI script" buttons): its file name comes from Content-Disposition. */
async function zipReq(path: string, body: unknown, fallback: string): Promise<{ name: string; blob: Blob }> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({ error: `Couldn't build the script (${res.status})` })))
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallback
  return { name, blob: await res.blob() }
}

/** Hand a downloaded blob to the browser as a file. */
export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  bus: () => req<{ bus: BusinessUnit[]; current: string; fake: boolean }>('GET', '/bus'),
  addBu: (label: string) => req<BusinessUnit>('POST', '/bus', { label }),
  patchBu: (id: string, label: string) => req<BusinessUnit>('PATCH', `/bus/${encodeURIComponent(id)}`, { label }),
  deleteBu: (id: string) => req('DELETE', `/bus/${encodeURIComponent(id)}`),

  catalog: (refresh?: boolean) => req<CatalogResponse>('GET', withQ('/catalog', r(refresh))),

  hosts: () => req<{ hosts: Host[]; bu: string; fake: boolean }>('GET', '/hosts'),
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

  analyze: (hostId: string, key: string, refresh?: boolean) => req<ModelAudit>('GET', withQ(`/hosts/${hostId}/analyze`, q({ key }), r(refresh))),
  analyzeFile: (hostId: string, key: string, path: string) =>
    req<{ path: string; ref: string; content: string }>('GET', `/hosts/${hostId}/analyze/file?${q({ key, path })}`),

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
  /** The staged promotion as a zip for the ps-utils CLI (api/promote/cli_bundle.py): same body as promoteModels / promoteAggs. */
  promoteModelsScript: (src: string, tgt: string, models: { name: string; branch: string; mode: PromoteMode; replaceOld: boolean }[]) =>
    zipReq('/promote/models/script', { sourceHostId: src, targetHostId: tgt, models }, 'promote-models.zip'),
  promoteAggsScript: (src: string, tgt: string, aggregates: string[], modelMap?: Record<string, string>) =>
    zipReq('/promote/aggregates/script', { sourceHostId: src, targetHostId: tgt, aggregates, modelMap }, 'promote-aggregates.zip'),
}
