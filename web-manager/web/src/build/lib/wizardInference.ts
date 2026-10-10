// Pure, store-free heuristics for the "Wizard" guided flow (WizardModal.tsx).
// Names and types first: a table following normal conventions (a `*key`/`*id`
// surrogate shared by fact and dimension, calendar columns named
// year/quarter/month, geo columns named country/state/city/zip) resolves from
// names alone. When the wizard has Build > Discovery profiles for the picked
// tables (`Profiles`, from api/discovery/profile.py - one scan per table, kept
// in discovery.db), the plan uses the data instead of guessing:
//   - a dimension key must be unique and never NULL (profile role `key`);
//   - with no name match, a fact column whose value range fits inside the
//     dimension key's (and has no more distinct values) is the join - only
//     when exactly one column fits;
//   - hierarchy levels must get coarser going up (fewer distinct values);
//   - metrics are the numeric columns the profile calls measures (or that are
//     named like one) - not ids, codes, flags, constants or empty columns;
//   - the secondary attribute is the most distinct text column (the name).
// Join checks (orphans + target uniqueness) run after planning: a join whose
// dimension side is not unique fans out, and one where no fact key matches is
// wrong - applyJoinChecks drops both.

import type { JoinCheck, ProfileColumn } from '../client'
import { joinTypeMismatch } from './joinTypes'

/** The profile facts the plan reads, per table. */
export interface TableFacts {
  rowCount: number | null
  columns: Pick<ProfileColumn, 'name' | 'kind' | 'role' | 'distinct' | 'nonNull' | 'min' | 'max'>[]
}

/** Keyed `schema.table`. */
export type Profiles = Record<string, TableFacts | undefined>

type ColFacts = TableFacts['columns'][number]

const factsKey = (t: { schema: string; table: string }) => `${t.schema}.${t.table}`

function colFacts(p: TableFacts | undefined, name: string): ColFacts | undefined {
  const l = name.toLowerCase()
  return p?.columns.find((c) => c.name.toLowerCase() === l)
}

/** Same pattern as api/discovery/profile.py _MEASURE_NAME. */
const MEASURE_NAME_RE = /amount|amt|price|cost|qty|quantity|count|total|revenue|sales|age|units/i

const fmtN = (n: number | null | undefined) => (n == null ? '?' : n.toLocaleString())

export interface WizardColumn {
  name: string
  type: string
  /** Declared PRIMARY KEY (a DDL import) - ranked first as the table's key. */
  primaryKey?: boolean
}

/** A declared FOREIGN KEY / REFERENCES (a DDL import). */
export interface WizardForeignKey {
  column: string
  toTable: string
  toColumn: string
}

export interface WizardTable {
  schema: string
  table: string
  columns: WizardColumn[]
  foreignKeys?: WizardForeignKey[]
}

// Coarse-to-fine order kept only for the picker preview text shown while
// choosing hint keywords; the actual level-stacking order used below is the
// reverse (finest first, since L1 is always the join key = the finest grain
// and each subsequent level added stacks "above" it per modelStore.ts's own
// addJoin rule).
const GEO_HINTS_COARSE_TO_FINE = ['country', 'region', 'state', 'province', 'county', 'city', 'postal', 'zip']
const GEO_HINTS_FINEST_TO_COARSEST = [...GEO_HINTS_COARSE_TO_FINE].reverse()

const TIME_HINTS_FINEST_TO_COARSEST = ['week', 'month', 'quarter', 'halfyear', 'year']

const NUMERIC_TYPE_RE = /^(int|integer|bigint|smallint|tinyint|long|decimal|numeric|float|double|real|money|number)/i
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
function rankKeyCandidates(dim: WizardTable, prof?: TableFacts): WizardColumn[] {
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
  const declared = dim.columns.filter((c) => c.primaryKey)
  const ranked = [...declared, ...[...exact, ...generic].filter((c) => !c.primaryKey)]
  if (prof) {
    // Profiled: only a unique, never-NULL column can be the dimension's key
    // (a `*key` column that repeats is a foreign key to another table).
    const unique = (c: WizardColumn) => colFacts(prof, c.name)?.role === 'key'
    const keys = [...ranked.filter(unique), ...dim.columns.filter((c) => unique(c) && !ranked.includes(c))]
    if (keys.length) return keys
  }
  if (ranked.length === 0 && dim.columns.length > 0) ranked.push(dim.columns[0])
  return ranked
}

const num = (v: string | null | undefined) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v))

/** a's [min, max] lies inside b's - numbers compared as numbers, else as text
 *  (ISO dates sort as text). */
function rangeInside(a: ColFacts, b: ColFacts): boolean {
  if (a.min == null || a.max == null || b.min == null || b.max == null) return false
  const [amin, amax, bmin, bmax] = [num(a.min), num(a.max), num(b.min), num(b.max)]
  if (amin != null && amax != null && bmin != null && bmax != null) return amin >= bmin && amax <= bmax
  return a.min >= b.min && a.max <= b.max
}

export interface JoinGuess {
  factColumn: string
  dimColumn: string
  /** fk: a foreign key the DDL declares · name: same column name · suffix:
   *  role-played (orderdatekey → datekey) · values: profiled value ranges fit
   *  (no name match). */
  basis: 'fk' | 'name' | 'suffix' | 'values'
  /** Orphans / target uniqueness, when the wizard ran the join check. */
  check?: JoinCheck
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
export function guessJoin(
  fact: WizardTable,
  dim: WizardTable,
  profiles: Profiles = {},
  claimed: Set<string> = new Set(),
): JoinGuess | null {
  const typesMatch = (f: WizardColumn, d: WizardColumn) =>
    !joinTypeMismatch({ table: fact.table, column: f.name, type: f.type }, { table: dim.table, column: d.name, type: d.type })
  // A declared foreign key wins over any guess - the first one to this table
  // whose column no other dimension has taken (two to one date table are
  // role-played).
  const lower = (s: string) => s.toLowerCase()
  for (const fk of fact.foreignKeys ?? []) {
    if (lower(fk.toTable) !== lower(dim.table) || claimed.has(lower(fk.column))) continue
    const f = fact.columns.find((c) => lower(c.name) === lower(fk.column))
    const d = dim.columns.find((c) => lower(c.name) === lower(fk.toColumn))
    if (f && d && typesMatch(f, d)) return { factColumn: f.name, dimColumn: d.name, basis: 'fk' }
  }
  const factProf = profiles[factsKey(fact)]
  const dimProf = profiles[factsKey(dim)]
  const candidates = rankKeyCandidates(dim, dimProf)
  const factByLower = new Map(fact.columns.map((c) => [c.name.toLowerCase(), c]))
  for (const candidate of candidates) {
    const match = factByLower.get(candidate.name.toLowerCase())
    if (match && typesMatch(match, candidate)) return { factColumn: match.name, dimColumn: candidate.name, basis: 'name' }
  }
  for (const candidate of candidates) {
    const lname = candidate.name.toLowerCase()
    const match = fact.columns.find(
      (c) => c.name.toLowerCase().endsWith(lname) && c.name.toLowerCase() !== lname && typesMatch(c, candidate),
    )
    if (match) return { factColumn: match.name, dimColumn: candidate.name, basis: 'suffix' }
  }
  // No name match: with both sides profiled, the fact column whose values all
  // fall inside the key's range - but only when exactly one column fits.
  if (factProf && dimProf) {
    for (const candidate of candidates) {
      const key = colFacts(dimProf, candidate.name)
      if (!key || key.role !== 'key') continue
      const fits = fact.columns.filter((c) => {
        const f = colFacts(factProf, c.name)
        return (
          f && !claimed.has(c.name.toLowerCase()) && f.kind === key.kind && typesMatch(c, candidate) &&
          !['measure', 'empty', 'constant'].includes(f.role) && !MEASURE_NAME_RE.test(c.name) &&
          f.distinct != null && key.distinct != null && f.distinct <= key.distinct && rangeInside(f, key)
        )
      })
      if (fits.length === 1) return { factColumn: fits[0].name, dimColumn: candidate.name, basis: 'values' }
    }
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
  /** What the profile changed or couldn't confirm - shown on Review. */
  notes: string[]
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

/** Profiled: each level above L1 must have fewer distinct values than the
 *  one below it (a Month level with more values than Day isn't a rollup), and
 *  an all-NULL column is no level at all. Unprofiled columns are kept. */
function keepCoarsening(levels: LevelPlan[], prof: TableFacts | undefined, notes: string[]): LevelPlan[] {
  if (!prof) return levels
  const kept: LevelPlan[] = [levels[0]]
  let below = colFacts(prof, levels[0].column)?.distinct ?? null
  for (const lvl of levels.slice(1)) {
    const f = colFacts(prof, lvl.column)
    if (f?.role === 'empty') {
      notes.push(`${lvl.column} skipped - every value is NULL`)
      continue
    }
    if (f?.distinct != null && below != null && f.distinct >= below) {
      notes.push(`${lvl.column} skipped - ${fmtN(f.distinct)} distinct values, not fewer than the level below (${fmtN(below)})`)
      continue
    }
    kept.push(lvl)
    if (f?.distinct != null) below = f.distinct
  }
  return kept
}

function planDimLevels(
  dim: WizardTable,
  join: JoinGuess,
  isTime: boolean,
  prof: TableFacts | undefined,
  notes: string[],
): { levels: LevelPlan[]; secondary: SecondaryPlan | null } {
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
    return { levels: keepCoarsening(levels, prof, notes), secondary: null }
  }

  for (const hint of GEO_HINTS_FINEST_TO_COARSEST) {
    const col = findHintColumn(dim.columns, usedNames, hint)
    if (col) {
      usedNames.add(col.name.toLowerCase())
      levels.push({ column: col.name })
    }
  }

  const kept = keepCoarsening(levels, prof, notes)
  if (kept.length > 1) return { levels: kept, secondary: null }

  // No geo hint matched - fall back to "Key + at least 1 Dim String": pick
  // one non-key, text-typed column as a secondary attribute on L1. Profiled,
  // the most distinct one (the name, not a code) and never an empty/constant one.
  const texts = dim.columns.filter(
    (c) => !usedNames.has(c.name.toLowerCase()) && !isKeyLikeColumn(c.name) && TEXT_TYPE_RE.test(c.type),
  )
  let textCol = texts[0]
  if (prof) {
    const usable = texts
      .map((c) => ({ c, f: colFacts(prof, c.name) }))
      .filter(({ f }) => !f || (f.role !== 'empty' && f.role !== 'constant'))
    usable.sort((a, b) => (b.f?.distinct ?? -1) - (a.f?.distinct ?? -1))
    textCol = usable[0]?.c
  }
  return { levels: kept, secondary: textCol ? { column: textCol.name } : null }
}

export function planDimension(
  fact: WizardTable,
  dim: WizardTable,
  isTime: boolean,
  profiles: Profiles = {},
  claimed: Set<string> = new Set(),
): DimPlan {
  const notes: string[] = []
  const join = guessJoin(fact, dim, profiles, claimed)
  if (!join) {
    return { schema: dim.schema, table: dim.table, isTime, join: null, levels: [], secondary: null, notes }
  }
  const dimProf = profiles[factsKey(dim)]
  if (dimProf && colFacts(dimProf, join.dimColumn)?.role !== 'key') {
    notes.push(`${join.dimColumn} is not unique in ${dim.table} - check the join before deploying`)
  }
  const { levels, secondary } = planDimLevels(dim, join, isTime, dimProf, notes)
  return { schema: dim.schema, table: dim.table, isTime, join, levels, secondary, notes }
}

export interface MetricPlan {
  column: string
  /** Why it is a metric (profiled) - shown on Review. */
  why?: string
}

/** A fact column the plan left out, and why. */
export interface SkippedColumn {
  column: string
  why: string
}

/** Every remaining numeric fact column not already claimed by a resolved
 *  join, and not itself key-shaped (a `*key`/`*id`-named column is an
 *  identifier, not something to SUM even when its warehouse type happens to
 *  be numeric), becomes a SUM metric - a sensible default so the wizard's
 *  preview and deploy actually has measures to query, matching what a user
 *  checking "Metric" by hand in the Inspector would produce. */
export function planMetrics(fact: WizardTable, dimPlans: DimPlan[], prof?: TableFacts, skipped: SkippedColumn[] = []): MetricPlan[] {
  const joinedFactCols = new Set(
    dimPlans.filter((d) => d.join).map((d) => d.join!.factColumn.toLowerCase()),
  )
  const numeric = fact.columns.filter((c) => !joinedFactCols.has(c.name.toLowerCase()) && NUMERIC_TYPE_RE.test(c.type))
  if (!prof) {
    return numeric.filter((c) => !isKeyLikeColumn(c.name)).map((c) => ({ column: c.name }))
  }
  const out: MetricPlan[] = []
  for (const c of numeric) {
    const f = colFacts(prof, c.name)
    const skip = (why: string) => skipped.push({ column: c.name, why })
    if (isKeyLikeColumn(c.name)) skip('named like a key or id')
    else if (!f || f.role === 'unknown') out.push({ column: c.name, why: 'numeric (not profiled)' })
    else if (f.role === 'empty') skip('every value is NULL')
    else if (f.role === 'constant') skip(`always ${f.min ?? 'the same value'}`)
    else if (f.role === 'key') skip('unique on every row - an identifier')
    else if (f.role === 'join') skip('looks like a foreign key')
    else if (f.role === 'measure') out.push({ column: c.name, why: `${fmtN(f.distinct)} distinct values, ${f.min} … ${f.max}` })
    else if (MEASURE_NAME_RE.test(c.name)) out.push({ column: c.name, why: `named like a measure (${fmtN(f.distinct)} distinct)` })
    else skip(`only ${fmtN(f.distinct)} distinct values - a code or flag, not a measure`)
  }
  return out
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
export function planDegenerate(fact: WizardTable, metrics: MetricPlan[], prof?: TableFacts, skipped: SkippedColumn[] = []): DegeneratePlan[] {
  const metricNames = new Set(metrics.map((m) => m.column.toLowerCase()))
  const already = new Set(skipped.map((s) => s.column.toLowerCase()))
  return fact.columns
    .filter((c) => !metricNames.has(c.name.toLowerCase()))
    .filter((c) => {
      const f = colFacts(prof, c.name)
      if (f?.role === 'empty') {
        if (!already.has(c.name.toLowerCase())) skipped.push({ column: c.name, why: 'every value is NULL' })
        return false
      }
      if (f?.role === 'measure') return false // a numeric measure the user unticked stays out
      return true
    })
    .map((c) => ({ column: c.name }))
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
  /** Fact columns left out of the metrics (profiled), with the reason. */
  skipped: SkippedColumn[]
  /** True when the fact table had a profile to plan from. */
  profiled: boolean
  /** True when no time dimension and no other dimensions were picked at all
   *  - the fact table stands alone, denormalized, and `degenerate` carries
   *  what its own columns become instead of separate dimension nodes. */
  denormalized: boolean
  degenerate: DegeneratePlan[]
}

export function planModel(
  fact: WizardTable,
  timeDim: WizardTable | null,
  otherDims: WizardTable[],
  profiles: Profiles = {},
): ModelPlan {
  const denormalized = !timeDim && otherDims.length === 0
  // A fact column joined by name isn't offered again to a values-based match.
  const claimed = new Set<string>()
  const plan = (d: WizardTable, isTime: boolean) => {
    const p = planDimension(fact, d, isTime, profiles, claimed)
    if (p.join) claimed.add(p.join.factColumn.toLowerCase())
    return p
  }
  const timeDimPlan = timeDim ? plan(timeDim, true) : null
  const dimPlans = otherDims.map((d) => plan(d, false))
  const allDimPlans = [...(timeDimPlan ? [timeDimPlan] : []), ...dimPlans]
  const insufficient = allDimPlans.filter((d) => !d.join).map((d) => `${d.schema}.${d.table}`)
  const factProf = profiles[factsKey(fact)]
  const skipped: SkippedColumn[] = []
  const metrics = planMetrics(fact, allDimPlans, factProf, skipped)
  return {
    fact,
    timeDim: timeDimPlan,
    dims: dimPlans,
    metrics,
    insufficient,
    skipped,
    profiled: !!factProf,
    denormalized,
    degenerate: denormalized ? planDegenerate(fact, metrics, factProf, skipped) : [],
  }
}

/** Join-check key for one planned join. */
export const joinCheckKey = (fact: WizardTable, d: DimPlan) =>
  d.join ? `${fact.schema}.${fact.table}.${d.join.factColumn}->${d.schema}.${d.table}.${d.join.dimColumn}` : ''

/** Folds join-check results into the plan: each join carries its check, and a
 *  join whose dimension side is not unique (it would fan out and multiply
 *  every metric), or where no fact key exists in the dimension, is dropped -
 *  that dimension lands on the canvas unjoined. */
export function applyJoinChecks(plan: ModelPlan, checks: Record<string, JoinCheck | undefined>): ModelPlan {
  const insufficient = [...plan.insufficient]
  const apply = (d: DimPlan): DimPlan => {
    const check = checks[joinCheckKey(plan.fact, d)]
    if (!d.join || !check) return d
    if (!check.targetUnique) {
      insufficient.push(`${d.schema}.${d.table}`)
      return {
        ...d, join: null, levels: [], secondary: null,
        notes: [...d.notes, `${d.join.dimColumn} repeats in ${d.table} (${fmtN(check.targetRows - check.targetDistinct)} duplicates) - joining would multiply the metrics, so it is left unjoined`],
      }
    }
    if (check.keys > 0 && check.orphanRows === check.keys) {
      insufficient.push(`${d.schema}.${d.table}`)
      return {
        ...d, join: null, levels: [], secondary: null,
        notes: [...d.notes, `No ${d.join.factColumn} value exists in ${d.table}.${d.join.dimColumn} (e.g. ${check.orphanSample.slice(0, 3).join(', ')}) - wrong key, or the two use different formats; left unjoined`],
      }
    }
    return { ...d, join: { ...d.join, check } }
  }
  const timeDim = plan.timeDim ? apply(plan.timeDim) : null
  const dims = plan.dims.map(apply)
  return { ...plan, timeDim, dims, insufficient }
}
