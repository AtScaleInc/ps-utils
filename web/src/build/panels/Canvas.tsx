import { useRef, useState } from 'react'
import { useModelStore, joinedColumnKeys, type Join, type Node } from '../modelStore'
import { fetchTableColumns } from '../client'

const NODE_W = 258
const HEADER_H = 44
const ROW_H = 24
const WORLD_W = 2000
const WORLD_H = 1400
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2
const ZOOM_STEP = 0.15

interface DragState {
  kind: 'node'
  id: string
  dx: number
  dy: number
}

interface LinkDragState {
  kind: 'link'
  from: { node: string; column: string }
}

export function Canvas() {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const nodes = useModelStore((s) => s.nodes)
  const joins = useModelStore((s) => s.joins)
  const selection = useModelStore((s) => s.selection)
  const select = useModelStore((s) => s.select)
  const addNode = useModelStore((s) => s.addNode)
  const moveNode = useModelStore((s) => s.moveNode)
  const autoArrange = useModelStore((s) => s.autoArrange)
  const removeNode = useModelStore((s) => s.removeNode)
  const addJoin = useModelStore((s) => s.addJoin)
  const removeJoin = useModelStore((s) => s.removeJoin)
  const setJoinRolePlay = useModelStore((s) => s.setJoinRolePlay)
  const cfg = useModelStore((s) => s.cfg)
  const joined = joinedColumnKeys(useModelStore.getState())

  const [drag, setDrag] = useState<DragState | LinkDragState | null>(null)
  const [linkTo, setLinkTo] = useState<{ x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState(1)

  // Node positions (node.x/y) live in this fixed "world" space; zoom only
  // scales how that world is painted (CSS transform on the wrapper below),
  // so a screen coordinate has to be un-scaled back to world space before
  // it means anything to addNode/moveNode/anchorFor.
  function surfacePoint(e: { clientX: number; clientY: number }) {
    const rect = surfaceRef.current!.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left + surfaceRef.current!.scrollLeft) / zoom,
      y: (e.clientY - rect.top + surfaceRef.current!.scrollTop) / zoom,
    }
  }

  function zoomBy(delta: number) {
    setZoom((z) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)) * 100) / 100)
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    const raw = e.dataTransfer.getData('application/x-sml-table')
    if (!raw) return
    const { schema, table, columns, sourceId } = JSON.parse(raw)
    const p = surfacePoint(e)
    // The Source panel's tree has table names only; fetch this table's columns.
    const cols = columns ?? (sourceId ? await fetchTableColumns(sourceId, schema, table).catch(() => undefined) : undefined)
    addNode(schema, table, p.x - NODE_W / 2, p.y - HEADER_H / 2, cols)
  }

  function onNodeGrab(e: React.PointerEvent, node: Node) {
    e.stopPropagation()
    const p = surfacePoint(e)
    setDrag({ kind: 'node', id: node.id, dx: p.x - node.x, dy: p.y - node.y })
    select({ node: node.id, column: null })
  }

  function onLinkStart(e: React.PointerEvent, nodeId: string, column: string) {
    e.stopPropagation()
    setDrag({ kind: 'link', from: { node: nodeId, column } })
    select({ node: nodeId, column })
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return
    const p = surfacePoint(e)
    if (drag.kind === 'node') {
      moveNode(drag.id, p.x - drag.dx, p.y - drag.dy)
    } else {
      setLinkTo(p)
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (drag?.kind === 'link') {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const row = el?.closest('[data-colkey]')
      const target = row?.getAttribute('data-colkey')
      if (target) {
        const [tNode, tCol] = target.split('::')
        if (tNode !== drag.from.node) {
          addJoin(drag.from, { node: tNode, column: tCol })
        }
      }
    }
    setDrag(null)
    setLinkTo(null)
  }

  function anchorFor(node: Node, column: string, side: 'l' | 'r') {
    const idx = node.columns.findIndex((c) => c.name === column)
    return {
      x: side === 'l' ? node.x : node.x + NODE_W,
      y: node.y + HEADER_H + Math.max(0, idx) * ROW_H + ROW_H / 2,
    }
  }

  // The join SVG clips anything outside its own width/height (the SVG spec's
  // default overflow:hidden on the root element) - a fixed 2000x1400 world
  // silently dropped every join line touching a node that Auto-arrange (or a
  // manual drag) placed further out, since a tall node like a Date dimension
  // can push whatever's stacked below it well past that. Size the world to
  // whatever the nodes actually need instead of a constant.
  const worldW = Math.max(WORLD_W, ...nodes.map((n) => n.x + NODE_W + 100))
  const worldH = Math.max(WORLD_H, ...nodes.map((n) => n.y + HEADER_H + n.columns.length * ROW_H + 100))

  return (
    <main
      className="panel-center"
      ref={surfaceRef}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={(e) => {
        // Only clear selection for a click on the canvas background, not one
        // that bubbled up from a node - pointerdown's stopPropagation doesn't
        // stop the later synthetic click event, which would otherwise
        // immediately undo the selection just made on a node/row.
        const target = e.target as HTMLElement
        if (!target.closest('.canvas-node')) select(null)
      }}
    >
      <div
        className="canvas-toolbar"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="section-label">Model Canvas</div>
        <div className="zoom-controls">
          <button className="btn btn-ghost zoom-btn" onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>
            −
          </button>
          <span className="zoom-level">{Math.round(zoom * 100)}%</span>
          <button className="btn btn-ghost zoom-btn" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>
            +
          </button>
          <button className="btn btn-ghost zoom-btn" onClick={() => setZoom(1)} disabled={zoom === 1}>
            Reset
          </button>
          <button className="btn btn-ghost zoom-btn" onClick={autoArrange} disabled={nodes.length === 0}>
            Auto-arrange
          </button>
        </div>
      </div>
      {nodes.length === 0 && (
        <div style={{ padding: 16, color: 'var(--as-muted)' }}>
          Drop a fact table here to start the model.
        </div>
      )}
      <div
        className="canvas-world"
        style={{
          position: 'relative',
          width: worldW,
          height: worldH,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0',
        }}
      >
      <svg
        className="join-svg"
        width={worldW}
        height={worldH}
        style={{ position: 'absolute', top: 0, left: 0, width: worldW, height: worldH, pointerEvents: 'none' }}
      >
        {joins.map((j: Join) => {
          const a = nodes.find((n) => n.id === j.a.node)
          const b = nodes.find((n) => n.id === j.b.node)
          if (!a || !b) return null
          const involvesFact = a.role === 'fact' || b.role === 'fact'
          const p1 = anchorFor(a, j.a.column, a.x < b.x ? 'r' : 'l')
          const p2 = anchorFor(b, j.b.column, a.x < b.x ? 'l' : 'r')
          const dx = Math.max(50, Math.abs(p2.x - p1.x) / 2)
          const path = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`
          const midX = (p1.x + p2.x) / 2
          const midY = (p1.y + p2.y) / 2
          return (
            <g key={j.id}>
              <path
                d={path}
                fill="none"
                stroke={involvesFact ? 'var(--as-join)' : 'var(--as-muted-30)'}
                strokeWidth={2.5}
                style={{ pointerEvents: 'stroke', cursor: involvesFact ? 'pointer' : 'default' }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!involvesFact) return
                  const next = window.prompt(
                    'Role-play prefix for this join (e.g. "Order", "Ship") - leave blank to clear:',
                    j.rolePlay ?? '',
                  )
                  if (next !== null) setJoinRolePlay(j.id, next.trim() || undefined)
                }}
              />
              {j.rolePlay && (
                <text
                  x={midX}
                  y={midY - 10}
                  fill="var(--as-join)"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                  textAnchor="middle"
                  style={{ pointerEvents: 'none' }}
                >
                  {j.rolePlay}
                </text>
              )}
              {/* Explicit delete control - clicking the join line itself no longer
                  deletes it (that surprised users into losing joins by accident
                  while trying to set a role-play label). */}
              <circle
                cx={midX}
                cy={midY}
                r={9}
                fill="var(--as-modal)"
                stroke="var(--as-join)"
                strokeWidth={1.5}
                // The parent <svg> is pointerEvents:'none' (so the canvas
                // background stays clickable/pannable under the join lines) -
                // the join <path> above re-enables it on its own stroke, but
                // this delete control needs the same override itself, or
                // clicks pass straight through it to whatever's behind.
                style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                onClick={(e) => {
                  e.stopPropagation()
                  removeJoin(j.id)
                }}
              />
              <text
                x={midX}
                y={midY}
                fill="var(--as-join)"
                fontSize={11}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ pointerEvents: 'none' }}
              >
                ✕
              </text>
            </g>
          )
        })}
        {drag?.kind === 'link' && linkTo && (
          <line
            x1={anchorFor(nodes.find((n) => n.id === drag.from.node)!, drag.from.column, 'r').x}
            y1={anchorFor(nodes.find((n) => n.id === drag.from.node)!, drag.from.column, 'r').y}
            x2={linkTo.x}
            y2={linkTo.y}
            stroke="var(--as-join)"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        )}
      </svg>
      {nodes.map((n) => (
        <div
          key={n.id}
          className="canvas-node"
          style={{
            left: n.x,
            top: n.y,
            zIndex: selection?.node === n.id ? 10 : 1,
            outline: selection?.node === n.id ? '2px solid var(--as-join)' : 'none',
          }}
        >
          <div
            className="canvas-node-header"
            style={{
              background: n.role === 'fact' ? 'var(--as-fact)' : n.role === 'dimension' ? 'var(--as-dimension)' : 'var(--as-panel)',
            }}
            onPointerDown={(e) => onNodeGrab(e, n)}
          >
            <div className="canvas-node-meta">
              {(n.role ?? 'unset').toUpperCase()} · {n.schema}
            </div>
            <div className="canvas-node-title">
              <span className="canvas-node-title-text" title={n.table}>
                {n.table}
              </span>
              <button
                className="node-remove"
                onClick={(e) => {
                  e.stopPropagation()
                  removeNode(n.id)
                }}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="canvas-node-body">
            {n.columns.map((col) => {
              const key = `${n.id}::${col.name}`
              const c = cfg[key]
              const selected = selection?.node === n.id && selection.column === col.name
              return (
                <div
                  key={key}
                  className="canvas-node-row"
                  data-colkey={key}
                  style={{ background: selected ? 'var(--as-selected-row)' : undefined }}
                  onClick={(e) => {
                    e.stopPropagation()
                    select({ node: n.id, column: col.name })
                  }}
                >
                  <span
                    className="join-dot join-dot-l"
                    onPointerDown={(e) => onLinkStart(e, n.id, col.name)}
                    style={{ opacity: joined.has(key) ? 1 : 0.28 }}
                  />
                  <span className="col-name" title={col.name}>
                    {col.name}
                  </span>
                  <span className="col-type">{col.type}</span>
                  {c?.measure && <span className="chip chip-fact">Σ SUM</span>}
                  {c?.degen && <span className="chip chip-dimension">DEGEN</span>}
                  {c?.dimRole === 'level' && (
                    <span className="chip chip-level">L{c.levelOrder != null ? c.levelOrder + 1 : '?'}</span>
                  )}
                  {c?.dimRole === 'secondary' && <span className="chip chip-dimension">SEC</span>}
                  {c?.dimRole === 'alias' && <span className="chip chip-join">ALIAS</span>}
                  <span
                    className="join-dot join-dot-r"
                    onPointerDown={(e) => onLinkStart(e, n.id, col.name)}
                    style={{ opacity: joined.has(key) ? 1 : 0.28 }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ))}
      </div>
    </main>
  )
}
