// ============================================================
// Hierarchy inference
//
// Two sources are combined:
//   1. Index-based   — multi-column indexes signal an ordered hierarchy
//   2. Name-based    — column naming conventions signal hierarchical structure
//
// Name-based strategies (applied in order, results deduplicated):
//   a. Known domain sequences  — year/quarter/month/…, country/state/city/…
//   b. sub-prefix pairing      — "subcategory" is a child of "category"
//   c. Shared-prefix grouping  — "product_category" + "product_subcategory"
//      share a prefix and the suffixes appear in a known sequence
// ============================================================

import { ColumnMeta, IndexMeta, SemanticHierarchy, DATE_TYPES, NUMERIC_TYPES, toTitleCase } from "./types.js";

// ----------------------------------------------------------
// Known ordered level sequences for common domain hierarchies
//
// Each sequence defines an ordered list of keyword segments that, when found
// in a table's column names, indicate a natural roll-up hierarchy.
//
// Ordering rules:
//   1. More-specific sequences come BEFORE generic ones so that specialised
//      columns (e.g., "fiscal_year") are consumed before generic keywords
//      (e.g., "year") have a chance to claim them.
//   2. Within a sequence, levels are ordered broadest → most granular.
//
// A sequence contributes a hierarchy only when ≥2 of its levels are present.
// ----------------------------------------------------------

const KNOWN_HIERARCHY_SEQUENCES: Array<{ name: string; levels: string[] }> = [
  // Fiscal calendar — must come BEFORE generic Date so fiscal_ columns are not mis-matched as "year"
  {
    name: "Fiscal Calendar",
    levels: ["fiscal_year", "fiscal_semester", "fiscal_quarter", "fiscal_period", "fiscal_week"],
  },
  // Academic calendar — must come BEFORE generic Date
  {
    name: "Academic Calendar",
    levels: ["academic_year", "school_year", "semester", "term", "course", "section"],
  },
  {
    name: "Date",
    levels: ["year", "quarter", "month", "week", "day"],
  },
  {
    name: "Time Of Day",
    levels: ["hour", "minute", "second"],
  },
  {
    name: "Geography",
    levels: [
      "continent", "country", "region", "state", "province",
      "city", "district", "county", "zip", "postal_code", "street",
    ],
  },
  {
    name: "Product",
    levels: [
      "division", "department", "category", "subcategory",
      "product_line", "product_family", "product",
    ],
  },
  {
    name: "Employee Organization",
    levels: ["company", "division", "department", "cost_center", "team", "employee"],
  },
  {
    name: "Organization",
    levels: ["company", "division", "department", "team", "employee"],
  },
  {
    name: "Account",
    levels: ["segment", "industry", "account_type", "account"],
  },
];

// ----------------------------------------------------------
// Index-based inference
// ----------------------------------------------------------

function inferFromIndexes(
  columns: ColumnMeta[],
  indexes: IndexMeta[],
): { hierarchies: SemanticHierarchy[]; usedColumns: Set<string> } {
  const byIndex = new Map<string, IndexMeta[]>();
  for (const idx of indexes) {
    const existing = byIndex.get(idx.indexName) ?? [];
    existing.push(idx);
    byIndex.set(idx.indexName, existing);
  }

  const colByName = new Map(columns.map((c) => [c.columnName, c]));
  const hierarchies: SemanticHierarchy[] = [];
  const usedColumns = new Set<string>();

  for (const [indexName, idxCols] of byIndex) {
    if (idxCols.length < 2) continue;
    const sorted = [...idxCols].sort((a, b) => a.ordinalPosition - b.ordinalPosition);
    const levels = sorted
      .filter((i) => colByName.has(i.columnName))
      .map((i) => ({ name: toTitleCase(i.columnName), sourceColumn: i.columnName }));

    if (levels.length >= 2) {
      hierarchies.push({ name: toTitleCase(indexName), levels, sourceIndex: indexName });
      levels.forEach((l) => usedColumns.add(l.sourceColumn.toLowerCase()));
    }
  }

  return { hierarchies, usedColumns };
}

// ----------------------------------------------------------
// Name-based inference
// ----------------------------------------------------------

/**
 * Returns true if `columnName` (lowercased) contains `keyword` as a whole
 * word segment (bounded by start, end, or underscore).
 */
function matchesSegment(columnName: string, keyword: string): boolean {
  // keyword itself may contain underscores (e.g. "postal_code")
  const escaped = keyword.replace(/_/g, "[_\\s]");
  return new RegExp(`(^|_)${escaped}(_|$)`).test(columnName);
}

/**
 * Strategy A: match columns against known ordered sequences.
 * A sequence contributes a hierarchy only when ≥2 of its levels are present.
 */
function inferFromKnownSequences(
  columns: ColumnMeta[],
  alreadyUsed: Set<string>,
): { hierarchies: SemanticHierarchy[]; usedColumns: Set<string> } {
  const hierarchies: SemanticHierarchy[] = [];
  const usedColumns = new Set<string>();

  for (const seq of KNOWN_HIERARCHY_SEQUENCES) {
    // Walk the sequence in broadest-to-granular order, finding the first
    // available column that matches each level keyword.  A column is only
    // used once across all sequences (enforced by usedColumns + alreadyUsed).
    const matchedColumns: ColumnMeta[] = [];

    for (const level of seq.levels) {
      const col = columns.find(
        (c) =>
          !alreadyUsed.has(c.columnName.toLowerCase()) &&
          !usedColumns.has(c.columnName.toLowerCase()) &&
          matchesSegment(c.columnName.toLowerCase(), level),
      );
      if (col) matchedColumns.push(col);
    }

    // Require at least 2 matched levels — a single-level "hierarchy" is just
    // an attribute and adds no analytical value.
    if (matchedColumns.length >= 2) {
      hierarchies.push({
        name: `${seq.name} Hierarchy`,
        levels: matchedColumns.map((c) => ({ name: toTitleCase(c.columnName), sourceColumn: c.columnName })),
      });
      matchedColumns.forEach((c) => usedColumns.add(c.columnName.toLowerCase()));
    }
  }

  return { hierarchies, usedColumns };
}

/**
 * Strategy B: "sub"-prefix pairing.
 * A column whose name starts with "sub" is a child of the column
 * whose name is the remainder (e.g. subcategory → category).
 */
function inferFromSubPrefix(
  columns: ColumnMeta[],
  alreadyUsed: Set<string>,
): { hierarchies: SemanticHierarchy[]; usedColumns: Set<string> } {
  const colByLower = new Map(columns.map((c) => [c.columnName.toLowerCase(), c]));
  const hierarchies: SemanticHierarchy[] = [];
  const usedColumns = new Set<string>();

  for (const col of columns) {
    const lower = col.columnName.toLowerCase();
    if (!lower.startsWith("sub")) continue;

    // "subcategory" → parent candidate is "category"
    // "sub_category" → parent candidate is "category"
    const parentKey = lower.replace(/^sub_?/, "");
    const parentCol = colByLower.get(parentKey);

    if (
      parentCol &&
      !alreadyUsed.has(lower) &&
      !alreadyUsed.has(parentKey) &&
      !usedColumns.has(lower) &&
      !usedColumns.has(parentKey)
    ) {
      hierarchies.push({
        name: `${toTitleCase(parentKey)} Hierarchy`,
        levels: [
          { name: toTitleCase(parentCol.columnName), sourceColumn: parentCol.columnName },
          { name: toTitleCase(col.columnName), sourceColumn: col.columnName },
        ],
      });
      usedColumns.add(lower);
      usedColumns.add(parentKey);
    }
  }

  return { hierarchies, usedColumns };
}

/**
 * Strategy C: shared-prefix grouping.
 * Columns that share a common underscore-delimited prefix AND whose
 * suffixes appear in a known hierarchy sequence are grouped together.
 *
 * Example: product_category, product_subcategory → "Product" hierarchy
 * with levels ordered by the known "Product" sequence.
 */
function inferFromSharedPrefix(
  columns: ColumnMeta[],
  alreadyUsed: Set<string>,
): { hierarchies: SemanticHierarchy[]; usedColumns: Set<string> } {
  // Build prefix → columns map (only for multi-part names)
  const prefixGroups = new Map<string, Array<{ col: ColumnMeta; suffix: string }>>();

  for (const col of columns) {
    if (alreadyUsed.has(col.columnName.toLowerCase())) continue;
    const parts = col.columnName.toLowerCase().split("_");
    if (parts.length < 2) continue;

    const prefix = parts[0];
    const suffix = parts.slice(1).join("_");

    // Only group if the suffix matches a level in any known sequence
    const isKnownLevel = KNOWN_HIERARCHY_SEQUENCES.some((seq) => seq.levels.includes(suffix));
    if (!isKnownLevel) continue;

    const group = prefixGroups.get(prefix) ?? [];
    group.push({ col, suffix });
    prefixGroups.set(prefix, group);
  }

  const hierarchies: SemanticHierarchy[] = [];
  const usedColumns = new Set<string>();

  for (const [prefix, entries] of prefixGroups) {
    if (entries.length < 2) continue;

    // Sort entries by their position in the known sequences
    const sorted = [...entries].sort((a, b) => {
      for (const seq of KNOWN_HIERARCHY_SEQUENCES) {
        const ai = seq.levels.indexOf(a.suffix);
        const bi = seq.levels.indexOf(b.suffix);
        if (ai !== -1 && bi !== -1) return ai - bi;
      }
      return 0;
    });

    hierarchies.push({
      name: `${toTitleCase(prefix)} Hierarchy`,
      levels: sorted.map(({ col }) => ({
        name: toTitleCase(col.columnName),
        sourceColumn: col.columnName,
      })),
    });
    sorted.forEach(({ col }) => usedColumns.add(col.columnName.toLowerCase()));
  }

  return { hierarchies, usedColumns };
}

// ----------------------------------------------------------
// Fallback: date column type detection
// ----------------------------------------------------------

function inferDateFallback(
  columns: ColumnMeta[],
  alreadyUsed: Set<string>,
): { hierarchies: SemanticHierarchy[]; warnings: string[] } {
  // Pattern matches column names that suggest a date component
  // (year, quarter, month, week, day, date, period).
  const dateNamePattern = /^(year|quarter|month|week|day|date|period)/i;

  // Validity-range column pattern — these indicate SCD-style effective/expiry
  // dates rather than a meaningful analytical roll-up.
  const validityPattern = /^(start|end|begin|expir|valid|effective)/i;

  const hierarchyWarnings: string[] = [];

  const dateCols = columns
    .filter(
      (c) =>
        !alreadyUsed.has(c.columnName.toLowerCase()) &&
        (
          // Typed as a date/timestamp — always include
          DATE_TYPES.has(c.dataType.toUpperCase()) ||
          // Named like a date component — only include when NOT a numeric type.
          // Without this guard, a column like "YearlyIncome" (DECIMAL) would be
          // incorrectly pulled into a "Date Hierarchy" because its name starts
          // with "year".
          (dateNamePattern.test(c.columnName) && !NUMERIC_TYPES.has(c.dataType.toUpperCase()))
        ),
    )
    .sort((a, b) => a.ordinalPosition - b.ordinalPosition);

  if (dateCols.length < 2) return { hierarchies: [], warnings: [] };

  const hierarchy: SemanticHierarchy = {
    name: "Date Hierarchy",
    levels: dateCols.map((c) => ({ name: toTitleCase(c.columnName), sourceColumn: c.columnName })),
  };

  // Warn when every level in the fallback hierarchy matches a validity-range
  // pattern (e.g. StartDate + EndDate).  This is a period boundary, not a
  // time roll-up, and will produce misleading analysis suggestions.
  const allValidityRange = dateCols.every((c) => validityPattern.test(c.columnName));
  if (allValidityRange) {
    const cols = dateCols.map((c) => c.columnName).join(", ");
    hierarchyWarnings.push(
      `[VALIDITY RANGE] The inferred "Date Hierarchy" on columns [${cols}] looks like ` +
      `a validity-period range (start/end dates), not a time roll-up. ` +
      `Analysis suggestions using this hierarchy may not be meaningful. ` +
      `Consider defining explicit calendar hierarchies instead.`,
    );
  }

  return { hierarchies: [hierarchy], warnings: hierarchyWarnings };
}

// ----------------------------------------------------------
// Public entry point
// ----------------------------------------------------------

/**
 * Infer all hierarchies for a dimension table from both index
 * metadata and column naming conventions.
 *
 * Returns the inferred hierarchies AND any advisory warnings produced during
 * inference (e.g., a fallback "Date Hierarchy" that looks like a validity range).
 * Callers should surface the warnings in the SemanticModel.warnings array.
 */
export function inferHierarchies(
  columns: ColumnMeta[],
  indexes: IndexMeta[],
): { hierarchies: SemanticHierarchy[]; warnings: string[] } {
  const hierarchies: SemanticHierarchy[] = [];
  const inferenceWarnings: string[] = [];
  const used = new Set<string>();

  const trackUsed = (h: SemanticHierarchy[]) => {
    h.forEach((hier) => hier.levels.forEach((l) => used.add(l.sourceColumn.toLowerCase())));
  };

  // 1. Index-based (highest confidence — explicit schema design)
  const fromIndexes = inferFromIndexes(columns, indexes);
  hierarchies.push(...fromIndexes.hierarchies);
  fromIndexes.usedColumns.forEach((c) => used.add(c));

  // 2. Known domain sequences
  const fromSeq = inferFromKnownSequences(columns, used);
  hierarchies.push(...fromSeq.hierarchies);
  fromSeq.usedColumns.forEach((c) => used.add(c));

  // 3. sub-prefix pairs
  const fromSub = inferFromSubPrefix(columns, used);
  hierarchies.push(...fromSub.hierarchies);
  fromSub.usedColumns.forEach((c) => used.add(c));

  // 4. Shared-prefix groups
  const fromPrefix = inferFromSharedPrefix(columns, used);
  hierarchies.push(...fromPrefix.hierarchies);
  fromPrefix.usedColumns.forEach((c) => used.add(c));

  // 5. Date-type fallback (when no date hierarchy was detected by the strategies above)
  const hasDateHierarchy = hierarchies.some((h) => h.name.toLowerCase().includes("date"));
  if (!hasDateHierarchy) {
    const fallback = inferDateFallback(columns, used);
    hierarchies.push(...fallback.hierarchies);
    inferenceWarnings.push(...fallback.warnings);
    trackUsed(fallback.hierarchies);
  }

  return { hierarchies, warnings: inferenceWarnings };
}

/** Returns the set of column names (lowercased) consumed by any hierarchy level. */
export function hierarchyColumnSet(hierarchies: SemanticHierarchy[]): Set<string> {
  const used = new Set<string>();
  for (const h of hierarchies) {
    for (const level of h.levels) {
      used.add(level.sourceColumn.toLowerCase());
    }
  }
  return used;
}
