import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { api, type BusinessUnit } from '../api'
import { getBu } from '../bu'
import { useModelStore } from '../build/modelStore'
import { useUi } from '../store'
import { ConnDot, ENVS, errMsg, plural } from './ui'

export function useBus() {
  return useQuery({ queryKey: ['bus'], queryFn: api.bus })
}

const notBus = { predicate: (q: { queryKey: readonly unknown[] }) => q.queryKey[0] !== 'bus' }

/** Forget everything loaded for the old business unit. In-flight calls are
 * cancelled first, so a late answer can't land in the new BU's cache. */
function dropBuData(qc: QueryClient) {
  void qc.cancelQueries(notBus)
  qc.removeQueries(notBus)
  useModelStore.getState().reset()
}

/** Switch business unit. The Build canvas belongs to the BU it was loaded in
 * (its Git repo, its hosts), so a canvas with tables on it asks first. */
export function useSwitchBu() {
  const qc = useQueryClient()
  const { switchBu, setAsk } = useUi()
  return (bu: BusinessUnit, onSwitched?: () => void) => {
    const go = () => {
      // Every cached list (hosts, Git, models, runs, ...) is the old BU's.
      dropBuData(qc)
      switchBu(bu.id)
      onSwitched?.()
    }
    if (useUi.getState().bu === bu.id) return onSwitched?.()
    if (useModelStore.getState().nodes.length) {
      setAsk({
        eyebrow: 'Business unit', title: `Switch to ${bu.label}.`,
        note: 'The Build canvas is cleared: its model belongs to the current business unit. Save or deploy it first to keep it.',
        label: `Switch to ${bu.label}`, tone: 'danger', go,
      })
    } else {
      go()
    }
  }
}

/** Nothing else renders until the business unit is known: every API call carries it. */
export function BuGate({ children }: { children: ReactNode }) {
  const bus = useBus()
  const qc = useQueryClient()
  const { bu, switchBu } = useUi()
  const list = bus.data?.bus ?? []
  useEffect(() => {
    // A list still reloading may predate a BU just added: only a settled one decides.
    if (!bus.data || bus.isFetching || (bu && list.some((b) => b.id === bu))) return
    // The BU in use was removed (demo reset, another tab): drop what was loaded for it.
    if (bu) dropBuData(qc)
    // The remembered pick, unless it was removed meanwhile; else the API's default.
    const saved = getBu()
    switchBu(list.some((b) => b.id === saved) ? saved! : bus.data.current)
  }, [bus.data, bus.isFetching, bu, list, switchBu, qc])

  if (bus.isError) return <div className="gate"><span className="eyebrow" style={{ color: 'var(--danger)' }}>Can't reach the API</span><span className="muted">{errMsg(bus.error)}</span></div>
  if (!bu || !list.some((b) => b.id === bu) && !bus.isFetching) return <div className="gate"><span className="hint">Loading business units…</span></div>
  // Keyed by BU: switching remounts every view, so no component keeps the old BU's state.
  return <Fragment key={bu}>{children}</Fragment>
}

/** The header's business unit picker, under the product name. */
export function BuPicker() {
  const bus = useBus().data?.bus ?? []
  const { bu, setView, setSettingsSection } = useUi()
  const switchTo = useSwitchBu()
  return (
    <select className="bu-select" aria-label="Business unit" title="Business unit - each has its own Git profile and hosts"
      value={bu ?? ''} onChange={(e) => {
        if (e.target.value === '+') { setView('settings'); setSettingsSection('bus'); return }
        const next = bus.find((b) => b.id === e.target.value)
        if (next) switchTo(next)
      }}>
      {bus.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
      <option value="+">+ Manage business units…</option>
    </select>
  )
}

/** Settings › Business units: create, rename, remove; switch from here too. */
export function BusView() {
  const { bu, flash, setAsk, setSettingsSection } = useUi()
  const qc = useQueryClient()
  const bus = useBus()
  const list = bus.data?.bus ?? []
  const switchTo = useSwitchBu()
  const [name, setName] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['bus'] })

  const add = useMutation({
    mutationFn: (label: string) => api.addBu(label),
    onSuccess: async (b) => {
      setName('')
      await refresh()  // the picker and the gate must know the BU before it's switched to
      // A new BU starts empty: go set up its Git profile and hosts.
      switchTo(b, () => setSettingsSection('hosts'))
      flash(`${b.label} added - set its Git profile and hosts`)
    },
    onError: (e) => flash(errMsg(e), 'err'),
  })

  return (
    <div className="settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 680 }}>
        <span className="eyebrow" style={{ color: 'var(--dev)' }}>Settings — Business units</span>
        <span className="display" style={{ fontSize: 34 }}>One realm per <em>business unit</em>.</span>
        <span className="muted" style={{ fontSize: 13.5, lineHeight: 1.4 }}>
          Each business unit has its own Git profile and its own Dev, Test, QA and Prod hosts. Nothing is shared between them:
          pick one under the product name to work in it.
        </span>
      </div>

      <div className="card bu-list">
        {list.map((b) => <BuRow key={b.id} unit={b} current={b.id === bu} last={list.length === 1}
          onSwitch={() => switchTo(b)} onChanged={refresh}
          onDelete={() => setAsk({
            eyebrow: 'Business unit', title: `Remove ${b.label}.`, note: 'Its Git profile is deleted. It has no hosts.',
            label: 'Remove', tone: 'danger',
            go: () => api.deleteBu(b.id).then(() => { refresh(); flash(`${b.label} removed`) }, (e) => flash(errMsg(e), 'err')),
          })} />)}
        <form className="bu-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(name.trim()) }}>
          <input className="input" value={name} placeholder="New business unit name" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn primary" style={{ height: 32 }} disabled={!name.trim() || add.isPending}>Add business unit</button>
        </form>
      </div>
    </div>
  )
}

function BuRow({ unit, current, last, onSwitch, onChanged, onDelete }: {
  unit: BusinessUnit; current: boolean; last: boolean; onSwitch: () => void; onChanged: () => void; onDelete: () => void
}) {
  const { flash } = useUi()
  const [label, setLabel] = useState<string | null>(null)
  const rename = useMutation({
    mutationFn: (l: string) => api.patchBu(unit.id, l),
    onSettled: () => { setLabel(null); onChanged() },
    onError: (e) => flash(errMsg(e), 'err'),
  })
  const blocked = current ? 'Switch to another business unit first' : last ? 'The last business unit stays'
    : unit.hosts ? `Remove its ${plural(unit.hosts, 'host')} first` : ''
  return (
    <div className={`bu-row ${current ? 'on' : ''}`}>
      <input className="input title" value={label ?? unit.label} aria-label="Business unit name"
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => { if (label !== null && label.trim() && label.trim() !== unit.label) rename.mutate(label.trim()); else setLabel(null) }} />
      <span className="bu-groups">
        {ENVS.map((e) => <span key={e.id} className="env-count"><span className="sq" style={{ background: e.color }} />{e.label} · {unit.groups[e.id] ?? 0}</span>)}
      </span>
      <ConnDot status={unit.git.status} label={unit.git.hasToken ? `Git ${unit.git.username || 'token'}` : 'Git not set'} />
      {current ? <span className="hint" style={{ color: 'var(--dev)' }}>Current</span>
        : <button type="button" className="btn info" style={{ height: 30 }} onClick={onSwitch}>Switch</button>}
      <button type="button" className="btn ghost" style={{ height: 30 }} disabled={!!blocked} title={blocked || 'Remove this business unit'} onClick={onDelete}>Remove</button>
    </div>
  )
}
