// Build > Develop "Preview data": turns the canvas into the join tree the API's
// discovery/data_preview.py quotes into SQL. Semantics follow what build.py
// emits: a fact reaches dimensions through its joins, a dimension reaches
// further (snowflaked) dimensions, never back into a fact; each join is its own
// instance, so a role-played dimension (Order Date / Ship Date) gets one
// alias per role.
import type { AggFn, ColumnConfig, Join, Node } from '../modelStore'

/** One table as it appears in the preview: a node reached through a path of joins. */
export interface Instance {
  id: string // 'root' or the join path, e.g. 'j1/j4'
  node: Node
  label: string
  parent: string | null
  /** [parentColumn, column] of the join from the parent instance. */
  on: [string, string] | null
  depth: number
}

export interface PreviewItem {
  id: string // `${instance.id}|${column}`
  instance: string
  column: string
  label: string
  kind: 'metric' | 'level' | 'secondary' | 'degenerate'
  agg?: AggFn
}

/** A pathological canvas (joins in every direction) would otherwise explode. */
const MAX_INSTANCES = 60

const nodeLabel = (n: Node) => (n.role === 'fact' ? n.factName : n.dimName) || n.table

export function joinTree(root: Node, nodes: Node[], joins: Join[]): Instance[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out: Instance[] = [{ id: 'root', node: root, label: nodeLabel(root), parent: null, on: null, depth: 0 }]
  const queue: { inst: Instance; path: Set<string> }[] = [{ inst: out[0], path: new Set([root.id]) }]
  while (queue.length && out.length < MAX_INSTANCES) {
    const { inst, path } = queue.shift()!
    for (const j of joins) {
      const here = j.a.node === inst.node.id ? j.a : j.b.node === inst.node.id ? j.b : null
      if (!here) continue
      const there = here === j.a ? j.b : j.a
      const next = byId.get(there.node)
      // Dimensions only, and no cycles along this path.
      if (!next || next.role === 'fact' || path.has(next.id)) continue
      const role = j.rolePlay?.trim()
      const name = nodeLabel(next)
      const inst2: Instance = {
        id: inst.id === 'root' ? j.id : `${inst.id}/${j.id}`,
        node: next,
        label: inst.depth === 0 ? (role ? `${role} ${name}` : name) : `${inst.label} › ${name}`,
        parent: inst.id,
        on: [here.column, there.column],
        depth: inst.depth + 1,
      }
      out.push(inst2)
      queue.push({ inst: inst2, path: new Set([...path, next.id]) })
      if (out.length >= MAX_INSTANCES) break
    }
  }
  return out
}

/** Metrics (root measures), degenerate dimensions (root) and every level /
 *  secondary / alias column of each instance, in hierarchy order. */
export function previewItems(tree: Instance[], cfg: Record<string, ColumnConfig>): PreviewItem[] {
  const items: PreviewItem[] = []
  for (const inst of tree) {
    const prefix = `${inst.node.id}::`
    const own = Object.entries(cfg).filter(([k]) => k.startsWith(prefix)).map(([k, c]) => ({ column: k.slice(prefix.length), c }))
    if (inst.id === 'root') {
      for (const { column, c } of own) {
        if (c.measure) items.push({ id: `root|${column}|m`, instance: 'root', column, kind: 'metric', agg: c.agg ?? 'SUM',
          label: c.display || column })
        if (c.degen) items.push({ id: `root|${column}|d`, instance: 'root', column, kind: 'degenerate',
          label: c.degenDisplay || column })
      }
    }
    if (inst.node.role === 'dimension') {
      const levels = own.filter(({ c }) => c.dimRole === 'level').sort((a, b) => (b.c.levelOrder ?? 0) - (a.c.levelOrder ?? 0))
      for (const { column, c } of levels) {
        items.push({ id: `${inst.id}|${column}`, instance: inst.id, column, kind: 'level', label: c.display || column })
        for (const { column: sc, c: s } of own.filter(({ c: x }) => (x.dimRole === 'secondary' || x.dimRole === 'alias')
          && x.attachToKey === `${prefix}${column}`)) {
          items.push({ id: `${inst.id}|${sc}`, instance: inst.id, column: sc, kind: 'secondary', label: s.display || sc })
        }
      }
    }
  }
  return items
}

export interface PreviewTable {
  alias: string
  schema: string
  table: string
  parent?: string
  on?: [string, string][]
  /** A shared dimension's own database / AtScale connection, and its name for messages. */
  database?: string
  connection?: string
  label?: string
}

export interface PreviewRequestBody {
  tables: PreviewTable[]
  columns: { alias: string; column: string; agg?: AggFn }[]
  /** Header per result column, same order as `columns`. */
  headers: { label: string; sub: string; kind: PreviewItem['kind'] }[]
}

/** Only the instances the picked columns need (plus their ancestors), aliased
 *  t0, t1, ... in tree order. `allTables` keeps every instance (Check joins). */
export function buildRequest(tree: Instance[], picked: PreviewItem[], allTables = false): PreviewRequestBody {
  const byId = new Map(tree.map((i) => [i.id, i]))
  const needed = new Set<string>(['root'])
  const want = allTables ? tree.map((i) => i.id) : picked.map((p) => p.instance)
  for (const id of want) {
    for (let cur = byId.get(id); cur && !needed.has(cur.id); cur = cur.parent ? byId.get(cur.parent) : undefined) needed.add(cur.id)
  }
  const kept = tree.filter((i) => needed.has(i.id))
  const alias = new Map(kept.map((i, n) => [i.id, `t${n}`]))
  const tables = kept.map((i) => ({
    alias: alias.get(i.id)!,
    schema: i.node.schema,
    table: i.node.table,
    ...(i.parent && i.on ? { parent: alias.get(i.parent)!, on: [i.on] } : {}),
    ...(i.node.package ? { database: i.node.database, connection: i.node.asConnection, label: `${i.label} (shared)` } : {}),
  }))
  return {
    tables,
    columns: picked.map((p) => ({ alias: alias.get(p.instance)!, column: p.column, ...(p.agg ? { agg: p.agg } : {}) })),
    headers: picked.map((p) => ({
      label: p.label,
      sub: p.kind === 'metric' ? `${p.agg} · ${p.column}` : `${byId.get(p.instance)?.label} · ${p.column}`,
      kind: p.kind,
    })),
  }
}
