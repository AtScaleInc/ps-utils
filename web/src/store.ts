import { create } from 'zustand'
import type { EnvId, Host, PromoteMode } from './api'

export type View = 'manage' | 'promote' | 'settings'
export type Section = 'models' | 'aggs'

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
  manage: HostPick & { modelKey: string | null; sel: string[]; q: string }
  src: HostPick
  tgt: HostPick
  pModel: string
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
  setManage: (p: Partial<UiState['manage']>) => void
  setSrc: (p: HostPick) => void
  setTgt: (p: HostPick) => void
  setPModel: (m: string) => void
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
  view: 'manage',
  section: 'models',
  manage: { env: 'dev', hostId: null, modelKey: null, sel: [], q: '' },
  src: { env: 'dev', hostId: null },
  tgt: { env: 'qa', hostId: null },
  pModel: '',
  staged: { models: [], aggs: [] },
  branchFor: {},
  modeFor: {},
  replaceFor: {},
  toast: null,
  ask: null,
  linkOpen: false,

  setView: (view) => set({ view }),
  setSection: (section) => set((s) => ({
    section, view: s.view === 'settings' ? 'manage' : s.view, manage: { ...s.manage, sel: [], q: '' },
  })),
  setManage: (p) => set((s) => ({ manage: { ...s.manage, ...p } })),
  // Changing the source host or group clears what's staged (§5 other rules).
  setSrc: (src) => set({ src, staged: { models: [], aggs: [] }, pModel: '', branchFor: {}, modeFor: {}, replaceFor: {} }),
  setTgt: (tgt) => set({ tgt }),
  setPModel: (pModel) => set({ pModel }),
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
