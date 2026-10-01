import { create } from 'zustand'
import type { EnvId, Host, PromoteMode } from './api'
import { setBu } from './bu'
import { effectiveEnv, usedEnvs } from './components/ui'

export type View = 'catalog' | 'build' | 'manage' | 'promote' | 'test' | 'monitor' | 'settings'
export type Section = 'models' | 'aggs'
/** Catalog's left-rail sections: every model across the BU's hosts, and validating one model wherever it's deployed. */
export type CatalogSection = 'models' | 'validate'
/** A model in the Catalog: its repo + name (the same model on every host). */
export interface CatalogPick { repoUrl: string; model: string }
/** Build's left-rail sections: table discovery / profiling, the wizard canvas, and the cube data preview. */
export type BuildSection = 'discover' | 'model' | 'preview'
/** Test's left-rail sections: set up + run, past runs by model, baseline-vs-candidate result and model compares. */
export type TestSection = 'run' | 'results' | 'compare' | 'model'
/** Monitor's left-rail sections: charts, the query list, where to act. */
export type MonitorSection = 'overview' | 'history' | 'hotspots'
/** Report window: a preset back from now, or a fixed from..to (epoch ms). */
export type MonitorRange = { preset: '1h' | '24h' | '2d' | '7d' | '30d' } | { preset: 'custom'; fromMs: number; toMs: number }
export interface MonitorFilters { model: string; user: string; queryType: '' | 'User' | 'System' }
/** Settings' left-rail sections. */
export type SettingsSection = 'hosts' | 'bus' | 'storage'
export interface RunSide { runId: string; hostId: string }

export interface Ask {
  eyebrow: string
  title: string
  note: string
  label: string
  tone?: 'danger' | 'prod'
  items?: { name: string; pill?: { label: string; bg: string; fg: string } }[]
  go: () => void
}

interface HostPick { env: EnvId; hostId: string | null }

interface UiState {
  /** Business unit everything below works in (bu.ts sends it as X-BU); null until /bus has loaded. */
  bu: string | null
  view: View
  catalogSection: CatalogSection
  /** Catalog's open model - shared by Models and Validate (the expanded row in each). */
  catalogPick: CatalogPick | null
  section: Section
  buildSection: BuildSection
  /** Build's host: where data sources are browsed and the default deploy target. */
  build: HostPick
  testSection: TestSection
  settingsSection: SettingsSection
  /** Test's reference host: where the model is read and queries generated. */
  test: HostPick
  /** Run shown in the results panel (live or from history). */
  testRunId: string | null
  /** Compare results: baseline vs candidate (run + host each). */
  testCompare: { baseline: RunSide | null; candidate: RunSide | null }
  monitorSection: MonitorSection
  /** Monitor's host: whose query history is polled and reported. */
  monitor: HostPick
  monitorRange: MonitorRange
  monitorFilters: MonitorFilters
  /** Poll the host every 5 minutes while the app is open. */
  monitorAuto: boolean
  /** analyzeKey: the model (ModelRow.key) Manage › Analyze audits. */
  manage: HostPick & { modelKey: string | null; analyzeKey: string | null; sel: string[]; q: string }
  /** Manage's Analyze section is open (Models / Aggregates otherwise - `section`, shared with Promote). */
  manageAnalyze: boolean
  src: HostPick
  tgt: HostPick
  pModel: string
  /** Target-model override for aggregates (null = matched by name): promote pModel's aggregates into this model. */
  tModel: string | null
  staged: Record<Section, string[]>
  /** Branch to deploy on the target, per staged model name. */
  branchFor: Record<string, string>
  /** Per staged model: deploy (default) or link only, and whether to undeploy the target's other-branch catalog. */
  modeFor: Record<string, PromoteMode>
  replaceFor: Record<string, boolean>
  toast: { msg: string; tone: 'ok' | 'err' | 'warn' } | null
  ask: Ask | null
  linkOpen: boolean

  /** Work in another business unit: every host pick, staged item and run is that BU's own, so they reset. */
  switchBu: (id: string) => void
  setView: (v: View) => void
  setCatalogSection: (s: CatalogSection) => void
  setCatalogPick: (p: CatalogPick | null) => void
  setSection: (s: Section) => void
  setBuildSection: (s: BuildSection) => void
  setBuild: (p: HostPick) => void
  setTestSection: (s: TestSection) => void
  setSettingsSection: (s: SettingsSection) => void
  setTest: (p: HostPick) => void
  setTestRunId: (id: string | null) => void
  setTestCompare: (p: Partial<UiState['testCompare']>) => void
  setMonitorSection: (s: MonitorSection) => void
  setMonitor: (p: HostPick) => void
  setMonitorRange: (r: MonitorRange) => void
  setMonitorFilters: (p: Partial<MonitorFilters>) => void
  setMonitorAuto: (on: boolean) => void
  setManage: (p: Partial<UiState['manage']>) => void
  setManageAnalyze: (on: boolean) => void
  setSrc: (p: HostPick) => void
  setTgt: (p: HostPick) => void
  setPModel: (m: string) => void
  setTModel: (m: string | null) => void
  stage: (names: string[]) => void
  unstage: (name: string) => void
  setBranch: (name: string, branch: string) => void
  setMode: (name: string, mode: PromoteMode) => void
  setReplace: (name: string, on: boolean) => void
  clearStaged: () => void
  flash: (msg: string, tone?: 'ok' | 'err' | 'warn') => void
  setAsk: (a: Ask | null) => void
  setLinkOpen: (o: boolean) => void
}

let toastTimer: ReturnType<typeof setTimeout> | undefined

/** Everything that names a host, model or run - all of it belongs to one business unit. */
const BU_SCOPED = {
  catalogPick: null,
  build: { env: 'dev', hostId: null },
  test: { env: 'dev', hostId: null },
  testRunId: null,
  testCompare: { baseline: null, candidate: null },
  monitor: { env: 'prod', hostId: null },
  monitorFilters: { model: '', user: '', queryType: '' },
  monitorAuto: false,
  manage: { env: 'dev', hostId: null, modelKey: null, analyzeKey: null, sel: [], q: '' },
  src: { env: 'dev', hostId: null },
  tgt: { env: 'test', hostId: null },
  pModel: '',
  tModel: null,
  staged: { models: [], aggs: [] },
  branchFor: {},
  modeFor: {},
  replaceFor: {},
  linkOpen: false,
} satisfies Partial<UiState>

export const useUi = create<UiState>((set) => ({
  ...BU_SCOPED,
  bu: null,
  view: 'build',
  catalogSection: 'models',
  section: 'models',
  buildSection: 'discover',
  testSection: 'run',
  settingsSection: 'hosts',
  monitorSection: 'overview',
  monitorRange: { preset: '24h' },
  manageAnalyze: false,
  toast: null,
  ask: null,

  switchBu: (bu) => {
    setBu(bu)
    set({ ...BU_SCOPED, bu, ask: null })
  },
  setView: (view) => set({ view }),
  setCatalogSection: (catalogSection) => set({ catalogSection }),
  setCatalogPick: (catalogPick) => set({ catalogPick }),
  setBuildSection: (buildSection) => set({ buildSection }),
  setBuild: (build) => set({ build }),
  setTestSection: (testSection) => set({ testSection }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setTest: (test) => set({ test }),
  setTestRunId: (testRunId) => set({ testRunId }),
  setTestCompare: (p) => set((s) => ({ testCompare: { ...s.testCompare, ...p } })),
  setSection: (section) => set((s) => ({
    section, view: s.view === 'settings' ? 'manage' : s.view, manage: { ...s.manage, sel: [], q: '' }, manageAnalyze: false,
  })),
  setManageAnalyze: (manageAnalyze) => set((s) => ({ manageAnalyze, manage: { ...s.manage, sel: [], q: '' } })),
  setMonitorSection: (monitorSection) => set({ monitorSection }),
  // Model / user names are per host: another host starts unfiltered.
  setMonitor: (monitor) => set((s) => ({ monitor, monitorFilters: { ...s.monitorFilters, model: '', user: '' } })),
  setMonitorRange: (monitorRange) => set({ monitorRange }),
  setMonitorFilters: (p) => set((s) => ({ monitorFilters: { ...s.monitorFilters, ...p } })),
  setMonitorAuto: (monitorAuto) => set({ monitorAuto }),
  setManage: (p) => set((s) => ({ manage: { ...s.manage, ...p } })),
  // Changing the source host or group clears what's staged (§5 other rules).
  setSrc: (src) => set({ src, staged: { models: [], aggs: [] }, pModel: '', tModel: null, branchFor: {}, modeFor: {}, replaceFor: {} }),
  setTgt: (tgt) => set({ tgt, tModel: null }),
  setPModel: (pModel) => set({ pModel, tModel: null }),
  // Another target model changes every diff state: drop the staged aggregates.
  setTModel: (tModel) => set((s) => ({ tModel, staged: { ...s.staged, aggs: [] } })),
  stage: (names) => set((s) => ({
    staged: { ...s.staged, [s.section]: [...s.staged[s.section], ...names.filter((n) => !s.staged[s.section].includes(n))] },
  })),
  unstage: (name) => set((s) => ({ staged: { ...s.staged, [s.section]: s.staged[s.section].filter((n) => n !== name) } })),
  setBranch: (name, branch) => set((s) => ({ branchFor: { ...s.branchFor, [name]: branch } })),
  setMode: (name, mode) => set((s) => ({ modeFor: { ...s.modeFor, [name]: mode } })),
  setReplace: (name, on) => set((s) => ({ replaceFor: { ...s.replaceFor, [name]: on } })),
  clearStaged: () => set((s) => ({ staged: { ...s.staged, [s.section]: [] } })),
  flash: (msg, tone = 'ok') => {
    clearTimeout(toastTimer)
    set({ toast: { msg, tone } })
    toastTimer = setTimeout(() => set({ toast: null }), tone === 'ok' ? 3500 : 7000)
  },
  setAsk: (ask) => set({ ask }),
  setLinkOpen: (linkOpen) => set({ linkOpen }),
}))

/** Promote's target group: as picked when it has hosts, else the next group with
 * hosts after the source's (Dev → Prod in a BU with only those two), not back
 * onto the source's group. */
export function targetPick(hosts: Host[], src: HostPick, tgt: HostPick): HostPick {
  const used = usedEnvs(hosts).map((e) => e.id)
  if (used.includes(tgt.env)) return tgt
  const srcEnv = effectiveEnv(hosts, src.env)
  return { ...tgt, env: used[used.indexOf(srcEnv) + 1] ?? srcEnv }
}

/** Falls back to the first host in the group when the picked one isn't in it,
 * and to the first group with hosts when the picked group has none. */
export function resolveHost(hosts: Host[], pick: HostPick): Host | null {
  const env = effectiveEnv(hosts, pick.env)
  const inEnv = hosts.filter((h) => h.env === env)
  return inEnv.find((h) => h.id === pick.hostId) ?? inEnv[0] ?? null
}
