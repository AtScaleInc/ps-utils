import type { MonitorQuery, QueryClass } from './api'
import type { Key } from './charts'

// Categorical slots validated on the panel surface (dataviz validate_palette.js, dark, #242424).
export const CLS: Record<QueryClass, { label: string; long: string; color: string }> = {
  cache: { label: 'Cache', long: 'Served from cache', color: '#199e70' },
  agg: { label: 'Aggregate', long: 'Used an aggregate', color: '#3987e5' },
  raw: { label: 'No aggregate', long: 'Warehouse, no aggregate', color: '#d95926' },
}
export const CLS_KEYS: Key[] = (['agg', 'cache', 'raw'] as QueryClass[]).map((k) => ({ key: k, label: CLS[k].label, color: CLS[k].color }))
export const TYPE_COLOR = { User: '#9085e9', System: '#c98500' }
export const P95_COLOR = '#3987e5'
/** Hit-rate lines: the aggregate and cache slots, so each rate wears the colour of what it counts. */
export const HIT_COLOR = { agg: '#3987e5', cache: '#199e70' }
/** A rate as the 0-1 ratio AtScale reports (0.73). */
export const fmtRate = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2))
export const AUTO_POLL_MS = 5 * 60e3

export function ClsPill({ cls }: { cls: QueryClass }) {
  return <span className="pill" style={{ background: 'transparent', border: `1px solid ${CLS[cls].color}`, color: 'var(--ink)' }}>
    <span className="viz-key" style={{ background: CLS[cls].color, marginRight: 6 }} />{CLS[cls].label}
  </span>
}

export function StatusText({ q }: { q: Pick<MonitorQuery, 'status'> }) {
  const color = q.status === 'failed' ? 'var(--danger)' : q.status === 'running' ? 'var(--warn)' : 'var(--muted)'
  return <span className="status" style={{ color }}>{q.status === 'failed' ? '✕ ' : q.status === 'running' ? '… ' : ''}{q.status}</span>
}
