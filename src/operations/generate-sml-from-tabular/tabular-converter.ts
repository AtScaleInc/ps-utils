/**
 * SSAS Tabular (TMSL/XMLA) -> AtScale SML converter.
 *
 * Ported from a standalone Python script (tabular_to_sml.py) distilled from
 * real Tabular -> SML migrations. Builds the full structural skeleton --
 * every dataset, every dimension, every fact relationship -- and translates
 * only mechanically-unambiguous measures. It deliberately does NOT attempt
 * to translate arbitrary DAX to MDX; that step needs per-measure human
 * judgment and is left as a documented follow-up pass (DEFERRED_MEASURES.md).
 *
 * WHAT IT DOES
 *   1. Parses the TMSL `createOrReplace.database.model` block: tables,
 *      columns, relationships, hierarchies, measures, and every table's
 *      partition query (to recover its real physical source, when possible).
 *   2. Classifies tables:
 *        - orphan    -- no relationships at all -> excluded (SML rule:
 *                        don't emit an unreferenced dataset)
 *        - fact      -- has >=1 measure AND joins OUT to >=1 other table
 *        - dimension -- everything else that's still referenced, INCLUDING
 *                        tables that carry measures but never join out
 *                        (their measures are 100% deferred)
 *   3. SSAS Tabular cannot role-play a dimension. When the same real-world
 *      dimension needs to join to a fact multiple times under different
 *      names (Order Date vs Ship Date), Tabular fakes it by importing the
 *      *same* source view once per role, under a different table name each
 *      time. This converter reads each table's partition query, resolves
 *      what object it actually reads from, and groups dimension tables that
 *      share the same source object into ONE consolidated SML dimension,
 *      wired to facts via `role_play` (when a fact has genuinely multiple
 *      distinct FK columns into the group) or an ordinary conformed
 *      relationship (when it only has one).
 *   4. Emits one SML dataset per kept table/family, one SML dimension per
 *      dimension table/family, one SML metric per SIMPLE measure, and a
 *      model.yml wiring every fact relationship (role-play or ordinary) plus
 *      any extra connections needed for cross-database sources.
 *   5. "Simple" measure = a bare SUM([col]) / AVERAGE([col]) / MIN([col]) /
 *      MAX([col]) / DISTINCTCOUNT([col]) / COUNT([col]) / COUNTROWS('t').
 *      Everything else is written to DEFERRED_MEASURES.md with its original
 *      DAX, untranslated.
 *   6. Returns README.md, DEFERRED_MEASURES.md, CONVERSION_REPORT.md/.json,
 *      and a context/ folder (verbatim TMSL copy + derived DDL/ERD/use-case
 *      docs + the effective build.yaml).
 *
 * LIMITATIONS -- see the module docstring of the original Python script for
 * the full list; the short version:
 *   - Partition-query resolution only handles simple single-table
 *     `SELECT ... FROM <object>` partitions. Multi-source joins and DAX
 *     calculated tables have no recoverable physical source.
 *   - `is_unique_key` is never set (needs a data profile).
 *   - `name_column` per dimension/family is chosen by a heuristic.
 *   - Role-play label text is derived automatically and may need renaming
 *     to match house terminology.
 *   - No semi-additive metrics, no time-intelligence calcs, no snowflake
 *     bridging, no parent-child hierarchy detection.
 */
import { dump } from "js-yaml";
import {
  MeasureClassifier, buildResolver, defaultMetricName, isIncidentalBlocker,
  type ColumnLookup, type MeasureAssessment, type MetricProvider,
} from "./dax/index.js";

// ============================================================
// TMSL input types (loose -- only the fields this converter reads)
// ============================================================

export type TmslColumn = {
  name: string;
  dataType?: string;
  isHidden?: boolean;
};

export type TmslPartitionSource = {
  type?: string;
  query?: string | string[];
};

export type TmslPartition = {
  source?: TmslPartitionSource;
};

export type TmslHierarchyLevel = {
  ordinal: number;
  column: string;
};

export type TmslHierarchy = {
  name: string;
  levels: TmslHierarchyLevel[];
};

export type TmslMeasure = {
  name: string;
  expression?: string | string[];
};

export type TmslTable = {
  name: string;
  columns: TmslColumn[];
  measures?: TmslMeasure[];
  hierarchies?: TmslHierarchy[];
  partitions?: TmslPartition[];
};

export type TmslRelationship = {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
};

export type TmslModel = {
  tables: TmslTable[];
  relationships: TmslRelationship[];
};

export type TmslDocument = {
  createOrReplace: {
    database: {
      model: TmslModel;
    };
  };
};

// ============================================================
// Converter options / result
// ============================================================

export type Warehouse = "Snowflake" | "Databricks" | "BigQuery" | "Postgres";

export type ConvertTabularOptions = {
  tmslFileName: string;
  warehouse: Warehouse;
  database: string;
  schema: string;
  modelName: string;
  catalogName?: string;
  currency?: string;
  description?: string;
  /** Verbatim content of the source TMSL file, copied into context/. */
  tmslRawContent: string;
};

export type ConvertTabularResult = {
  sml: Map<string, string>;
};

// ============================================================
// io / naming helpers
// ============================================================

function od(obj: Record<string, unknown>): Record<string, unknown> {
  return obj;
}

function toYaml(obj: unknown): string {
  return dump(obj, {
    indent: 2,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}

/**
 * A measure name becomes a file name, and SSAS measure names routinely contain
 * "/" ("ALE/Minutes", "Cases/PAL"). Left alone those silently create nested
 * directories in the SML output, so the object lands at a path no loader
 * expects. Only the file name is sanitized -- `unique_name` keeps the original
 * so BI references are unchanged.
 */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

function cleanDesc(s: string | undefined): string {
  return (s ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/** Fallback storage-case physical identifier, used only when a table's real
 * physical name/columns could not be resolved from its partition query.
 * Rule 1: Snowflake unquoted identifiers uppercase; other warehouses
 * lowercase by convention. */
function physicalName(name: string, warehouse: string): string {
  let n = name.trim().replace(/[^0-9A-Za-z]+/g, "_");
  n = n.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "COL";
  if (/^[0-9]/.test(n)) n = "C_" + n;
  return warehouse.toLowerCase() === "snowflake" ? n.toUpperCase() : n.toLowerCase();
}

/** Title-case a physical column name into a human label, e.g.
 * 'day_of_week_num' -> 'Day Of Week Num'. */
function cleanLabel(physcol: string): string {
  return physcol
    .replace(/_/g, " ")
    .split(" ")
    .map((w) => (w === w.toLowerCase() ? capitalize(w) : w))
    .join(" ");
}

function capitalize(w: string): string {
  return w.length ? w[0].toUpperCase() + w.slice(1) : w;
}

const DTYPE_MAP: Record<string, string> = {
  int64: "long",
  decimal: "decimal(18,4)",
  double: "double",
  boolean: "boolean",
  string: "string",
  dateTime: "datetime",
};

function smlDtype(tmslType: string | undefined): string {
  return DTYPE_MAP[tmslType ?? ""] ?? "string";
}

// ============================================================
// DAX parsing
// ============================================================

const SIMPLE_RE = /^\s*(SUM|COUNTROWS|COUNT|AVERAGE|MIN|MAX|DISTINCTCOUNT)\s*\(\s*([\s\S]*)\s*\)\s*$/i;
const COLREF_RE = /^\[([^\]]+)\]$/;
const TABLECOLREF_RE = /^'?[^'[\]]+'?\[([^\]]+)\]$/;
const CALC_METHOD: Record<string, string> = {
  SUM: "sum",
  AVERAGE: "average",
  MIN: "minimum",
  MAX: "maximum",
  DISTINCTCOUNT: "count distinct",
  COUNT: "count non-null",
  COUNTROWS: "count non-null",
};

function exprText(m: TmslMeasure): string {
  const e = m.expression;
  if (Array.isArray(e)) return e.join("\n").trim();
  return (e ?? "").trim();
}

function classifyMeasure(m: TmslMeasure): { calc: string; col: string | null } | null {
  const e = exprText(m);
  const mm = SIMPLE_RE.exec(e);
  if (!mm) return null;
  const fn = mm[1].toUpperCase();
  const arg = mm[2].trim();
  if (fn === "COUNTROWS") return { calc: CALC_METHOD[fn], col: null };
  const cm = COLREF_RE.exec(arg) ?? TABLECOLREF_RE.exec(arg);
  if (!cm) return null;
  return { calc: CALC_METHOD[fn], col: cm[1] };
}

// ============================================================
// Date-dim sniff
// ============================================================

const DATE_SUFFIXES = [" Yr", " Yr Qtr", " Yr Mnth", " Dte"];

/** Return a common prefix if this table's columns look like a
 * Year/Quarter/Month/Day calendar table with a shared naming prefix. */
function detectDatePrefix(table: TmslTable): string | null {
  const names = new Set(table.columns.map((c) => c.name));
  for (const n of names) {
    if (n.endsWith(" Yr") && !n.endsWith(" Yr Qtr")) {
      const prefix = n.slice(0, -" Yr".length);
      const needed = DATE_SUFFIXES.map((suf) => `${prefix}${suf}`);
      if (needed.every((x) => names.has(x))) return prefix;
    }
  }
  return null;
}

// ============================================================
// Partition-query parsing
// ============================================================

function getPartitionQuery(table: TmslTable): string | null {
  const partitions = table.partitions ?? [];
  if (partitions.length === 0) return null;
  const q = partitions[0].source?.query;
  if (Array.isArray(q)) return q.join("\n");
  return q ?? null;
}

function getPartitionType(table: TmslTable): string | null {
  const partitions = table.partitions ?? [];
  if (partitions.length === 0) return null;
  return partitions[0].source?.type ?? null;
}

/** Return [(physical_col, alias_or_null), ...] from a simple flat SELECT
 * list. Handles `col "Alias"` and `col AS "Alias"` styles. Returns [] if the
 * SELECT/FROM shape isn't found (caller should treat that as unparseable). */
function parseSelectCols(query: string): Array<[string, string | null]> {
  const m = /SELECT\s+([\s\S]*?)\n\s*FROM\s/i.exec(query);
  if (!m) return [];
  const body = m[1];
  let items = body.split(/,\s*\n|\n\s*,/);
  if (items.length <= 1) items = body.split(",");
  const cols: Array<[string, string | null]> = [];
  for (let item of items) {
    item = item.replace(/--.*/g, "").trim();
    if (!item) continue;
    const mm = /^([A-Za-z0-9_]+)\s*(?:AS\s+)?("([^"]*)")?\s*$/i.exec(item);
    if (mm) {
      cols.push([mm[1], mm[3] ?? null]);
    } else {
      cols.push([item, null]);
    }
  }
  return cols;
}

export type PhysicalSourceKind = "query" | "calculated" | "join_query" | "unresolved_query" | "none";

export type PhysicalSource = {
  kind: PhysicalSourceKind;
  fromObject: string | null;
  selectCols: Array<[string, string | null]> | null;
};

/** Best-effort resolution of what a Tabular table's partition actually
 * reads from.
 *   kind == "query"           -> fromObject + selectCols resolved
 *   kind == "calculated"      -> a DAX calculated table; no physical source
 *   kind == "join_query"      -> joins multiple sources; no single object
 *   kind == "unresolved_query" -> query partition, but FROM/columns unparseable
 *   kind == "none"            -> no partition/query found */
function resolvePhysicalSource(table: TmslTable): PhysicalSource {
  const ptype = getPartitionType(table);
  if (ptype === "calculated") {
    return { kind: "calculated", fromObject: null, selectCols: null };
  }
  const q = getPartitionQuery(table);
  if (!q) return { kind: "none", fromObject: null, selectCols: null };
  if (/\bJOIN\b/i.test(q)) {
    return { kind: "join_query", fromObject: null, selectCols: null };
  }
  const m = /FROM\s+([\w.]+)/i.exec(q);
  const fromObject = m ? m[1] : null;
  const cols = parseSelectCols(q);
  if (!fromObject || cols.length === 0) {
    return { kind: "unresolved_query", fromObject: null, selectCols: null };
  }
  return { kind: "query", fromObject, selectCols: cols };
}

/** 'MYDB.dbo.vd_date' -> ['MYDB', 'dbo', 'vd_date']; tolerates fewer
 * parts by left-padding with null. */
function splitQualified(obj: string): [string | null, string | null, string] {
  const parts: Array<string | null> = obj.split(".");
  while (parts.length < 3) parts.unshift(null);
  return [parts[parts.length - 3], parts[parts.length - 2], parts[parts.length - 1] as string];
}

/** Derive a human dimension name from a resolved source object name, e.g.
 * 'vd_date' -> 'Date Dimension'. */
function familyLabel(fromObject: string): string {
  const [, , objRaw] = splitQualified(fromObject);
  const obj = objRaw.replace(/^(vd_|vf_|v_|d_|f_)/i, "");
  return `${cleanLabel(obj)} Dimension`;
}

// ============================================================
// Naming-convention preservation
// ============================================================

/** Given several role-specific aliases for the SAME physical column, find
 * the longest common trailing token run so leading, role-distinguishing
 * tokens can be recovered per alias. */
function commonSuffixTokens(aliasList: Array<string | null>): string[] {
  const tokenLists = aliasList.filter((a): a is string => Boolean(a)).map((a) => a.split(/\s+/));
  if (tokenLists.length < 2) return [];
  const minLen = Math.min(...tokenLists.map((t) => t.length));
  let commonLen = 0;
  for (let i = 1; i <= minLen; i++) {
    const tails = new Set(tokenLists.map((t) => t.slice(-i).map((w) => w.toLowerCase()).join("")));
    if (tails.size === 1) commonLen = i;
    else break;
  }
  return commonLen ? tokenLists[0].slice(-commonLen) : [];
}

/** Recover each family member's ORIGINAL alias prefix (e.g. 'Serv', 'Prov',
 * 'AHP', 'Refer Prov') by comparing its alias for a shared anchor column
 * against the other members' aliases for the same column and extracting
 * what differs. Falls back to stripping the common leading words of the
 * members' TABLE NAMES when no alias-level signal is available. */
function detectMemberPrefixes(
  members: string[],
  physicalSource: Record<string, PhysicalSource>,
  anchorPhysCols: string[],
  phys: (n: string) => string,
): { prefixes: Record<string, string | null>; suffixTokens: string[] | null } {
  for (const anchor of anchorPhysCols) {
    const memberAlias = new Map<string, string>();
    for (const m of members) {
      const src = physicalSource[m];
      if (src.kind === "query" && src.selectCols) {
        for (const [physcol, alias] of src.selectCols) {
          if (alias && phys(physcol) === anchor) {
            memberAlias.set(m, alias);
            break;
          }
        }
      }
    }
    if (memberAlias.size >= 2) {
      const suffixTokens = commonSuffixTokens([...memberAlias.values()]);
      if (suffixTokens.length) {
        const prefixes: Record<string, string | null> = {};
        let ok = true;
        for (const [m, alias] of memberAlias) {
          const toks = alias.split(/\s+/);
          const n = suffixTokens.length;
          const tail = toks.slice(toks.length - n);
          if (
            tail.length === n &&
            tail.map((w) => w.toLowerCase()).join("") === suffixTokens.map((w) => w.toLowerCase()).join("")
          ) {
            const prefixToks = n ? toks.slice(0, toks.length - n) : toks;
            prefixes[m] = prefixToks.length ? prefixToks.join(" ") : null;
          } else {
            ok = false;
          }
        }
        if (ok && Object.keys(prefixes).length === members.length) {
          return { prefixes, suffixTokens };
        }
      }
    }
  }

  // fallback: strip common leading words of the TABLE NAMES themselves
  const tokenLists = members.map((m) => m.split(/\s+/));
  let commonLen = 0;
  const minLen = Math.min(...tokenLists.map((t) => t.length));
  for (let i = 0; i < minLen; i++) {
    const toksI = new Set(tokenLists.map((t) => t[i].toLowerCase()));
    if (toksI.size === 1) commonLen += 1;
    else break;
  }
  const prefixes: Record<string, string | null> = {};
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    let remainder = tokenLists[i].slice(commonLen);
    if (remainder.length && remainder[0].toLowerCase() === "of") remainder = remainder.slice(1);
    prefixes[m] = remainder.length ? remainder.join(" ") : m;
  }
  return { prefixes, suffixTokens: null };
}

/** Remove a known leading prefix (e.g. 'Serv') from an alias (e.g. 'Serv Is
 * Prior Mnth') to recover the role-neutral suffix ('Is Prior Mnth').
 * Case-insensitive token match; returns null if the alias doesn't actually
 * start with that prefix. */
function stripPrefixTokens(alias: string, prefix: string | null): string | null {
  if (!prefix) return alias;
  const pToks = prefix.split(/\s+/);
  const aToks = alias.split(/\s+/);
  if (aToks.length <= pToks.length) return null;
  const head = aToks.slice(0, pToks.length).map((w) => w.toLowerCase());
  if (head.join("") !== pToks.map((w) => w.toLowerCase()).join("")) return null;
  return aToks.slice(pToks.length).join(" ");
}

// ============================================================
// Issue / report tracking
// ============================================================

type Severity = "error" | "action_needed" | "warning" | "info";

type Issue = { severity: Severity; category: string; object: string; message: string };

type ConvertedDim = {
  name: string;
  kind: "role_play_family" | "standalone";
  dimType: string;
  sourceObject?: string | null;
  members?: string[];
  numRolesCollapsed?: number;
  memberPrefixes?: Record<string, string | null>;
  physicalSourceConfirmed?: boolean;
};

type ConvertedMetric = { name: string; fact: string; calculationMethod: string; column: string };

// ============================================================
// Family metadata
// ============================================================

type FamilyHier = {
  year: string | null;
  quarter: string | null;
  month: string | null;
  day: string | null;
  yearLabel: string;
  quarterLabel: string;
  monthLabel: string;
  dayLabel: string;
};

type FamilyMeta = {
  label: string;
  members: string[];
  isTime: boolean;
  physCols: Map<string, string>; // physical column -> dtype
  keyCol: string;
  nameCol: string;
  hier: FamilyHier | null;
  memberPrefix: Record<string, string | null>;
};

// ============================================================
// Mermaid ERD
// ============================================================

function sanitizeMermaidId(name: string): string {
  return name.replace(/[^0-9A-Za-z]+/g, "_");
}

function buildMermaidDiagram(
  rels: TmslRelationship[],
  factTables: Set<string>,
  singletonDims: Set<string>,
  familyOfMember: Map<string, string>,
): string {
  const lines: string[] = ["```mermaid", "erDiagram"];
  let any = false;
  for (const r of rels) {
    if (!factTables.has(r.fromTable)) continue;
    if (!(singletonDims.has(r.toTable) || familyOfMember.has(r.toTable))) continue;
    const target = familyOfMember.get(r.toTable) ?? r.toTable;
    lines.push(`    ${sanitizeMermaidId(r.fromTable)} }o--|| ${sanitizeMermaidId(target)} : "${r.fromColumn}"`);
    any = true;
  }
  lines.push("```");
  return any ? lines.join("\n") : "";
}

// ============================================================
// Main conversion entry point
// ============================================================

export function convertTabularToSml(
  tmsl: TmslDocument,
  opts: ConvertTabularOptions,
): ConvertTabularResult {
  const model = tmsl.createOrReplace.database.model;
  const tables = new Map<string, TmslTable>();
  for (const t of model.tables) tables.set(t.name, t);
  const rels = model.relationships;

  const sml = new Map<string, string>();

  const issues: Issue[] = [];
  const convertedDims: ConvertedDim[] = [];
  const convertedMetrics: ConvertedMetric[] = [];

  function logIssue(severity: Severity, category: string, object: string, message: string): void {
    issues.push({ severity, category, object, message });
  }

  const W = opts.warehouse;
  const phys = (n: string) => physicalName(n, W);

  // ---- classify tables (relationship-driven) ------------------------------
  const fromTables = new Set(rels.map((r) => r.fromTable));
  const toTables = new Set(rels.map((r) => r.toTable));
  const usedTables = new Set([...fromTables, ...toTables]);
  const allTables = new Set(tables.keys());
  const orphanTables = [...allTables].filter((t) => !usedTables.has(t)).sort();

  const factTables = [...usedTables]
    .filter((n) => (tables.get(n)?.measures?.length ?? 0) > 0 && fromTables.has(n))
    .sort();
  const factTablesSet = new Set(factTables);
  const excludedMeasureTables = [...usedTables]
    .filter((n) => (tables.get(n)?.measures?.length ?? 0) > 0 && !factTablesSet.has(n))
    .sort();
  const dimTables = [...usedTables].filter((n) => !factTablesSet.has(n)).sort();
  const allModeled = [...factTables, ...dimTables];

  for (const t of orphanTables) {
    logIssue(
      "info",
      "orphan_table_excluded",
      t,
      "No relationships to any other table -- excluded per the SML rule against emitting an " +
        "unreferenced dataset. Not converted; not a failure.",
    );
  }
  for (const t of excludedMeasureTables) {
    const nMeasures = tables.get(t)?.measures?.length ?? 0;
    logIssue(
      "action_needed",
      "measures_without_fact_relationship",
      t,
      `Carries ${nMeasures} DAX measure(s) but never joins out to another table, so there's no ` +
        "relationship to attach it as a fact without fabricating one. Modeled as a dimension only; " +
        "its measures are NOT converted -- see DEFERRED_MEASURES.md. Needs a human relationship " +
        "design if these measures matter.",
    );
  }

  // ---- resolve physical source for every modeled table ---------------------
  const physicalSource: Record<string, PhysicalSource> = {};
  for (const t of allModeled) physicalSource[t] = resolvePhysicalSource(tables.get(t)!);
  const unresolvedTables = allModeled
    .filter((t) => ["calculated", "join_query", "unresolved_query", "none"].includes(physicalSource[t].kind))
    .sort();
  for (const t of unresolvedTables) {
    const kind = physicalSource[t].kind;
    const reason: Record<string, string> = {
      calculated:
        "backed by a DAX calculated table (e.g. SUMMARIZECOLUMNS) with no physical source at all -- " +
        "would need a hand-written SQL query dataset.",
      join_query:
        "its partition query joins multiple sources -- this converter only resolves single-object " +
        "SELECT ... FROM partitions, so no single physical source could be attributed.",
      unresolved_query:
        "has a query partition but the simple parser could not confidently extract a FROM object " +
        "and/or SELECT column list from it.",
      none: "has no partition/query in the TMSL at all.",
    };
    logIssue(
      "action_needed",
      "unresolved_physical_source",
      t,
      `${reason[kind] ?? "unrecognized partition shape."} Table/column names in the output are a ` +
        "naming-convention GUESS, not a confirmed physical source -- verify against real DDL before " +
        "trusting them.",
    );
  }

  // ---- connection registry (auto-create one per distinct source DB) -------
  const catalogName = opts.catalogName ?? `${opts.modelName}_catalog`;
  const primaryConnection = `Connection - ${opts.modelName}`;
  const connections = new Map<string, string>([[opts.database.toUpperCase(), primaryConnection]]);
  const extraConnectionsCreated: Array<[string, string]> = [];

  function connectionFor(db: string | null): string {
    if (!db) return primaryConnection;
    const key = db.toUpperCase();
    if (!connections.has(key)) {
      const name = `${primaryConnection} - ${key}`;
      connections.set(key, name);
      extraConnectionsCreated.push([key, name]);
      logIssue(
        "action_needed",
        "cross_database_source_connection_created",
        name,
        `A table's confirmed physical source lives in database '${key}', different from the primary ` +
          `--database argument ('${opts.database}'). A new connection object was created automatically ` +
          `-- confirm its credentials/grants include SELECT on the relevant objects in '${key}' before ` +
          "deploying.",
      );
    }
    return connections.get(key)!;
  }

  function tablePhysicalRef(t: string): [string, string, string | null] {
    const src = physicalSource[t];
    if (src.kind === "query" && src.fromObject) {
      const [db, schema, obj] = splitQualified(src.fromObject);
      return [W.toLowerCase() === "snowflake" ? obj.toUpperCase() : obj.toLowerCase(), connectionFor(db), schema];
    }
    return [phys(t), primaryConnection, null];
  }

  /** alias-or-physical -> resolved physical column name, for one table. */
  function colPhysMap(t: string): Map<string, string> {
    const src = physicalSource[t];
    const mapping = new Map<string, string>();
    if (src.kind === "query" && src.selectCols) {
      for (const [physcol, alias] of src.selectCols) {
        mapping.set(alias ?? physcol, phys(physcol));
      }
    }
    for (const c of tables.get(t)!.columns) {
      if (!mapping.has(c.name)) mapping.set(c.name, phys(c.name));
    }
    return mapping;
  }

  // ---- relationship-derived dimension keys (fallback path only) ------------
  const dimKeyCol = new Map<string, Set<string>>();
  for (const r of rels) {
    if (!dimKeyCol.has(r.toTable)) dimKeyCol.set(r.toTable, new Set());
    dimKeyCol.get(r.toTable)!.add(r.toColumn);
  }

  function fallbackKeyCol(t: string): string {
    const keys = dimKeyCol.get(t);
    if (keys && keys.size) return [...keys].sort()[0];
    return tables.get(t)!.columns[0].name;
  }

  function pickNameColumn(t: string, keyCol: string): string {
    const cols = tables.get(t)!.columns;
    const candidates = cols.filter((c) => !c.isHidden && c.name !== keyCol);
    for (const kw of ["name", "desc", "descr"]) {
      for (const c of candidates) {
        if (c.name.toLowerCase().includes(kw)) return c.name;
      }
    }
    for (const c of candidates) {
      if (c.dataType === "string") return c.name;
    }
    return keyCol;
  }

  const datePrefix = new Map<string, string>();
  for (const t of dimTables) {
    const p = detectDatePrefix(tables.get(t)!);
    if (p) datePrefix.set(t, p);
  }

  // ---- ROLE-PLAY FAMILY DETECTION ------------------------------------------
  function normObj(o: string | null): string | null {
    return o ? o.trim().toLowerCase() : null;
  }

  const srcGroups = new Map<string, string[]>();
  for (const t of dimTables) {
    const key = normObj(physicalSource[t].fromObject);
    if (key) {
      if (!srcGroups.has(key)) srcGroups.set(key, []);
      srcGroups.get(key)!.push(t);
    }
  }

  const families = new Map<string, string[]>();
  for (const [obj, members] of srcGroups) {
    if (members.length > 1) families.set(obj, members);
  }
  const familyOfMember = new Map<string, string>();
  for (const [obj, members] of families) {
    for (const m of members) familyOfMember.set(m, obj);
  }
  const singletonDims = dimTables.filter((t) => !familyOfMember.has(t));

  const familyMeta = new Map<string, FamilyMeta>();
  for (const [fromObject, members] of families) {
    const label = familyLabel(fromObject);
    let isTimeFamily = members.some((m) => detectDatePrefix(tables.get(m)!));

    const physCols = new Map<string, string>();
    for (const m of members) {
      const src = physicalSource[m];
      const aliasToDtype = new Map<string, string>();
      for (const c of tables.get(m)!.columns) aliasToDtype.set(c.name, c.dataType ?? "string");
      if (src.kind === "query" && src.selectCols) {
        for (const [physcol, alias] of src.selectCols) {
          const dtype = (alias ? aliasToDtype.get(alias) : undefined) ?? aliasToDtype.get(physcol) ?? "string";
          const key = phys(physcol);
          if (!physCols.has(key)) physCols.set(key, dtype);
        }
      } else {
        for (const c of tables.get(m)!.columns) {
          const key = phys(c.name);
          if (!physCols.has(key)) physCols.set(key, c.dataType ?? "string");
        }
      }
    }

    const firstMember = members[0];
    const firstSrc = physicalSource[firstMember];
    let keyColPhys: string;
    if (firstSrc.kind === "query" && firstSrc.selectCols) {
      keyColPhys = phys(firstSrc.selectCols[0][0]);
    } else {
      keyColPhys = phys(fallbackKeyCol(firstMember));
    }

    let nameColPhys = keyColPhys;
    outer: for (const m of members) {
      const src = physicalSource[m];
      if (!(src.kind === "query" && src.selectCols)) continue;
      for (const [physcol, alias] of src.selectCols) {
        if (alias && ["name", "desc", "descr"].some((kw) => alias.toLowerCase().includes(kw))) {
          nameColPhys = phys(physcol);
          break outer;
        }
      }
    }

    const { prefixes: memberPrefix } = detectMemberPrefixes(members, physicalSource, [nameColPhys, keyColPhys], phys);

    let hier: FamilyHier | null = null;
    if (isTimeFamily) {
      const roleMember = members.find((m) => detectDatePrefix(tables.get(m)!))!;
      const prefix = detectDatePrefix(tables.get(roleMember)!)!;
      const src = physicalSource[roleMember];
      const aliasToPhys = new Map<string, string>();
      for (const [physcol, alias] of src.selectCols ?? []) {
        if (alias) aliasToPhys.set(alias, phys(physcol));
      }
      hier = {
        year: aliasToPhys.get(`${prefix} Yr`) ?? null,
        quarter: aliasToPhys.get(`${prefix} Yr Qtr`) ?? null,
        month: aliasToPhys.get(`${prefix} Yr Mnth`) ?? null,
        day: aliasToPhys.get(`${prefix} Dte`) ?? keyColPhys,
        yearLabel: "Yr",
        quarterLabel: "Yr Qtr",
        monthLabel: "Yr Mnth",
        dayLabel: "Dte",
      };
      if (!(hier.year && hier.quarter && hier.month && hier.day)) {
        logIssue(
          "warning",
          "incomplete_time_hierarchy",
          familyLabel(fromObject),
          `Detected as a date family (prefix '${prefix}' on member '${roleMember}') but one or more of ` +
            "the Year/Quarter/Month/Date columns could not be resolved to a physical column -- built as " +
            "a standard dimension instead of a time dimension. Check manually.",
        );
        isTimeFamily = false;
      }
    }

    familyMeta.set(fromObject, {
      label,
      members,
      isTime: isTimeFamily,
      physCols,
      keyCol: keyColPhys,
      nameCol: nameColPhys,
      hier,
      memberPrefix,
    });
  }

  // ============================================================== EMIT ==

  sml.set(
    "catalog.yml",
    toYaml(
      od({
        unique_name: catalogName,
        object_type: "catalog",
        label: opts.modelName,
        description: cleanDesc(
          opts.description ??
            `${opts.modelName} semantic model migrated from an SSAS Tabular model (${opts.tmslFileName}).`,
        ),
        version: 1.7,
        aggressive_agg_promotion: false,
        build_speculative_aggs: false,
      }),
    ),
  );

  sml.set(
    `connections/${primaryConnection}.yml`,
    toYaml(
      od({
        unique_name: primaryConnection,
        label: primaryConnection,
        object_type: "connection",
        as_connection: W,
        database: opts.database,
        schema: opts.schema,
      }),
    ),
  );

  const datasetFor = new Map<string, string>();
  for (const t of allModeled) datasetFor.set(t, t);
  const dimBaseLevel = new Map<string, string>();
  const familyDatasetName = new Map<string, string>();

  // --- DAX->MDX resolver registry -------------------------------------------
  // MDX needs qualified [Dimension].[Hierarchy].[Level] paths. Hierarchy naming
  // is NOT uniform here -- a standalone dimension gets "<t> Hierarchy" while a
  // consolidated role-play family's hierarchy is just "<label>" -- so each
  // dimension records its real names as it is built rather than the DAX module
  // guessing them later.
  const dimHierarchy = new Map<string, string>();
  const dimLevels = new Map<string, Set<string>>();
  const dimTimeTypes = new Set<string>();
  const dimYearLevel = new Map<string, string>();

  function registerDimension(
    dimension: string, hierarchy: string, levels: Iterable<string>,
    opts: { isTime?: boolean; yearLevel?: string } = {},
  ): void {
    dimHierarchy.set(dimension, hierarchy);
    dimLevels.set(dimension, new Set(levels));
    if (opts.isTime) dimTimeTypes.add(dimension);
    if (opts.yearLevel) dimYearLevel.set(dimension, opts.yearLevel);
  }

  function datasetColumnsFor(t: string): Array<Record<string, unknown>> {
    const cmap = colPhysMap(t);
    return tables.get(t)!.columns.map((c) =>
      od({ name: cmap.get(c.name), data_type: smlDtype(c.dataType) }),
    );
  }

  for (const t of [...factTables, ...dimTables.filter((d) => !familyOfMember.has(d))]) {
    const nMeasures = tables.get(t)!.measures?.length ?? 0;
    const [tablePhysName, connId] = tablePhysicalRef(t);
    let desc = `Migrated from SSAS Tabular table "${t}".`;
    if (factTablesSet.has(t)) {
      desc += ` Fact table (${nMeasures} source DAX measures; see README).`;
    } else if (excludedMeasureTables.includes(t)) {
      desc += ` Source table carried ${nMeasures} DAX measure(s), all complex cross-references ` +
        `(deferred) -- modeled as a dimension only.`;
    }
    if (physicalSource[t].kind === "query") {
      desc += ` Physical source confirmed from partition query: ${physicalSource[t].fromObject}.`;
    } else if (unresolvedTables.includes(t)) {
      desc += " WARNING: no queryable physical source could be resolved for this table " +
        `(partition kind: ${physicalSource[t].kind}) -- table/column names below are a ` +
        "naming-convention GUESS, not a confirmed physical source. See README.";
    }
    sml.set(
      `datasets/${t}.yml`,
      toYaml(
        od({
          unique_name: t,
          object_type: "dataset",
          label: t,
          description: cleanDesc(desc),
          connection_id: connId,
          table: tablePhysName,
          columns: datasetColumnsFor(t),
        }),
      ),
    );
  }

  function secondaryAttrsForFamily(fromObject: string, exclude: Set<string>): Array<Record<string, unknown>> {
    const meta = familyMeta.get(fromObject)!;
    const ds = meta.label;
    const physToAlias = new Map<string, [string, string]>();
    for (const m of meta.members) {
      const src = physicalSource[m];
      if (!(src.kind === "query" && src.selectCols)) continue;
      for (const [physcol, alias] of src.selectCols) {
        const key = phys(physcol);
        if (!physToAlias.has(key) && alias) physToAlias.set(key, [m, alias]);
      }
    }

    const attrs: Array<Record<string, unknown>> = [];
    for (const pcol of meta.physCols.keys()) {
      if (exclude.has(pcol)) continue;
      let label: string | null = null;
      if (physToAlias.has(pcol)) {
        const [m, alias] = physToAlias.get(pcol)!;
        const prefix = meta.memberPrefix[m];
        const stripped = prefix ? stripPrefixTokens(alias, prefix) : alias;
        label = stripped ?? alias;
      }
      if (!label) label = cleanLabel(pcol);
      attrs.push(od({ unique_name: label, label, dataset: ds, name_column: pcol, key_columns: [pcol] }));
    }
    return attrs;
  }

  for (const [fromObject, meta] of familyMeta) {
    const label = meta.label;
    const [db, schema, obj] = splitQualified(fromObject);
    const connId = connectionFor(db);
    const tablePhysName = W.toLowerCase() === "snowflake" ? obj.toUpperCase() : obj.toLowerCase();
    familyDatasetName.set(fromObject, label);

    const dsColumns = [...meta.physCols].map(([pcol, dt]) => od({ name: pcol, data_type: smlDtype(dt) }));
    sml.set(
      `datasets/${label}.yml`,
      toYaml(
        od({
          unique_name: label,
          object_type: "dataset",
          label,
          description: cleanDesc(
            `Conformed dimension consolidated from ${meta.members.length} SSAS Tabular tables that all ` +
              `read from the same source (${fromObject}), imported once per role because Tabular cannot ` +
              `role-play a dimension: ${meta.members.join(", ")}. See README.`,
          ),
          connection_id: connId,
          table: tablePhysName,
          columns: dsColumns,
        }),
      ),
    );

    if (meta.isTime && meta.hier && meta.hier.year && meta.hier.quarter && meta.hier.month && meta.hier.day) {
      const h = meta.hier;
      const { yearLabel: yl, quarterLabel: ql, monthLabel: ml, dayLabel: dl } = h;
      const levelAttrs = [
        od({ unique_name: yl, label: yl, dataset: label, key_columns: [h.year], name_column: h.year, time_unit: "year" }),
        od({ unique_name: ql, label: ql, dataset: label, key_columns: [h.quarter], name_column: h.quarter, time_unit: "quarter" }),
        od({ unique_name: ml, label: ml, dataset: label, key_columns: [h.month], name_column: h.month, time_unit: "month" }),
        od({ unique_name: dl, label: dl, dataset: label, key_columns: [meta.keyCol], name_column: h.day, time_unit: "day" }),
      ];
      const exclude = new Set([h.year!, h.quarter!, h.month!, h.day!, meta.keyCol]);
      const hierLevels = [
        od({ unique_name: yl }),
        od({ unique_name: ql }),
        od({ unique_name: ml }),
        od({ unique_name: dl, secondary_attributes: secondaryAttrsForFamily(fromObject, exclude) }),
      ];
      sml.set(
        `dimensions/${label}.yml`,
        toYaml(
          od({
            unique_name: label,
            object_type: "dimension",
            label,
            type: "time",
            description: cleanDesc(
              `Conformed calendar date dimension, consolidated from ${meta.members.length} SSAS Tabular ` +
                `tables that all read from ${fromObject}. Roles are expressed via SML role_play on the ` +
                `fact relationships instead of separate dimensions. Base level names (${yl}/${ql}/${ml}/${dl}) ` +
                `preserve the original Tabular alias wording so role-played captions (e.g. 'Serv ${dl}') ` +
                "match historical naming.",
            ),
            hierarchies: [od({ unique_name: label, label, levels: hierLevels })],
            level_attributes: levelAttrs,
          }),
        ),
      );
      dimBaseLevel.set(label, dl);
      registerDimension(label, label, [yl, ql, ml, dl], { isTime: true, yearLevel: yl });
      convertedDims.push({
        name: label,
        kind: "role_play_family",
        dimType: "time",
        sourceObject: fromObject,
        members: meta.members,
        numRolesCollapsed: meta.members.length,
        memberPrefixes: meta.memberPrefix,
      });
    } else {
      const exclude = new Set([meta.keyCol, meta.nameCol]);
      const secondary = secondaryAttrsForFamily(fromObject, exclude);
      sml.set(
        `dimensions/${label}.yml`,
        toYaml(
          od({
            unique_name: label,
            object_type: "dimension",
            label,
            type: "standard",
            description: cleanDesc(
              `Conformed dimension, consolidated from ${meta.members.length} SSAS Tabular tables that all ` +
                `read from ${fromObject}. Roles are expressed via SML role_play on the fact relationships ` +
                "instead of separate dimensions.",
            ),
            hierarchies: [od({ unique_name: label, label, levels: [od({ unique_name: label, secondary_attributes: secondary })] })],
            level_attributes: [
              od({ unique_name: label, label, dataset: label, key_columns: [meta.keyCol], name_column: meta.nameCol }),
            ],
          }),
        ),
      );
      dimBaseLevel.set(label, label);
      registerDimension(label, label, [label]);
      convertedDims.push({
        name: label,
        kind: "role_play_family",
        dimType: "standard",
        sourceObject: fromObject,
        members: meta.members,
        numRolesCollapsed: meta.members.length,
        memberPrefixes: meta.memberPrefix,
      });
    }
  }

  function secondaryAttrsFor(t: string, ds: string, excludeCols: Set<string>): Array<Record<string, unknown>> {
    const cmap = colPhysMap(t);
    const attrs: Array<Record<string, unknown>> = [];
    for (const c of tables.get(t)!.columns) {
      if (excludeCols.has(c.name)) continue;
      const pcol = cmap.get(c.name)!;
      attrs.push(od({ unique_name: c.name, label: c.name, dataset: ds, name_column: pcol, key_columns: [pcol] }));
    }
    return attrs;
  }

  function buildDateDimension(t: string): void {
    const prefix = datePrefix.get(t)!;
    const ds = datasetFor.get(t)!;
    const cmap = colPhysMap(t);
    const keyCol = fallbackKeyCol(t);
    const yearL = `${prefix} Yr`;
    const qtrL = `${prefix} Yr Qtr`;
    const mnthL = `${prefix} Yr Mnth`;
    const dayL = `${prefix} Dte`;
    const levelAttributes = [
      od({ unique_name: yearL, label: yearL, dataset: ds, key_columns: [cmap.get(yearL)], name_column: cmap.get(yearL), time_unit: "year" }),
      od({ unique_name: qtrL, label: qtrL, dataset: ds, key_columns: [cmap.get(qtrL)], name_column: cmap.get(qtrL), time_unit: "quarter" }),
      od({ unique_name: mnthL, label: mnthL, dataset: ds, key_columns: [cmap.get(mnthL)], name_column: cmap.get(mnthL), time_unit: "month" }),
      od({
        unique_name: dayL, label: dayL, dataset: ds, key_columns: [cmap.get(keyCol)], name_column: cmap.get(dayL), time_unit: "day",
        description: "Base grain of this date dimension (one row per calendar day).",
      }),
    ];
    const hierLevels = [
      od({ unique_name: yearL }),
      od({ unique_name: qtrL }),
      od({ unique_name: mnthL }),
      od({ unique_name: dayL, secondary_attributes: secondaryAttrsFor(t, ds, new Set([keyCol, yearL, qtrL, mnthL, dayL])) }),
    ];
    sml.set(
      `dimensions/${t}.yml`,
      toYaml(
        od({
          unique_name: t,
          object_type: "dimension",
          label: t,
          type: "time",
          description: `Conformed calendar date dimension for the '${prefix}' date role (migrated from ` +
            `SSAS Tabular table "${t}"). Grain: one row per day.`,
          hierarchies: [od({
            unique_name: `${t} Hierarchy`, label: `${t} Hierarchy`,
            description: `Year > Quarter > Month > Day rollup for ${prefix} date.`,
            levels: hierLevels,
          })],
          level_attributes: levelAttributes,
        }),
      ),
    );
    dimBaseLevel.set(t, dayL);
    registerDimension(t, `${t} Hierarchy`, [yearL, qtrL, mnthL, dayL], { isTime: true, yearLevel: yearL });
    const confirmed = physicalSource[t].kind === "query";
    convertedDims.push({
      name: t, kind: "standalone", dimType: "time",
      sourceObject: physicalSource[t].fromObject, physicalSourceConfirmed: confirmed,
    });
  }

  function buildHierarchyDimension(t: string): void {
    const ds = datasetFor.get(t)!;
    const cmap = colPhysMap(t);
    const tmslHiers = tables.get(t)!.hierarchies ?? [];
    const keyCol = fallbackKeyCol(t);
    const allCols = new Set<string>();
    const hierarchiesOut: Array<Record<string, unknown>> = [];
    for (const h of tmslHiers) {
      const hname = h.name.trim();
      const levelCols = [...h.levels].sort((a, b) => a.ordinal - b.ordinal).map((lv) => lv.column);
      for (const c of levelCols) allCols.add(c);
      const hierLevels: Array<Record<string, unknown>> = [];
      levelCols.forEach((col, i) => {
        if (i === levelCols.length - 1) {
          hierLevels.push(od({ unique_name: col, secondary_attributes: secondaryAttrsFor(t, ds, new Set(levelCols)) }));
        } else {
          hierLevels.push(od({ unique_name: col }));
        }
      });
      hierarchiesOut.push(od({
        unique_name: hname, label: hname,
        description: `Natural rollup migrated from SSAS Tabular hierarchy "${hname}".`,
        levels: hierLevels,
      }));
    }
    const levelAttributes = [...allCols].map((c) =>
      od({ unique_name: c, label: c, dataset: ds, key_columns: [cmap.get(c)], name_column: cmap.get(c) }),
    );
    if (!allCols.has(keyCol)) {
      levelAttributes.push(od({ unique_name: keyCol, label: keyCol, dataset: ds, key_columns: [cmap.get(keyCol)], name_column: cmap.get(keyCol) }));
      (hierarchiesOut[0].levels as Array<Record<string, unknown>>).unshift(od({ unique_name: keyCol, is_hidden: true }));
    }
    sml.set(
      `dimensions/${t}.yml`,
      toYaml(
        od({
          unique_name: t, object_type: "dimension", label: t, type: "standard",
          description: `Migrated from SSAS Tabular table "${t}" (natural hierarchy retained from source).`,
          hierarchies: hierarchiesOut, level_attributes: levelAttributes,
        }),
      ),
    );
    const sortedLevels = [...tmslHiers[0].levels].sort((a, b) => a.ordinal - b.ordinal);
    dimBaseLevel.set(t, sortedLevels[sortedLevels.length - 1].column);
    // A natural-hierarchy dimension can expose several hierarchies; the first
    // is the one a bare level reference resolves against.
    registerDimension(t, String(hierarchiesOut[0].unique_name), allCols);
    const confirmed = physicalSource[t].kind === "query";
    convertedDims.push({
      name: t, kind: "standalone", dimType: "natural_hierarchy",
      sourceObject: physicalSource[t].fromObject, physicalSourceConfirmed: confirmed,
    });
  }

  function buildSimpleDimension(t: string): void {
    const ds = datasetFor.get(t)!;
    const cmap = colPhysMap(t);
    const keyCol = fallbackKeyCol(t);
    const nameCol = pickNameColumn(t, keyCol);
    const levelName = t;
    const levelAttributes = [
      od({ unique_name: levelName, label: t, dataset: ds, key_columns: [cmap.get(keyCol)], name_column: cmap.get(nameCol) }),
    ];
    const hierLevels = [
      od({ unique_name: levelName, secondary_attributes: secondaryAttrsFor(t, ds, new Set([keyCol])) }),
    ];
    sml.set(
      `dimensions/${t}.yml`,
      toYaml(
        od({
          unique_name: t, object_type: "dimension", label: t, type: "standard",
          description: `Migrated from SSAS Tabular table "${t}".`,
          hierarchies: [od({ unique_name: `${t} Hierarchy`, label: `${t} Hierarchy`, levels: hierLevels })],
          level_attributes: levelAttributes,
        }),
      ),
    );
    dimBaseLevel.set(t, levelName);
    registerDimension(t, `${t} Hierarchy`, [levelName, keyCol]);
    const confirmed = physicalSource[t].kind === "query";
    convertedDims.push({
      name: t, kind: "standalone", dimType: "simple",
      sourceObject: physicalSource[t].fromObject, physicalSourceConfirmed: confirmed,
    });
  }

  for (const t of singletonDims) {
    if (datePrefix.has(t)) buildDateDimension(t);
    else if (tables.get(t)!.hierarchies?.length) buildHierarchyDimension(t);
    else buildSimpleDimension(t);
  }

  const allMetricNames: string[] = [];
  const metricFolder = new Map<string, string>();
  for (const ft of factTables) {
    const ds = datasetFor.get(ft)!;
    const cmap = colPhysMap(ft);
    const rowKey = fallbackKeyCol(ft);
    for (const m of tables.get(ft)!.measures ?? []) {
      const res = classifyMeasure(m);
      if (!res) continue;
      const { calc, col } = res;
      const physCol = cmap.get(col ?? rowKey)!;
      const isCurrency = /amt|amount|charge|payment|cost|writeoff|refund|adjustment/i.test(col ?? rowKey);
      const fmt = isCurrency ? "$#,##0.00" : "general number";
      sml.set(
        `metrics/${fileSafe(m.name)}.yml`,
        toYaml(
          od({
            unique_name: m.name, object_type: "metric", label: m.name,
            description: cleanDesc(`Migrated from SSAS Tabular measure "${m.name}" on "${ft}" (source DAX: ${exprText(m).slice(0, 160)}).`),
            calculation_method: calc, format: fmt, dataset: ds, column: physCol,
            unrelated_dimensions_handling: "repeat",
          }),
        ),
      );
      allMetricNames.push(m.name);
      metricFolder.set(m.name, ft);
      convertedMetrics.push({ name: m.name, fact: ft, calculationMethod: calc, column: physCol });
    }
  }

  // --- DAX measures that are not a bare aggregation ---------------------------
  // Previously every one of these was deferred untranslated. Now each is routed
  // to the conversion path AtScale will actually accept: verbatim server-side
  // DAX when every function is on the whitelist, generated MDX when the whole
  // expression has a faithful equivalent, and deferral only when neither holds.
  const tableToDimension = new Map<string, string>();
  for (const [member, fromObject] of familyOfMember) {
    const label = familyDatasetName.get(fromObject);
    if (label) tableToDimension.set(member, label);
  }
  for (const dim of dimHierarchy.keys()) {
    if (!tableToDimension.has(dim)) tableToDimension.set(dim, dim);
  }

  const sourceMeasureNames = new Set<string>();
  for (const t of usedTables) {
    for (const m of tables.get(t)?.measures ?? []) sourceMeasureNames.add(m.name);
  }

  const daxResolver = buildResolver({
    measures: sourceMeasureNames,
    dimensionOf: tableToDimension,
    levelsOf: dimLevels,
    hierarchyOf: dimHierarchy,
    timeDimensions: dimTimeTypes,
    defaultLevelOf: dimBaseLevel,
    yearLevelOf: dimYearLevel,
  });

  const columnLookup: ColumnLookup = {
    isColumn: (t, n) => (tables.get(t)?.columns ?? []).some((c) => c.name === n),
    isMeasure: (t, n) => (tables.get(t)?.measures ?? []).some((mm) => mm.name === n),
    knowsTable: (t) => tables.has(t),
  };

  // Index the base metrics already emitted, so a lifted SUM('F'[charge]) reuses
  // the model's existing "Gross Charge" instead of minting a duplicate.
  const metricByAggregation = new Map<string, string>();
  const aggKey = (dataset: string, column: string, method: string): string =>
    `${dataset}\u0000${column}\u0000${method}`;
  for (const m of convertedMetrics) {
    const ds = datasetFor.get(m.fact) ?? m.fact;
    metricByAggregation.set(aggKey(ds, m.column, m.calculationMethod), m.name);
  }

  const liftedMetrics: Array<{ name: string; dataset: string; column: string; method: string }> = [];

  // Minting is staged, not immediate: a lifted aggregation is only worth a new
  // base metric if the rewrite actually unblocks the measure. Without this a
  // measure that still fails after extraction leaves orphan hidden metrics
  // behind, referenced by nothing.
  type PendingMetric = {
    key: string; name: string; dataset: string; physCol: string; method: string; table: string;
  };
  let pendingMetrics: PendingMetric[] = [];

  function commitPendingMetrics(): void {
    for (const pm of pendingMetrics) {
      sml.set(
        `metrics/${fileSafe(pm.name)}.yml`,
        toYaml(
          od({
            unique_name: pm.name,
            object_type: "metric",
            label: pm.name,
            description: cleanDesc(
              `Base metric created by ps-utils so inline ${pm.method.toUpperCase()} aggregations ` +
                `over "${pm.physCol}" could be lifted out of DAX calculations. AtScale models ` +
                "plain aggregations as metrics, not calculations.",
            ),
            calculation_method: pm.method,
            dataset: pm.dataset,
            column: pm.physCol,
            is_hidden: true,
            unrelated_dimensions_handling: "repeat",
          }),
        ),
      );
      allMetricNames.push(pm.name);
      sourceMeasureNames.add(pm.name); // so MDX can resolve the lifted metric
      metricFolder.set(pm.name, pm.table);
      metricByAggregation.set(pm.key, pm.name);
      convertedMetrics.push({
        name: pm.name, fact: pm.table, calculationMethod: pm.method, column: pm.physCol,
      });
      liftedMetrics.push({
        name: pm.name, dataset: pm.dataset, column: pm.physCol, method: pm.method,
      });
    }
    pendingMetrics = [];
  }

  const metricProvider: MetricProvider = ({ method, table, column }) => {
    const dataset = datasetFor.get(table);
    if (!dataset || !tables.has(table)) return undefined;
    const physCol = colPhysMap(table).get(column);
    if (!physCol) return undefined;

    const key = aggKey(dataset, physCol, method);
    const existing = metricByAggregation.get(key);
    if (existing) return { metric: existing, created: false };

    const staged = pendingMetrics.find((pm) => pm.key === key);
    if (staged) return { metric: staged.name, created: true };

    let name = defaultMetricName(method, column);
    const taken = (n: string): boolean =>
      allMetricNames.includes(n) || pendingMetrics.some((pm) => pm.name === n);
    if (taken(name)) name = `${name} (${table})`;
    if (taken(name)) return undefined;

    pendingMetrics.push({ key, name, dataset, physCol, method, table });
    return { metric: name, created: true };
  };

  const daxClassifier = new MeasureClassifier(daxResolver, columnLookup, metricProvider);
  const assessments: MeasureAssessment[] = [];
  const factDeferred = new Map<string, Array<[string, string]>>();
  const convertedCalcs: Array<{ name: string; fact: string; engine: string; confidence: string }> = [];

  for (const ft of factTables) {
    for (const m of tables.get(ft)!.measures ?? []) {
      if (classifyMeasure(m)) continue; // already emitted as a base metric
      pendingMetrics = [];
      const a = daxClassifier.classify(ft, m.name, exprText(m));
      if (a.verdict === "daxNative" || a.verdict === "mdxTranslated") commitPendingMetrics();
      else pendingMetrics = [];
      assessments.push(a);

      if (a.verdict === "daxNative" || a.verdict === "mdxTranslated") {
        const engine = a.verdict === "daxNative" ? "dax" : "mdx";
        const expression = a.verdict === "daxNative"
          ? (a.rewrittenExpression ?? a.expression)
          : a.mdx!;
        const review = a.notes.length ? ` Review: ${a.notes.join("; ")}` : "";
        const provenance = a.verdict === "mdxTranslated"
          ? ` Translated from DAX by ps-utils (source DAX: ${exprText(m).slice(0, 160)}).`
          : a.rewrittenExpression
            ? ` Inline aggregations lifted into base metrics by ps-utils (source DAX: ${exprText(m).slice(0, 160)}).`
            : ` Migrated verbatim as AtScale server-side DAX.`;
        sml.set(
          `calculations/${fileSafe(m.name)}.yml`,
          toYaml(
            od({
              unique_name: m.name,
              object_type: "metric_calc",
              label: m.name,
              description: cleanDesc(
                `Migrated from SSAS Tabular measure "${m.name}" on "${ft}".${provenance}${review}`,
              ),
              expression,
            }),
          ),
        );
        allMetricNames.push(m.name);
        metricFolder.set(m.name, ft);
        convertedCalcs.push({ name: m.name, fact: ft, engine, confidence: a.confidence });
        continue;
      }

      if (!factDeferred.has(ft)) factDeferred.set(ft, []);
      factDeferred.get(ft)!.push([m.name, exprText(m)]);
    }
  }

  // A converted calculation that references a measure which did NOT convert
  // would publish and then fail to resolve at query time, so flag it here.
  const convertedNames = new Set(allMetricNames);
  for (const a of assessments) {
    if (a.verdict !== "daxNative" && a.verdict !== "mdxTranslated") continue;
    const missing = a.referencedMeasures.filter((r) => !convertedNames.has(r));
    if (missing.length) {
      logIssue("warning", "calculation_references_deferred_measure", a.name,
        `References ${missing.map((x) => `"${x}"`).join(", ")}, which did not convert. ` +
          "The calculation will publish but not resolve until those are modeled.");
    }
  }

  const totalDeferred = [...factDeferred.values()].reduce((n, v) => n + v.length, 0);

  function targetDatasetAndLevel(toTable: string): [string, string | undefined] {
    if (familyOfMember.has(toTable)) {
      const fromObject = familyOfMember.get(toTable)!;
      const dsName = familyDatasetName.get(fromObject)!;
      return [dsName, dimBaseLevel.get(dsName)];
    }
    return [datasetFor.get(toTable) ?? toTable, dimBaseLevel.get(toTable) ?? toTable];
  }

  const factTargetCols = new Map<string, Set<string>>();
  for (const r of rels) {
    if (!factTablesSet.has(r.fromTable)) continue;
    let targetKey: string;
    if (familyOfMember.has(r.toTable)) targetKey = familyOfMember.get(r.toTable)!;
    else if (dimBaseLevel.has(r.toTable) || singletonDims.includes(r.toTable)) targetKey = r.toTable;
    else continue;
    const k = `${r.fromTable}${targetKey}`;
    if (!factTargetCols.has(k)) factTargetCols.set(k, new Set());
    factTargetCols.get(k)!.add(r.fromColumn);
  }

  function roleLabelFromColumn(col: string): string {
    // Fallback only -- generic surrogate-key naming conventions (leading "d_",
    // trailing "_sk"/"_key"/"_id"), not any particular source schema's own
    // column-naming vocabulary. Prefer the alias-derived role_play prefix
    // (recovered from the source's own column aliases) whenever available;
    // this only fires when that recovery fails.
    let base = col.replace(/^d_/i, "");
    base = base.replace(/_(sk|key|id)$/i, "");
    base = base.replace(/^_+|_+$/g, "") || col;
    return `${cleanLabel(base)} {0}`;
  }

  const modelRelationships: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const r of rels) {
    const ft = r.fromTable;
    if (!factTablesSet.has(ft)) continue;
    const dt = r.toTable;
    const [dsName, level] = targetDatasetAndLevel(dt);
    if (level === undefined) {
      logIssue(
        "error", "unmapped_relationship", `${ft} -> ${dt}`,
        `Fact '${ft}' has a relationship to '${dt}' via column '${r.fromColumn}', but no dataset/level ` +
          `could be resolved for '${dt}' (it isn't a fact, a singleton dimension, or a role-play family ` +
          `member). This relationship was DROPPED -- check whether '${dt}' should have been classified ` +
          "as a dimension.",
      );
      continue;
    }
    const targetKey = familyOfMember.get(dt) ?? dt;
    const distinctCols = factTargetCols.get(`${ft}${targetKey}`) ?? new Set<string>();
    let rolePlay: string | null = null;
    if (distinctCols.size > 1) {
      let prefix: string | null = null;
      if (familyOfMember.has(dt)) {
        const fo = familyOfMember.get(dt)!;
        prefix = familyMeta.get(fo)!.memberPrefix[dt] ?? null;
      }
      if (prefix) {
        rolePlay = `${prefix} {0}`;
      } else {
        rolePlay = roleLabelFromColumn(r.fromColumn);
        logIssue(
          "warning", "role_play_label_fallback", `${ft} -> ${dt}`,
          `Could not recover an original alias-based prefix for '${dt}' -- role_play label '${rolePlay}' ` +
            "was derived from the FK column name instead, and may not match the exact historical naming " +
            "this dimension used to have.",
        );
      }
    }
    let uname = `${ft}_${dsName}_${r.fromColumn}`;
    let i = 2;
    while (seen.has(uname)) {
      uname = `${ft}_${dsName}_${r.fromColumn}_${i}`;
      i += 1;
    }
    seen.add(uname);
    const rel: Record<string, unknown> = od({
      unique_name: uname,
      from: od({ dataset: datasetFor.get(ft), join_columns: [colPhysMap(ft).get(r.fromColumn)] }),
      to: od({ dimension: dsName, level }),
    });
    if (rolePlay) rel.role_play = rolePlay;
    modelRelationships.push(rel);
  }

  const dedup = new Set<string>();
  const finalRels: Array<Record<string, unknown>> = [];
  for (const r of modelRelationships) {
    const from = r.from as Record<string, unknown>;
    const to = r.to as Record<string, unknown>;
    const k = `${from.dataset}${(from.join_columns as string[])[0]}${to.dimension}`;
    if (dedup.has(k)) {
      logIssue(
        "info", "duplicate_relationship_collapsed", r.unique_name as string,
        `Same physical join (${from.dataset}.${(from.join_columns as string[])[0]} -> ${to.dimension}) was ` +
          "mapped to more than one role in the source model -- collapsed to a single ordinary relationship " +
          "instead of two redundant ones.",
      );
      continue;
    }
    dedup.add(k);
    finalRels.push(r);
  }

  const modelMetrics = allMetricNames.map((n) => od({ unique_name: n, folder: metricFolder.get(n) }));
  sml.set(
    `models/${opts.modelName}.yml`,
    toYaml(
      od({
        unique_name: opts.modelName, object_type: "model", label: opts.modelName,
        description: cleanDesc(
          opts.description ?? `${opts.modelName} model migrated from SSAS Tabular. Pass 1: structure + ` +
            "simple metrics only -- see README.",
        ),
        visible: true, relationships: finalRels, metrics: modelMetrics,
      }),
    ),
  );

  for (const [dbKey, connName] of extraConnectionsCreated) {
    let schemaGuess = opts.schema;
    for (const [fo] of familyMeta) {
      const [d, s] = splitQualified(fo);
      if (d && d.toUpperCase() === dbKey && s) {
        schemaGuess = W.toLowerCase() === "snowflake" ? s.toUpperCase() : s.toLowerCase();
        break;
      }
    }
    for (const t of allModeled) {
      const src = physicalSource[t];
      if (src.kind === "query" && src.fromObject) {
        const [d, s] = splitQualified(src.fromObject);
        if (d && d.toUpperCase() === dbKey && s) {
          schemaGuess = W.toLowerCase() === "snowflake" ? s.toUpperCase() : s.toLowerCase();
          break;
        }
      }
    }
    sml.set(
      `connections/${connName}.yml`,
      toYaml(od({ unique_name: connName, label: connName, object_type: "connection", as_connection: W, database: dbKey, schema: schemaGuess })),
    );
  }

  sml.set(`context/${opts.tmslFileName}`, opts.tmslRawContent);

  const ddl: string[] = [
    `-- Derived DDL (${W}) -- reconstructed for traceability; confirmed physical`,
    "-- sources are noted per table; unconfirmed ones are a naming-convention guess.\n",
  ];
  for (const t of [...factTables, ...singletonDims]) {
    const [tablePhysName] = tablePhysicalRef(t);
    const cmap = colPhysMap(t);
    const confirmed = physicalSource[t].kind === "query";
    ddl.push(`-- ${confirmed ? "CONFIRMED" : "GUESSED"} physical source for "${t}"`);
    ddl.push(`CREATE TABLE ${opts.database}.${opts.schema}.${tablePhysName} (`);
    ddl.push(tables.get(t)!.columns.map((c) => `    ${cmap.get(c.name)} ${smlDtype(c.dataType).toUpperCase()}`).join(",\n"));
    ddl.push(");\n");
  }
  for (const [fromObject, meta] of familyMeta) {
    const [db, schema, obj] = splitQualified(fromObject);
    const tablePhysName = W.toLowerCase() === "snowflake" ? obj.toUpperCase() : obj.toLowerCase();
    ddl.push(`-- CONFIRMED physical source for family "${meta.label}" (${meta.members.join(", ")})`);
    ddl.push(`CREATE TABLE ${db}.${schema}.${tablePhysName} (`);
    ddl.push([...meta.physCols].map(([pcol, dt]) => `    ${pcol} ${smlDtype(dt).toUpperCase()}`).join(",\n"));
    ddl.push(");\n");
  }
  sml.set("context/ddl.sql", ddl.join("\n"));

  sml.set("context/erd.mmd", buildMermaidDiagram(rels, factTablesSet, new Set(singletonDims), familyOfMember).replace(/^```mermaid\n|\n```$/g, ""));

  const useCase: string[] = [
    `# ${opts.modelName} -- Derived Use Case`, "",
    "No use-case document was supplied; derived from the source model's own measures and hierarchies.", "",
    "## Subject areas / fact tables", "",
  ];
  for (const ft of factTables) {
    const joined = [...new Set(rels.filter((r) => r.fromTable === ft).map((r) => familyOfMember.get(r.toTable) ?? r.toTable))].sort();
    const nSimple = (tables.get(ft)!.measures ?? []).filter((m) => classifyMeasure(m)).length;
    useCase.push(
      `### ${ft}`,
      `- ${nSimple} simple metrics modeled, ${(factDeferred.get(ft) ?? []).length} deferred.`,
      `- Dimensions joined: ${joined.join(", ")}`, "",
    );
  }
  sml.set("context/use_case.md", useCase.join("\n"));

  sml.set(
    "context/build.yaml",
    toYaml(
      od({
        inputs: od({
          use_case: "./context/use_case.md (derived)",
          ddl: "./context/ddl.sql (derived)",
          erd: "./context/erd.mmd (derived)",
          existing_sml: `./context/${opts.tmslFileName} (TMSL export -- ground truth)`,
        }),
        output_dir: "./output",
        unrelated_dimension_handling: "repeat",
        warehouse: W,
        database: opts.database,
        schema: opts.schema,
        model_unique_name: opts.modelName,
        catalog_unique_name: catalogName,
        currency: opts.currency ?? "USD",
        time_window: "calendar",
        use_cases_excluded: excludedMeasureTables,
        semi_additive_default: "none (deferred)",
        role_play_families: Object.fromEntries([...familyMeta.values()].map((meta) => [meta.label, meta.members])),
        unresolved_physical_sources: unresolvedTables,
        extra_connections: extraConnectionsCreated.map(([, c]) => c),
        mode: "programmatic",
      }),
    ),
  );

  const dl: string[] = [
    "# Deferred measures -- follow-up pass", "",
    "Measures that convert neither as AtScale server-side DAX nor as MDX. Each one lists the " +
      "functions that blocked it and where the logic belongs instead, so this is a work list " +
      "rather than a pile of untranslated DAX.", "",
    `**Total deferred: ${totalDeferred}**`, "",
  ];
  for (const ft of factTables) {
    const deferred = factDeferred.get(ft);
    if (!deferred || deferred.length === 0) continue;
    dl.push(`## ${ft} (${deferred.length} deferred)\n`);
    for (const [name, dax] of deferred) {
      dl.push(`**${name}**`, "```dax", dax, "```");
      const a = assessments.find((x) => x.name === name && x.table === ft);
      if (a) {
        const blocked = [...new Set(a.blockers.map((b) => b.fn))].sort();
        // Split incidental blockers (ones the translator handles on its own)
        // from the ones that actually need a decision, so this reads as a work
        // list rather than a frequency table.
        const real = blocked.filter((f) => !isIncidentalBlocker(f));
        const incidental = blocked.filter((f) => isIncidentalBlocker(f));
        if (real.length) dl.push(`- Blocked by: ${real.map((f) => `\`${f}\``).join(", ")}`);
        if (incidental.length) {
          dl.push(`- Also present (translatable on their own): ${
            incidental.map((f) => `\`${f}\``).join(", ")}`);
        }
        if (a.error) dl.push(`- Reason: ${a.error}`);
        for (const note of a.notes) dl.push(`- ${note}`);
      }
      dl.push("");
    }
  }
  dl.push("## Excluded-measure tables (modeled as dimensions only)\n");
  for (const t of excludedMeasureTables) {
    dl.push(`### ${t}`);
    for (const m of tables.get(t)!.measures ?? []) {
      dl.push(`**${m.name}**`, "```dax", exprText(m), "```", "");
    }
  }
  sml.set("DEFERRED_MEASURES.md", dl.join("\n"));

  const nDatasets = factTables.length + singletonDims.length + familyMeta.size;
  const nDims = singletonDims.length + familyMeta.size;
  const rolePlayLines = [...familyMeta.entries()]
    .map(([fo, meta]) => `| ${meta.label} | \`${fo}\` | ${meta.members.length} | ${meta.members.join(", ")} |`)
    .join("\n") || "| (none detected) | | | |";
  const unresolvedLines = unresolvedTables.map((t) => `- \`${t}\` (partition kind: \`${physicalSource[t].kind}\`)`).join("\n") || "- (none)";
  const extraConnLines = extraConnectionsCreated.map(([db, c]) => `- \`${c}\` (database \`${db}\`)`).join("\n") || "- (none)";

  const readme = `# ${opts.modelName} -- AtScale SML Model (Pass 1)

Migrated from SSAS Tabular (TMSL/XMLA export \`${opts.tmslFileName}\`) via ps-utils' \`generate-sml-from-tabular\`,
targeting ${W}. This is Pass 1: full structural skeleton (every fact, dimension, relationship) plus
mechanically-unambiguous metrics only. See \`DEFERRED_MEASURES.md\` for ${totalDeferred} complex DAX measures
left for a follow-up pass.

## Inputs

- **\`context/${opts.tmslFileName}\`** -- verbatim TMSL/XMLA export; the primary content input. Every
  table's partition query was also parsed to recover its real physical source where possible (see below)
  -- this stands in for a DDL/data-profile input wherever it succeeded.
- **\`context/ddl.sql\`** -- derived \`CREATE TABLE\` statements, each marked CONFIRMED (from a resolved
  partition query) or GUESSED (naming-convention fallback -- verify these against real DDL).
- **\`context/erd.mmd\`** -- derived Mermaid ERD from the TMSL relationships block.
- **\`context/use_case.md\`** -- derived from the source model's own measures/hierarchies.
- **Data profile**: not provided.
- **Target warehouse**: ${W} (explicit).

## Build parameters

| Parameter | Value | Source |
|---|---|---|
| \`unrelated_dimension_handling\` | \`repeat\` | Default -- multi-fact model |
| \`warehouse\` | ${W} | Explicit |
| \`model_unique_name\` | \`${opts.modelName}\` | Explicit |
| \`catalog_unique_name\` | \`${catalogName}\` | \`<model>_catalog\` |
| \`database\` / \`schema\` | \`${opts.database}\` / \`${opts.schema}\` | Explicit (primary connection) |
| \`currency\` | ${opts.currency ?? "USD"} | ${opts.currency && opts.currency !== "USD" ? "Explicit" : "Default"} |
| \`time_window\` | calendar | Default -- no fiscal/retail445 signal handled |
| \`use_cases_excluded\` | ${excludedMeasureTables.length} tables | See below |
| \`semi_additive_default\` | none this pass | Deferred |

## Assumptions and decisions

- **Role-play family detection.** ${familyMeta.size} group(s) of dimension tables were found to share the
  exact same resolved physical source (proof: their partition queries' \`FROM\` clause resolves to the same
  object) -- meaning Tabular had imported that one source multiple times to fake role-play. Each group was
  consolidated into ONE SML dimension, wired to facts via \`role_play\` where a fact has genuinely multiple
  distinct FK columns into it, or an ordinary relationship where it has only one:

  | Consolidated dimension | Source object | Tables collapsed | Members |
  |---|---|---|---|
${rolePlayLines}

- **Physical naming.** Where a table's partition query could be resolved to a single-object
  \`SELECT ... FROM\`, its real physical table/column names were used directly (confirmed, not guessed).
  Where it could not be resolved (a DAX calculated table, a join across multiple sources, or no parseable
  query), the physical name falls back to a ${W.toLowerCase() === "snowflake" ? "UPPER_SNAKE_CASE" : "lower_snake_case"}
  guess from the Tabular display name -- **verify these against real DDL/a data profile before trusting them:**
${unresolvedLines}
- **Cross-database sources.** ${extraConnectionsCreated.length === 0 ? "No additional connections were needed -- every resolved source lives in the primary database." : `${extraConnectionsCreated.length} table(s) resolved to a source in a different database than \`--database ${opts.database}\`, so additional connection object(s) were created automatically:`}
${extraConnLines}
- **${orphanTables.length} orphan tables excluded** (no relationships to anything): ${orphanTables.length ? orphanTables.join(", ") : "(none)"}.
- **${excludedMeasureTables.length} tables modeled as dimensions only, not facts**: ${excludedMeasureTables.length ? excludedMeasureTables.join(", ") : "(none)"}.
  Each carries measures in the source but never joins out to another table, so there's no relationship to
  attach as a fact without fabricating one; their measures are deferred.
- **\`is_unique_key\` omitted everywhere** (no data profile).
- **\`name_column\` chosen by heuristic** (first non-hidden column/alias whose name contains
  "name"/"desc"/"descr", else the key column) -- spot-check it.
- **A family's natural key is assumed to be the first column in its members' SELECT list** -- a
  convention, not a guarantee; verify on unfamiliar schemas.
- **Simple-measure classification**: measures that were a bare SUM/AVERAGE/MIN/MAX/DISTINCTCOUNT/COUNT/
  COUNTROWS were translated; the rest are deferred (see \`DEFERRED_MEASURES.md\`). \`COUNTROWS\` metrics use
  \`count non-null\` on the fact's key column as a row-count approximation (SML has no literal "count rows"
  method).
- **No semi-additive metrics, snowflake bridges, or time-intelligence calcs this pass** -- all deferred
  alongside the complex measures.

## Generation summary

- **Datasets:** ${nDatasets} (${factTables.length} facts + ${singletonDims.length} standalone dimensions +
  ${familyMeta.size} consolidated role-play families; ${orphanTables.length} orphans excluded from
  ${allTables.size} source tables)
- **Dimensions:** ${nDims} (${familyMeta.size} of which are consolidated role-play families replacing
  ${[...familyMeta.values()].reduce((n, m) => n + m.members.length, 0)} separate Pass-1-style dimensions)
- **Fact tables:** ${factTables.length}
- **Model relationships:** ${finalRels.length}
- **Base metrics emitted:** ${allMetricNames.length} (of ${allMetricNames.length + totalDeferred} total source measures)
- **Known caveats:** see "Assumptions and decisions" above and this operation's module docstring for
  structural limitations.

## Reproducing this build

\`context/\` holds a verbatim copy of the source TMSL and the effective \`build.yaml\` (including the
detected role-play families, unresolved physical sources, and any extra connections created). Re-running
\`generate-sml-from-tabular\` with the same arguments against the same TMSL file reproduces an equivalent
model (the conversion is deterministic).
`;
  sml.set("README.md", readme);

  // ======================================================= CONVERSION REPORT
  const sevOrder: Record<Severity, number> = { error: 0, action_needed: 1, warning: 2, info: 3 };
  const issuesSorted = [...issues].sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
  const sevCounts: Record<string, number> = {};
  for (const i of issues) sevCounts[i.severity] = (sevCounts[i.severity] ?? 0) + 1;

  const rolePlayDims = convertedDims.filter((d) => d.kind === "role_play_family");
  const standaloneDims = convertedDims.filter((d) => d.kind === "standalone");
  const unconfirmedStandalone = standaloneDims.filter((d) => !d.physicalSourceConfirmed);

  const reportLines: string[] = [
    `# Conversion Report -- ${opts.modelName}`, "",
    `Source: \`${opts.tmslFileName}\`  |  Warehouse: ${W}  |  Generated by ps-utils' \`generate-sml-from-tabular\``, "",
    "This report is the complete account of what this run converted automatically, what it deliberately " +
      "left for manual follow-up, and every issue it noticed along the way. Pair it with " +
      "`DEFERRED_MEASURES.md` (full DAX text for every unconverted measure) when handing this off for " +
      "manual work.", "",
    "## Summary", "",
    "| | Count |", "|---|---|",
    `| Fact tables converted | ${factTables.length} |`,
    `| Dimensions converted (total) | ${convertedDims.length} |`,
    `| &nbsp;&nbsp;-- role-play families (replacing ${rolePlayDims.reduce((n, d) => n + (d.numRolesCollapsed ?? 0), 0)} source tables) | ${rolePlayDims.length} |`,
    `| &nbsp;&nbsp;-- standalone dimensions | ${standaloneDims.length} |`,
    `| &nbsp;&nbsp;&nbsp;&nbsp;-- of which, physical source UNCONFIRMED (guessed) | ${unconfirmedStandalone.length} |`,
    `| Metrics converted | ${convertedMetrics.length} |`,
    `| Calculations converted | ${convertedCalcs.length} (${convertedCalcs.filter((c) => c.engine === "dax").length} as server-side DAX, ${convertedCalcs.filter((c) => c.engine === "mdx").length} translated to MDX) |`,
    `| Measures NOT converted (deferred, complex DAX) | ${totalDeferred} |`,
    `| Model relationships created | ${finalRels.length} |`,
    `| Orphan tables excluded | ${orphanTables.length} |`,
    `| Tables with measures but no fact relationship (excluded) | ${excludedMeasureTables.length} |`,
    `| Extra connections created (cross-database) | ${extraConnectionsCreated.length} |`,
    `| **Issues logged** | **${issues.length}** (${sevCounts.error ?? 0} error, ${sevCounts.action_needed ?? 0} action needed, ${sevCounts.warning ?? 0} warning, ${sevCounts.info ?? 0} info) |`,
    "",
    "## What got converted", "",
    "### Dimensions -- role-play families", "",
    "Groups of source tables that all read from the identical physical object (proof they were the same " +
      "dimension, imported multiple times because Tabular can't role-play), consolidated into one SML " +
      "dimension each. Recovered prefixes are each member's ORIGINAL alias-derived naming (or, failing " +
      "that, its table-name-derived naming) -- used verbatim as the `role_play` label so the role-played " +
      "result matches historical report naming as closely as possible.", "",
    "| Dimension | Type | Source object | Roles | Recovered role prefixes |",
    "|---|---|---|---|---|",
  ];
  for (const d of rolePlayDims) {
    const prefixStr = Object.entries(d.memberPrefixes ?? {}).map(([m, p]) => `${m} → ‘${p ?? "(none)"}’`).join("; ");
    reportLines.push(`| ${d.name} | ${d.dimType} | \`${d.sourceObject}\` | ${d.numRolesCollapsed} | ${prefixStr} |`);
  }
  if (rolePlayDims.length === 0) reportLines.push("| (none detected) | | | | |");

  reportLines.push(
    "", "### Dimensions -- standalone", "",
    "| Dimension | Type | Physical source | Confirmed? |", "|---|---|---|---|",
  );
  for (const d of standaloneDims) {
    reportLines.push(`| ${d.name} | ${d.dimType} | \`${d.sourceObject ?? "(guessed)"}\` | ${d.physicalSourceConfirmed ? "Yes" : "NO -- guessed"} |`);
  }

  reportLines.push(
    "", `### Metrics (${convertedMetrics.length} converted)`, "",
    "| Metric | Fact | Calculation | Column |", "|---|---|---|---|",
  );
  for (const m of convertedMetrics) {
    reportLines.push(`| ${m.name} | ${m.fact} | ${m.calculationMethod} | ${m.column} |`);
  }

  reportLines.push(
    "", "## What did NOT get converted -- needs manual follow-up", "",
    `### Complex DAX measures (${totalDeferred} total)`, "",
    "Full DAX text for every one of these is in `DEFERRED_MEASURES.md`. Summary by fact:", "",
    "| Fact | Deferred measures |", "|---|---|",
  );
  for (const ft of factTables) {
    const deferred = factDeferred.get(ft);
    if (deferred && deferred.length) reportLines.push(`| ${ft} | ${deferred.length} |`);
  }

  reportLines.push(
    "", `### Tables with measures excluded entirely (${excludedMeasureTables.length})`, "",
    "These carry DAX measures but never join out to another table -- see the " +
      "`measures_without_fact_relationship` issues below for what to do about them.", "",
  );
  for (const t of excludedMeasureTables) {
    reportLines.push(`- \`${t}\` (${(tables.get(t)!.measures ?? []).length} measures)`);
  }
  if (excludedMeasureTables.length === 0) reportLines.push("- (none)");

  reportLines.push(
    "", `### Tables with no confirmed physical source (${unresolvedTables.length})`, "",
    "Table/column names for these are a naming-convention guess, not a confirmed physical object -- see " +
      "the `unresolved_physical_source` issues below for why each one failed to resolve, and consider a " +
      "manual `sql:` query-dataset rebuild.", "",
  );
  for (const t of unresolvedTables) reportLines.push(`- \`${t}\` (partition kind: \`${physicalSource[t].kind}\`)`);
  if (unresolvedTables.length === 0) reportLines.push("- (none)");

  reportLines.push(
    "", `### Orphan tables excluded (${orphanTables.length})`, "",
    "No relationships to anything in the source model -- not converted, not necessarily a problem (may " +
      "be unused, or used by a different cube/perspective not in this export).", "",
  );
  for (const t of orphanTables) reportLines.push(`- \`${t}\``);
  if (orphanTables.length === 0) reportLines.push("- (none)");

  reportLines.push(
    "", "## All issues encountered, in detail", "",
    "Sorted by severity (error > action_needed > warning > info). `error` means something was dropped and " +
      "likely needs a fix; `action_needed` means the model is usable but a human should confirm something " +
      "before trusting it in production; `warning` and `info` are FYI.", "",
    "| Severity | Category | Object | Message |", "|---|---|---|---|",
  );
  for (const i of issuesSorted) {
    const msg = i.message.replace(/\|/g, "\\|");
    reportLines.push(`| ${i.severity} | ${i.category} | \`${i.object}\` | ${msg} |`);
  }
  if (issues.length === 0) reportLines.push("| (none) | | | |");

  sml.set("CONVERSION_REPORT.md", reportLines.join("\n"));

  const conversionReportJson = {
    modelName: opts.modelName,
    sourceTmsl: opts.tmslFileName,
    summary: {
      factTablesConverted: factTables.length,
      dimensionsConvertedTotal: convertedDims.length,
      rolePlayFamilies: rolePlayDims.length,
      rolePlaySourceTablesCollapsed: rolePlayDims.reduce((n, d) => n + (d.numRolesCollapsed ?? 0), 0),
      standaloneDimensions: standaloneDims.length,
      standaloneDimensionsUnconfirmedSource: unconfirmedStandalone.length,
      metricsConverted: convertedMetrics.length,
      calculationsConverted: convertedCalcs.length,
      calculationsAsDax: convertedCalcs.filter((c) => c.engine === "dax").length,
      calculationsAsMdx: convertedCalcs.filter((c) => c.engine === "mdx").length,
      calculationsNeedingReview: convertedCalcs.filter((c) => c.confidence !== "high").length,
      baseMetricsLiftedFromCalculations: liftedMetrics.length,
      measuresDeferred: totalDeferred,
      modelRelationships: finalRels.length,
      orphanTablesExcluded: orphanTables.length,
      tablesExcludedMeasuresOnly: excludedMeasureTables.length,
      extraConnectionsCreated: extraConnectionsCreated.length,
      issuesTotal: issues.length,
      issuesBySeverity: sevCounts,
    },
    convertedDimensions: convertedDims,
    convertedMetrics,
    convertedCalcs,
    deferredMeasuresByFact: Object.fromEntries([...factDeferred].filter(([, v]) => v.length).map(([k, v]) => [k, v.length])),
    excludedMeasureTables,
    unresolvedPhysicalSources: unresolvedTables,
    orphanTables,
    extraConnections: extraConnectionsCreated.map(([, c]) => c),
    issues,
  };
  sml.set("CONVERSION_REPORT.json", JSON.stringify(conversionReportJson, null, 2));

  return { sml };
}
