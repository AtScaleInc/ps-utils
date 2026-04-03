// ============================================================
// Secondary attribute inference
//
// When a dimension column has a companion column whose name is
// the same base name with a "_name", "_description", "_desc",
// "_label", or "_title" suffix, the companion is treated as a
// human-readable label for the primary column rather than an
// independent attribute.
//
// Examples:
//   category_id  +  category_name        → category_name is a "name" label
//   product_code +  product_description  → product_description is a "description" label
//   status       +  status_label         → status_label is a "name" label
// ============================================================

import {
  ColumnMeta,
  SemanticAttribute,
  SemanticLabel,
  toSemanticType,
  toTitleCase,
} from "./types.js";

// System/ETL column patterns excluded from dimension attributes.
const SYSTEM_COLUMN_PATTERNS = [
  /^au_/i,
  /^source_create/i,
  /^source_update/i,
  /^qlik_last/i,
];

export function isSystemColumn(columnName: string): boolean {
  return SYSTEM_COLUMN_PATTERNS.some((p) => p.test(columnName));
}

// Suffixes that signal a label column, in priority order.
const LABEL_SUFFIXES: Array<{ suffix: string; kind: SemanticLabel["kind"] }> = [
  { suffix: "_description", kind: "description" },
  { suffix: "_desc",        kind: "description" },
  { suffix: "_name",        kind: "name" },
  { suffix: "_label",       kind: "name" },
  { suffix: "_title",       kind: "name" },
];

// Language identifiers used in multilingual schemas.
// Ordered so that the most specific match is tried first.
// Each entry can appear as:
//   - an underscore-delimited suffix  (e.g. column_en, column_english)
//   - an underscore-delimited prefix  (e.g. english_column)
//   - a camelCase prefix with no separator (e.g. EnglishColumnName → "english" prefix)
const LANGUAGE_NAMES: string[] = [
  "english", "spanish", "french", "german", "portuguese",
  "italian", "dutch", "russian", "japanese", "chinese",
  "arabic", "korean", "turkish", "hebrew", "thai",
];

// ISO 2-letter codes (underscore-delimited only — too short for camelCase detection)
const LANGUAGE_CODES: string[] = [
  "en", "es", "fr", "de", "pt", "it", "nl", "ru", "ja", "zh", "ar", "ko",
];

// Suffixes that commonly appear on the *primary* (key) column.
// Used to infer the base when looking up a parent for a label column.
const KEY_SUFFIXES = ["_id", "_key", "_code", "_num", "_number"];

/**
 * Given the lowercased name of a label column (e.g. "category_name"),
 * return the lowercased base key that should own it (e.g. "category",
 * "category_id", "category_key", …), trying each key suffix in turn.
 */
function resolveParentKey(base: string, colByLower: Map<string, ColumnMeta>): string | null {
  if (colByLower.has(base)) return base;
  for (const ks of KEY_SUFFIXES) {
    if (colByLower.has(base + ks)) return base + ks;
  }
  return null;
}

/**
 * Separate dimension columns into:
 *   - `attributes`  — primary attributes (each may carry `labels`)
 *   - `consumed`    — column names absorbed into a parent as labels
 *
 * @param columns   All columns for the table (PK already excluded by caller)
 * @param excluded  Column names already excluded (FK columns, PK, etc.)
 */
export function groupSecondaryAttributes(
  columns: ColumnMeta[],
  excluded: Set<string>,
): { attributes: SemanticAttribute[]; consumed: Set<string> } {
  const colByLower = new Map(
    columns.map((c) => [c.columnName.toLowerCase(), c]),
  );

  // Map from primary column name → its label columns
  const labelMap = new Map<string, SemanticLabel[]>();
  const consumed = new Set<string>();

  for (const col of columns) {
    if (excluded.has(col.columnName)) continue;

    const lower = col.columnName.toLowerCase();

    for (const { suffix, kind } of LABEL_SUFFIXES) {
      if (!lower.endsWith(suffix)) continue;

      const base = lower.slice(0, lower.length - suffix.length);
      const parentKey = resolveParentKey(base, colByLower);
      if (!parentKey) continue;

      const parentCol = colByLower.get(parentKey)!;
      if (excluded.has(parentCol.columnName)) continue;

      // Register this column as a label of its parent
      const existing = labelMap.get(parentCol.columnName) ?? [];
      existing.push({
        name: toTitleCase(col.columnName),
        sourceColumn: col.columnName,
        kind,
      });
      labelMap.set(parentCol.columnName, existing);
      consumed.add(col.columnName);
      break; // only one suffix rule applies per column
    }
  }

  // Build the final attribute list, skipping consumed label columns
  const attributes: SemanticAttribute[] = columns
    .filter((c) => !excluded.has(c.columnName) && !consumed.has(c.columnName))
    .map((c) => {
      const attr: SemanticAttribute = {
        name: toTitleCase(c.columnName),
        sourceColumn: c.columnName,
        dataType: toSemanticType(c.dataType),
        nullable: c.nullable,
      };
      const labels = labelMap.get(c.columnName);
      if (labels?.length) attr.labels = labels;
      return attr;
    });

  return { attributes, consumed };
}

/**
 * Extract the language tag and base name from a column name, if any.
 * Handles three patterns:
 *   1. Underscore suffix:  `column_en` or `column_english`  → {base: "column", lang: "en"}
 *   2. Underscore prefix:  `english_column`                 → {base: "column", lang: "english"}
 *   3. CamelCase prefix:   `EnglishColumnName` (lowercased → "englishcolumnname")
 *                          → {base: "columnname", lang: "english"}
 */
function extractLanguageTag(
  lower: string,
): { base: string; lang: string } | null {
  // Pattern 1: underscore ISO code suffix  (e.g. column_en)
  for (const code of LANGUAGE_CODES) {
    const suffix = "_" + code;
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return { base: lower.slice(0, lower.length - suffix.length), lang: code };
    }
  }

  // Pattern 2: underscore full-language suffix or prefix
  for (const lang of LANGUAGE_NAMES) {
    const suffixPat = "_" + lang;
    const prefixPat = lang + "_";

    if (lower.endsWith(suffixPat) && lower.length > suffixPat.length) {
      return { base: lower.slice(0, lower.length - suffixPat.length), lang };
    }
    if (lower.startsWith(prefixPat) && lower.length > prefixPat.length) {
      return { base: lower.slice(prefixPat.length), lang };
    }
  }

  // Pattern 3: camelCase prefix (no underscore separator)
  // A language name immediately followed by another word character (the base starts).
  for (const lang of LANGUAGE_NAMES) {
    if (lower.startsWith(lang) && lower.length > lang.length) {
      const remainder = lower.slice(lang.length);
      // Only treat as a camelCase prefix when the remainder looks like a real word (≥2 chars)
      if (remainder.length >= 2) {
        return { base: remainder, lang };
      }
    }
  }

  return null;
}

/**
 * Second pass: detect multilingual column groups and collapse non-English
 * variants into SemanticLabel entries on the primary (English) attribute.
 *
 * Handles underscore-separated suffixes/prefixes AND CamelCase prefixes:
 *   `product_name_en` / `product_name_es` / `product_name_fr`
 *   `english_product_name` / `spanish_product_name`
 *   `EnglishDayNameOfWeek` / `SpanishDayNameOfWeek` / `FrenchDayNameOfWeek`
 *
 * The English column (or unsuffixed base if present) becomes the primary.
 * All other language variants become SemanticLabel entries.
 *
 * Mutates the `attributes` array in place.
 */
export function applyMultilingualGrouping(
  attributes: SemanticAttribute[],
): Set<string> {
  const absorbed = new Set<string>();
  const attrByLower = new Map(attributes.map((a) => [a.sourceColumn.toLowerCase(), a]));

  // Group attributes by their base name.
  const baseGroups = new Map<string, Array<{ attr: SemanticAttribute; lang: string }>>();

  for (const attr of attributes) {
    const lower = attr.sourceColumn.toLowerCase();
    const tag = extractLanguageTag(lower);
    if (!tag) continue;

    const group = baseGroups.get(tag.base) ?? [];
    group.push({ attr, lang: tag.lang });
    baseGroups.set(tag.base, group);
  }

  for (const [base, members] of baseGroups) {
    // Only process groups with ≥2 language variants.
    if (members.length < 2) continue;

    // Skip if the whole group is already absorbed.
    if (members.every((m) => absorbed.has(m.attr.sourceColumn))) continue;

    // Determine the primary attribute:
    // Prefer: unsuffixed base > english variant > first member
    const basePrimary =
      attrByLower.get(base) ??
      attrByLower.get("english_" + base) ??
      attrByLower.get(base + "_en") ??
      attrByLower.get(base + "_english");

    const englishMember =
      members.find((m) => m.lang === "english") ??
      members.find((m) => m.lang === "en");

    const primary = basePrimary ?? englishMember?.attr ?? members[0].attr;

    // All members except the primary become labels.
    const nonPrimary = members.filter((m) => m.attr !== primary);

    const existingLabels = primary.labels ?? [];
    for (const { attr: variant } of nonPrimary) {
      if (absorbed.has(variant.sourceColumn)) continue;
      existingLabels.push({
        name: toTitleCase(variant.sourceColumn),
        sourceColumn: variant.sourceColumn,
        kind: "name",
      });
      absorbed.add(variant.sourceColumn);
    }
    if (existingLabels.length > 0) primary.labels = existingLabels;
  }

  // Remove absorbed attributes from the array in place.
  for (let i = attributes.length - 1; i >= 0; i--) {
    if (absorbed.has(attributes[i].sourceColumn)) {
      attributes.splice(i, 1);
    }
  }

  return absorbed;
}
