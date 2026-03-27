// ============================================================
// Schema Metadata → Semantic Model Proposer
// ============================================================
// Reads database schema metadata via the DatabaseMetaData interface
// and proposes a dimensional semantic model (facts, dimensions,
// measures, hierarchies, relationships).
//
// Inference logic lives in dedicated modules:
//   hierarchy-inference.ts  — column-name and index-based hierarchies
//   attribute-inference.ts  — _name / _description secondary attributes
//   measure-inference.ts    — column-name-based aggregation selection
//   pii-detection.ts        — PII / HIPAA column exclusion
// ============================================================

import {
  DatabaseMetaData,
  TableMeta,
  ColumnMeta,
  SemanticModel,
  SemanticDimension,
  SemanticFact,
  SemanticAttribute,
  SemanticRelationship,
  SnowflakeRelationship,
  SemanticView,
  isNumericType,
  toSemanticType,
  toTitleCase,
} from "./types.js";

import { inferHierarchies, hierarchyColumnSet } from "./hierarchy-inference.js";
import { groupSecondaryAttributes, applyMultilingualGrouping } from "./attribute-inference.js";
import { expandMeasures } from "./measure-inference.js";
import {
  ProfileMap,
  profileTables,
  applyProfileTypeOverrides,
} from "./column-profiler.js";
import { InferenceEngine } from "./inference/engine.js";
import {
  PiiSeverity,
  PiiColumnFlag,
  detectPiiColumns,
  getPiiExclusionSet,
  formatPiiWarnings,
} from "./pii-detection.js";
import {
  AnalysisSuggestion,
  SuggestionOptions,
  generateAnalysisSuggestions,
} from "./analysis-suggestions.js";
import {
  SmlSerializerOptions,
  SmlOutput,
  serializeToSml,
} from "./sml-serializer.js";

// Re-export public types so consumers only need to import from this module.
export * from "./types.js";

// ----------------------------------------------------------
// 1. Metadata reader
// ----------------------------------------------------------

interface RawMetadata {
  tables: TableMeta[];
  columnsByTable: Map<string, ColumnMeta[]>;
  foreignKeysByTable: Map<string, import("./types").ForeignKeyMeta[]>;
  indexesByTable: Map<string, import("./types").IndexMeta[]>;
  views: import("./types").ViewMeta[];
}

async function readMetadata(
  db: DatabaseMetaData,
  schemaPattern?: string,
): Promise<RawMetadata> {
  const tables = (await db.getTables(schemaPattern)).filter(
    (t) => t.tableType === "TABLE",
  );
  const views = await db.getViews(schemaPattern);

  const columnsByTable = new Map<string, ColumnMeta[]>();
  const foreignKeysByTable = new Map<string, import("./types").ForeignKeyMeta[]>();
  const indexesByTable = new Map<string, import("./types").IndexMeta[]>();

  await Promise.all(
    tables.map(async (t) => {
      const [cols, fks, idxs] = await Promise.all([
        db.getColumns(t.tableName),
        db.getForeignKeys(t.tableName),
        db.getIndexInfo(t.tableName),
      ]);
      columnsByTable.set(t.tableName, cols);
      foreignKeysByTable.set(t.tableName, fks);
      indexesByTable.set(t.tableName, idxs);
    }),
  );

  return { tables, columnsByTable, foreignKeysByTable, indexesByTable, views };
}

// ----------------------------------------------------------
// 2. Classifier: facts vs. dimensions
// ----------------------------------------------------------

function classifyTables(
  tables: TableMeta[],
  columnsByTable: Map<string, ColumnMeta[]>,
  foreignKeysByTable: Map<string, import("./types").ForeignKeyMeta[]>,
): { factTables: Set<string>; dimensionTables: Set<string> } {
  // FACT: table name ends with "fact" (word boundary), OR has at least one FK
  // to another table AND at least one numeric non-FK, non-PK column.
  // Requiring at least one FK prevents pure dimension/lookup tables from being
  // misclassified.  Requiring a numeric non-FK column excludes bridge tables
  // (e.g. order_product with only key columns) and 1:1 extension tables
  // (e.g. queries_planned with only text/JSON columns).
  // DIMENSION: everything else.
  const factTables = new Set<string>();
  const dimensionTables = new Set<string>();

  for (const table of tables) {
    const fks = foreignKeysByTable.get(table.tableName) ?? [];
    const cols = columnsByTable.get(table.tableName) ?? [];
    const fkColumns = new Set(fks.map((fk) => fk.fkColumnName));
    const uniqueParentTables = new Set(fks.map((fk) => fk.pkTableName));

    const hasFactSuffix = /(?:^|[_\s])fact$/i.test(table.tableName);
    const hasFKs = uniqueParentTables.size >= 1;
    const hasNumericNonFKCols = cols.some(
      (c) => !fkColumns.has(c.columnName) && !c.isPrimaryKey && isNumericType(c.dataType),
    );

    if (hasFactSuffix || (hasFKs && hasNumericNonFKCols)) {
      factTables.add(table.tableName);
    } else {
      dimensionTables.add(table.tableName);
    }
  }

  return { factTables, dimensionTables };
}

// ----------------------------------------------------------
// 3. Main proposer
// ----------------------------------------------------------

export interface ProposeOptions {
  /** Schema/catalog pattern forwarded to getTables() and getViews(). */
  schemaPattern?: string;
  /**
   * Pluggable inference engine for vertical-specific hierarchy and measure
   * inference.  When omitted, only the generic base inference runs.
   * Use createDefaultEngine() from "./inference.js" for all built-in verticals.
   */
  inferenceEngine?: InferenceEngine;
  /**
   * When set, the returned model also contains an `sml` property with a
   * `Map<filePath, yamlContent>` ready to write to disk as AtScale SML files.
   *
   * @example
   * sml: { connectionName: "My Snowflake Connection" }
   */
  sml?: SmlSerializerOptions;
  /**
   * When set, generates a ranked list of measure × hierarchy pairs and tuples
   * that are likely to yield business value.  Pass an object to fine-tune the
   * output, or `true` to use all defaults.
   *
   * @example
   * // Defaults: up to 25 suggestions, pairs + tuples, score ≥ 0.5
   * suggestions: true
   *
   * @example
   * // Custom: top 10 pairs only
   * suggestions: { maxSuggestions: 10, includeTuples: false }
   */
  suggestions?: true | SuggestionOptions;
  /**
   * Maximum rows to sample per table when the database supports `sampleRows()`.
   * Profiling enables pattern-based type overrides, identifier suppression,
   * boolean flag detection, and data-driven PII signals.
   * Defaults to 250 when the database implements `sampleRows`; set to 0 to disable.
   */
  sampleSize?: number;
  /**
   * Minimum PII severity to exclude from the semantic model output.
   *   "HIGH"   — exclude only direct identifiers (SSN, MRN, card numbers, …)
   *   "MEDIUM" — also exclude quasi-identifiers (IP, coordinates, usernames) [default]
   *   "LOW"    — exclude everything including demographic quasi-identifiers
   *   false    — disable PII filtering entirely (not recommended)
   */
  piiExclusionSeverity?: PiiSeverity | false;

  /**
   * Override the automatic fact/dimension classification.
   * When provided, exactly these table names (case-insensitive) are treated as
   * fact tables; all other tables are treated as dimensions.
   */
  factTables?: string[];
}

// ----------------------------------------------------------
// Shared PII helper
// ----------------------------------------------------------

/**
 * Build the set of column names to exclude for PII/HIPAA reasons.
 *
 * Combines two detection sources:
 *   1. Name-based detection (pii-detection.ts) — matches column names against
 *      known PII patterns (SSN, email, phone, etc.)
 *   2. Pattern-based detection (column-profiler.ts) — recognises PII from
 *      the shape of actual values (e.g., a VARCHAR that contains email addresses)
 *
 * Also accumulates PiiColumnFlag entries into `flagAccumulator` so that
 * warnings can be formatted and appended to the model at the end.
 */
function buildPiiExclusionSet(
  tableName: string,
  cols: ColumnMeta[],
  severity: import("./pii-detection").PiiSeverity | false,
  tableProfiles: Map<string, import("./column-profiler").ColumnProfile> | undefined,
  flagAccumulator: PiiColumnFlag[],
): Set<string> {
  if (severity === false) return new Set<string>();

  // Name-based detection
  const nameBasedExclusion = getPiiExclusionSet(tableName, cols, severity);
  flagAccumulator.push(...detectPiiColumns(tableName, cols));

  // Pattern-based detection (only available when column profiling ran)
  const patternBasedCols = tableProfiles
    ? Array.from(tableProfiles.values())
        .filter((p) => p.patternPiiSignal !== undefined)
        .map((p) => p.columnName)
    : [];

  return new Set([...nameBasedExclusion, ...patternBasedCols]);
}

export async function proposeSemanticModel(
  db: DatabaseMetaData,
  modelName = "ProposedModel",
  options: ProposeOptions | string = {},  // string kept for backward compat
): Promise<SemanticModel> {
  // Normalise the overloaded third argument
  const opts: ProposeOptions =
    typeof options === "string" ? { schemaPattern: options } : options;
  const {
    schemaPattern,
    inferenceEngine,
    piiExclusionSeverity = "MEDIUM",
    suggestions: suggestionsOpt,
    sml: smlOpts,
    sampleSize = 250,
  } = opts;

  const allPiiFlags: PiiColumnFlag[] = [];  // accumulates flags from every table/view
  const warnings: string[] = [];

  // ==========================================================================
  // Phase 1: Read all schema metadata from the database
  // ==========================================================================
  const rawMetadata = await readMetadata(db, schemaPattern);

  // ==========================================================================
  // Phase 2: Column profiling (optional — requires db.sampleRows)
  // Sampling refines data types beyond what the schema declares and provides
  // pattern-based PII signals (e.g., detecting emails stored as VARCHAR).
  // ==========================================================================
  let profileMap: ProfileMap = new Map();
  if (db.sampleRows && sampleSize > 0) {
    profileMap = await profileTables(db, rawMetadata.columnsByTable, sampleSize);
  }

  // ==========================================================================
  // Phase 3: Classify tables as facts or dimensions
  // Fact tables have FKs to ≥2 distinct tables AND at least one numeric non-FK column.
  // Everything else is treated as a dimension (or skipped if unclassifiable).
  // ==========================================================================
  let { factTables, dimensionTables } = classifyTables(
    rawMetadata.tables,
    rawMetadata.columnsByTable,
    rawMetadata.foreignKeysByTable,
  );

  // Apply explicit fact table override when provided
  if (opts.factTables?.length) {
    const overrideSet = new Set(opts.factTables.map((t) => t.toLowerCase()));
    const allTableNames = rawMetadata.tables.map((t) => t.tableName);
    factTables      = new Set(allTableNames.filter((n) => overrideSet.has(n.toLowerCase())));
    dimensionTables = new Set(allTableNames.filter((n) => !overrideSet.has(n.toLowerCase())));
  }

  if (factTables.size === 0) {
    warnings.push(
      "No fact tables detected. All tables classified as dimensions. " +
      "Consider verifying foreign key and numeric column presence.",
    );
  }

  // Misclassification check: a table classified as a fact that is ALSO the PK
  // target of a foreign key from a "substantial" fact table is likely a wide
  // dimension (e.g. a product master with FK references to lookup tables).
  //
  // We only warn when the referencing table has ≥3 non-FK numeric columns —
  // this filters out bridge/junction tables (like FactInternetSalesReason which
  // has zero measure columns) that legitimately FK back to a parent fact table.
  // A bridge table referencing a fact is a normal fact-to-fact snowflake pattern;
  // a measure-rich fact table pointing to another fact strongly suggests the
  // target should have been a dimension.
  for (const factTable of factTables) {
    const substantialReferencingFacts = new Set<string>();

    for (const [sourceTable, fks] of rawMetadata.foreignKeysByTable) {
      if (sourceTable === factTable) continue;  // skip self-referential FKs
      if (!factTables.has(sourceTable)) continue;  // only check fact→fact FKs

      const hasFkToThisTable = fks.some((fk) => fk.pkTableName === factTable);
      if (!hasFkToThisTable) continue;

      // Count non-FK numeric columns on the referencing table to determine
      // whether it is a genuine fact (many measures) or a bridge table (few/none).
      const sourceFkCols = new Set(fks.map((fk) => fk.fkColumnName));
      const sourceCols = rawMetadata.columnsByTable.get(sourceTable) ?? [];
      const measureCount = sourceCols.filter(
        (c) => !sourceFkCols.has(c.columnName) && isNumericType(c.dataType),
      ).length;

      if (measureCount >= 3) {
        substantialReferencingFacts.add(sourceTable);
      }
    }

    if (substantialReferencingFacts.size > 0) {
      const referencingList = Array.from(substantialReferencingFacts).join(", ");
      warnings.push(
        `[LIKELY MISCLASSIFIED] "${factTable}" was classified as a fact table ` +
        `(has ≥2 FK references to other tables plus numeric columns), but it is ` +
        `also the PK target of foreign keys from the fact table(s): ${referencingList}. ` +
        `This table is probably a wide dimension with lookup FK relationships. ` +
        `Its numeric columns (e.g. prices, stock levels) will appear as measures ` +
        `rather than attributes, and any FK pointing to it cannot be resolved as ` +
        `a relationship. Consider whether its outbound FKs are dimension lookups ` +
        `rather than fact joins.`,
      );
    }
  }

  // ==========================================================================
  // Phase 4: Build dimension datasets
  // ==========================================================================
  // --- Build dimensions ---
  const dimensions: SemanticDimension[] = [];

  for (const tableName of dimensionTables) {
    const rawCols = rawMetadata.columnsByTable.get(tableName) ?? [];
    const cols = applyProfileTypeOverrides(rawCols, profileMap.get(tableName));
    const idxs = rawMetadata.indexesByTable.get(tableName) ?? [];
    const fks = rawMetadata.foreignKeysByTable.get(tableName) ?? [];
    const pkCols = cols.filter((c) => c.isPrimaryKey);

    // Columns excluded from the flat attribute list: PK, FKs, hierarchy columns.
    const fkColumns = new Set(fks.map((fk) => fk.fkColumnName));

    // When no explicit PK is declared, infer the composite key from all NOT NULL
    // non-FK columns. This avoids generating a level_attribute referencing a
    // non-existent "id" column.
    const inferredPkCols = pkCols.length === 0
      ? rawCols.filter((c) => !c.nullable && !fkColumns.has(c.columnName))
      : pkCols;

    if (pkCols.length === 0) {
      warnings.push(
        `Dimension table "${tableName}" has no primary key — inferring composite key from NOT NULL columns: [${inferredPkCols.map((c) => c.columnName).join(", ")}]`,
      );
    }

    const primaryKeys = inferredPkCols.map((c) => c.columnName);
    const pkColumnSet = new Set(primaryKeys);

    // Detect and exclude PII / HIPAA columns — combines name-based and
    // pattern-based detection; accumulates flags for the final warning list.
    const tableProfiles = profileMap.get(tableName);
    const piiExclusion = buildPiiExclusionSet(
      tableName, cols, piiExclusionSeverity, tableProfiles, allPiiFlags,
    );

    // Infer hierarchies first so we know which columns they consume.
    // When an engine is provided it wraps the base inference and adds
    // vertical-specific hierarchies on top.
    const nonPkCols = cols.filter(
      (c) => !pkColumnSet.has(c.columnName) && !piiExclusion.has(c.columnName),
    );
    const hierarchyResult = inferenceEngine
      ? inferenceEngine.inferHierarchies(nonPkCols, idxs)
      : inferHierarchies(nonPkCols, idxs);

    // Prefix any hierarchy warnings with the table name so users can locate them.
    hierarchyResult.warnings.forEach((w) =>
      warnings.push(`[${tableName}] ${w}`),
    );

    const { hierarchies } = hierarchyResult;
    const hierarchyCols = hierarchyColumnSet(hierarchies);

    const excluded = new Set([
      ...Array.from(fkColumns),
      ...Array.from(hierarchyCols),
    ]);

    // Group _name / _description companions into their parent's labels.
    const { attributes } = groupSecondaryAttributes(nonPkCols, excluded);

    // Collapse multilingual variants (_en / _es / _fr …) into SemanticLabel entries.
    applyMultilingualGrouping(attributes);

    // H: Propagate JDBC column remarks as descriptions.
    for (const attr of attributes) {
      const colMeta = rawCols.find((c) => c.columnName === attr.sourceColumn);
      if (colMeta?.remarks?.trim()) {
        attr.description = colMeta.remarks.trim();
      }
    }

    // I: Assign UI folders based on column name prefix patterns.
    const FOLDER_PREFIXES: Array<[RegExp, string]> = [
      [/^date_/i,     "Date Attributes"],
      [/^fiscal_/i,   "Fiscal Attributes"],
      [/^calendar_/i, "Calendar Attributes"],
    ];
    for (const attr of attributes) {
      for (const [pattern, folder] of FOLDER_PREFIXES) {
        if (pattern.test(attr.sourceColumn)) {
          attr.folder = folder;
          break;
        }
      }
    }

    // F: Detect dimension-to-dimension FK relationships (snowflake schema).
    // Group by constraint name to build composite joins correctly.
    const sfksByConstraint = new Map<string, typeof fks>();
    for (const fk of fks.filter((fk) => dimensionTables.has(fk.pkTableName))) {
      const g = sfksByConstraint.get(fk.constraintName) ?? [];
      g.push(fk);
      sfksByConstraint.set(fk.constraintName, g);
    }
    const snowflakeRelationships: SnowflakeRelationship[] = [];
    for (const [, group] of sfksByConstraint) {
      group.sort((a, b) => a.keySeq - b.keySeq);
      const fromCols = group.map((fk) => fk.fkColumnName);
      const toCols   = group.map((fk) => fk.pkColumnName);
      // Skip identity self-joins (PK referencing itself — semantically redundant).
      if (group[0].pkTableName === tableName && fromCols.join() === toCols.join()) continue;
      // Skip multi-column FK snowflake joins. AtScale requires to.level to be the
      // target's is_unique_key LA *and* the source to have an LA with matching
      // key_columns.length — constraints that conflict for composite FKs whose
      // columns differ from the target's PK columns (self-joins, bridge tables).
      if (fromCols.length > 1) continue;
      snowflakeRelationships.push({
        fromColumns: fromCols,
        toTable:     group[0].pkTableName,
        toColumns:   toCols,
      });
    }

    // H: Table-level remarks for dimension description.
    const tableRemark = rawMetadata.tables
      .find((t) => t.tableName === tableName)
      ?.remarks
      ?.trim();

    dimensions.push({
      kind: "dimension",
      name: toTitleCase(tableName),
      sourceTable: tableName,
      primaryKeys,
      attributes,
      hierarchies,
      ...(tableRemark          ? { description:             tableRemark            } : {}),
      ...(snowflakeRelationships.length > 0 ? { snowflakeRelationships } : {}),
    });
  }

  // ==========================================================================
  // Phase 5: Build fact datasets
  // ==========================================================================
  // --- Build facts ---
  const facts: SemanticFact[] = [];

  for (const tableName of factTables) {
    const rawFactCols = rawMetadata.columnsByTable.get(tableName) ?? [];
    const cols = applyProfileTypeOverrides(rawFactCols, profileMap.get(tableName));
    const fks = rawMetadata.foreignKeysByTable.get(tableName) ?? [];
    const pkCol = cols.find((c) => c.isPrimaryKey);
    const fkColumns = new Set(fks.map((fk) => fk.fkColumnName));

    // Detect and exclude PII columns — same logic as for dimensions.
    const factTableProfiles = profileMap.get(tableName);
    const factPiiExclusion = buildPiiExclusionSet(
      tableName, cols, piiExclusionSeverity, factTableProfiles, allPiiFlags,
    );

    // Identifier suppression: skip numeric columns that profile as high-cardinality
    // identifiers (e.g. surrogate keys that happen to be non-FK numeric columns).
    const identifierCols = factTableProfiles
      ? new Set(
          Array.from(factTableProfiles.values())
            .filter((p) => p.cardinalityClass === "identifier")
            .map((p) => p.columnName),
        )
      : new Set<string>();

    const numericCols = cols.filter(
      (c) =>
        !c.isPrimaryKey &&
        !fkColumns.has(c.columnName) &&
        !factPiiExclusion.has(c.columnName) &&
        !identifierCols.has(c.columnName) &&
        isNumericType(c.dataType),
    );
    const genericMeasures = numericCols.flatMap((c) => expandMeasures(c));
    const verticalMeasures = inferenceEngine
      ? inferenceEngine.inferMeasures(cols)
      : [];
    // Deduplicate: skip vertical measures whose sourceColumn+aggregation pair
    // is already covered by generic inference.
    const genericKeys = new Set(genericMeasures.map((m) => `${m.sourceColumn}:${m.aggregation}`));
    const measures = [
      ...genericMeasures,
      ...verticalMeasures.filter((m) => !genericKeys.has(`${m.sourceColumn}:${m.aggregation}`)),
    ];

    const degenerateDimensions: SemanticAttribute[] = cols
      .filter(
        (c) =>
          !c.isPrimaryKey &&
          !fkColumns.has(c.columnName) &&
          !factPiiExclusion.has(c.columnName) &&
          !isNumericType(c.dataType),
      )
      .map((c) => ({
        name: toTitleCase(c.columnName),
        sourceColumn: c.columnName,
        dataType: toSemanticType(c.dataType),
        nullable: c.nullable,
      }));

    // Collapse multilingual variants in degenerate dimensions too.
    applyMultilingualGrouping(degenerateDimensions);

    if (measures.length === 0) {
      warnings.push(`Fact table "${tableName}" has no numeric measure columns.`);
    }

    facts.push({
      kind: "fact",
      name: toTitleCase(tableName),
      sourceTable: tableName,
      primaryKey: pkCol?.columnName,
      measures,
      degenerateDimensions,
    });
  }

  // ==========================================================================
  // Phase 6: Build relationships (fact → dimension joins)
  // ==========================================================================
  // --- Build relationships ---
  const dimensionNameByTable = new Map(dimensions.map((d) => [d.sourceTable, d.name]));
  const factNameByTable = new Map(facts.map((f) => [f.sourceTable, f.name]));
  const relationships: SemanticRelationship[] = [];

  for (const [tableName, fks] of rawMetadata.foreignKeysByTable) {
    const fromDataset =
      factNameByTable.get(tableName) ?? dimensionNameByTable.get(tableName);
    if (!fromDataset) continue;

    // G: Group FK rows by constraintName so composite foreign keys (multi-column
    // joins) produce a single relationship with fromColumns instead of many
    // duplicate single-column relationships.
    const fksByConstraint = new Map<string, typeof fks>();
    for (const fk of fks) {
      const group = fksByConstraint.get(fk.constraintName) ?? [];
      group.push(fk);
      fksByConstraint.set(fk.constraintName, group);
    }

    for (const [constraintName, fkGroup] of fksByConstraint) {
      // Sort by keySeq for deterministic column ordering.
      fkGroup.sort((a, b) => a.keySeq - b.keySeq);

      const toDataset = dimensionNameByTable.get(fkGroup[0].pkTableName);
      if (!toDataset) {
        warnings.push(
          `Foreign key "${constraintName}" references "${fkGroup[0].pkTableName}" ` +
          `which was not found as a dimension.`,
        );
        continue;
      }

      const fromCols = rawMetadata.columnsByTable.get(tableName) ?? [];
      const fkColMeta = fromCols.find((c) => c.columnName === fkGroup[0].fkColumnName);
      const cardinality: SemanticRelationship["cardinality"] =
        fkColMeta?.isPrimaryKey ? "ONE_TO_ONE" : "MANY_TO_ONE";

      const fromColumns = fkGroup.map((fk) => fk.fkColumnName);

      relationships.push({
        fromDataset,
        fromColumn: fromColumns[0],
        ...(fromColumns.length > 1 ? { fromColumns } : {}),
        toDataset,
        toColumn: fkGroup[0].pkColumnName,
        constraintName,
        cardinality,
      });
    }
  }

  // ==========================================================================
  // Phase 7: Structural inference warnings
  // These analyse the shape of the schema (FK patterns, column name conventions)
  // to emit advisory warnings that help the user improve the semantic model.
  // ==========================================================================

  // Role-playing dimensions: a fact has multiple FKs to the same dimension table.
  // Classic example: FactInternetSales → DimDate × 3 (OrderDate, DueDate, ShipDate).
  // The model is still valid but the user should rename the FK role for clarity.
  for (const fact of facts) {
    const factFks = rawMetadata.foreignKeysByTable.get(fact.sourceTable) ?? [];
    const pkTableCounts = new Map<string, number>();
    for (const fk of factFks) {
      pkTableCounts.set(fk.pkTableName, (pkTableCounts.get(fk.pkTableName) ?? 0) + 1);
    }
    for (const [pkTable, count] of pkTableCounts) {
      if (count > 1 && dimensionTables.has(pkTable)) {
        warnings.push(
          `[ROLE-PLAYING] "${fact.sourceTable}" has ${count} foreign keys to "${pkTable}". ` +
          `Consider modelling as role-playing dimensions (e.g. OrderDate, ShipDate).`,
        );
      }
    }
  }

  // Conformed dimensions: a single dimension table referenced by multiple fact tables.
  // This is not a problem — conformed dims are a best practice in dimensional modelling —
  // but it is worth noting so the user can verify attribute consistency across facts.
  const dimRefCount = new Map<string, Set<string>>();
  for (const [tableName, fks] of rawMetadata.foreignKeysByTable) {
    if (!factTables.has(tableName)) continue;
    for (const fk of fks) {
      if (!dimensionTables.has(fk.pkTableName)) continue;
      const referencingFacts = dimRefCount.get(fk.pkTableName) ?? new Set<string>();
      referencingFacts.add(tableName);
      dimRefCount.set(fk.pkTableName, referencingFacts);
    }
  }
  for (const [dimTable, factSet] of dimRefCount) {
    if (factSet.size >= 2) {
      warnings.push(
        `[CONFORMED DIM] "${dimTable}" is referenced by ${factSet.size} fact tables: ` +
        `${Array.from(factSet).join(", ")}. Ensure shared attributes are consistent.`,
      );
    }
  }

  // Audit columns: warn when standard ETL/audit columns are present in dimension tables.
  const AUDIT_PATTERNS = [
    /^(created_at|created_date|create_date)$/i,
    /^(updated_at|updated_date|modified_at|modified_date|last_updated)$/i,
    /^(created_by|updated_by|modified_by|last_modified_by)$/i,
    /^(etl_batch_id|etl_run_id|batch_id|load_id|insert_date|load_date)$/i,
    /^(row_hash|checksum|hash_key|dw_insert_date|dw_update_date)$/i,
  ];
  for (const [tableName, cols] of rawMetadata.columnsByTable) {
    const auditCols = cols
      .filter((c) => AUDIT_PATTERNS.some((re) => re.test(c.columnName)))
      .map((c) => c.columnName);
    if (auditCols.length > 0) {
      warnings.push(
        `[AUDIT COLS] "${tableName}" contains ETL/audit columns that should be excluded ` +
        `from the semantic layer: ${auditCols.join(", ")}.`,
      );
    }
  }

  // SCD Type 2 detection: effective_date + end_date + current_flag pattern.
  for (const [tableName, cols] of rawMetadata.columnsByTable) {
    if (!dimensionTables.has(tableName)) continue;
    const colNames = cols.map((c) => c.columnName.toLowerCase());
    const hasEffective = colNames.some((n) => /effective_date|start_date|valid_from/.test(n));
    const hasEnd = colNames.some((n) => /end_date|expiry_date|valid_to/.test(n));
    const hasCurrent = colNames.some((n) => /is_current|current_flag|active_flag/.test(n));
    if (hasEffective && hasEnd && hasCurrent) {
      warnings.push(
        `[SCD TYPE 2] "${tableName}" appears to be a Slowly Changing Dimension Type 2 ` +
        `(has effective_date / end_date / current_flag pattern). ` +
        `Consider filtering to current rows in the SML dataset definition.`,
      );
    }
  }

  // ==========================================================================
  // Phase 8: Build view datasets
  // Views are treated as read-only attribute collections; no measures are inferred.
  // ==========================================================================
  // --- Build views ---
  const views: SemanticView[] = rawMetadata.views.map((v) => {
    const viewPiiExclusion =
      piiExclusionSeverity !== false
        ? getPiiExclusionSet(v.viewName, v.columns, piiExclusionSeverity)
        : new Set<string>();
    allPiiFlags.push(
      ...(piiExclusionSeverity !== false ? detectPiiColumns(v.viewName, v.columns) : []),
    );

    return {
      name: toTitleCase(v.viewName),
      sourceSql: v.definition,
      attributes: v.columns
        .filter((c) => !viewPiiExclusion.has(c.columnName))
        .map((c) => ({
          name: toTitleCase(c.columnName),
          sourceColumn: c.columnName,
          dataType: toSemanticType(c.dataType),
          nullable: c.nullable,
        })),
    };
  });

  // Append PII/HIPAA exclusion warnings
  warnings.push(...formatPiiWarnings(allPiiFlags));

  const model: SemanticModel = {
    name: modelName,
    generatedAt: new Date().toISOString(),
    facts,
    dimensions,
    relationships,
    views,
    suggestions: [],
    warnings,
  };

  // Generate analysis suggestions if requested
  if (suggestionsOpt) {
    const suggOpts: SuggestionOptions =
      suggestionsOpt === true ? {} : suggestionsOpt;
    model.suggestions = generateAnalysisSuggestions(model, suggOpts);
  }

  // Serialize to AtScale SML if requested
  if (smlOpts) {
    // Pass through the raw column map so dataset files are complete
    const smlOptsWithCols: SmlSerializerOptions = {
      ...smlOpts,
      columnsByTable:
        smlOpts.columnsByTable ??
        (rawMetadata.columnsByTable as Map<string, import("./types").ColumnMeta[]>),
    };
    model.sml = serializeToSml(model, smlOptsWithCols);
  }

  return model;
}

// ----------------------------------------------------------
// 4. Pretty-print utility
// ----------------------------------------------------------

export function printSemanticModel(model: SemanticModel): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Semantic Model: ${model.name}`);
  console.log(`Generated:      ${model.generatedAt}`);
  console.log("=".repeat(60));

  console.log(`\nFACT DATASETS (${model.facts.length})`);
  for (const f of model.facts) {
    console.log(`  [FACT] ${f.name}  →  source: ${f.sourceTable}`);
    if (f.primaryKey) console.log(`    PK: ${f.primaryKey}`);
    console.log(`    Measures (${f.measures.length}):`);
    for (const m of f.measures) {
      console.log(`      • ${m.name} [${m.dataType}] — ${m.aggregation}(${m.sourceColumn})`);
    }
    if (f.degenerateDimensions.length) {
      console.log(`    Degenerate dimensions (${f.degenerateDimensions.length}):`);
      for (const d of f.degenerateDimensions) {
        console.log(`      • ${d.name} [${d.dataType}]`);
      }
    }
  }

  console.log(`\nDIMENSION DATASETS (${model.dimensions.length})`);
  for (const d of model.dimensions) {
    console.log(`  [DIM] ${d.name}  →  source: ${d.sourceTable}`);
    console.log(`    PK: ${d.primaryKeys.join(", ")}`);

    if (d.hierarchies.length) {
      console.log(`    Hierarchies (${d.hierarchies.length}):`);
      for (const h of d.hierarchies) {
        const levels = h.levels.map((l) => l.name).join(" → ");
        const src = h.sourceIndex ? ` [idx: ${h.sourceIndex}]` : "";
        console.log(`      ◦ ${h.name}${src}: ${levels}`);
      }
    }

    console.log(`    Attributes (${d.attributes.length}):`);
    for (const a of d.attributes) {
      console.log(`      • ${a.name} [${a.dataType}]`);
      if (a.labels?.length) {
        for (const lbl of a.labels) {
          console.log(`          ↳ ${lbl.kind}: ${lbl.name} (${lbl.sourceColumn})`);
        }
      }
    }
  }

  console.log(`\nRELATIONSHIPS (${model.relationships.length})`);
  for (const r of model.relationships) {
    console.log(
      `  ${r.fromDataset}.${r.fromColumn}  →  ${r.toDataset}.${r.toColumn}` +
      `  [${r.cardinality}]  (${r.constraintName})`,
    );
  }

  if (model.views.length) {
    console.log(`\nVIEWS (${model.views.length})`);
    for (const v of model.views) {
      console.log(`  [VIEW] ${v.name}  (${v.attributes.length} attributes)`);
    }
  }

  if (model.suggestions.length) {
    console.log(`\nANALYSIS SUGGESTIONS (${model.suggestions.length})`);
    const byType = model.suggestions.reduce<Record<string, AnalysisSuggestion[]>>(
      (acc, s) => {
        (acc[s.analysisType] ??= []).push(s);
        return acc;
      },
      {},
    );
    for (const [type, items] of Object.entries(byType)) {
      console.log(`\n  [${type.toUpperCase()}]`);
      for (const s of items) {
        const score = (s.relevanceScore * 100).toFixed(0);
        const dims = s.hierarchies.map((h) => `${h.dimensionName} › ${h.hierarchyName}`).join("  +  ");
        console.log(`    • ${s.title}  [${score}%]`);
        console.log(`        ${s.measure.factName} › ${s.measure.measureName}`);
        console.log(`        ↳ ${dims}`);
      }
    }
  }

  if (model.warnings.length) {
    const piiWarnings = model.warnings.filter((w) => w.startsWith("[PII") || w.startsWith("[PHI"));
    const otherWarnings = model.warnings.filter((w) => !w.startsWith("[PII") && !w.startsWith("[PHI"));

    if (piiWarnings.length) {
      console.log(`\nPII / HIPAA EXCLUSIONS (${piiWarnings.length})`);
      for (const w of piiWarnings) {
        console.log(`  🔒 ${w}`);
      }
    }
    if (otherWarnings.length) {
      console.log(`\nWARNINGS (${otherWarnings.length})`);
      for (const w of otherWarnings) {
        console.log(`  ⚠  ${w}`);
      }
    }
  }

  console.log(`\n${"=".repeat(60)}\n`);
}

// ----------------------------------------------------------
// 5. Usage
// ----------------------------------------------------------
//
// Implement DatabaseMetaData for your driver, then call:
//
//   import { proposeSemanticModel, printSemanticModel } from "./jdbc-semantic-model.js";
//
//   const model = await proposeSemanticModel(myDbMeta, "SalesModel", "public");
//   printSemanticModel(model);
