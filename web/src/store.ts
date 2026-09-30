import { create } from 'zustand'
import type { EnvId, Host, PromoteMode } from './api'

export type View = 'build' | 'manage' | 'promote' | 'test' | 'monitor' | 'settings'
export type Section = 'models' | 'aggs'
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
export type SettingsSection = 'hosts' | 'storage'
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
  view: View
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
  manage: HostPick & { modelKey: string | null; sel: string[]; q: string }
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

  setView: (v: View) => void
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

export const useUi = create<UiState>((set) => ({
  view: 'build',
  section: 'models',
  buildSection: 'discover',
  build: { env: 'dev', hostId: null },
  testSection: 'run',
  settingsSection: 'hosts',
  test: { env: 'dev', hostId: null },
  testRunId: null,
  testCompare: { baseline: null, candidate: null },
  monitorSection: 'overview',
  monitor: { env: 'prod', hostId: null },
  monitorRange: { preset: '24h' },
  monitorFilters: { model: '', user: '', queryType: '' },
  monitorAuto: false,
  manage: { env: 'dev', hostId: null, modelKey: null, sel: [], q: '' },
  src: { env: 'dev', hostId: null },
  tgt: { env: 'qa', hostId: null },
  pModel: '',
  tModel: null,
  staged: { models: [], aggs: [] },
  branchFor: {},
  modeFor: {},
  replaceFor: {},
  toast: null,
  ask: null,
  linkOpen: false,

  setView: (view) => set({ view }),
  setBuildSection: (buildSection) => set({ buildSection }),
  setBuild: (build) => set({ build }),
  setTestSection: (testSection) => set({ testSection }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setTest: (test) => set({ test }),
  setTestRunId: (testRunId) => set({ testRunId }),
  setTestCompare: (p) => set((s) => ({ testCompare: { ...s.testCompare, ...p } })),
  setSection: (section) => set((s) => ({
    section, view: s.view === 'settings' ? 'manage' : s.view, manage: { ...s.manage, sel: [], q: '' },
  })),
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

/** Falls back to the first host in the group when the picked one isn't in it. */
export function resolveHost(hosts: Host[], pick: HostPick): Host | null {
  const inEnv = hosts.filter((h) => h.env === pick.env)
  return inEnv.find((h) => h.id === pick.hostId) ?? inEnv[0] ?? null
}
