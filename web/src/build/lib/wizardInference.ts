// Pure, store-free heuristics for the "Wizard" guided flow (WizardModal.tsx).
// Deliberately name/type-only, not cardinality-based - querying real distinct
// counts would need a whole new AtScale SQL-analytics-port client (none
// exists in this codebase yet) and adds real per-table query latency; the
// tradeoff was discussed and the user chose fast + simple over that, on the
// basis that a table following normal naming conventions (a `*key`/`*id`
// surrogate shared by fact and dimension, calendar columns named
// year/quarter/month, geo columns named country/state/city/zip) resolves
// correctly, and one that doesn't is a naming-convention problem to fix at
// the source, not something worth adding query latency to work around.

import { joinTypeMismatch } from './joinTypes'

export interface WizardColumn {
  name: string
  type: string
}

export interface WizardTable {
  schema: string
  table: string
  columns: WizardColumn[]
}

// Coarse-to-fine order kept only for the picker preview text shown while
// choosing hint keywords; the actual level-stacking order used below is the
// reverse (finest first, since L1 is always the join key = the finest grain
// and each subsequent level added stacks "above" it per modelStore.ts's own
// addJoin rule).
const GEO_HINTS_COARSE_TO_FINE = ['country', 'region', 'state', 'province', 'county', 'city', 'postal', 'zip']
const GEO_HINTS_FINEST_TO_COARSEST = [...GEO_HINTS_COARSE_TO_FINE].reverse()

const TIME_HINTS_FINEST_TO_COARSEST = ['week', 'month', 'quarter', 'halfyear', 'year']

const NUMERIC_TYPE_RE = /^(int|integer|bigint|smallint|tinyint|decimal|numeric|float|double|real|money|number)/i
const TEXT_TYPE_RE = /(char|text|string|varchar)/i

function tableStem(name: string): string {
  return name.replace(/^(dim_|fact_|fct_)/i, '').toLowerCase()
}

function isKeyLikeColumn(name: string): boolean {
  return /(key|id)$/i.test(name)
}

/** Ranks a dimension table's own columns by how likely each is to be its
 *  surrogate key/identity column - exact `{stem}key`/`{stem}id` first, then
 *  any other `*key`/`*id` column, then falls back to the table's first
 *  column so every table has at least one candidate to try against the fact
 *  table's columns. */
function rankKeyCandidates(dim: WizardTable): WizardColumn[] {
  const stem = tableStem(dim.table)
  const exact: WizardColumn[] = []
  const generic: WizardColumn[] = []
  for (const c of dim.columns) {
    const lname = c.name.toLowerCase()
    if (lname === `${stem}key` || lname === `${stem}id` || lname === `${stem}_key` || lname === `${stem}_id`) {
      exact.push(c)
    } else if (isKeyLikeColumn(c.name)) {
      generic.push(c)
    }
  }
  const ranked = [...exact, ...generic]
  if (ranked.length === 0 && dim.columns.length > 0) ranked.push(dim.columns[0])
  return ranked
}

export interface JoinGuess {
  factColumn: string
  dimColumn: string
}

/** Finds the join column pair by the surrogate-key convention confirmed
 *  against every real SML sample used this session: the same column name
 *  (e.g. `productkey`) appears verbatim on both the fact table and the
 *  dimension table. Falls back to a role-play-aware suffix match (e.g. the
 *  fact's `orderdatekey`/`shipdatekey` both end with dimdate's own `datekey`)
 *  since that's the standard Kimball role-playing convention this app's own
 *  SML rules already support (`role_play`), not a naming mistake - an exact-
 *  only match would otherwise reject every role-played date/conformed
 *  dimension. Returns null if no dimension key-candidate name matches any
 *  fact column at all - callers must not invent a join in that case. A name
 *  match whose types differ (string vs int) is skipped - the same join-key
 *  type guardrail the canvas enforces (joinTypes.ts). */
export function guessJoin(fact: WizardTable, dim: WizardTable): JoinGuess | null {
  const typesMatch = (f: WizardColumn, d: WizardColumn) =>
    !joinTypeMismatch({ table: fact.table, column: f.name, type: f.type }, { table: dim.table, column: d.name, type: d.type })
  const factByLower = new Map(fact.columns.map((c) => [c.name.toLowerCase(), c]))
  for (const candidate of rankKeyCandidates(dim)) {
    const match = factByLower.get(candidate.name.toLowerCase())
    if (match && typesMatch(match, candidate)) return { factColumn: match.name, dimColumn: candidate.name }
  }
  for (const candidate of rankKeyCandidates(dim)) {
    const lname = candidate.name.toLowerCase()
    const match = fact.columns.find(
      (c) => c.name.toLowerCase().endsWith(lname) && c.name.toLowerCase() !== lname && typesMatch(c, candidate),
    )
    if (match) return { factColumn: match.name, dimColumn: candidate.name }
  }
  return null
}

export interface LevelPlan {
  column: string
  timeUnit?: 'year' | 'halfyear' | 'quarter' | 'month' | 'week' | 'day'
}

export interface SecondaryPlan {
  column: string
}

export interface DimPlan {
  schema: string
  table: string
  isTime: boolean
  join: JoinGuess | null
  /** L1..Ln in stacking order; empty only when join is null (nothing to anchor L1 to). */
  levels: LevelPlan[]
  secondary: SecondaryPlan | null
}

/** Builds the level (and, failing that, secondary-attribute) plan for one
 *  dimension, given its resolved join column (L1's identity). Time
 *  dimensions stack week/month/quarter/halfyear/year above a day-grain L1;
 *  other dimensions stack geo columns finest-to-coarsest above the key, or -
 *  per the "always has a Key and at least 1 Dim String" fallback - attach
 *  one text-typed column as a secondary attribute when no geo pattern is
 *  found at all. */
function findHintColumn(columns: WizardColumn[], used: Set<string>, hint: string): WizardColumn | null {
  const candidates = columns.filter((c) => !used.has(c.name.toLowerCase()))
  // Prefer a column whose name *starts with* the hint - a real rollup column
  // (e.g. `weeknumberofyear`, `monthnumberofyear`) is named grain-first, while
  // a cyclical position attribute of a DIFFERENT, finer grain (e.g.
  // `daynumberofweek` - which day within the week, not a week-of-year value)
  // merely contains a coarser hint word later in its name. Confirmed against
  // a real dimdate table where plain substring matching picked
  // `daynumberofweek` for "week" and mistagged `weeknumberofyear` as "year".
  // Only fall back to a loose substring match when nothing starts with it.
  return candidates.find((c) => c.name.toLowerCase().startsWith(hint)) ?? candidates.find((c) => c.name.toLowerCase().includes(hint)) ?? null
}

function planDimLevels(dim: WizardTable, join: JoinGuess, isTime: boolean): { levels: LevelPlan[]; secondary: SecondaryPlan | null } {
  const usedNames = new Set([join.dimColumn.toLowerCase()])
  const levels: LevelPlan[] = [{ column: join.dimColumn, timeUnit: isTime ? 'day' : undefined }]

  if (isTime) {
    for (const hint of TIME_HINTS_FINEST_TO_COARSEST) {
      const col = findHintColumn(dim.columns, usedNames, hint)
      if (col) {
        usedNames.add(col.name.toLowerCase())
        levels.push({ column: col.name, timeUnit: hint as LevelPlan['timeUnit'] })
      }
    }
    return { levels, secondary: null }
  }

  for (const hint of GEO_HINTS_FINEST_TO_COARSEST) {
    const col = findHintColumn(dim.columns, usedNames, hint)
    if (col) {
      usedNames.add(col.name.toLowerCase())
      levels.push({ column: col.name })
    }
  }

  if (levels.length > 1) return { levels, secondary: null }

  // No geo hint matched - fall back to "Key + at least 1 Dim String": pick
  // one non-key, text-typed column as a secondary attribute on L1.
  const textCol = dim.columns.find(
    (c) => !usedNames.has(c.name.toLowerCase()) && !isKeyLikeColumn(c.name) && TEXT_TYPE_RE.test(c.type),
  )
  return { levels, secondary: textCol ? { column: textCol.name } : null }
}

export function planDimension(fact: WizardTable, dim: WizardTable, isTime: boolean): DimPlan {
  const join = guessJoin(fact, dim)
  if (!join) {
    return { schema: dim.schema, table: dim.table, isTime, join: null, levels: [], secondary: null }
  }
  const { levels, secondary } = planDimLevels(dim, join, isTime)
  return { schema: dim.schema, table: dim.table, isTime, join, levels, secondary }
}

export interface MetricPlan {
  column: string
}

/** Every remaining numeric fact column not already claimed by a resolved
 *  join, and not itself key-shaped (a `*key`/`*id`-named column is an
 *  identifier, not something to SUM even when its warehouse type happens to
 *  be numeric), becomes a SUM metric - a sensible default so the wizard's
 *  preview and deploy actually has measures to query, matching what a user
 *  checking "Metric" by hand in the Inspector would produce. */
export function planMetrics(fact: WizardTable, dimPlans: DimPlan[]): MetricPlan[] {
  const joinedFactCols = new Set(
    dimPlans.filter((d) => d.join).map((d) => d.join!.factColumn.toLowerCase()),
  )
  return fact.columns
    .filter(
      (c) => !joinedFactCols.has(c.name.toLowerCase()) && !isKeyLikeColumn(c.name) && NUMERIC_TYPE_RE.test(c.type),
    )
    .map((c) => ({ column: c.name }))
}

export interface DegeneratePlan {
  column: string
}

/** Denormalized-table case: no time dimension and no other dimensions were
 *  picked, so there's nothing to join to at all - every fact column that
 *  isn't a metric is instead exposed directly off the fact table as a
 *  degenerate dimension (SML's `degenerate: true` attribute), matching what
 *  a user manually checking "Degenerate dimension" per column in the
 *  Inspector would build for a single denormalized table. */
export function planDegenerate(fact: WizardTable, metrics: MetricPlan[]): DegeneratePlan[] {
  const metricNames = new Set(metrics.map((m) => m.column.toLowerCase()))
  return fact.columns.filter((c) => !metricNames.has(c.name.toLowerCase())).map((c) => ({ column: c.name }))
}

export interface ModelPlan {
  fact: WizardTable
  timeDim: DimPlan | null
  dims: DimPlan[]
  metrics: MetricPlan[]
  /** Names (schema.table) of dimensions with no resolvable join - the
   *  "insufficient information" case: these still get added to the canvas
   *  (unjoined) rather than being silently dropped. */
  insufficient: string[]
  /** True when no time dimension and no other dimensions were picked at all
   *  - the fact table stands alone, denormalized, and `degenerate` carries
   *  what its own columns become instead of separate dimension nodes. */
  denormalized: boolean
  degenerate: DegeneratePlan[]
}

export function planModel(fact: WizardTable, timeDim: WizardTable | null, otherDims: WizardTable[]): ModelPlan {
  const denormalized = !timeDim && otherDims.length === 0
  const timeDimPlan = timeDim ? planDimension(fact, timeDim, true) : null
  const dimPlans = otherDims.map((d) => planDimension(fact, d, false))
  const allDimPlans = [...(timeDimPlan ? [timeDimPlan] : []), ...dimPlans]
  const insufficient = allDimPlans.filter((d) => !d.join).map((d) => `${d.schema}.${d.table}`)
  const metrics = planMetrics(fact, allDimPlans)
  return {
    fact,
    timeDim: timeDimPlan,
    dims: dimPlans,
    metrics,
    insufficient,
    denormalized,
    degenerate: denormalized ? planDegenerate(fact, metrics) : [],
  }
}
