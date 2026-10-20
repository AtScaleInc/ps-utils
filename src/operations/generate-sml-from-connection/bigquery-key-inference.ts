/**
 * Key inference for BigQuery datasets that declare no constraints.
 *
 * BigQuery supports PRIMARY KEY / FOREIGN KEY only as optional, unenforced
 * metadata, and most datasets never declare any. The SML generator classifies
 * facts, finds joins and attaches dimensions from those keys, so without them it
 * produces an empty model.
 *
 * This module infers them from column names and data. It is BigQuery-only —
 * the caller gates it on the dialect — and deliberately conservative: when a
 * match is ambiguous it reports the ambiguity instead of guessing.
 *
 * Pure functions only; the SqlSchemaAdapter does the I/O (uniqueness checks).
 */
import { toSemanticType } from "../../algorithm/types.js";

export interface InferColumn {
  name:     string;
  dataType: string;
}

export interface InferTable {
  name:    string;
  columns: InferColumn[];
}

export interface KeyCandidate {
  column: string;
  /** Lower is stronger: 0 = named for the table, 1 = *key, 2 = *id, 3 = pk*, 4 = only column. */
  tier:   number;
}

export type Uniqueness = "unique" | "duplicate" | "unknown";

export interface InferredForeignKey {
  fkTable:  string;
  fkColumn: string;
  pkTable:  string;
  pkColumn: string;
  /** False when the column only ends in the key's name (e.g. orderdatekey -> datekey). */
  exact:    boolean;
}

export interface AmbiguousForeignKey {
  fkTable:    string;
  fkColumn:   string;
  candidates: string[];
}

/** Generic key names that would match nearly every column ending in them. */
const GENERIC_KEY_NAMES = new Set(["key", "id"]);

/** Fused or underscored prefixes that mark a table's role rather than its subject. */
const TABLE_PREFIXES = ["dim", "fact", "lkp", "ref"];

/** Minimum length of a primary-key name before a suffix match is trusted. */
const MIN_SUFFIX_KEY_LENGTH = 5;

/** Same, for a key name once its per-table prefix is removed (`item_sk` is 6). */
const MIN_STRIPPED_KEY_LENGTH = 5;

export function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * What a table is "about", as the names its key column is likely to carry.
 *
 *   dimcustomer   -> ["customer"]
 *   dim_geo_state -> ["geostate", "state"]
 */
export function tableBases(table: string): string[] {
  const tokens = table.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let joined = tokens.join("");
  for (const p of TABLE_PREFIXES) {
    if (joined.startsWith(p) && joined.length > p.length) {
      joined = joined.slice(p.length);
      break;
    }
  }
  const bases = new Set<string>([joined]);
  if (tokens.length > 1) bases.add(tokens[tokens.length - 1]!);
  return [...bases];
}

/**
 * A column name with a leading per-table prefix removed, lower-cased:
 * `i_item_sk` -> `item_sk`, `ss_sold_date_sk` -> `sold_date_sk`. Names without
 * one (`customerkey`) come back unchanged.
 */
export function stripColumnPrefix(name: string): string {
  return name.toLowerCase().replace(/^[a-z]{1,4}_(?=[a-z0-9_]{3,})/, "");
}

/** True for surrogate-key names such as `d_date_sk` or `sk`. */
function isSurrogateKey(column: string): boolean {
  return /(^|_)sk$/i.test(column);
}

/** How key-like a column name is for a table, or undefined if it isn't. */
export function keyTier(column: string, bases: string[]): number | undefined {
  const n = normalize(column);
  const stripped = normalize(stripColumnPrefix(column));
  if (bases.some((b) => [n, stripped].some((x) => x === `${b}key` || x === `${b}id` || x === `${b}sk`))) return 0;
  if (n.endsWith("key") || isSurrogateKey(column)) return 1;
  if (n.endsWith("id")) return 2;
  if (n.startsWith("pk")) return 3;
  return undefined;
}

/** Primary-key candidates for a table, strongest first, ties broken by column order. */
export function keyCandidates(table: InferTable): KeyCandidate[] {
  const bases = tableBases(table.name);
  const found: Array<KeyCandidate & { order: number }> = [];
  table.columns.forEach((c, order) => {
    const tier = keyTier(c.name, bases);
    if (tier !== undefined) found.push({ column: c.name, tier, order });
  });
  if (found.length === 0 && table.columns.length === 1) {
    found.push({ column: table.columns[0]!.name, tier: 4, order: 0 });
  }
  return found
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .map(({ column, tier }) => ({ column, tier }));
}

/**
 * Pick the primary key from ranked candidates.
 *
 * A candidate must be verified unique. If it could not be verified (empty table,
 * or too large to scan), only a name that is explicitly the table's own key
 * (tier 0) is trusted.
 */
export function choosePrimaryKey(
  candidates: KeyCandidate[],
  verdict: (column: string) => Uniqueness,
): string | undefined {
  for (const c of candidates) {
    const v = verdict(c.column);
    if (v === "unique") return c.column;
    if (v === "unknown" && c.tier === 0) return c.column;
  }
  return undefined;
}

/**
 * Foreign keys implied by column names matching other tables' primary keys.
 *
 * A column matches a key by exact name, or by ending in it (so `orderdatekey`
 * and `shipdatekey` both reference `datekey`). When several tables share a key
 * name, the one named for the column's subject wins; otherwise the match is
 * reported as ambiguous and skipped.
 */
export function inferForeignKeys(
  tables: InferTable[],
  primaryKeys: Map<string, string>,
): { foreignKeys: InferredForeignKey[]; ambiguous: AmbiguousForeignKey[] } {
  const foreignKeys: InferredForeignKey[] = [];
  const ambiguous:   AmbiguousForeignKey[] = [];

  const semantic = (t: InferTable, col: string): string => {
    const c = t.columns.find((x) => x.name === col);
    return c ? toSemanticType(c.dataType) : "unknown";
  };

  for (const t of tables) {
    for (const col of t.columns) {
      if (primaryKeys.get(t.name) === col.name) continue;
      const n = normalize(col.name);
      const ns = stripColumnPrefix(col.name);
      const colType = toSemanticType(col.dataType);

      const matches: Array<{ table: InferTable; pkColumn: string; exact: boolean }> = [];
      for (const p of tables) {
        if (p.name === t.name) continue;
        const pkColumn = primaryKeys.get(p.name);
        if (!pkColumn) continue;
        const pn  = normalize(pkColumn);
        const pns = stripColumnPrefix(pkColumn);
        if (GENERIC_KEY_NAMES.has(pn) || GENERIC_KEY_NAMES.has(normalize(pns))) continue;
        if (semantic(p, pkColumn) !== colType) continue;

        // With the per-table prefix removed, `ss_item_sk` and `i_item_sk` are both
        // `item_sk`; a role like `ss_sold_date_sk` ends in `_date_sk` at a word boundary.
        const prefixRemoved = ns !== col.name.toLowerCase() || pns !== pkColumn.toLowerCase();
        const exactStripped  = prefixRemoved && normalize(ns) === normalize(pns) && normalize(pns).length >= MIN_STRIPPED_KEY_LENGTH;
        const boundarySuffix = prefixRemoved && normalize(pns).length >= MIN_STRIPPED_KEY_LENGTH
                               && ns.endsWith(`_${pns}`);
        const exact  = n === pn || exactStripped;
        const suffix = !exact && (boundarySuffix || (pn.length >= MIN_SUFFIX_KEY_LENGTH && n.endsWith(pn)));
        if (exact || suffix) matches.push({ table: p, pkColumn, exact });
      }
      if (matches.length === 0) continue;

      let chosen = matches;
      if (matches.length > 1) {
        const stems = [n, normalize(ns)].map((x) => x.replace(/(key|id|sk)$/, ""));
        const named = matches.filter((m) => tableBases(m.table.name).some((b) => stems.includes(b)));
        chosen = named.length === 1 ? named : [];
      }
      if (chosen.length === 1) {
        foreignKeys.push({
          fkTable: t.name, fkColumn: col.name,
          pkTable: chosen[0]!.table.name, pkColumn: chosen[0]!.pkColumn,
          exact: chosen[0]!.exact,
        });
      } else {
        ambiguous.push({
          fkTable: t.name, fkColumn: col.name,
          candidates: matches.map((m) => m.table.name),
        });
      }
    }
  }
  return { foreignKeys, ambiguous };
}
