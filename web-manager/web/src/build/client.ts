// Ported from sml-wizard web/src/api/client.ts. Login/session calls are gone:
// hosts and credentials come from Settings, host-bound calls go through
// /api/hosts/<id>/..., and Git credentials are the shared Git profile.
const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body?.error ?? `Request to ${path} failed with ${res.status}`)
  }
  return body as T
}

// Build works on one host at a time (the host picked in the Build bar);
// BuildView sets it here so the ported panels keep their call signatures.
let buildHostId: string | null = null
export function setBuildHost(id: string | null) {
  buildHostId = id
}
function hostPath(path: string): string {
  if (!buildHostId) throw new Error('Pick a host in the Build bar first')
  return `/hosts/${encodeURIComponent(buildHostId)}${path}`
}

export interface SourceSummary {
  id: string
  label: string
  dialect: string | null
  connectionId: string
  database: string
  /** Set when AtScale couldn't list this warehouse's databases (no `database` then). */
  error?: string
}

/** Every warehouse database, including warehouses AtScale couldn't list (`error` set). */
export async function fetchSourceList(refresh = false) {
  return (await request<{ sources: SourceSummary[] }>(hostPath(`/sources${refresh ? '?refresh=1' : ''}`))).sources
}

/** Only the usable sources (each has a database). */
export async function fetchSources() {
  return (await fetchSourceList()).filter((s) => !s.error)
}

export interface SchemaColumn {
  name: string
  type: string
}

export interface SchemaTable {
  name: string
  /** Not in the schema tree (names only); load with fetchTableColumns. */
  columns?: SchemaColumn[]
}

export interface SchemaEntry {
  name: string
  tables: SchemaTable[]
  /** AtScale couldn't list this schema's tables. */
  error?: string
  /** Tables still being listed in the background - poll /schemas again. */
  loading?: boolean
}

export function fetchSchemas(sourceId: string, search?: string, refresh = false) {
  const qs = new URLSearchParams()
  if (search) qs.set('search', search)
  if (refresh) qs.set('refresh', '1')
  const q = qs.toString()
  return request<SchemaEntry[]>(hostPath(`/sources/${encodeURIComponent(sourceId)}/schemas${q ? `?${q}` : ''}`))
}

/** One table's columns (cached on the API per table). */
export function fetchTableColumns(sourceId: string, schema: string, table: string) {
  const qs = new URLSearchParams({ schema, table })
  return request<SchemaColumn[]>(hostPath(`/sources/${encodeURIComponent(sourceId)}/columns?${qs}`))
}

/** Several tables' columns: -> {"schema.table": columns}. */
export function fetchTablesColumns(sourceId: string, tables: { schema: string; table: string }[]) {
  return request<Record<string, SchemaColumn[]>>(hostPath(`/sources/${encodeURIComponent(sourceId)}/columns`), {
    method: 'POST', body: JSON.stringify({ tables }),
  })
}

export interface SmlFile {
  name: string
  body: string
}

export interface GenerateSmlPayload {
  modelName: string
  catalogName?: string
  connectionName: string
  asConnection: string
  database: string
  schema: string
  dialect?: string | null
  nodes: unknown[]
  joins: unknown[]
  cfg: Record<string, unknown>
  calculations?: unknown[]
  /** Set when this model was loaded from an AtScale-attached repo - deploy
   *  pushes back to this exact repo/branch instead of computing a new
   *  slug-derived repo name, which would create an unrelated duplicate repo. */
  gitRepoUrl?: string
  gitBranch?: string
  /** A shared dimensions package: no model; Deploy only attaches the repo. */
  shared?: boolean
}

export interface HostDeployResult {
  hostId: string
  label: string
  env: string
  ok: boolean
  catalogId?: string | null
  warnings?: string[]
  error?: string
  /** Shared dimensions: the repo was attached (nothing deployed). */
  attached?: boolean
}

export interface DeployResult {
  git: { repoUrl: string; branch: string; commit: string; created: boolean; path: string }
  fileCount: number
  results: HostDeployResult[]
  shared?: boolean
}

interface Job<T> { id: string; status: 'running' | 'done' | 'failed'; result: T | null; error: string | null }

/** The Deploy pipeline: generate SML -> save to the model's working copy ->
 *  push to Git once -> deploy that branch on every host in `hostIds`. */
export async function deployModel(payload: GenerateSmlPayload, hostIds: string[]): Promise<DeployResult> {
  const res = await fetch(`${BASE}/build/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, hostIds }),
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 422 && Array.isArray(body.errors)) {
    throw new SmlValidationFailure(body.errors)
  }
  if (!res.ok) throw new Error(body?.error ?? `Deploy failed with ${res.status}`)
  let job = body as Job<DeployResult>
  while (job.status === 'running') {
    await new Promise((r) => setTimeout(r, 1000))
    job = await request<Job<DeployResult>>(`/jobs/${job.id}`)
  }
  if (job.status === 'failed' || !job.result) throw new Error(job.error ?? 'Deploy failed')
  return job.result
}

/** Which hosts have the model's data warehouse connection. */
export async function deployPreflight(connectionId: string, hostIds: string[]) {
  const qs = `?connection=${encodeURIComponent(connectionId)}&hostIds=${hostIds.map(encodeURIComponent).join(',')}`
  return (await request<{ hosts: { hostId: string; ok: boolean; error?: string }[] }>(`/build/preflight${qs}`)).hosts
}

export class SmlValidationFailure extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(errors.join('; '))
    this.errors = errors
  }
}

export async function generateSml(payload: GenerateSmlPayload) {
  const res = await fetch(`${BASE}/sml/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  if (res.status === 422 && Array.isArray(body.errors)) {
    throw new SmlValidationFailure(body.errors)
  }
  if (!res.ok) {
    throw new Error(body?.error ?? `Generate failed with ${res.status}`)
  }
  return body as { files: SmlFile[] }
}

/** package.yml's packages are fetched and staged for sml-cli; `shared`
 *  accepts a package repo's missing model. */
export function validateSml(files: SmlFile[], shared = false) {
  return request<{ passed: boolean; returncode: number; output: string }>('/sml/validate', {
    method: 'POST',
    body: JSON.stringify({ files, shared }),
  })
}

// -- Shared dimensions (SML packages, api/smlgen/packages.py) ------------------------------

export interface SharedRepo {
  name: string
  fullName: string
  url: string
  branch: string
  /** catalog.yml carries the shared-dimensions tag; false = a repo with no model. */
  tagged: boolean
  source: 'git' | 'host'
}

export async function fetchSharedRepos(hostId: string | null, refresh = false) {
  const qs = new URLSearchParams()
  if (hostId) qs.set('hostId', hostId)
  if (refresh) qs.set('refresh', '1')
  return (await request<{ repos: SharedRepo[] }>(`/build/shared-repos?${qs}`)).repos
}

export interface LoadedSharedRepo {
  package: import('./modelStore').PackageRef
  commit: { sha: string; date: string; message: string }
  /** The package's connection unique_names - must differ from the model's own. */
  connections: string[]
  nodes: import('./modelStore').Node[]
  joins: import('./modelStore').Join[]
  cfg: Record<string, import('./modelStore').ColumnConfig>
}

/** The repo's dimensions at the branch head, pinned as `commit:<sha>`. */
export function loadSharedRepo(body: { repoUrl: string; branch: string; taken: string[] }) {
  return request<LoadedSharedRepo>('/build/shared/load', { method: 'POST', body: JSON.stringify(body) })
}

export interface ImportedSource {
  connectionId: string | null
  database: string | null
  dialect: string | null
}

export interface ImportedModel {
  nodes: unknown[]
  joins: unknown[]
  cfg: Record<string, unknown>
  calculations?: unknown[]
  source?: ImportedSource | null
  /** Catalog carries Build's marker comment (api/smlgen/support.py). */
  builtHere?: boolean
  /** Non-empty = open read-only: Save / Deploy would drop these. */
  unsupported?: { feature: string; detail: string; file: string; kind: 'complex' | 'detail' }[]
  /** A shared dimensions repo (tagged, or no model). */
  shared?: boolean
  /** package.yml entries that couldn't be fetched. */
  packageWarnings?: string[]
  /** A working copy made by Import & convert (routes/importer.py) - read-only. */
  imported?: boolean
}

/** Parse SML files already in hand (an XML import's conversion) onto the canvas. */
export function importSmlFiles(files: SmlFile[]) {
  return request<ImportedModel>('/sml/import', { method: 'POST', body: JSON.stringify({ files }) })
}

export function importSmlPath(path: string) {
  return request<ImportedModel>('/sml/import-path', { method: 'POST', body: JSON.stringify({ path }) })
}

export function importSmlGit(payload: { repoUrl?: string; branch?: string; modelName?: string }) {
  return request<ImportedModel>('/sml/import-git', { method: 'POST', body: JSON.stringify(payload) })
}

/** Saving IS generating SML and writing it somewhere real - no separate
 *  proprietary state format. Loading is /sml/import-path or /sml/import-git. */
export function saveSmlToPath(path: string, files: SmlFile[]) {
  return request<{ ok: boolean; path: string; count: number }>('/sml/save-path', {
    method: 'POST',
    body: JSON.stringify({ path, files }),
  })
}

/** Default save path: writes into workspace/<slugified-model-name>/ on the
 *  API server - no manual path typing. Same directory publish/deploy stages
 *  into, so Save and Deploy share one working copy per model. */
export function saveSml(modelName: string, files: SmlFile[]) {
  return request<{ ok: boolean; path: string; count: number }>('/sml/save', {
    method: 'POST',
    body: JSON.stringify({ modelName, files }),
  })
}

export interface WorkspaceModel {
  name: string
  path: string
  /** Present when this workspace directory is a real git clone (created by
   *  importSmlGit's modelName-targeted clone) - lets Load resume it as an
   *  update (commit on top of real history) rather than a brand new repo. */
  gitRepoUrl?: string
  gitBranch?: string
}

export function fetchWorkspaceModels() {
  return request<WorkspaceModel[]>('/sml/models')
}

export interface AttachedRepoProject {
  id: string
  name: string
  caption?: string
  models?: { id: string; name: string; caption?: string }[]
}

export interface AttachedRepo {
  repoId: string
  name: string
  url: string
  branch: string
  projects: AttachedRepoProject[]
}

export function fetchAttachedRepos() {
  return request<AttachedRepo[]>(hostPath('/build/repos'))
}

/** Unregisters a repo AtScale still lists as attached even though its
 *  actual Git side is gone (e.g. the GitHub repo was deleted) - only
 *  removes AtScale's own attachment record, not anything already deployed. */
export function unlinkAttachedRepo(repoId: string) {
  return request<{ ok: boolean }>(hostPath(`/build/repos/${encodeURIComponent(repoId)}`), { method: 'DELETE' })
}

// -- Cube data preview (Preview tab) -----------------------------------------

export interface CatalogCube {
  catalog: string
  catalogGuid: string | null
  cube: string
  cubeGuid: string | null
}

export function fetchPreviewCatalogs() {
  return request<CatalogCube[]>(hostPath('/preview/catalogs'))
}

export interface PreviewSecondaryAttribute {
  name: string
  caption: string
}

export interface PreviewLevel {
  uniqueName: string
  caption: string
  secondaryAttributes: PreviewSecondaryAttribute[]
}

export interface PreviewHierarchy {
  uniqueName: string
  caption: string
  levels: PreviewLevel[]
}

export interface PreviewDimension {
  uniqueName: string
  caption: string
  hierarchies: PreviewHierarchy[]
}

export interface PreviewMeasureItem {
  uniqueName: string
  caption: string
}

export interface PreviewMeasureFolder {
  folder: string
  items: PreviewMeasureItem[]
}

export interface PreviewMetadata {
  dimensions: PreviewDimension[]
  measures: PreviewMeasureFolder[]
}

export function fetchPreviewMetadata(catalog: string, cube: string) {
  const qs = `?catalog=${encodeURIComponent(catalog)}&cube=${encodeURIComponent(cube)}`
  return request<PreviewMetadata>(hostPath(`/preview/metadata${qs}`))
}

export interface PreviewQueryPayload {
  catalog: string
  cube: string
  dialect: 'mdx' | 'sql'
  hierarchies: string[]
  measures: string[]
  useAgg?: boolean
  useCache?: boolean
}

export interface PreviewQueryResult {
  columns: string[]
  rows: (string | null)[][]
  query: string
  /** More rows existed than the preview returns (maxRows). */
  truncated?: boolean
  maxRows?: number
}

export function runPreviewQuery(payload: PreviewQueryPayload) {
  return request<PreviewQueryResult>(hostPath('/preview/query'), { method: 'POST', body: JSON.stringify(payload) })
}

/** Build > Preview > Freehand: run MDX or SQL the user typed against a catalog/cube. */
export function runFreehandQuery(payload: { catalog: string; cube: string; dialect: 'mdx' | 'sql'; query: string; useAgg?: boolean; useCache?: boolean }) {
  return request<PreviewQueryResult>(hostPath('/preview/freehand'), { method: 'POST', body: JSON.stringify(payload) })
}

// -- Discovery (api/routes/discovery.py) ---------------------------------------------------

export interface DiscoveryTableRef {
  source: string // SourceSummary.id: `${connectionId}::${database}`
  schema: string
  table: string
  dialect?: string | null
}

export interface DiscoveryFlag {
  level: 'warn' | 'info'
  text: string
}

export interface ProfileColumn {
  name: string
  type: string | null
  kind: 'numeric' | 'temporal' | 'string' | 'boolean' | 'other'
  nonNull: number | null
  distinct: number | null
  nulls: number | null
  nullPct: number | null
  distinctPct: number | null
  min: string | null
  max: string | null
  avg: number | null
  blanks?: number | null
  sentinels?: number | null
  negatives?: number | null
  future?: number | null
  patterns?: { pattern: string; share: number }[]
  storedAs?: 'number' | 'date' | null
  role: 'key' | 'join' | 'measure' | 'attribute' | 'time' | 'constant' | 'empty' | 'unknown'
  roleWhy: string
  flags: DiscoveryFlag[]
  error: string | null
}

export interface ProfileRun {
  id: number
  profiledAt: string
  rowCount: number | null
  columnCount: number
  elapsedMs: number
  columns: SchemaColumn[]
}

export interface ProfileDrift {
  since: string
  rowCount: number | null
  rowDelta: number | null
  rowDeltaPct: number | null
  added: string[]
  removed: string[]
  retyped: { name: string; from: string | null; to: string | null }[]
  shifts: { name: string; what: 'nullPct' | 'distinct'; from: number; to: number }[]
}

export interface TableProfile {
  id: number
  table: string
  profiledAt: string
  rowCount: number | null
  elapsedMs: number
  columns: ProfileColumn[]
  duplicates: { groups: number; extraRows: number } | null
  duplicatesError: string | null
  drift: ProfileDrift | null
  history: ProfileRun[]
}

export interface DiscoveryTable {
  dialect: string | null
  columns: SchemaColumn[]
  sample: { columns: string[]; rows: unknown[][]; source: string } | null
  sampleAt?: string
  sampleError?: string
  statistics: { type: string; columns: string[]; value: unknown; lastUpdated: string }[] | null
  statisticsAt?: string
  statisticsError?: string
}

export interface JoinCheck {
  from: string
  to: string
  keys: number
  distinctKeys: number
  orphanRows: number
  orphanKeys: number
  orphanPct: number
  orphanSample: unknown[]
  targetRows: number
  targetDistinct: number
  targetUnique: boolean
  fetchedAt: string
}

export interface DiscoveryStore {
  path: string
  profiles: number
  items: number
  bytes: number
  keepPerTable: number
  tables: { hostId: string; connectionId: string; database: string; schema: string; table: string; runs: number; newest: string; bytes: number }[]
}

function tableQs(t: DiscoveryTableRef, extra: Record<string, string | undefined> = {}) {
  const qs = new URLSearchParams({ source: t.source, schema: t.schema, table: t.table })
  if (t.dialect) qs.set('dialect', t.dialect)
  for (const [k, v] of Object.entries(extra)) if (v) qs.set(k, v)
  return qs.toString()
}

export const discoveryApi = {
  table: (t: DiscoveryTableRef, refresh = false) =>
    request<DiscoveryTable>(hostPath(`/discovery/table?${tableQs(t, { refresh: refresh ? '1' : undefined })}`)),
  profile: (t: DiscoveryTableRef, opts: { refresh?: boolean; id?: number } = {}) =>
    request<TableProfile>(hostPath(`/discovery/profile?${tableQs(t, {
      refresh: opts.refresh ? '1' : undefined, id: opts.id != null ? String(opts.id) : undefined,
    })}`)),
  /** The stored profile only - null when the table was never profiled (no scan). */
  cachedProfile: (t: DiscoveryTableRef) =>
    fetch(`${BASE}${hostPath(`/discovery/profile?${tableQs(t, { cached: '1' })}`)}`).then(async (res) => {
      const body = await res.json().catch(() => ({}))
      if (res.status === 404 && body?.notProfiled) return null
      if (!res.ok) throw new Error(body?.error ?? `Profile lookup failed with ${res.status}`)
      return body as TableProfile
    }),
  topValues: (t: DiscoveryTableRef, column: string, refresh = false) =>
    request<{ column: string; values: { value: unknown; count: number }[]; fetchedAt: string }>(
      hostPath(`/discovery/top-values?${tableQs(t, { column, refresh: refresh ? '1' : undefined })}`)),
  joinCheck: (t: DiscoveryTableRef, body: { column: string; toSchema: string; toTable: string; toColumn: string; refresh?: boolean }) =>
    request<JoinCheck>(hostPath('/discovery/join-check'), { method: 'POST', body: JSON.stringify({ ...t, ...body }) }),
  storeInfo: () => request<DiscoveryStore>('/discovery/store'),
  cleanup: (body: { olderThanDays?: number | null; keepPerTable?: number | null; hostId?: string | null; dryRun?: boolean }) =>
    request<{ count: number; runs?: { id: number; hostId: string; table: string; profiledAt: string }[] }>(
      '/discovery/cleanup', { method: 'POST', body: JSON.stringify(body) }),
  compact: () => request<{ freedBytes: number }>('/discovery/compact', { method: 'POST' }),
}

// -- Develop > Preview data (api/discovery/data_preview.py) -------------------------------

export type DataPreviewMode = 'rows' | 'aggregate' | 'check'

export interface DataPreviewRows {
  mode: 'rows' | 'aggregate'
  sql: string
  rows: (string | null)[][]
  /** The engine's query/sample limit (10) - not adjustable. */
  limit: number
  elapsedMs: number
}

export interface DataPreviewCheck {
  mode: 'check'
  sql: string
  rootRows: number | null
  joinedRows: number | null
  fanOut: boolean
  joins: { alias: string; table: string; parent: string; on: [string, string][]; matched: number | null }[]
  elapsedMs: number
}

export function runDataPreview(body: {
  source: string
  dialect?: string | null
  mode: DataPreviewMode
  tables: import('./lib/dataPreview').PreviewTable[]
  columns: { alias: string; column: string; agg?: string }[]
}) {
  return request<DataPreviewRows | DataPreviewCheck>(hostPath('/discovery/data-preview'), {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// -- Import & convert: another model's export -> SML (api/routes/importer.py) ---------------

/** xml: AtScale project_2_0 XML; ssas: SSAS Multidimensional XMLA; tabular: SSAS Tabular TMSL JSON. */
export type ImportKind = 'xml' | 'ssas' | 'tabular'

export interface ImportConnection {
  name: string
  file: string
  database: string | null
  schema: string | null
  asConnection: string | null
  datasets: number
}

export interface ImportSummary {
  counts: Record<string, number>
  connections: ImportConnection[]
  models: { name: string; file: string; visible: boolean }[]
}

export interface ImportInspection extends ImportSummary {
  kind: ImportKind
  project: string
  caption: string | null
  cubes: { name: string; caption: string | null; visible: boolean }[]
  datasets: number
  /** Tabular: the warehouses it converts for, and the one its own data sources name (if any). */
  warehouses?: string[]
  warehouse?: string | null
}

/** Which ps-utils ran the conversion (api/smlgen/converters.py cli_info). */
export interface ImportConverter {
  source: 'repo' | 'npm'
  label: string
  version: string | null
  path: string
  builtAt?: string
}

export interface ImportConversion extends ImportSummary {
  files: SmlFile[]
  report: string
  log: string
  converter: ImportConverter
}

export interface ImportConnected extends ImportSummary {
  files: SmlFile[]
  validation: { passed: boolean; returncode: number | null; output: string }
  workspaceExists: boolean
}

/** A failed conversion carries the ps-utils CLI's log. */
export class ConversionFailure extends Error {
  log: string
  constructor(message: string, log: string) {
    super(message)
    this.log = log
  }
}

async function importRequest<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/build/import/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (typeof out?.log === 'string') throw new ConversionFailure(out.error ?? 'Conversion failed', out.log)
    throw new Error(out?.error ?? `Import ${path} failed with ${res.status}`)
  }
  return out as T
}

export interface DdlColumn {
  name: string
  /** The AtScale metadata type a live source would report (Int, Long, Decimal, String, ...). */
  type: string
  /** The type as the DDL wrote it, e.g. NUMBER(38,0). */
  ddlType: string
  nullable: boolean
  primaryKey: boolean
}

export interface DdlForeignKey {
  column: string
  toSchema: string | null
  toTable: string
  toColumn: string
}

export interface DdlTable {
  schema: string | null
  name: string
  kind: 'table' | 'view'
  columns: DdlColumn[]
  foreignKeys: DdlForeignKey[]
}

/** A parsed DDL file - Build › Import & convert › Database DDL. */
export interface DdlSchema {
  fileName: string
  tables: DdlTable[]
  schemas: string[]
  statements: number
  skipped: number
}

export function parseDdl(text: string, fileName: string) {
  return importRequest<DdlSchema>('ddl', { text, fileName })
}

export function inspectImport(kind: ImportKind, text: string, fileName: string) {
  return importRequest<ImportInspection>('inspect', { kind, text, fileName })
}

export function convertImport(payload: {
  kind: ImportKind
  text: string
  fileName: string
  repoName: string
  catalogName?: string
  modelMode: 'new' | 'existing'
  warehouse?: string
  models: Record<string, string>
}) {
  return importRequest<ImportConversion>('convert', payload)
}

/** The converted files, every connection pointed at the picked data source, validated with sml-cli. */
export function connectImport(payload: {
  repoName: string
  files: SmlFile[]
  asConnection: string
  connections: Record<string, { database: string; schema: string }>
}) {
  return importRequest<ImportConnected>('connect', payload)
}

export function saveImport(repoName: string, files: SmlFile[], replace: boolean) {
  return importRequest<{ ok: boolean; path: string; count: number }>('save', { repoName, files, replace })
}

export interface ImportPublishResult {
  git: DeployResult['git']
  fileCount: number
  results: (HostDeployResult & { linked?: number })[]
  action: 'link' | 'deploy'
}

/** Push to Git once, then link each model or deploy the branch on every host. */
export async function publishImport(body: {
  repoName: string
  catalogName?: string
  files: SmlFile[]
  models: string[]
  asConnection: string
  hostIds: string[]
  action: 'link' | 'deploy'
  replace: boolean
}): Promise<ImportPublishResult> {
  let job = await importRequest<Job<ImportPublishResult>>('publish', body)
  while (job.status === 'running') {
    await new Promise((r) => setTimeout(r, 1000))
    job = await request<Job<ImportPublishResult>>(`/jobs/${job.id}`)
  }
  if (job.status === 'failed' || !job.result) throw new Error(job.error ?? `${body.action} failed`)
  return job.result
}
