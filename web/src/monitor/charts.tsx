// Monitor's charts: hand-built SVG (no chart dependency), dark theme only.
// Palette: validated categorical slots on the panel surface (#242424) - see monitor.css.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface Slice { key: string; label: string; value: number; color: string }
export interface Key { key: string; label: string; color: string }

export const fmtMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60e3) return `${(ms / 1000).toFixed(ms < 10e3 ? 2 : 1)} s`
  return `${Math.floor(ms / 60e3)}m ${Math.round((ms % 60e3) / 1000)}s`
}
export const fmtN = (n: number) => n.toLocaleString()
export const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(n / of < 0.1 ? 1 : 0)}%` : '—')

const pad2 = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function fmtStamp(ms: number, withDay = true) {
  const d = new Date(ms)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return withDay ? `${MONTHS[d.getMonth()]} ${pad2(d.getDate())} ${hm}` : hm
}
const tickLabel = (t: number, bucketMs: number) => {
  const d = new Date(t)
  return bucketMs >= 86400e3 ? `${MONTHS[d.getMonth()]} ${d.getDate()}`
    : bucketMs >= 6 * 3600e3 && d.getHours() === 0 ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** One tooltip per chart, positioned inside the chart's box. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null)
  const show = (e: React.PointerEvent | React.MouseEvent, body: ReactNode) => {
    const box = (e.currentTarget as Element).closest('.viz')!.getBoundingClientRect()
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, body })
  }
  const node = tip && (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y, transform: `translate(${tip.x > 260 ? 'calc(-100% - 12px)' : '12px'}, -50%)` }}>
      {tip.body}
    </div>
  )
  return { show, hide: () => setTip(null), node }
}

function TipRow({ color, label, value }: { color?: string; label: string; value: string }) {
  return (
    <div className="viz-tip-row">
      {color ? <span className="viz-key" style={{ background: color }} /> : <span className="viz-key blank" />}
      <b>{value}</b><span>{label}</span>
    </div>
  )
}

// -- donut ------------------------------------------------------------------------------------

function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
}

/** Part-to-whole of a few categories: ring + legend with value and share (identity never colour-alone). */
export function Donut({ slices, title, center, sub }: { slices: Slice[]; title: string; center: string; sub: string }) {
  const tip = useTip()
  const total = slices.reduce((a, s) => a + s.value, 0)
  const size = 148, c = size / 2, r1 = 70, r0 = 47
  let a = 0
  return (
    <div className="viz donut">
      <span className="eyebrow">{title}</span>
      <div className="donut-body">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${title}: ${slices.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
          {!total && <circle cx={c} cy={c} r={(r0 + r1) / 2} fill="none" stroke="var(--off)" strokeWidth={r1 - r0} />}
          {total > 0 && slices.filter((s) => s.value > 0).map((s) => {
            const a0 = a
            const a1 = a + (s.value / total) * Math.PI * 2
            a = a1
            const d = a1 - a0 >= Math.PI * 2 - 1e-6
              ? `${arc(c, c, r0, r1, 0, Math.PI)} ${arc(c, c, r0, r1, Math.PI, Math.PI * 2 - 1e-4)}` : arc(c, c, r0, r1, a0, a1)
            return (
              <path key={s.key} d={d} fill={s.color} stroke="var(--panel)" strokeWidth={2} className="viz-mark"
                onPointerMove={(e) => tip.show(e, <><div className="viz-tip-h">{title}</div><TipRow color={s.color} label={s.label} value={`${fmtN(s.value)} · ${pct(s.value, total)}`} /></>)}
                onPointerLeave={tip.hide} />
            )
          })}
          <text x={c} y={c - 2} textAnchor="middle" className="donut-v">{center}</text>
          <text x={c} y={c + 16} textAnchor="middle" className="donut-s">{sub}</text>
        </svg>
        <div className="legend col-legend">
          {slices.map((s) => (
            <div key={s.key} className="legend-row">
              <span className="viz-key" style={{ background: s.color }} />
              <span className="legend-l">{s.label}</span>
              <span className="legend-v">{fmtN(s.value)}</span>
              <span className="legend-p">{pct(s.value, total)}</span>
            </div>
          ))}
        </div>
      </div>
      {tip.node}
    </div>
  )
}

// -- axes helpers -------------------------------------------------------------------------------

function niceMax(v: number) {
  if (v <= 0) return 1
  const e = 10 ** Math.floor(Math.log10(v))
  const m = v / e
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * e
}

const M = { l: 48, r: 12, t: 10, b: 24 }

function Grid({ w, h, max, fmt }: { w: number; h: number; max: number; fmt: (v: number) => string }) {
  const ticks = [0, 0.5, 1].map((f) => f * max)
  return (
    <g>
      {ticks.map((v) => {
        const y = M.t + (h - M.t - M.b) * (1 - v / max)
        return (
          <g key={v}>
            <line x1={M.l} x2={w - M.r} y1={y} y2={y} className={v === 0 ? 'viz-base' : 'viz-grid'} />
            <text x={M.l - 8} y={y + 3} textAnchor="end" className="viz-tick">{fmt(v)}</text>
          </g>
        )
      })}
    </g>
  )
}

function XTicks<T extends { t: number }>({ points, x, h, bucketMs }: { points: T[]; x: (i: number) => number; h: number; bucketMs: number }) {
  const every = Math.max(1, Math.ceil(points.length / 7))
  return (
    <g>
      {points.map((p, i) => (i % every === 0 ? <text key={p.t} x={x(i)} y={h - 6} textAnchor="middle" className="viz-tick">{tickLabel(p.t, bucketMs)}</text> : null))}
    </g>
  )
}

// -- stacked volume bars ----------------------------------------------------------------------------

export function StackedBars<T extends { t: number }>({ title, points, keys, bucketMs, height = 190 }: {
  title: string; points: T[]; keys: Key[]; bucketMs: number; height?: number
}) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const [hover, setHover] = useState<number | null>(null)
  const val = (p: T, k: string) => Number((p as Record<string, unknown>)[k]) || 0
  const tot = (p: T) => keys.reduce((a, k) => a + val(p, k.key), 0)
  const max = niceMax(Math.max(0, ...points.map(tot)))
  const n = Math.max(points.length, 1)
  const slot = (w - M.l - M.r) / n
  const bw = Math.max(1, slot - (slot > 6 ? 2 : 0.5))
  const plotH = height - M.t - M.b
  const x = (i: number) => M.l + slot * i + slot / 2
  return (
    <div className="viz" ref={ref}>
      <div className="viz-head">
        <span className="eyebrow">{title}</span>
        <div className="legend">{keys.map((k) => <span key={k.key} className="legend-item"><span className="viz-key" style={{ background: k.color }} />{k.label}</span>)}</div>
      </div>
      <svg width={w} height={height} role="img" aria-label={title}>
        <Grid w={w} h={height} max={max} fmt={(v) => (v >= 1000 ? `${v / 1000}k` : String(v))} />
        {points.map((p, i) => {
          let y = M.t + plotH
          const segs = keys.map((k) => {
            const v = val(p, k.key)
            const hgt = (v / max) * plotH
            y -= hgt
            return v ? <rect key={k.key} x={x(i) - bw / 2} y={y} width={bw} height={Math.max(hgt - (hgt > 3 ? 1 : 0), 0.5)} fill={k.color}
              opacity={hover === null || hover === i ? 1 : 0.45} /> : null
          })
          return <g key={p.t}>{segs}</g>
        })}
        <XTicks points={points} x={x} h={height} bucketMs={bucketMs} />
        {/* hit targets: the whole column, wider than the bar */}
        {points.map((p, i) => (
          <rect key={`h${p.t}`} x={M.l + slot * i} y={M.t} width={slot} height={plotH} fill="transparent"
            onPointerMove={(e) => {
              setHover(i)
              tip.show(e, <>
                <div className="viz-tip-h">{fmtStamp(p.t)} · {fmtN(tot(p))} queries</div>
                {keys.map((k) => <TipRow key={k.key} color={k.color} label={k.label} value={fmtN(val(p, k.key))} />)}
              </>)
            }}
            onPointerLeave={() => { setHover(null); tip.hide() }} />
        ))}
      </svg>
      {tip.node}
    </div>
  )
}

// -- latency line ---------------------------------------------------------------------------------------

export function LineChart({ title, points, color, label, bucketMs, height = 190 }: {
  title: string; points: { t: number; v: number | null }[]; color: string; label: string; bucketMs: number; height?: number
}) {
  const [ref, w] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const [hover, setHover] = useState<number | null>(null)
  const max = niceMax(Math.max(0, ...points.map((p) => p.v ?? 0)))
  const n = Math.max(points.length, 1)
  const slot = (w - M.l - M.r) / n
  const plotH = height - M.t - M.b
  const x = (i: number) => M.l + slot * i + slot / 2
  const y = (v: number) => M.t + plotH * (1 - v / max)
  // Break the line where a bucket had no finished query.
  const paths: string[] = []
  let cur = ''
  points.forEach((p, i) => {
    if (p.v === null) { if (cur) paths.push(cur); cur = ''; return }
    cur += `${cur ? 'L' : 'M'} ${x(i)} ${y(p.v)} `
  })
  if (cur) paths.push(cur)
  const hp = hover !== null ? points[hover] : null
  return (
    <div className="viz" ref={ref}>
      <div className="viz-head"><span className="eyebrow">{title}</span></div>
      <svg width={w} height={height} role="img" aria-label={title}>
        <Grid w={w} h={height} max={max} fmt={(v) => (v ? fmtMs(v) : '0')} />
        {paths.map((d, i) => <path key={i} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {points.map((p, i) => (p.v !== null && (i === 0 || points[i - 1].v === null) && (i === points.length - 1 || points[i + 1].v === null)
          ? <circle key={p.t} cx={x(i)} cy={y(p.v)} r={3} fill={color} /> : null))}
        {hp && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + plotH} className="viz-cross" />
            {hp.v !== null && <circle cx={x(hover)} cy={y(hp.v)} r={4.5} fill={color} stroke="var(--panel)" strokeWidth={2} />}
          </g>
        )}
        <XTicks points={points} x={x} h={height} bucketMs={bucketMs} />
        {points.map((p, i) => (
          <rect key={`h${p.t}`} x={M.l + slot * i} y={M.t} width={slot} height={plotH} fill="transparent"
            onPointerMove={(e) => { setHover(i); tip.show(e, <><div className="viz-tip-h">{fmtStamp(p.t)}</div><TipRow color={color} label={label} value={fmtMs(p.v)} /></>) }}
            onPointerLeave={() => { setHover(null); tip.hide() }} />
        ))}
      </svg>
      {tip.node}
    </div>
  )
}

// -- per-row 100% mix bars (models, users) ---------------------------------------------------------------

export function MixBars({ title, rows, keys, onPick }: {
  title: string
  rows: { name: string; count: number; p95: number | null }[]
  keys: Key[]
  onPick?: (name: string) => void
}) {
  const tip = useTip()
  const val = (r: object, k: string) => Number((r as Record<string, unknown>)[k]) || 0
  return (
    <div className="viz">
      <div className="viz-head"><span className="eyebrow">{title}</span></div>
      <div className="mix">
        <div className="mix-row th"><span>Name</span><span className="num">Queries</span><span>Mix</span><span className="num">p95</span></div>
        {rows.map((r) => (
          <div key={r.name} className={`mix-row ${onPick ? 'pick' : ''}`} onClick={() => onPick?.(r.name)}
            onPointerMove={(e) => tip.show(e, <>
              <div className="viz-tip-h">{r.name} · {fmtN(r.count)} queries</div>
              {keys.map((k) => <TipRow key={k.key} color={k.color} label={k.label} value={`${fmtN(val(r, k.key))} · ${pct(val(r, k.key), r.count)}`} />)}
              <TipRow label="p95 latency" value={fmtMs(r.p95)} />
            </>)}
            onPointerLeave={tip.hide}>
            <span className="ellipsis">{r.name}</span>
            <span className="num mono">{fmtN(r.count)}</span>
            <span className="mix-bar">
              {keys.map((k) => {
                const v = val(r, k.key)
                return v ? <span key={k.key} style={{ flexGrow: v, background: k.color }} /> : null
              })}
            </span>
            <span className="num mono">{fmtMs(r.p95)}</span>
          </div>
        ))}
        {!rows.length && <div className="empty">No queries</div>}
      </div>
      {tip.node}
    </div>
  )
}
