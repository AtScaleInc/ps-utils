import { create } from 'zustand'

// State shape per docs/BUILD_PLAN.md "Dynamic hierarchy model" — replaces the
// design mockup's fixed L1/L2/L3 with an arbitrary-length, user-ordered chain.

export type Role = 'fact' | 'dimension' | null
export type AggFn = 'SUM' | 'MIN' | 'MAX' | 'COUNT' | 'COUNT DISTINCT' | 'AVG'
export type DimRole = 'none' | 'level' | 'secondary' | 'alias'
//: SML's exact time_unit enum (lowercase, singular) - confirmed against real
//: SML repos (sample-dev/dimensions/Date.yml, sales-insights-postgres/
//: dimensions/Date Dimension.yml): year/halfyear/quarter/month/week/day.
export type TimeUnit = 'year' | 'halfyear' | 'quarter' | 'month' | 'week' | 'day'

export interface ColumnMeta {
  name: string
  type: string
}

export interface TableRef {
  schema: string
  name: string
  columns: ColumnMeta[]
}

export interface Node {
  id: string
  schema: string
  table: string
  columns: ColumnMeta[]
  x: number
  y: number
  role: Role
  dimName?: string
  hierName?: string
  factName?: string
  /** Marks this dimension as SML `type: time` with `time_unit` on each level. */
  isTime?: boolean
}

export interface Join {
  id: string
  a: { node: string; column: string }
  b: { node: string; column: string }
  /** Role-play prefix (e.g. "Order", "Ship") for a second FK from the same
   *  fact to the same conformed dimension - only meaningful on a fact<->dim
   *  join. Emitted as `role_play: "<prefix> {0}"` in the model relationship. */
  rolePlay?: string
}

/** Column key format: `${nodeId}::${column}` — matches the design doc's data-colkey. */
export type ColumnKey = string

export interface ColumnConfig {
  measure?: boolean
  agg?: AggFn
  display?: string
  query?: string

  degen?: boolean
  degenDisplay?: string
  degenQuery?: string

  dimRole?: DimRole
  /** Position in this table's level chain, set only when dimRole === 'level'.
   *  Arbitrary length (2 to 8+) — never clamped to a fixed L1/L2/L3 enum. */
  levelOrder?: number
  /** The column key of the target level, set only when dimRole is 'secondary' | 'alias'.
   *  Resolved dynamically against whatever chain the user actually built. */
  attachToKey?: ColumnKey
  /** SML lets a level/attribute's key_columns (join/identity), name_column
   *  (display), and sort_column all be different physical columns - e.g.
   *  key on `datekey`, display `date_name`. The column the user clicked to
   *  mark as a level/secondary/alias is the anchor and defaults to serving
   *  as all three; these name another column on the same table (by column
   *  name, not a full ColumnKey - always same node) to override one. */
  keyColumn?: string
  displayColumn?: string
  sortColumn?: string
  /** SML's level_attributes.time_unit, set only on a `level` (never
   *  secondary/alias) inside a table marked isTime - required for AtScale to
   *  treat the level as a real calendar unit (rollups, time-intelligence
   *  calcs) rather than an opaque string. Without it build.py falls back to
   *  guessing from the column's own name, which is often wrong. */
  timeUnit?: TimeUnit
}

export interface Selection {
  node: string
  column: string | null
}

export interface LinkDrag {
  from: { node: string; column: string }
  side: 'l' | 'r'
  to: { x: number; y: number }
}

export interface SourceMeta {
  dialect: string | null
  connectionId: string
  database: string
}

/** A calculated metric (SML `object_type: metric_calc`) - a raw MDX
 *  expression the user types, not modeled/validated by this wizard beyond
 *  passing it through (see README's "Known limitations" - no MDX authoring
 *  UI, no function-whitelist checking; sml-cli/AtScale validates it). */
export interface Calculation {
  id: string
  uniqueName: string
  label: string
  expression: string
  description?: string
}

export interface SourceRepo {
  url: string
  branch: string
}

export interface ModelState {
  modelName: string
  /** Set when the current model was loaded from an AtScale-attached repo, so
   *  Deploy pushes back to the same repo/branch it came from instead of
   *  requiring the model name alone to rediscover it. Cleared by reset(). */
  sourceRepo: SourceRepo | null
  sourceId: string | null
  sourceMeta: SourceMeta | null
  search: string
  openSchemas: Record<string, boolean>
  nodes: Node[]
  joins: Join[]
  cfg: Record<ColumnKey, ColumnConfig>
  calculations: Calculation[]
  selection: Selection | null
  linkDrag: LinkDrag | null

  setModelName: (name: string) => void
  setSourceRepo: (repo: SourceRepo | null) => void
  setSourceId: (id: string | null, meta?: SourceMeta | null) => void
  /** Patches sourceMeta in place - for correcting a connection's
   *  dialect/connectionId/database by hand, e.g. after importing SML whose
   *  connection file had the wrong values. */
  updateSourceMeta: (patch: Partial<SourceMeta>) => void
  /** This wizard assumes one schema for the whole model (buildPayload reads
   *  nodes[0].schema) - this corrects it on every node at once, for the same
   *  "SML had the wrong value" case as updateSourceMeta. */
  setSchemaForAllNodes: (schema: string) => void
  setSearch: (search: string) => void
  toggleSchema: (schema: string) => void
  addNode: (schema: string, table: string, x: number, y: number, columns?: ColumnMeta[]) => string
  moveNode: (id: string, x: number, y: number) => void
  /** Re-lays-out every node: fact tables in the leftmost column, then their
   *  directly-joined dimensions, then dimensions reached only through a
   *  snowflake join to another dimension, and so on outward by join
   *  distance - anything unreachable from a fact goes in a trailing column.
   *  Rows within a column are spaced by each node's actual rendered height
   *  (not a fixed slot), since that fixed-slot grid is exactly what made a
   *  many-column node overlap its neighbor after import. */
  autoArrange: () => void
  removeNode: (id: string) => void
  setNodeRole: (id: string, role: Role) => void
  setNodeField: (id: string, field: 'dimName' | 'hierName' | 'factName', value: string) => void
  setNodeIsTime: (id: string, isTime: boolean) => void
  setLevelOrder: (nodeId: string, key: ColumnKey, direction: 'up' | 'down') => void
  addJoin: (a: { node: string; column: string }, b: { node: string; column: string }) => void
  removeJoin: (id: string) => void
  setJoinRolePlay: (id: string, rolePlay: string | undefined) => void
  select: (selection: Selection | null) => void
  setColumnConfig: (key: ColumnKey, patch: Partial<ColumnConfig>) => void
  setColumnDimRole: (nodeId: string, key: ColumnKey, dimRole: DimRole) => void
  addCalculation: () => string
  updateCalculation: (id: string, patch: Partial<Calculation>) => void
  removeCalculation: (id: string) => void
  reset: () => void
  /** Replaces nodes/joins/cfg/calculations wholesale - used by SML import
   *  (the wizard's only load path; there is no separate proprietary save
   *  format). `calculations` defaults to [] for callers that don't have any
   *  (e.g. older saved state). */
  loadModelData: (data: {
    nodes: Node[]
    joins: Join[]
    cfg: Record<ColumnKey, ColumnConfig>
    calculations?: Calculation[]
  }) => void
}

const columnKey = (nodeId: string, column: string): ColumnKey => `${nodeId}::${column}`

// Mirrors Canvas.tsx's own node geometry (NODE_W/HEADER_H/ROW_H) - kept here
// too since autoArrange needs each node's actual rendered height to space
// rows without overlap, and the store can't import from a panel component.
const LAYOUT_NODE_W = 258
const LAYOUT_HEADER_H = 44
const LAYOUT_ROW_H = 24
const LAYOUT_COL_GAP = 60
const LAYOUT_ROW_GAP = 40
const LAYOUT_MARGIN = 40

function nodeHeight(n: Node): number {
  return LAYOUT_HEADER_H + n.columns.length * LAYOUT_ROW_H
}

/** Layers every node by join-distance from the nearest fact table (facts are
 *  layer 0), so a snowflaked dim-of-a-dim lands further out than the dims a
 *  fact joins directly - anything unreachable from any fact (a table with no
 *  joins yet, or an island) goes in one trailing layer rather than blocking
 *  the rest of the layout. */
function layerNodes(nodes: Node[], joins: Join[]): Node[][] {
  const adjacency = new Map<string, string[]>()
  for (const n of nodes) adjacency.set(n.id, [])
  for (const j of joins) {
    adjacency.get(j.a.node)?.push(j.b.node)
    adjacency.get(j.b.node)?.push(j.a.node)
  }

  const layerOf = new Map<string, number>()
  const queue: string[] = []
  for (const n of nodes) {
    if (n.role === 'fact') {
      layerOf.set(n.id, 0)
      queue.push(n.id)
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!
    const layer = layerOf.get(id)!
    for (const next of adjacency.get(id) ?? []) {
      if (!layerOf.has(next)) {
        layerOf.set(next, layer + 1)
        queue.push(next)
      }
    }
  }

  const maxLayer = Math.max(0, ...layerOf.values())
  const orphanLayer = maxLayer + 1
  const layers: Node[][] = []
  for (const n of nodes) {
    const layer = layerOf.get(n.id) ?? orphanLayer
    layers[layer] = layers[layer] ?? []
    layers[layer].push(n)
  }
  return layers.filter(Boolean)
}

/** Shared with Inspector.tsx's own copy (seeding a Display name from a raw
 *  column/table name) - kept in sync by hand since the store can't import
 *  from a panel component. */
function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Auto-seeded names for a role, derived from the table name (strip dim_/fact_/fct_
 *  prefix, title-case). Shared by addNode's initial role guess and setNodeRole's
 *  manual role change so both paths seed dimName/hierName/factName consistently. */
function seededNamesFor(table: string, role: Role) {
  const stem = table.replace(/^(dim_|fact_|fct_)/i, '')
  const titled = titleCase(stem)
  return {
    dimName: role === 'dimension' ? `${titled} Dimension` : undefined,
    hierName: role === 'dimension' ? `${titled} Hierarchy` : undefined,
    factName: role === 'fact' ? `${titled} Facts` : undefined,
  }
}

let seq = 0

export const useModelStore = create<ModelState>((set, get) => ({
  modelName: '',
  sourceRepo: null,
  sourceId: null,
  sourceMeta: null,
  search: '',
  openSchemas: {},
  nodes: [],
  joins: [],
  cfg: {},
  calculations: [],
  selection: null,
  linkDrag: null,

  setModelName: (name) => set({ modelName: name }),
  setSourceRepo: (repo) => set({ sourceRepo: repo }),

  // Deliberately does NOT touch nodes/joins/cfg/calculations - picking a
  // source is also how a loaded model gets its connection re-matched to a
  // real registered one (see ManageModelModal's applyImportedSource), and
  // that must not blank out the model that was just loaded. Use reset()
  // to start over on a blank canvas.
  setSourceId: (id, meta) => set({ sourceId: id, sourceMeta: meta ?? null }),
  updateSourceMeta: (patch) =>
    set((s) => ({ sourceMeta: s.sourceMeta ? { ...s.sourceMeta, ...patch } : s.sourceMeta })),
  setSchemaForAllNodes: (schema) => set((s) => ({ nodes: s.nodes.map((n) => ({ ...n, schema })) })),
  setSearch: (search) => set({ search }),
  toggleSchema: (schema) =>
    set((s) => ({ openSchemas: { ...s.openSchemas, [schema]: !s.openSchemas[schema] } })),

  addNode: (schema, table, x, y, columns = []) => {
    const id = `n${seq++}`
    const role: Role = /^(fct|fact)/i.test(table) ? 'fact' : /^dim/i.test(table) ? 'dimension' : null
    const names = seededNamesFor(table, role)
    set((s) => ({
      nodes: [...s.nodes, { id, schema, table, columns, x: Math.max(0, x), y: Math.max(0, y), role, ...names }],
      selection: { node: id, column: null },
    }))
    return id
  },

  moveNode: (id, x, y) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, x: Math.max(0, x), y: Math.max(0, y) } : n)),
    })),

  autoArrange: () =>
    set((s) => {
      const layers = layerNodes(s.nodes, s.joins)
      const positioned = new Map<string, { x: number; y: number }>()
      layers.forEach((layer, layerIdx) => {
        let y = LAYOUT_MARGIN
        for (const n of layer) {
          positioned.set(n.id, { x: LAYOUT_MARGIN + layerIdx * (LAYOUT_NODE_W + LAYOUT_COL_GAP), y })
          y += nodeHeight(n) + LAYOUT_ROW_GAP
        }
      })
      return { nodes: s.nodes.map((n) => ({ ...n, ...(positioned.get(n.id) ?? {}) })) }
    }),

  removeNode: (id) =>
    set((s) => {
      const cfg = Object.fromEntries(Object.entries(s.cfg).filter(([key]) => !key.startsWith(`${id}::`)))
      return {
        nodes: s.nodes.filter((n) => n.id !== id),
        joins: s.joins.filter((j) => j.a.node !== id && j.b.node !== id),
        cfg,
        selection: s.selection?.node === id ? null : s.selection,
      }
    }),

  setNodeRole: (id, role) =>
    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id !== id) return n
        const seeded = seededNamesFor(n.table, role)
        return {
          ...n,
          role,
          dimName: n.dimName || seeded.dimName,
          hierName: n.hierName || seeded.hierName,
          factName: n.factName || seeded.factName,
        }
      }),
    })),

  setNodeField: (id, field, value) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, [field]: value } : n)) })),

  setNodeIsTime: (id, isTime) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, isTime } : n)) })),

  setJoinRolePlay: (id, rolePlay) =>
    set((s) => ({ joins: s.joins.map((j) => (j.id === id ? { ...j, rolePlay } : j)) })),

  setColumnDimRole: (nodeId, key, dimRole) =>
    set((s) => {
      const existing = s.cfg[key] ?? {}
      let levelOrder = existing.levelOrder
      if (dimRole === 'level' && existing.dimRole !== 'level') {
        const currentLevels = levelsOf(s, nodeId)
        levelOrder = currentLevels.length ? currentLevels[currentLevels.length - 1].levelOrder + 1 : 0
      }
      // Seed Display name/Query name the same way a manual "mark as level"
      // click already does (Inspector's seedNames) - needed here too now
      // that addJoin can set dimRole:'level' on its own (the join's key
      // column becoming L1 automatically), which bypassed that seeding and
      // left Display/Query name blank until the user opened the column and
      // touched something.
      const column = key.slice(nodeId.length + 2)
      const display = dimRole === 'none' ? existing.display : existing.display || titleCase(column)
      const query = dimRole === 'none' ? existing.query : existing.query || column
      return { cfg: { ...s.cfg, [key]: { ...existing, dimRole, levelOrder, display, query } } }
    }),

  setLevelOrder: (nodeId, key, direction) =>
    set((s) => {
      const levels = levelsOf(s, nodeId)
      const idx = levels.findIndex((l) => l.key === key)
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1
      if (idx < 0 || swapIdx < 0 || swapIdx >= levels.length) return {}
      const a = levels[idx]
      const b = levels[swapIdx]
      return {
        cfg: {
          ...s.cfg,
          [a.key]: { ...s.cfg[a.key], levelOrder: b.levelOrder },
          [b.key]: { ...s.cfg[b.key], levelOrder: a.levelOrder },
        },
      }
    }),

  addJoin: (a, b) => {
    if (a.node === b.node) return
    const exists = get().joins.some(
      (j) =>
        (j.a.node === a.node && j.a.column === a.column && j.b.node === b.node && j.b.column === b.column) ||
        (j.b.node === a.node && j.b.column === a.column && j.a.node === b.node && j.a.column === b.column),
    )
    if (exists) return
    set((s) => ({ joins: [...s.joins, { id: `j${seq++}`, a, b }] }))

    // Auto-mark the dimension-side join column as a hierarchy level (L1) if
    // it isn't configured as anything yet - the join's key column is the
    // natural anchor for this table's hierarchy (matches the SML generator's
    // own key_columns handling), so it should be visible/editable in the
    // Inspector immediately instead of silently existing only once SML is
    // generated. Anything the user marks afterward stacks after it as L2, L3, ...
    const state = get()
    const aNode = state.nodes.find((n) => n.id === a.node)
    const bNode = state.nodes.find((n) => n.id === b.node)
    const dimSide = aNode?.role === 'dimension' ? a : bNode?.role === 'dimension' ? b : null
    if (dimSide) {
      const key = columnKey(dimSide.node, dimSide.column)
      const existingCfg = state.cfg[key]
      if (!existingCfg?.dimRole || existingCfg.dimRole === 'none') {
        get().setColumnDimRole(dimSide.node, key, 'level')
      }
    }
  },

  removeJoin: (id) => set((s) => ({ joins: s.joins.filter((j) => j.id !== id) })),

  select: (selection) => set({ selection }),

  setColumnConfig: (key, patch) =>
    set((s) => ({ cfg: { ...s.cfg, [key]: { ...s.cfg[key], ...patch } } })),

  addCalculation: () => {
    const id = `calc${seq++}`
    set((s) => ({
      calculations: [...s.calculations, { id, uniqueName: `Calc ${s.calculations.length + 1}`, label: '', expression: '' }],
    }))
    return id
  },

  updateCalculation: (id, patch) =>
    set((s) => ({ calculations: s.calculations.map((c) => (c.id === id ? { ...c, ...patch } : c)) })),

  removeCalculation: (id) => set((s) => ({ calculations: s.calculations.filter((c) => c.id !== id) })),

  reset: () =>
    set({ nodes: [], joins: [], cfg: {}, calculations: [], selection: null, linkDrag: null, sourceRepo: null }),

  loadModelData: (data) => {
    // Imported/loaded ids (n0, j0, ...) come from a separate counter (the
    // backend's parser, or a previous session) - bump the local `seq` past
    // whatever's highest here so a newly-added node/join can't collide.
    const maxNum = (id: string) => parseInt(id.replace(/^\D+/, ''), 10) || 0
    const highest = Math.max(
      0,
      ...data.nodes.map((n) => maxNum(n.id)),
      ...data.joins.map((j) => maxNum(j.id)),
      ...(data.calculations ?? []).map((c) => maxNum(c.id)),
    )
    seq = Math.max(seq, highest + 1)
    set({
      nodes: data.nodes,
      joins: data.joins,
      cfg: data.cfg,
      calculations: data.calculations ?? [],
      selection: null,
      linkDrag: null,
    })
  },

}))

// ---- Derived selectors -----------------------------------------------------

/** Levels of a dimension table, sorted by levelOrder — arbitrary length (2 to 8+),
 *  never clamped. This is the core fix over the mockup's fixed L1/L2/L3. */
export function levelsOf(state: ModelState, nodeId: string) {
  return Object.entries(state.cfg)
    .filter(([key, c]) => key.startsWith(`${nodeId}::`) && c.dimRole === 'level')
    .map(([key, c]) => ({ key, column: key.split('::')[1], levelOrder: c.levelOrder ?? 0, config: c }))
    .sort((x, y) => x.levelOrder - y.levelOrder)
}

export function secondariesOf(state: ModelState, levelKey: ColumnKey) {
  return Object.entries(state.cfg)
    .filter(([, c]) => c.dimRole === 'secondary' && c.attachToKey === levelKey)
    .map(([key, c]) => ({ key, config: c }))
}

export function aliasesOf(state: ModelState, levelKey: ColumnKey) {
  return Object.entries(state.cfg)
    .filter(([, c]) => c.dimRole === 'alias' && c.attachToKey === levelKey)
    .map(([key, c]) => ({ key, config: c }))
}

export function joinedColumnKeys(state: ModelState): Set<ColumnKey> {
  const set = new Set<ColumnKey>()
  for (const j of state.joins) {
    set.add(columnKey(j.a.node, j.a.column))
    set.add(columnKey(j.b.node, j.b.column))
  }
  return set
}

/** Unions dimension nodes connected by dim<->dim joins into logical multi-table
 *  dimensions, for the inspector's cross-table hierarchy readout and the SML
 *  generation payload. A dim<->dim join is one where neither/both endpoints'
 *  parent node has role 'fact'. */
export function dimensionGroups(state: ModelState): string[][] {
  const dimIds = new Set(state.nodes.filter((n) => n.role === 'dimension').map((n) => n.id))
  const adjacency = new Map<string, Set<string>>()
  for (const id of dimIds) adjacency.set(id, new Set())
  for (const j of state.joins) {
    if (dimIds.has(j.a.node) && dimIds.has(j.b.node)) {
      adjacency.get(j.a.node)!.add(j.b.node)
      adjacency.get(j.b.node)!.add(j.a.node)
    }
  }
  const seen = new Set<string>()
  const groups: string[][] = []
  for (const id of dimIds) {
    if (seen.has(id)) continue
    const group: string[] = []
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      group.push(cur)
      for (const next of adjacency.get(cur) ?? []) if (!seen.has(next)) stack.push(next)
    }
    groups.push(group)
  }
  return groups
}

export function counters(state: ModelState) {
  const datasets = state.nodes.length
  const joins = state.joins.length
  const metrics = Object.values(state.cfg).filter((c) => c.measure).length
  const levels = Object.values(state.cfg).filter((c) => c.dimRole === 'level').length
  const calculations = state.calculations.length
  return { datasets, joins, metrics, levels, calculations }
}

export { columnKey }
