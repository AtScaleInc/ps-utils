import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type ConnStatus, type DiffState, type EnvId, type Host } from '../api'

export const ENVS: { id: EnvId; label: string; color: string }[] = [
  { id: 'dev', label: 'Dev', color: '#2AA5C7' },
  { id: 'qa', label: 'Test-QA', color: '#12A594' },
  { id: 'prod', label: 'Prod', color: '#F07B29' },
]
export const envOf = (id: EnvId) => ENVS.find((e) => e.id === id) ?? ENVS[0]

const STAT: Record<string, [string, string]> = {
  Deployed: ['#12A594', '#FFFFFF'], Linked: ['#0E0E0E', '#2AA5C7'], Error: ['#FF3B35', '#FFFFFF'],
  Built: ['#12A594', '#FFFFFF'], Stale: ['#F5A623', '#161616'], Building: ['#2AA5C7', '#FFFFFF'],
  Inactive: ['#0E0E0E', 'rgba(255,255,255,.56)'], Invalid: ['#F5A623', '#161616'],
}
const DIFF: Record<DiffState, [string, string]> = {
  new: ['#2AA5C7', '#FFFFFF'], upd: ['#F07B29', '#FFFFFF'], same: ['rgba(255,255,255,.08)', 'rgba(255,255,255,.56)'],
  older: ['#F5A623', '#161616'], diverged: ['#F5A623', '#161616'], unknown: ['#333333', '#CFCFCF'], uda: ['#333333', '#CFCFCF'],
  noexp: ['#333333', '#CFCFCF'], srcoff: ['#333333', '#CFCFCF'],
  miss: ['#FF3B35', '#FFFFFF'], dup: ['#FF3B35', '#FFFFFF'], repl: ['#F5A623', '#161616'],
}
export const CONN: Record<ConnStatus, [string, string]> = {
  connected: ['Connected', '#3BD44A'], untested: ['Not tested', '#9A9A9A'], failed: ['Failed', '#FF3B35'],
  testing: ['Testing…', '#F5A623'], missing: ['Not set', '#9A9A9A'],
}

export const diffColors = (s: DiffState) => DIFF[s]

export function StatusPill({ status, note }: { status: string; note?: string | null }) {
  const [bg, fg] = STAT[status] ?? ['#333333', '#CFCFCF']
  return <span className="pill" title={note ?? undefined} style={{ background: bg, color: fg, cursor: note ? 'help' : undefined }}>{status}</span>
}

export function DiffPill({ state, label }: { state: DiffState; label: string }) {
  const [bg, fg] = DIFF[state]
  return <span className="pill" style={{ background: bg, color: fg }}>{label}</span>
}

export function ConnDot({ status, label }: { status: ConnStatus; label?: string }) {
  const [text, color] = CONN[status] ?? CONN.untested
  return <span className="status" style={{ color }}><span className="dot" style={{ background: color }} />{label ?? text}</span>
}

export function Checkbox({ state, onClick }: { state: 'on' | 'off' | 'some'; onClick?: (e: React.MouseEvent) => void }) {
  return <span className={`cb ${state === 'on' ? 'on' : ''}`} onClick={onClick}>{state === 'on' ? '✓' : state === 'some' ? '–' : ''}</span>
}

export function EnvSegment({ value, onPick }: { value: EnvId; onPick: (e: EnvId) => void }) {
  return (
    <div className="seg">
      {ENVS.map((e) => {
        const on = e.id === value
        return (
          <button key={e.id} type="button" className={on ? 'on' : ''} style={{ background: on ? e.color : 'transparent' }} onClick={() => onPick(e.id)}>
            <span className="sq" style={{ width: 7, height: 7, background: on ? '#FFFFFF' : e.color }} />{e.label}
          </button>
        )
      })}
    </div>
  )
}

export function HostSelect({ hosts, env, value, onChange }: { hosts: Host[]; env: EnvId; value: string | null; onChange: (id: string) => void }) {
  const opts = hosts.filter((h) => h.env === env)
  return (
    <select className="select host" value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={!opts.length}>
      {!opts.length && <option value="">No hosts in group</option>}
      {opts.map((h) => <option key={h.id} value={h.id}>{h.label} — {h.hostname || 'no host set'}</option>)}
    </select>
  )
}

export function useHosts() {
  return useQuery({ queryKey: ['hosts'], queryFn: api.hosts })
}

export function useGit() {
  const q = useQuery({ queryKey: ['git'], queryFn: api.git })
  const ready = !!q.data && q.data.hasToken && q.data.status !== 'failed'
  return { ...q, ready }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const day = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`
  return withTime ? `${day} ${fmtTime(iso)}` : day
}
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function ago(epochSec: number, now: number): string {
  const m = Math.max(0, Math.floor((now - epochSec * 1000) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ${m % 60}m ago`
}

/** Reloads the current lists from AtScale, bypassing the 2 h cache. */
export function RefreshButton({ cachedAt, onRefresh, cachedFor = '2 h' }: {
  cachedAt: number | null | undefined; onRefresh: () => Promise<unknown>
  /** How long the list is kept before it reloads by itself (tooltip only). */
  cachedFor?: string
}) {
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const run = async () => {
    setBusy(true)
    try { await onRefresh() } finally { setBusy(false); setNow(Date.now()) }
  }
  const title = cachedAt ? `Loaded from AtScale ${new Date(cachedAt * 1000).toLocaleTimeString()} · cached for ${cachedFor}` : 'Reload from AtScale'
  return (
    <button type="button" className="btn info" style={{ height: 32, display: 'flex', alignItems: 'center', gap: 8 }} disabled={busy} title={title} onClick={run}>
      <span style={{ display: 'inline-block', animation: busy ? 'spin 0.9s linear infinite' : undefined }}>↻</span>
      {busy ? 'Refreshing…' : 'Refresh'}
      {cachedAt && !busy && <span className="hint" style={{ fontSize: 9 }}>{ago(cachedAt, now)}</span>}
    </button>
  )
}

/** The repo's GitHub branches, each with its head commit. AtScale deploys a
 * branch head, not a commit, so the head shown is what would land. */
export function BranchSelect({ hostId, repoUrl, value, onChange, compact }: {
  hostId: string; repoUrl: string; value: string; onChange: (b: string) => void; compact?: boolean
}) {
  const q = useQuery({ queryKey: ['branches', hostId, repoUrl], queryFn: () => api.branches(hostId, repoUrl) })
  const list = q.data?.branches ?? []
  const names = [...new Set([value, ...list.map((b) => b.name)])]
  const sha = (n: string) => list.find((b) => b.name === n)?.sha?.slice(0, 7)
  return (
    <select className="select" title={q.isError ? errMsg(q.error) : 'Branch head is what gets deployed'}
      style={compact ? { height: 26, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 11 } : { height: 34, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
      value={value} onChange={(e) => onChange(e.target.value)} onMouseDown={(e) => e.stopPropagation()}>
      {names.map((n) => <option key={n} value={n}>{n}{sha(n) ? ` · ${sha(n)}` : ''}</option>)}
    </select>
  )
}
