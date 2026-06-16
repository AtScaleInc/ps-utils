/**
 * DDL generator — Phase 7 of the fingerprint algorithm.
 *
 * Reads a SchemaFingerprint and emits CREATE TABLE statements that faithfully
 * reproduce the structure implied by the fingerprint:
 *
 *   • Dimension tables — one table per dimension, with key columns for each
 *     level in each hierarchy, a PRIMARY KEY on the leaf level of the primary
 *     hierarchy, and optional label columns where labelUniqueness was recorded.
 *
 *   • Fact tables — FK columns for each dimension join plus one column per
 *     measure, with FOREIGN KEY constraints referencing the dimension leaf keys.
 *
 * All table and column names are synthetic (the original names are not stored
 * in the fingerprint).  Names are derived deterministically from the opaque
 * IDs so that the same fingerprint always produces the same DDL.
 *
 * BigQuery dialect omits PRIMARY KEY / FOREIGN KEY constraints (not supported).
 */

import type {
  DimensionFingerprint,
  FactFingerprint,
  FingerprintMetadata,
  HierarchyFingerprint,
  LevelFingerprint,
  MeasureFingerprint,
  SchemaFingerprint,
} from "./types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export type SqlDialect = "ansi" | "postgresql" | "snowflake" | "mysql" | "bigquery";

export interface DdlOptions {
  dialect?:  SqlDialect;
  /**
   * Optional metadata block from the fingerprint (present when the fingerprint
   * was captured with --preserve-meta-data true).  When supplied, real table
   * and column names are used instead of synthetic ones.
   */
  metadata?: FingerprintMetadata;
}

/**
 * Generate CREATE TABLE DDL from a SchemaFingerprint.
 *
 * @param fp      Parsed fingerprint (from readFingerprintFile or extractFingerprint).
 * @param options Dialect and other generation options.
 * @returns       SQL string — dimension tables first, then fact tables.
 */
export function generateDdl(fp: SchemaFingerprint, options: DdlOptions = {}): string {
  const dialect = options.dialect ?? "ansi";
  const ctx = buildContext(fp, dialect, options.metadata);
  const sections: string[] = [fileHeader(fp, dialect)];
  // Skip dimensions/facts that share a physical table name with an earlier entry.
  // Multiple SML dimensions can reference the same physical dataset; the physical
  // table only needs one DDL block.
  const seenTables = new Set<string>();

  for (const dim of fp.dimensions) {
    const tableName = ctx.dimTableName.get(dim.id) ?? dimIdToTable(dim.id);
    if (seenTables.has(tableName)) continue;
    seenTables.add(tableName);
    sections.push(renderDimensionTable(dim, ctx, dialect));
  }

  for (const fact of fp.facts) {
    const tableName = ctx.factTableName.get(fact.id) ?? factIdToTable(fact.id);
    if (seenTables.has(tableName)) continue;
    seenTables.add(tableName);
    sections.push(renderFactTable(fact, ctx, dialect));
  }

  return sections.join("\n\n") + "\n";
}

// ─── Build context (pre-pass) ─────────────────────────────────────────────────

/**
 * Collected metadata the renderers need without re-scanning the fingerprint.
 */
interface Context {
  dialect:         SqlDialect;
  /** True when a metadata block was provided; affects label-column fallback behavior. */
  usingMetadata:   boolean;
  /** dimId → table name (real when metadata present, otherwise synthetic) */
  dimTableName:    Map<string, string>;
  /** factId → table name (real when metadata present, otherwise synthetic) */
  factTableName:   Map<string, string>;
  /** levelId → { colName, colType } — leaf column info for FK generation */
  leafColInfo:     Map<string, { colName: string; colType: string }>;
  /** levelId → physical key col name for ALL levels */
  levelColName:    Map<string, string>;
  /**
   * levelId → explicit label col name. Only populated when the metadata lists
   * a separate label column for that level (label ≠ key). When absent and
   * usingMetadata is false, a synthetic name is used as fallback.
   */
  levelLblName:    Map<string, string>;
  /** measureId → physical col name */
  measureColName:  Map<string, string>;
  /** `${factId}:${joinIndex}` → FK col name */
  joinColName:     Map<string, string>;
}

function buildContext(fp: SchemaFingerprint, dialect: SqlDialect, metadata?: FingerprintMetadata): Context {
  const dimTableName  = new Map<string, string>();
  const factTableName = new Map<string, string>();
  const leafColInfo   = new Map<string, { colName: string; colType: string }>();
  const levelColName  = new Map<string, string>();
  const levelLblName  = new Map<string, string>();
  const measureColName = new Map<string, string>();
  const joinColName   = new Map<string, string>();

  for (const dim of fp.dimensions) {
    dimTableName.set(dim.id, metadata?.dimensionTables[dim.id] ?? dimIdToTable(dim.id));

    // Walk hierarchies to collect level col info and leaf col info
    const multiHier = dim.hierarchies.length > 1;
    for (let h = 0; h < dim.hierarchies.length; h++) {
      const hier = dim.hierarchies[h]!;
      for (let l = 0; l < hier.levels.length; l++) {
        const level   = hier.levels[l]!;
        const colName = metadata?.levelKeyColumns[level.id] ?? levelKeyColName(l, h, multiHier);
        levelColName.set(level.id, colName);
        // When metadata is present, only set a label entry if the metadata explicitly
        // lists one for this level. Absence means label == key (no separate label col).
        // When metadata is absent, always fall back to a synthetic name.
        const lblName = metadata
          ? metadata.levelLabelColumns[level.id]
          : levelLabelColName(l, h, multiHier);
        if (lblName !== undefined && !levelLblName.has(level.id)) {
          levelLblName.set(level.id, lblName);
        }
        if (level.role === "leaf") {
          const colType = mapType(keyBaseType(level.memberCount), dialect);
          leafColInfo.set(level.id, { colName, colType });
        }
      }
    }
  }

  for (const fact of fp.facts) {
    factTableName.set(fact.id, metadata?.factTables[fact.id] ?? factIdToTable(fact.id));

    for (const measure of fact.measures) {
      measureColName.set(
        measure.id,
        metadata?.measureColumns[measure.id] ?? measureIdToCol(measure.id),
      );
    }

    // Pre-compute join FK column names using zero-based join index as key
    const dimJoinCount = new Map<string, number>();
    for (const join of fact.joins) {
      dimJoinCount.set(join.toDimensionId, (dimJoinCount.get(join.toDimensionId) ?? 0) + 1);
    }
    const dimJoinSeen = new Map<string, number>();
    for (let j = 0; j < fact.joins.length; j++) {
      const join  = fact.joins[j]!;
      const seen  = (dimJoinSeen.get(join.toDimensionId) ?? 0) + 1;
      dimJoinSeen.set(join.toDimensionId, seen);
      const multi = (dimJoinCount.get(join.toDimensionId) ?? 1) > 1;
      const dName = metadata?.dimensionTables[join.toDimensionId] ?? dimIdToTable(join.toDimensionId);
      const defaultFkCol = multi ? `${dName}_key_${seen}` : `${dName}_key`;
      joinColName.set(
        `${fact.id}:${j}`,
        metadata?.joinColumns[`${fact.id}:${j}`] ?? defaultFkCol,
      );
    }
  }

  return { dialect, usingMetadata: metadata !== undefined, dimTableName, factTableName, leafColInfo, levelColName, levelLblName, measureColName, joinColName };
}

// ─── Dimension table renderer ─────────────────────────────────────────────────

function renderDimensionTable(
  dim:     DimensionFingerprint,
  ctx:     Context,
  dialect: SqlDialect,
): string {
  const tableName = ctx.dimTableName.get(dim.id) ?? dimIdToTable(dim.id);
  const multiHier = dim.hierarchies.length > 1;

  const colLines:         string[] = [];
  const constraintLines:  string[] = [];
  let primaryKeyCol: string | undefined;
  // Guard against duplicate column names when multiple hierarchy levels share
  // the same physical column (e.g. a degenerate SML hierarchy where two levels
  // have the same unique_name and therefore the same key column).
  const emittedCols = new Set<string>();

  for (let h = 0; h < dim.hierarchies.length; h++) {
    const hier = dim.hierarchies[h]!;

    if (multiHier) {
      colLines.push(`    -- Hierarchy ${h + 1}: ${hier.levels.length} level(s)`);
    }

    for (let l = 0; l < hier.levels.length; l++) {
      const level      = hier.levels[l]!;
      const colName    = ctx.levelColName.get(level.id) ?? levelKeyColName(l, h, multiHier);
      const baseType   = keyBaseType(level.memberCount);
      const colType    = mapType(baseType, dialect);
      const roleNote   = level.role === "root"
        ? `root, ${fmt(level.memberCount)} members`
        : `${fmt(level.memberCount)} members`;

      if (!emittedCols.has(colName)) {
        emittedCols.add(colName);
        colLines.push(col(colName, colType, "NOT NULL", roleNote));
      }

      // Label column when fingerprint recorded labelUniqueness.
      // When using metadata, levelLblName is only set when the metadata explicitly
      // lists a separate label column — absence means label == key, so skip it.
      // When not using metadata, fall back to a synthetic label name.
      const lblCol = ctx.levelLblName.has(level.id)
        ? ctx.levelLblName.get(level.id)!
        : (!ctx.usingMetadata && (level as LevelFingerprint).labelUniqueness !== undefined)
          ? levelLabelColName(l, h, multiHier)
          : undefined;
      if (lblCol !== undefined && !emittedCols.has(lblCol)) {
        emittedCols.add(lblCol);
        const lblType = mapType("VARCHAR(200)", dialect);
        colLines.push(col(lblCol, lblType, null, "label"));
      }

      // First hierarchy's leaf becomes the table PK
      if (level.role === "leaf" && h === 0) {
        primaryKeyCol = colName;
      }
    }
  }

  // PRIMARY KEY
  if (primaryKeyCol && dialect !== "bigquery") {
    constraintLines.push(`    PRIMARY KEY (${primaryKeyCol})`);
  }

  return [
    `-- Dimension ${dim.id} (~${fmt(dim.rowCount)} rows)`,
    `CREATE TABLE ${tableName} (`,
    buildColumnBody(colLines, constraintLines),
    `);`,
  ].join("\n");
}

// ─── Fact table renderer ──────────────────────────────────────────────────────

function renderFactTable(
  fact:    FactFingerprint,
  ctx:     Context,
  dialect: SqlDialect,
): string {
  const tableName = ctx.factTableName.get(fact.id) ?? factIdToTable(fact.id);

  const colLines:        string[] = [];
  const constraintLines: string[] = [];

  // Track how many times each dimension appears (handles rare multi-join-to-same-dim)
  const dimJoinCount = new Map<string, number>();
  for (const join of fact.joins) {
    dimJoinCount.set(join.toDimensionId, (dimJoinCount.get(join.toDimensionId) ?? 0) + 1);
  }
  const dimJoinSeen = new Map<string, number>();

  // FK columns
  let joinIdx = 0;
  for (const join of fact.joins) {
    const dimTable   = ctx.dimTableName.get(join.toDimensionId) ?? dimIdToTable(join.toDimensionId);
    const leafInfo   = ctx.leafColInfo.get(join.toLeafLevelId);
    const leafColRef = leafInfo?.colName ?? "id";
    const leafType   = leafInfo?.colType ?? mapType("BIGINT", dialect);

    dimJoinSeen.set(join.toDimensionId, (dimJoinSeen.get(join.toDimensionId) ?? 0) + 1);
    const fkCol = ctx.joinColName.get(`${fact.id}:${joinIdx}`) ?? (() => {
      const seen  = dimJoinSeen.get(join.toDimensionId)!;
      const multi = (dimJoinCount.get(join.toDimensionId) ?? 1) > 1;
      return multi ? `${dimTable}_key_${seen}` : `${dimTable}_key`;
    })();
    joinIdx++;

    const nullNote = join.nullFkFraction > 0.01
      ? `${(join.nullFkFraction * 100).toFixed(1)}% null`
      : "NOT NULL";
    colLines.push(col(fkCol, leafType, null, `→ ${join.toDimensionId} leaf; ${nullNote}`));

    if (dialect !== "bigquery") {
      constraintLines.push(`    FOREIGN KEY (${fkCol}) REFERENCES ${dimTable} (${leafColRef})`);
    }
  }

  // Measure columns
  for (const measure of fact.measures) {
    const mCol  = ctx.measureColName.get(measure.id) ?? measureIdToCol(measure.id);
    const mType = mapType(measureBaseType(measure), dialect);
    const note  = `${measure.additivity} ${measure.aggregation}`;
    colLines.push(col(mCol, mType, null, note));
  }

  return [
    `-- Fact ${fact.id} (~${fmt(fact.rowCount)} rows, ${fact.joins.length} join(s), ${fact.measures.length} measure(s))`,
    `CREATE TABLE ${tableName} (`,
    buildColumnBody(colLines, constraintLines),
    `);`,
  ].join("\n");
}

// ─── Name derivation ──────────────────────────────────────────────────────────

/** "D1" → "dim_1",  "D12" → "dim_12" */
function dimIdToTable(dimId: string): string {
  return `dim_${dimId.replace(/^D/i, "")}`;
}

/** "F1" → "fact_1",  "F2" → "fact_2" */
function factIdToTable(factId: string): string {
  return `fact_${factId.replace(/^F/i, "")}`;
}

/**
 * Level key column name within a dimension table.
 *
 * Single hierarchy:   l1_key, l2_key, l3_key
 * Multiple hierarchies: h1_l1_key, h2_l1_key
 */
function levelKeyColName(levelIndex: number, hierIndex: number, multiHier: boolean): string {
  const prefix = multiHier ? `h${hierIndex + 1}_` : "";
  return `${prefix}l${levelIndex + 1}_key`;
}

function levelLabelColName(levelIndex: number, hierIndex: number, multiHier: boolean): string {
  const prefix = multiHier ? `h${hierIndex + 1}_` : "";
  return `${prefix}l${levelIndex + 1}_label`;
}

/** "F1.M2" → "m2",  "F1.M12" → "m12" */
function measureIdToCol(measureId: string): string {
  const part = measureId.split(".").at(-1) ?? measureId;
  return part.toLowerCase();
}

// ─── Type inference ───────────────────────────────────────────────────────────

/** ANSI base type for a hierarchy level key, inferred from member count. */
function keyBaseType(memberCount: number): string {
  if (memberCount <= 32_767)       return "SMALLINT";
  if (memberCount <= 2_147_483_647) return "INTEGER";
  return "BIGINT";
}

/** ANSI base type for a measure column. */
function measureBaseType(m: MeasureFingerprint): string {
  if (m.dataType === "integer") return "BIGINT";
  return "DECIMAL(18,4)";  // decimal or unknown
}

/** Translate a base type to the target dialect. */
function mapType(baseType: string, dialect: SqlDialect): string {
  if (dialect === "snowflake") {
    if (baseType === "SMALLINT")      return "NUMBER(5,0)";
    if (baseType === "INTEGER")       return "NUMBER(10,0)";
    if (baseType === "BIGINT")        return "NUMBER(19,0)";
    if (baseType === "DECIMAL(18,4)") return "NUMBER(18,4)";
    if (baseType.startsWith("VARCHAR")) return baseType;  // VARCHAR(n) passes through
    return baseType;
  }
  if (dialect === "bigquery") {
    if (baseType === "SMALLINT" || baseType === "INTEGER" || baseType === "BIGINT") return "INT64";
    if (baseType === "DECIMAL(18,4)") return "FLOAT64";
    if (baseType.startsWith("VARCHAR")) return "STRING";
    return baseType;
  }
  // ansi / postgresql / mysql — use standard types
  return baseType;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const COL_NAME_WIDTH = 28;
const COL_TYPE_WIDTH = 18;

function col(name: string, type: string, constraint: string | null, comment: string): string {
  const namePad = name.padEnd(COL_NAME_WIDTH);
  const typePad = type.padEnd(COL_TYPE_WIDTH);
  const cnstr   = constraint ? `${constraint.padEnd(10)} ` : " ".repeat(11);
  return `    ${namePad} ${typePad} ${cnstr}-- ${comment}`;
}

/**
 * Join column definition lines and constraint lines into a valid SQL column
 * list body (everything between the outer parentheses of CREATE TABLE).
 *
 * The naive `lines.join(",\n")` is wrong: each col() line ends with a
 * `-- inline comment`, so the separator comma lands inside the comment and is
 * silently ignored by the SQL parser.  This helper inserts the comma BEFORE
 * the trailing ` --` on each column line, leaving pure comment lines
 * (hierarchy section headers) unchanged and comma-free.
 */
function buildColumnBody(colLines: string[], constraintLines: string[]): string {
  const out: string[] = [];

  for (let i = 0; i < colLines.length; i++) {
    const line        = colLines[i]!;
    const isComment   = /^\s*--/.test(line);
    const needsComma  = !isComment && (i < colLines.length - 1 || constraintLines.length > 0);

    if (!needsComma) {
      out.push(line);
    } else {
      // Insert comma before the trailing inline comment so it stays outside `--`
      const commentStart = line.indexOf(" --");
      out.push(commentStart !== -1
        ? `${line.slice(0, commentStart)},${line.slice(commentStart)}`
        : `${line},`);
    }
  }

  for (let i = 0; i < constraintLines.length; i++) {
    const line   = constraintLines[i]!;
    const isLast = i === constraintLines.length - 1;
    out.push(isLast ? line : `${line},`);
  }

  return out.join("\n");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

// ─── File header ──────────────────────────────────────────────────────────────

function fileHeader(fp: SchemaFingerprint, dialect: SqlDialect): string {
  return [
    `-- Generated by atscale-utils generate-ddl-from-data-shape`,
    `-- Fingerprint version : ${fp.version}`,
    `-- Captured at         : ${fp.capturedAt}`,
    `-- Dialect             : ${dialect}`,
    `--`,
    `-- Table and column names are synthetic — original names are not stored in`,
    `-- the fingerprint.  Every run from the same fingerprint produces identical DDL.`,
    `--`,
    `-- Dimensions: ${fp.dimensions.length}   Facts: ${fp.facts.length}   Conformed: ${fp.conformedDimensions.length}`,
  ].join("\n");
}
